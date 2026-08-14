const MIN_FUSE_MS = 8000;
const MAX_FUSE_MS = 25000;

const REACTION_MIN_DELAY_MS = 2000;
const REACTION_MAX_DELAY_MS = 6000;
const REACTION_TIMEOUT_MS = 8000; // grace period after green before stragglers are force-finished
const REACTION_PENALTY_MS = 99999; // sentinel for a false start or a no-click — guaranteed "slowest"

const TS_MIN_SECONDS = 10;
const TS_MAX_SECONDS = 30;
const TS_TIMEOUT_EXTRA_MS = 10000;

const SEQ_TOTAL = 10;
const SEQ_PENALTY_MS = 3000; // added per wrong-number click, on top of real elapsed time
const SEQ_TIMEOUT_MS = 60000; // safety net so a stalled player can't hold the round open forever

// 러시안 룰렛. The gameType id stays "pirate" from when the game was named
// 해적 룰렛 — renaming it would strand rooms already holding the old value.
//
// The dud is equally likely to be anywhere, so a round lasts about half the
// slots. Scaling by headcount keeps that at roughly four turns each instead of
// ending in one lap once a few more people join. Rounded to a multiple of six
// so the grid has no ragged last row, and capped so it stays on one screen.
const RR_SLOTS_PER_PLAYER = 8;
const RR_MIN_SLOTS = 18;
const RR_MAX_SLOTS = 60;

function rouletteSlotCount(playerCount) {
  const raw = Math.max(RR_MIN_SLOTS, playerCount * RR_SLOTS_PER_PLAYER);
  return Math.min(RR_MAX_SLOTS, Math.ceil(raw / 6) * 6);
}

const GAME_TYPES = ["bomb", "reaction", "timesense", "stopwatch", "pirate", "sequence"];

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
      answers: [], // timesense: { id, diffSeconds, missed } | stopwatch: { id, digit1, digit2, score } | sequence: { id, elapsedSeconds, wrongClicks, missed }
      swProgress: {}, // stopwatch: participantId -> { startAt, digit1, digit2 }
      seqProgress: {}, // sequence: participantId -> { nextExpected, wrongClicks }
      trapSlot: null, // roulette: the dud — never leaves the server until it is hit
      stabbedSlots: [], // roulette: { slot, id } in the order they were picked
      slotCount: 0, // roulette: scales with the headcount at round start
    };
    if (!this.data.swProgress) this.data.swProgress = {};
    if (!this.data.seqProgress) this.data.seqProgress = {};
    if (!this.data.stabbedSlots) this.data.stabbedSlots = [];
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
        (this.data.gameType === "bomb" || this.data.gameType === "pirate") &&
        this.data.phase === "playing" &&
        this.data.order[this.data.currentIndex] === participantId
      ) {
        // don't let the round stall on someone who just dropped out mid-turn
        this.data.currentIndex = (this.data.currentIndex + 1) % this.data.order.length;
      } else if (
        (this.data.gameType === "timesense" || this.data.gameType === "stopwatch") &&
        this.data.phase === "playing"
      ) {
        if (this.allConnectedAnswered()) {
          this.data.phase = "result";
          await this.state.storage.deleteAlarm();
        }
      } else if (this.data.gameType === "sequence" && this.data.phase === "playing") {
        if (this.allConnectedAnswered()) {
          this.data.phase = "result";
          this.computeSequenceLoser();
          await this.state.storage.deleteAlarm();
          await this.reportLoss();
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
          if (connectedCount < 2) return;
          await this.startTimesenseRound();
        } else if (this.data.gameType === "stopwatch") {
          if (connectedCount < 2) return;
          await this.startStopwatchRound();
        } else if (this.data.gameType === "pirate") {
          if (connectedCount < 2) return;
          await this.startPirateRound();
        } else if (this.data.gameType === "sequence") {
          if (connectedCount < 2) return;
          await this.startSequenceRound();
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

      if (msg.type === "seqClick" && this.data.gameType === "sequence" && this.data.phase === "playing") {
        if (this.data.answers.some((a) => a.id === participantId)) return;
        const progress = this.data.seqProgress[participantId];
        if (!progress) return;
        const number = Number(msg.number);
        if (!Number.isInteger(number) || number < 1 || number > SEQ_TOTAL) return;

        if (number === progress.nextExpected) {
          progress.nextExpected += 1;
          if (progress.nextExpected > SEQ_TOTAL) {
            const elapsedSeconds =
              (Date.now() - this.data.roundStartAt) / 1000 + progress.wrongClicks * (SEQ_PENALTY_MS / 1000);
            this.data.answers.push({ id: participantId, elapsedSeconds, wrongClicks: progress.wrongClicks, missed: false });
            if (this.allConnectedAnswered()) {
              this.data.phase = "result";
              this.computeSequenceLoser();
              await this.state.storage.deleteAlarm();
              await this.reportLoss();
            }
          }
        } else {
          progress.wrongClicks += 1;
        }
        await this.persist();
        await this.syncDirectory();
        this.broadcast();
        return;
      }

      if (msg.type === "stab" && this.data.gameType === "pirate" && this.data.phase === "playing") {
        if (this.data.order[this.data.currentIndex] !== participantId) return;
        const slot = Number(msg.slot);
        if (!Number.isInteger(slot) || slot < 0 || slot >= this.data.slotCount) return;
        if (this.data.stabbedSlots.some((s) => s.slot === slot)) return;

        this.data.stabbedSlots.push({ slot, id: participantId });

        if (slot === this.data.trapSlot) {
          this.data.phase = "exploded";
          this.data.loserId = participantId;
          await this.persist();
          await this.syncDirectory();
          await this.reportLoss();
          this.broadcast();
          return;
        }

        this.data.currentIndex = (this.data.currentIndex + 1) % this.data.order.length;
        await this.persist();
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
        } else if (this.data.gameType === "stopwatch" && this.data.phase === "result") {
          await this.startStopwatchRound();
        } else if (this.data.gameType === "pirate" && this.data.phase === "exploded") {
          await this.startPirateRound();
        } else if (this.data.gameType === "sequence" && this.data.phase === "result") {
          await this.startSequenceRound();
        }
        return;
      }

      if (msg.type === "swStart" && this.data.gameType === "stopwatch" && this.data.phase === "playing") {
        if (this.data.answers.some((a) => a.id === participantId)) return;
        const progress = this.data.swProgress[participantId] || { startAt: null, digit1: null, digit2: null };
        if (progress.startAt || (progress.digit1 !== null && progress.digit2 !== null)) return;
        progress.startAt = Date.now();
        this.data.swProgress[participantId] = progress;
        await this.persist();
        this.broadcast();
        return;
      }

      if (msg.type === "swStop" && this.data.gameType === "stopwatch" && this.data.phase === "playing") {
        const progress = this.data.swProgress[participantId];
        if (!progress || !progress.startAt) return;
        const digit = (Date.now() - progress.startAt) % 10;
        progress.startAt = null;
        if (progress.digit1 === null) {
          progress.digit1 = digit;
        } else if (progress.digit2 === null) {
          progress.digit2 = digit;
        } else {
          return;
        }
        this.data.swProgress[participantId] = progress;

        if (progress.digit1 !== null && progress.digit2 !== null) {
          const score = progress.digit1 * progress.digit2;
          this.data.answers.push({ id: participantId, digit1: progress.digit1, digit2: progress.digit2, score });
          if (this.allConnectedAnswered()) {
            this.data.phase = "result";
          }
        }
        await this.persist();
        await this.syncDirectory();
        this.broadcast();
        return;
      }

      if (msg.type === "backToLobby" && participantId === this.data.hostId) {
        this.data.phase = "lobby";
        this.resetRoundState();
        await this.state.storage.deleteAlarm();
        await this.persist();
        await this.syncDirectory();
        this.broadcast();
        return;
      }

      if (msg.type === "changeGame" && participantId === this.data.hostId && this.data.phase === "lobby") {
        if (!GAME_TYPES.includes(msg.gameType) || msg.gameType === this.data.gameType) return;
        this.data.gameType = msg.gameType;
        this.resetRoundState();
        await this.persist();
        await this.syncDirectory();
        this.broadcast();
        return;
      }
    });
  }

  resetRoundState() {
    this.data.order = [];
    this.data.currentIndex = 0;
    this.data.roundParticipantIds = [];
    this.data.loserId = null;
    this.data.targetSeconds = null;
    this.data.roundStartAt = null;
    this.data.answers = [];
    this.data.swProgress = {};
    this.data.seqProgress = {};
    this.data.trapSlot = null;
    this.data.stabbedSlots = [];
    this.data.slotCount = 0;
    this.data.participants.forEach((p) => {
      p.reactionMs = null;
      p.falseStart = false;
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

  // ---------- stopwatch ----------

  async startStopwatchRound() {
    this.data.phase = "playing";
    this.data.answers = [];
    this.data.swProgress = {};
    await this.persist();
    await this.syncDirectory();
    this.broadcast();
  }

  // ---------- sequence ----------

  async startSequenceRound() {
    this.data.phase = "playing";
    this.data.roundStartAt = Date.now();
    this.data.answers = [];
    this.data.seqProgress = {};
    this.data.participants.forEach((p) => {
      if (p.connected) this.data.seqProgress[p.id] = { nextExpected: 1, wrongClicks: 0 };
    });
    await this.state.storage.setAlarm(this.data.roundStartAt + SEQ_TIMEOUT_MS);
    await this.persist();
    await this.syncDirectory();
    this.broadcast();
  }

  computeSequenceLoser() {
    let worstId = null;
    let worstSeconds = -Infinity;
    for (const a of this.data.answers) {
      const seconds = a.missed ? Infinity : a.elapsedSeconds;
      if (seconds > worstSeconds) {
        worstSeconds = seconds;
        worstId = a.id;
      }
    }
    this.data.loserId = worstId;
  }

  async alarmSequence() {
    if (this.data.phase !== "playing") return;
    const answered = new Set(this.data.answers.map((a) => a.id));
    for (const p of this.data.participants) {
      if (p.connected && !answered.has(p.id)) {
        const progress = this.data.seqProgress[p.id];
        this.data.answers.push({
          id: p.id,
          elapsedSeconds: null,
          wrongClicks: progress ? progress.wrongClicks : 0,
          missed: true,
        });
      }
    }
    this.data.phase = "result";
    this.computeSequenceLoser();
    await this.persist();
    await this.syncDirectory();
    await this.reportLoss();
    this.broadcast();
  }

  // ---------- pirate ----------

  async startPirateRound() {
    this.data.order = this.data.participants.filter((p) => p.connected).map((p) => p.id);
    this.data.currentIndex = Math.floor(Math.random() * this.data.order.length);
    this.data.slotCount = rouletteSlotCount(this.data.order.length);
    this.data.trapSlot = Math.floor(Math.random() * this.data.slotCount);
    this.data.stabbedSlots = [];
    this.data.loserId = null;
    this.data.phase = "playing";
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
    } else if (this.data.gameType === "bomb") {
      await this.alarmBomb();
    } else if (this.data.gameType === "sequence") {
      await this.alarmSequence();
    }
    // stopwatch and pirate never set an alarm; a leftover one must not explode them
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
        // which game it was — without this the weekly tally can only say how
        // often someone lost, not what they kept losing at
        gameType: this.data.gameType,
        ts: Date.now(),
      }),
    });
  }

  broadcast() {
    const holderId =
      (this.data.gameType === "bomb" || this.data.gameType === "pirate") && this.data.phase === "playing"
        ? this.data.order[this.data.currentIndex]
        : null;

    // The dud is the whole game — it stays on the server until it is hit,
    // otherwise anyone reading the socket frames could just avoid it.
    const isPirate = this.data.gameType === "pirate";
    const pirate = isPirate
      ? {
          totalSlots: this.data.slotCount,
          stabbedSlots: this.data.stabbedSlots,
          trapSlot: this.data.phase === "exploded" ? this.data.trapSlot : null,
        }
      : null;

    for (const [ws, pid] of this.sockets) {
      const p = this.data.participants.find((pp) => pp.id === pid);
      const canReact =
        this.data.gameType === "reaction" &&
        (this.data.phase === "armed" || this.data.phase === "green") &&
        this.data.roundParticipantIds.includes(pid) &&
        !!p &&
        p.reactionMs == null;
      const swProgress = this.data.swProgress[pid];
      const seqProgress = this.data.seqProgress[pid];

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
        pirate,
        you: {
          id: pid,
          isHost: pid === this.data.hostId,
          canPass: this.data.gameType === "bomb" && this.data.phase === "playing" && holderId === pid,
          canStab: isPirate && this.data.phase === "playing" && holderId === pid,
          canReact,
          answered: this.data.answers.some((a) => a.id === pid),
          sw:
            this.data.gameType === "stopwatch"
              ? {
                  running: !!(swProgress && swProgress.startAt),
                  digit1: swProgress ? swProgress.digit1 : null,
                  digit2: swProgress ? swProgress.digit2 : null,
                  done: this.data.answers.some((a) => a.id === pid),
                }
              : null,
          seq:
            this.data.gameType === "sequence"
              ? {
                  nextExpected: seqProgress ? seqProgress.nextExpected : null,
                  wrongClicks: seqProgress ? seqProgress.wrongClicks : 0,
                  done: this.data.answers.some((a) => a.id === pid),
                }
              : null,
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