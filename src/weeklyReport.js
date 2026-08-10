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
    .map((p) => ({ name: p.name, 종류: tagLabel(p.tag), rating: round1(p.rating), reviewCount: p.reviewCount }));

  const ranked = allPlaces
    .filter((p) => p.ranked)
    .sort((a, b) => b.rating - a.rating || b.reviewCount - a.reviewCount)
    .slice(0, 3)
    .map((p) => ({ name: p.name, rating: round1(p.rating), reviewCount: p.reviewCount }));

  // Places the team rates noticeably worse once it arrives by delivery.
  const deliveryGap = allPlaces
    .filter((p) => p.dineIn.count > 0 && p.delivery.count > 0 && p.dineIn.avg - p.delivery.avg >= 1)
    .map((p) => ({ name: p.name, 매장: round1(p.dineIn.avg), 배달: round1(p.delivery.avg) }));

  // Field names are Korean and spell out what the number means. With a neutral
  // "count" the model read the tallies as wins and congratulated people for
  // losing — the data has to be unambiguous rather than the prompt compensating.
  return {
    기간: board.rangeLabel,
    총_당첨수: board.totalExplosions || 0,
    게임별_당첨수: relabelGames(board.byGame || {}),
    참가자별_당첨: (board.entries || []).map((e) => ({
      이름: e.name,
      당첨횟수: e.count,
      게임별: relabelGames(e.games || {}),
    })),
    등록된_맛집_총수: allPlaces.length,
    이번주_신규맛집: newPlaces,
    평점_상위: ranked,
    배달이_더_낮은집: deliveryGap,
  };
}

// Everything handed to the writer is already in Korean. Passing raw ids let the
// model invent its own names — "pirate" came back as 해적게임 rather than
// 러시안 룰렛 — so the labels are applied before the data ever leaves here.
function relabelGames(counts) {
  const out = {};
  for (const [id, n] of Object.entries(counts)) out[gameLabel(id)] = n;
  return out;
}

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

// Qwen handles Korean noticeably better than the Llama models on the catalogue,
// which matters here because the output is the entire deliverable.
const MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

// Reasoning models spend part of the budget on the think block, so this has to
// leave room for both that and the answer, or the report ends mid-sentence.
const MAX_TOKENS = 1200;

const SYSTEM_PROMPT = [
  "너는 사내 팀 게임·맛집 기록 앱의 주간 리포트를 쓰는 작성자다.",
  "주어진 집계 수치만으로 한국어 리포트를 쓴다.",
  "",
  "가장 중요한 규칙:",
  "- '당첨'은 게임에서 져서 커피를 사는 것이다. 이긴 게 절대 아니다.",
  "- 당첨 횟수를 승리, 우승, 완승, 성과처럼 표현하면 안 된다.",
  "- 당첨이 많은 사람은 그만큼 커피를 많이 산 사람이다.",
  "",
  "그 밖의 규칙:",
  "- 반드시 주어진 수치만 사용한다. 없는 사실을 지어내지 않는다.",
  "- 숫자를 바꾸거나 반올림하지 않는다.",
  "- 3~6줄. 한 줄에 한 가지 내용만 쓴다.",
  "- 가볍고 유쾌한 사내 공지 말투. 과한 이모지나 과장은 피한다.",
  "- 제목, 머리말, 마크다운 기호를 쓰지 않는다. 본문만 출력한다.",
  "- '기록 이전'은 집계 이전 데이터이므로 언급하지 않는다.",
].join("\n");

async function generateWithAI(env, stats) {
  if (!env.AI) return null;

  const res = await env.AI.run(MODEL, {
    max_tokens: MAX_TOKENS,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "이번 주 집계:\n" + JSON.stringify(stats, null, 2) },
    ],
  });

  const raw = (res && (res.response || res.result)) || "";
  return cleanModelText(raw);
}

// Reasoning models emit a <think> block before the answer, and several models
// pad line ends with the two spaces markdown uses for a break. Neither belongs
// in text that gets pasted into Slack.
export function cleanModelText(raw) {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<\/?think>/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length)
    .join("\n")
    .trim();
}

// Generation must never leave the week without a report, so a model failure
// falls back to the deterministic writer rather than surfacing an error.
export async function writeReport(env, stats) {
  try {
    const text = await generateWithAI(env, stats);
    if (text) return text;
    console.error("weekly report: model returned empty text");
  } catch (err) {
    console.error("weekly report: model call failed", err);
  }
  return writeFallbackReport(stats);
}

export function writeFallbackReport(stats) {
  const lines = [];

  if (!stats.총_당첨수) {
    lines.push("이번 주는 아무도 지지 않았어요. 다들 바빴나 봅니다.");
  } else {
    const top = stats.참가자별_당첨[0];
    lines.push(`이번 주 최다 당첨은 ${top.이름}님 (${top.당첨횟수}회).`);

    const spread = Object.entries(top.게임별)
      .sort((a, b) => b[1] - a[1])
      .map(([g, c]) => `${g} ${c}회`)
      .join(", ");
    if (spread) lines.push(`  └ ${spread}`);

    const games = Object.entries(stats.게임별_당첨수).sort((a, b) => b[1] - a[1]);
    if (games.length) {
      lines.push(`가장 많이 돌아간 게임은 ${games[0][0]} (${games[0][1]}회).`);
    }
    lines.push(`전체 ${stats.총_당첨수}번의 내기가 있었습니다.`);
  }

  if (stats.이번주_신규맛집.length) {
    const names = stats.이번주_신규맛집.map((p) => `${p.name}(${p.종류})`).join(", ");
    lines.push(`새로 등록된 맛집 ${stats.이번주_신규맛집.length}곳: ${names}`);
  }

  if (stats.평점_상위.length) {
    const t = stats.평점_상위[0];
    lines.push(`현재 1위 맛집은 ${t.name} — ★${t.rating.toFixed(1)} (리뷰 ${t.reviewCount}개).`);
  }

  for (const p of stats.배달이_더_낮은집) {
    lines.push(`${p.name}은 매장 ★${p.매장.toFixed(1)}인데 배달은 ★${p.배달.toFixed(1)}. 가서 먹는 게 낫겠어요.`);
  }

  return lines.join("\n");
}

export async function generateWeeklyReport(env) {
  const stats = await collectWeeklyStats(env);
  const text = await writeReport(env, stats);

  const lb = env.LEADERBOARD.get(env.LEADERBOARD.idFromName("global"));
  await lb.fetch("https://leaderboard/report", {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  return { text, stats };
}
