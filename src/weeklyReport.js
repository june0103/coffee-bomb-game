// Weekly report generation.
//
// Structured deliberately so that swapping the placeholder writer for a model
// call is a one-function change: collectWeeklyStats gathers the numbers,
// writeReport turns them into prose, and generateWeeklyReport wires the two to
// storage. Only writeReport should need to change.

const GAME_LABELS = {
  bomb: "폭탄 돌리기",
  reaction: "반응속도 게임",
  timesense: "시간 감각 게임",
  stopwatch: "콩콩팥팥",
  pirate: "러시안 룰렛",
  unknown: "기록 이전",
};

const TAG_LABELS = {
  korean: "한식",
  chinese: "중식",
  japanese: "일식",
  western: "양식",
  snack: "분식",
  etc: "기타",
};

const gameLabel = (id) => GAME_LABELS[id] || id;
const tagLabel = (id) => TAG_LABELS[id] || id;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function collectWeeklyStats(env) {
  const lb = env.LEADERBOARD.get(env.LEADERBOARD.idFromName("global"));
  const board = await (await lb.fetch("https://leaderboard/current")).json();

  const registry = env.RESTAURANTS.get(env.RESTAURANTS.idFromName("global"));
  const listed = await (await registry.fetch("https://restaurants/list")).json();
  const allPlaces = listed.places || [];

  // The registry is not week-scoped, so newly added places are filtered by hand.
  const since = Date.now() - WEEK_MS;
  const newPlaces = allPlaces
    .filter((p) => p.addedAt >= since)
    .map((p) => ({ name: p.name, tag: p.tag, rating: p.rating, reviewCount: p.reviewCount }));

  const ranked = allPlaces
    .filter((p) => p.ranked)
    .sort((a, b) => b.rating - a.rating || b.reviewCount - a.reviewCount)
    .slice(0, 3)
    .map((p) => ({ name: p.name, rating: p.rating, reviewCount: p.reviewCount }));

  // Places the team rates noticeably worse once it arrives by delivery.
  const deliveryGap = allPlaces
    .filter((p) => p.dineIn.count > 0 && p.delivery.count > 0 && p.dineIn.avg - p.delivery.avg >= 1)
    .map((p) => ({ name: p.name, dineIn: p.dineIn.avg, delivery: p.delivery.avg }));

  return {
    rangeLabel: board.rangeLabel,
    totalLosses: board.totalExplosions || 0,
    byGame: board.byGame || {},
    players: (board.entries || []).map((e) => ({ name: e.name, count: e.count, games: e.games || {} })),
    placeCount: allPlaces.length,
    newPlaces,
    topRated: ranked,
    deliveryGap,
  };
}

// Placeholder writer. Step 3 replaces the body with a Workers AI call; the
// signature and return value stay the same so nothing else has to move.
export function writeReport(stats) {
  const lines = [];

  if (!stats.totalLosses) {
    lines.push("이번 주는 아무도 지지 않았어요. 다들 바빴나 봅니다.");
  } else {
    const top = stats.players[0];
    lines.push(`이번 주 최다 당첨은 ${top.name}님 (${top.count}회).`);

    const spread = Object.entries(top.games)
      .sort((a, b) => b[1] - a[1])
      .map(([g, c]) => `${gameLabel(g)} ${c}회`)
      .join(", ");
    if (spread) lines.push(`  └ ${spread}`);

    const games = Object.entries(stats.byGame).sort((a, b) => b[1] - a[1]);
    if (games.length) {
      lines.push(`가장 많이 돌아간 게임은 ${gameLabel(games[0][0])} (${games[0][1]}회).`);
    }
    lines.push(`전체 ${stats.totalLosses}번의 내기가 있었습니다.`);
  }

  if (stats.newPlaces.length) {
    const names = stats.newPlaces.map((p) => `${p.name}(${tagLabel(p.tag)})`).join(", ");
    lines.push(`새로 등록된 맛집 ${stats.newPlaces.length}곳: ${names}`);
  }

  if (stats.topRated.length) {
    const t = stats.topRated[0];
    lines.push(`현재 1위 맛집은 ${t.name} — ★${t.rating.toFixed(1)} (리뷰 ${t.reviewCount}개).`);
  }

  for (const p of stats.deliveryGap) {
    lines.push(`${p.name}은 매장 ★${p.dineIn.toFixed(1)}인데 배달은 ★${p.delivery.toFixed(1)}. 가서 먹는 게 낫겠어요.`);
  }

  return lines.join("\n");
}

export async function generateWeeklyReport(env) {
  const stats = await collectWeeklyStats(env);
  const text = writeReport(stats);

  const lb = env.LEADERBOARD.get(env.LEADERBOARD.idFromName("global"));
  await lb.fetch("https://leaderboard/report", {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  return { text, stats };
}
