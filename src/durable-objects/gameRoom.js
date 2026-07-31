const MIN_FUSE_MS = 8000;
const MAX_FUSE_MS = 25000;
const GAME_TYPES = ["bomb"];

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map(); // WebSocket -> participantId
    this.ready = this.load();
  }

  async load() {
    const stored = await this.state.storage.get("data");
    this.data = stored || {
      id: null,
      name: "",
      gameType: "bomb",
      createdAt: Date.now(),
      participants: [], // { id, name, connected }
      hostId: null,
      phase: "lobby", // lobby | playing | exploded | closed
      order: [],
      currentIndex: 0,
      loserId: null,
    };
  }

  async persist() {
    await this.state.storage.put("data", this.data);
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      const body = await request.json();
      if (!this.data.id) {
        this.data.id = body.id;
        this.data.name = body.name;
        this.data.gameType = GAME_TYPES.includes(body.gameType) ? body.gameType : "bomb";
        this.data.createdAt = Date.now();
        await this.persist();
        // not added to the directory yet — it appears once someone actually joins
      }
      return new Response("ok");
    }

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.handleSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("not found", { status: 404 });
  }

  handleSocket(ws) {
    let participantId = null;

    const onClose = async () => {
      this.sockets.delete(ws);
      if (!participantId) return;
      const p = this.data.participants.find((pp) => pp.id === participantId);
      if (p) p.connected = false;

      if (participantId === this.data.hostId && this.data.phase !== "closed") {
        this.data.phase = "closed";
        await this.state.storage.deleteAlarm();
      } else if (this.data.phase === "playing" && this.data.order[this.data.currentIndex] === participantId) {
        this.data.currentIndex = (this.data.currentIndex + 1) % this.data.order.length;
      }

      await this.persist();
      await this.syncDirectory();
      this.broadcast();
    };

    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onClose);

    ws.addEventListener("message", async (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }

      if (msg.type === "join") {
        const name = (msg.name || "").toString().trim().slice(0, 12);
        const deviceId = msg.deviceId ? msg.deviceId.toString().slice(0, 64) : null;
        const existing = msg.rejoinId && this.data.participants.find((p) => p.id === msg.rejoinId);
        if (existing) {
          participantId = existing.id;
          existing.connected = true;
          if (name) existing.name = name;
          if (deviceId) existing.deviceId = deviceId;
        } else {
          if (!name) return;
          participantId = crypto.randomUUID();
          this.data.participants.push({ id: participantId, name, connected: true, deviceId });
          if (!this.data.hostId) this.data.hostId = participantId;
        }
        this.sockets.set(ws, participantId);
        ws.send(JSON.stringify({ type: "welcome", yourId: participantId }));
        await this.persist();
        await this.syncDirectory();
        this.broadcast();
        return;
      }

      if (!participantId) return;

      if (msg.type === "start" && participantId === this.data.hostId && this.data.phase === "lobby") {
        if (this.data.participants.length < 2) return;
        this.data.order = this.data.participants.map((p) => p.id);
        this.data.currentIndex = Math.floor(Math.random() * this.data.order.length);
        this.data.phase = "playing";
        this.data.loserId = null;
        await this.armBomb();
        return;
      }

      if (msg.type === "pass" && this.data.phase === "playing") {
        const holderId = this.data.order[this.data.currentIndex];
        if (holderId !== participantId) return;
        this.data.currentIndex = (this.data.currentIndex + 1) % this.data.order.length;
        await this.persist();
        this.broadcast();
        return;
      }

      if (msg.type === "restart" && participantId === this.data.hostId && this.data.phase === "exploded") {
        this.data.currentIndex = Math.floor(Math.random() * this.data.order.length);
        this.data.phase = "playing";
        this.data.loserId = null;
        await this.armBomb();
        return;
      }

      if (msg.type === "backToLobby" && participantId === this.data.hostId) {
        this.data.phase = "lobby";
        this.data.order = [];
        this.data.currentIndex = 0;
        this.data.loserId = null;
        await this.state.storage.deleteAlarm();
        await this.persist();
        await this.syncDirectory();
        this.broadcast();
        return;
      }
    });
  }

  async armBomb() {
    const duration = MIN_FUSE_MS + Math.random() * (MAX_FUSE_MS - MIN_FUSE_MS);
    await this.state.storage.setAlarm(Date.now() + duration);
    await this.persist();
    await this.syncDirectory();
    this.broadcast();
  }

  async alarm() {
    await this.ready;
    if (this.data.phase !== "playing") return;
    this.data.phase = "exploded";
    this.data.loserId = this.data.order[this.data.currentIndex];
    await this.persist();
    await this.syncDirectory();
    await this.reportLoss();
    this.broadcast();
  }

  async reportLoss() {
    const loser = this.data.participants.find((p) => p.id === this.data.loserId);
    if (!loser) return;
    const lb = this.env.LEADERBOARD.get(this.env.LEADERBOARD.idFromName("global"));
    await lb.fetch("https://leaderboard/record", {
      method: "POST",
      body: JSON.stringify({
        deviceId: loser.deviceId || loser.id,
        name: loser.name,
        ts: Date.now(),
      }),
    });
  }

  broadcast() {
    const holderId = this.data.phase === "playing" ? this.data.order[this.data.currentIndex] : null;
    for (const [ws, pid] of this.sockets) {
      const payload = {
        type: "state",
        name: this.data.name,
        gameType: this.data.gameType,
        phase: this.data.phase,
        hostId: this.data.hostId,
        participants: this.data.participants,
        currentHolderId: holderId,
        loserId: this.data.loserId,
        you: {
          id: pid,
          isHost: pid === this.data.hostId,
          canPass: this.data.phase === "playing" && holderId === pid,
        },
      };
      try {
        ws.send(JSON.stringify(payload));
      } catch {
        // socket already gone; close handler will clean it up
      }
    }
  }

  async syncDirectory() {
    const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("global"));
    const connectedCount = this.data.participants.filter((p) => p.connected).length;

    if (connectedCount === 0 || this.data.phase === "closed") {
      await dir.fetch("https://directory/remove", {
        method: "POST",
        body: JSON.stringify({ id: this.data.id }),
      });
      return;
    }

    await dir.fetch("https://directory/upsert", {
      method: "POST",
      body: JSON.stringify({
        id: this.data.id,
        name: this.data.name,
        gameType: this.data.gameType,
        participantCount: connectedCount,
        phase: this.data.phase,
        createdAt: this.data.createdAt,
      }),
    });
  }
}
