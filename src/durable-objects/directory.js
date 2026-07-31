const PRUNE_AFTER_MS = 6 * 60 * 60 * 1000; // drop rooms older than 6h
const PRUNE_INTERVAL_MS = 30 * 60 * 1000;

export class Directory {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = null;
  }

  async load() {
    if (this.rooms) return;
    const stored = await this.state.storage.get("rooms");
    this.rooms = new Map(stored || []);
  }

  async persist() {
    await this.state.storage.put("rooms", Array.from(this.rooms.entries()));
  }

  async prune() {
    const cutoff = Date.now() - PRUNE_AFTER_MS;
    let changed = false;
    for (const [id, room] of this.rooms) {
      if (room.createdAt < cutoff) {
        this.rooms.delete(id);
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  async scheduleAlarm() {
    const existing = await this.state.storage.getAlarm();
    if (existing == null) await this.state.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
  }

  async fetch(request) {
    await this.load();
    const url = new URL(request.url);

    if (url.pathname === "/list") {
      await this.prune();
      const rooms = Array.from(this.rooms.values()).sort((a, b) => b.createdAt - a.createdAt);
      return new Response(JSON.stringify({ rooms }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/upsert" && request.method === "POST") {
      const data = await request.json();
      this.rooms.set(data.id, data);
      await this.persist();
      await this.scheduleAlarm();
      return new Response("ok");
    }

    if (url.pathname === "/remove" && request.method === "POST") {
      const data = await request.json();
      this.rooms.delete(data.id);
      await this.persist();
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }

  async alarm() {
    await this.load();
    await this.prune();
    await this.scheduleAlarm();
  }
}
