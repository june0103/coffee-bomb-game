const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const PRUNE_AFTER_MS = 60 * 24 * 60 * 60 * 1000; // keep ~60 days of history
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function weekStart(ts) {
  const shifted = new Date(ts + KST_OFFSET_MS);
  const day = shifted.getUTCDay();
  const diffToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(shifted);
  monday.setUTCDate(shifted.getUTCDate() - diffToMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.getTime() - KST_OFFSET_MS;
}

function formatKstDate(ts) {
  const d = new Date(ts + KST_OFFSET_MS);
  return (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
}

export class Leaderboard {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.events = null;
  }

  async load() {
    if (this.events) return;
    this.events = (await this.state.storage.get('events')) || [];
  }

  async persist() {
    await this.state.storage.put('events', this.events);
  }

  async scheduleAlarm() {
    const existing = await this.state.storage.getAlarm();
    if (existing == null) await this.state.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
  }

  async fetch(request) {
    await this.load();
    const url = new URL(request.url);

    if (url.pathname === '/record' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (body.deviceId && body.name) {
        this.events.push({
          deviceId: body.deviceId.toString().slice(0, 64),
          name: body.name.toString().slice(0, 12),
          gameType: body.gameType ? body.gameType.toString().slice(0, 20) : null,
          ts: typeof body.ts === 'number' ? body.ts : Date.now(),
        });
        await this.persist();
        await this.scheduleAlarm();
      }
      return new Response('ok');
    }

    if (url.pathname === '/current') {
      const now = Date.now();
      const start = weekStart(now);
      const end = start + WEEK_MS;
      const tally = new Map();
      const byGame = {};
      for (const e of this.events) {
        if (e.ts < start || e.ts >= end) continue;
        const entry = tally.get(e.deviceId) || { name: e.name, count: 0, games: {} };
        entry.count += 1;
        entry.name = e.name;
        // events recorded before gameType was captured have none
        const game = e.gameType || 'unknown';
        entry.games[game] = (entry.games[game] || 0) + 1;
        byGame[game] = (byGame[game] || 0) + 1;
        tally.set(e.deviceId, entry);
      }
      const entries = Array.from(tally.values()).sort((a, b) => b.count - a.count).slice(0, 20);
      const totalExplosions = entries.reduce((sum, e) => sum + e.count, 0);
      return new Response(JSON.stringify({
        entries,
        totalExplosions,
        byGame,
        rangeLabel: formatKstDate(start) + ' ~ ' + formatKstDate(end - 24 * 60 * 60 * 1000),
      }), { headers: { 'content-type': 'application/json; charset=utf-8' } });
    }

    return new Response('not found', { status: 404 });
  }

  async alarm() {
    await this.load();
    const cutoff = Date.now() - PRUNE_AFTER_MS;
    const before = this.events.length;
    this.events = this.events.filter((e) => e.ts >= cutoff);
    if (this.events.length !== before) await this.persist();
    await this.scheduleAlarm();
  }
}
