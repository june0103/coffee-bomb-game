const MIN_FUSE_MS = 8000;
const MAX_FUSE_MS = 25000;

const REACTION_MIN_DELAY_MS = 2000;
const REACTION_MAX_DELAY_MS = 6000;
const REACTION_TIMEOUT_MS = 8000; // grace period after green before stragglers are force-finished
const REACTION_PENALTY_MS = 99999; // sentinel for a false start or a no-click — guaranteed "slowest"

const TS_MIN_SECONDS = 10;
const TS_MAX_SECONDS = 30;
const TS_TIMEOUT_EXTRA_MS = 10000;

const GAME_TYPES = ["bomb", "reaction", "timesense"];

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
      participants: [], // { id, name, connected, deviceId, reactionMs?, falseStart? }
      hostId: null,
      phase: "lobby", // lobby | playing | exploded | armed | green | finished | result | closed
      order: [], // bomb: turn order
      currentIndex: 0, // bomb: whose turn
      roundParticipantIds: [], // reaction: who's in this round
      loserId: null,
      targetSeconds: null, // timesense
      roundStartAt: null, // timesense
      answers: [], // timesense: { id, diffSeconds, missed }
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
      } else if (
        this.data.gameType === "bomb" &&
        this.data.phase === "playing" &&
        this.data.order[this.data.currentIndex] === participantId
      ) {
        this.data.currentIndex = (this.data.currentIndex + 1) % this.data.order.length;
      } else if (this.data.gameType === "timesense" && this.data.phase === "playing") {
        if (this.allConnectedAnswered()) {
          this.data.phase = "result";
          await this.state.storage.deleteAlarm();
        }
      }

      await this.persist();
      await this.syncDirectory();
      this.broadcast();

      if (this.data.gameType === "reaction" && (this.data.phase === "armed" || this.data.phase === "green")) {
        if (this.isReactionRoundComplete()) await this.finishReaction();
      }
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
        const connectedCount = this.data.participants.filter((p) => p.connected).length;
        if (this.data.gameType === "bomb") {
          if (connectedCount < 2) return;
          this.data.order = this.data.participants.map((p) => p.id);
          this.data.currentIndex = Math.floor(Math.random() * this.data.order.length);
          this.data.phase = "playing";
          this.data.loserId = null;
          await this.armBomb();
        } else if (this.data.gameType === "reaction") {
          if (connectedCount < 2) return;
          await this.startReactionRound();
        } else if (this.data.gameType === "timesense") {
          await this.startTimesenseRound();
        }
        return;
      }

      if (msg.type === "pass" && this.data.gameType === "bomb" && this.data.phase === "playing") {
        const holderId = this.data.order[this.data.currentIndex];
        if (holderId !== participantId) return;
        this.data.currentIndex = (this.data.currentIndex + 1) % this.data.order.length;
        await this.persist();
        this.broadcast();
        return;
      }

      if (msg.type === "react" && this.data.gameType === "reaction") {
        if (!this.registerReaction(participantId)) return;
        await this.persist();
        this.broadcast();
        if (this.isReactionRoundComplete()) await this.finishReaction();
        return;
      }

      if (msg.type === "react" && this.data.gameType === "timesense" && this.data.phase === "playing") {
        if (this.data.answers.some((a) => a.id === participantId)) return;
        const elapsedSeconds = (Date.now() - this.data.roundStartAt) / 1000;
        const diffSeconds = elapsedSeconds - this.data.targetSeconds;
        this.data.answers.push({ id: participantId, diffSeconds, missed: false });
        if (this.allConnectedAnswered()) {
          this.data.phase = "result";
          await this.state.storage.deleteAlarm();
        }
        await this.persist();
        await this.syncDirectory();
        this.broadcast();
        return;
      }

      if (msg.type === "restart" && participantId === this.data.hostId) {
        if (this.data.gameType === "bomb" && this.data.phase === "exploded") {
          this.data.currentIndex = Math.floor(Math.random() * this.data.order.length);
          this.data.phase = "playing";
          this.data.loserId = null;
          await this.armBomb();
        } else if (this.data.gameType === "reaction" && this.data.phase === "finished") {
          await this.startReactionRound();
        } else if (this.data.gameType === "timesense" && this.data.phase === "result") {
          await this.startTimesenseRound();
        }
        return;
      }

      if (msg.type === "backToLobby" && participantId === this.data.hostId) {
        this.data.phase = "lobby";
        this.data.order = [];
        this.data.currentIndex = 0;
        this.data.roundParticipantIds = [];
        this.data.loserId = null;
        this.data.targetSeconds = null;
        this.data.roundStartAt = null;
        this.data.answers = [];
        this.data.participants.forEach((p) => {
          p.reactionMs = null;
          p.falseStart = false;
        });
        await this.state.storage.deleteAlarm();
        await this.persist();
        await this.syncDirectory();
        this.broadcast();
        return;
      }
    });
  }

  // ---------- bomb ----------

  async armBomb() {
    const duration = MIN_FUSE_MS + Math.random() * (MAX_FUSE_MS - MIN_FUSE_MS);
    await this.state.storage.setAlarm(Date.now() + duration);
    await this.persist();
    await this.syncDirectory();
    this.broadcast();
  }

  async alarmBomb() {
    if (this.data.phase !== "playing") return;
    this.data.phase = "exploded";
    this.data.loserId = this.data.order[this.data.currentIndex];
    await this.persist();
    await this.syncDirectory();
    await this.reportLoss();
    this.broadcast();
  }

  // ---------- reaction ----------

  async startReactionRound() {
    this.data.roundParticipantIds = this.data.participants.filter((p) => p.connected).map((p) => p.id);
    this.data.participants.forEach((p) => {
      p.reactionMs = null;
      p.falseStart = false;
    });
    this.data.loserId = null;
    this.data.phase = "armed";
    const delay = REACTION_MIN_DELAY_MS + Math.random() * (REACTION_MAX_DELAY_MS - REACTION_MIN_DELAY_MS);
    await this.state.storage.setAlarm(Date.now() + delay);
    await this.persist();
    await this.syncDirectory();
    this.broadcast();
  }

  registerReaction(participantId) {
    if (this.data.phase !== "armed" && this.data.phase !== "green") return false;
    if (!this.data.roundParticipantIds.includes(participantId)) return false;
    const p = this.data.participants.find((pp) => pp.id === participantId);
    if (!p || p.reactionMs != null) return false;

    if (this.data.phase === "armed") {
      p.falseStart = true;
      p.reactionMs = REACTION_PENALTY_MS;
    } else {
      p.reactionMs = Date.now() - this.data.greenAt;
    }
    return true;
  }

  isReactionRoundComplete() {
    return this.data.roundParticipantIds.every((id) => {
      const p = this.data.participants.find((pp) => pp.id === id);
      return !p || !p.connected || p.reactionMs != null;
    });
  }

  async alarmReaction() {
    if (this.data.phase === "armed") {
      this.data.phase = "green";
      this.data.greenAt = Date.now();
      await this.state.storage.setAlarm(Date.now() + REACTION_TIMEOUT_MS);
      await this.persist();
      await this.syncDirectory();
      this.broadcast();
    } else if (this.data.phase === "green") {
      await this.finishReaction();
    }
  }

  async finishReaction() {
    if (this.data.phase !== "armed" && this.data.phase !== "green") return;
    await this.state.storage.deleteAlarm();
    this.data.phase = "finished";

    let worstId = null;
    let worstMs = -Infinity;
    for (const id of this.data.roundParticipantIds) {
      const p = this.data.participants.find((pp) => pp.id === id);
      if (!p) continue;
      const ms = p.reactionMs != null ? p.reactionMs : REACTION_PENALTY_MS;
      if (ms > worstMs) {
        worstMs = ms;
        worstId = id;
      }
    }
    this.data.loserId = worstId;

    await this.persist();
    await this.syncDirectory();
    await this.reportLoss();
    this.broadcast();
  }

  // ---------- timesense ----------

  allConnectedAnswered() {
    const connectedIds = this.data.participants.filter((p) => p.connected).map((p) => p.id);
    if (!connectedIds.length) return false;
    const answered = new Set(this.data.answers.map((a) => a.id));
    return connectedIds.every((id) => answered.has(id));
  }

  async startTimesenseRound() {
    this.data.targetSeconds = TS_MIN_SECONDS + Math.floor(Math.random() * (TS_MAX_SECONDS - TS_MIN_SECONDS + 1));
    this.data.roundStartAt = Date.now();
    this.data.answers = [];
    this.data.phase = "playing";
    const timeoutMs = this.data.targetSeconds * 1000 + TS_TIMEOUT_EXTRA_MS;
    await this.state.storage.setAlarm(this.data.roundStartAt + timeoutMs);
    await this.persist();
    await this.syncDirectory();
    this.broadcast();
  }

  async alarmTimesense() {
    if (this.data.phase !== "playing") return;
    const answered = new Set(this.data.answers.map((a) => a.id));
    for (const p of this.data.participants) {
      if (p.connected && !answered.has(p.id)) {
        this.data.answers.push({ id: p.id, diffSeconds: null, missed: true });
      }
    }
    this.data.phase = "result";
    await this.persist();
    await this.syncDirectory();
    this.broadcast();
  }

  // ---------- shared ----------

  async alarm() {
    await this.ready;
    if (this.data.gameType === "reaction") {
      await this.alarmReaction();
    } else if (this.data.gameType === "timesense") {
      await this.alarmTimesense();
    } else {
      await this.alarmBomb();
    }
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
    const holderId =
      this.data.gameType === "bomb" && this.data.phase === "playing" ? this.data.order[this.data.currentIndex] : null;

    for (const [ws, pid] of this.sockets) {
      const p = this.data.participants.find((pp) => pp.id === pid);
      const canReact =
        this.data.gameType === "reaction" &&
        (this.data.phase === "armed" || this.data.phase === "green") &&
        this.data.roundParticipantIds.includes(pid) &&
        !!p &&
        p.reactionMs == null;

      const payload = {
        type: "state",
        name: this.data.name,
        gameType: this.data.gameType,
        phase: this.data.phase,
        hostId: this.data.hostId,
        participants: this.data.participants,
        currentHolderId: holderId,
        loserId: this.data.loserId,
        targetSeconds: this.data.targetSeconds,
        roundStartAt: this.data.roundStartAt,
        answers: this.data.answers,
        you: {
          id: pid,
          isHost: pid === this.data.hostId,
          canPass: this.data.gameType === "bomb" && this.data.phase === "playing" && holderId === pid,
          canReact,
          answered: this.data.answers.some((a) => a.id === pid),
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
