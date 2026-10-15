const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const PRUNE_AFTER_MS = 60 * DAY_MS; // keep ~60 days of history
const PRUNE_INTERVAL_MS = DAY_MS;
const MAX_RANGE_DAYS = 60; // nothing older than the prune horizon survives
const DEFAULT_RANGE_DAYS = 7;

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

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

  // Every finished game writes exactly one loss, so these counts double as how
  // often each game was actually played.
  tally(start, end) {
    const byPerson = new Map();
    const byGame = {};
    for (const e of this.events) {
      if (e.ts < start || e.ts >= end) continue;
      const entry = byPerson.get(e.deviceId) || { name: e.name, count: 0, games: {} };
      entry.count += 1;
      entry.name = e.name;
      // events recorded before gameType was captured have none
      const game = e.gameType || 'unknown';
      entry.games[game] = (entry.games[game] || 0) + 1;
      byGame[game] = (byGame[game] || 0) + 1;
      byPerson.set(e.deviceId, entry);
    }
    const entries = Array.from(byPerson.values()).sort((a, b) => b.count - a.count).slice(0, 20);
    return {
      entries,
      totalExplosions: entries.reduce((sum, e) => sum + e.count, 0),
      byGame,
    };
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

    // The report is keyed by week, and this object already owns the KST week
    // boundary, so it stores the text rather than the caller recomputing it.
    if (url.pathname === '/report' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const text = (body.text || '').toString().slice(0, 4000);
      if (!text) return new Response('empty', { status: 400 });
      await this.state.storage.put('report:' + weekStart(Date.now()), {
        text,
        generatedAt: Date.now(),
      });
      return new Response('ok');
    }

    if (url.pathname === '/current') {
      const now = Date.now();
      const start = weekStart(now);
      const end = start + WEEK_MS;
      const report = (await this.state.storage.get('report:' + start)) || null;
      return json({
        ...this.tally(start, end),
        report,
        rangeLabel: formatKstDate(start) + ' ~ ' + formatKstDate(end - DAY_MS),
      });
    }

    // Arbitrary trailing window, for questions the weekly view can't answer —
    // a single week is often only a handful of games. Capped at the prune
    // horizon since nothing older than that survives anyway.
    if (url.pathname === '/range') {
      // An absent param reads as null, and Number(null) is 0 — without the
      // truthiness check that silently becomes a one day window.
      const raw = url.searchParams.get('days');
      const parsed = Math.floor(Number(raw));
      const asked = raw && Number.isFinite(parsed) ? parsed : DEFAULT_RANGE_DAYS;
      const days = Math.min(MAX_RANGE_DAYS, Math.max(1, asked));
      const end = Date.now();
      const start = end - days * DAY_MS;
      return json({
        ...this.tally(start, end + 1),
        days,
        rangeLabel: formatKstDate(start) + ' ~ ' + formatKstDate(end),
      });
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
