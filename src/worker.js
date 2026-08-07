import listHtml from "../public/list.html";
import roomHtml from "../public/room.html";
import rankingHtml from "../public/ranking.html";
import placesHtml from "../public/places.html";
import placeHtml from "../public/place.html";

import { generateWeeklyReport } from "./weeklyReport.js";

//.gg

export { GameRoom } from "./durable-objects/gameRoom.js";
export { Directory } from "./durable-objects/directory.js";
export { Leaderboard } from "./durable-objects/leaderboard.js";
export { Restaurants } from "./durable-objects/restaurants.js";

const ROOM_ID_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid mix-ups

function randomRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  let id = "";
  for (const b of bytes) id += ROOM_ID_CHARS[b % ROOM_ID_CHARS.length];
  return id;
}

function html(body) {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/") return html(listHtml);
    if (pathname === "/ranking") return html(rankingHtml);
    if (pathname === "/places") return html(placesHtml);
    if (/^\/places\/\d+$/.test(pathname)) return html(placeHtml);
    if (/^\/r\/[A-Za-z0-9]+$/.test(pathname)) return html(roomHtml);

    if (pathname === "/api/rooms" && request.method === "GET") {
      const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
      return dir.fetch("https://directory/list");
    }

    if (pathname === "/api/leaderboard" && request.method === "GET") {
      const lb = env.LEADERBOARD.get(env.LEADERBOARD.idFromName("global"));
      return lb.fetch("https://leaderboard/current");
    }

    // Manual rerun for when the weekly cron misses a run. Unauthenticated,
    // which is fine while the report is generated locally — add a guard before
    // wiring this to a model call so it can't be used to burn the daily quota.
    if (pathname === "/api/report/regenerate" && request.method === "POST") {
      try {
        const { text } = await generateWeeklyReport(env);
        return json({ ok: true, text });
      } catch (err) {
        return json({ ok: false, error: String(err) }, { status: 500 });
      }
    }

    // Restaurant search, proxied so the Kakao key stays server-side.
    // Results are relayed live and never stored — Kakao's operating policy
    // forbids caching or persisting them.
    if (pathname === "/api/places/search" && request.method === "GET") {
      const q = (url.searchParams.get("q") || "").trim();
      if (q.length < 2) return json({ places: [] });
      if (!env.KAKAO_REST_KEY) return json({ error: "kakao_key_missing" }, { status: 500 });

      const kakaoUrl = new URL("https://dapi.kakao.com/v2/local/search/keyword.json");
      kakaoUrl.searchParams.set("query", q);
      kakaoUrl.searchParams.set("category_group_code", "FD6"); // 음식점만
      kakaoUrl.searchParams.set("size", "10");
      // Centre on the office and sort by distance, so the nearest branch of a
      // chain comes first instead of an unrelated one across the country.
      if (env.OFFICE_LAT && env.OFFICE_LNG) {
        kakaoUrl.searchParams.set("x", env.OFFICE_LNG);
        kakaoUrl.searchParams.set("y", env.OFFICE_LAT);
        kakaoUrl.searchParams.set("radius", env.OFFICE_RADIUS_M || "800");
        kakaoUrl.searchParams.set("sort", "distance");
      }

      const res = await fetch(kakaoUrl, {
        headers: { Authorization: `KakaoAK ${env.KAKAO_REST_KEY}` },
      });
      if (!res.ok) {
        // surface the status only — the response body can echo the key back
        return json({ error: "kakao_error", status: res.status }, { status: 502 });
      }

      const data = await res.json();
      // When a keyword matches no 음식점, Kakao pads the response with unrelated
      // places (searching "스타벅스" returns 양평해장국). Keep only rows the query
      // actually shows up in — the category is checked too so dish-name searches
      // like "김치찌개" still match restaurants that aren't named after the dish.
      const needle = q.replace(/\s+/g, "").toLowerCase();
      const matches = (text) => (text || "").replace(/\s+/g, "").toLowerCase().includes(needle);

      const places = (data.documents || [])
        .map((d) => ({
          id: d.id,
          name: d.place_name,
          category: d.category_name,
          address: d.road_address_name || d.address_name,
          placeUrl: d.place_url,
          distance: d.distance ? Number(d.distance) : null, // metres from the office
        }))
        .filter((p) => matches(p.name) || matches(p.category));
      return json({ places });
    }

    // Restaurant registry. Kakao place ids are numeric, so this pattern can
    // never swallow the /api/places/search route above.
    if (pathname.startsWith("/api/places")) {
      const registry = env.RESTAURANTS.get(env.RESTAURANTS.idFromName("global"));

      if (pathname === "/api/places" && request.method === "GET") {
        return registry.fetch("https://restaurants/list");
      }

      if (pathname === "/api/places" && request.method === "POST") {
        return registry.fetch("https://restaurants/place", {
          method: "POST",
          body: await request.text(),
        });
      }

      const detailMatch = pathname.match(/^\/api\/places\/(\d+)$/);
      if (detailMatch && request.method === "GET") {
        return registry.fetch("https://restaurants/place?id=" + detailMatch[1]);
      }

      const reviewMatch = pathname.match(/^\/api\/places\/(\d+)\/review$/);
      if (reviewMatch && (request.method === "PUT" || request.method === "DELETE")) {
        const body = await request.json().catch(() => ({}));
        return registry.fetch("https://restaurants/review", {
          method: request.method,
          body: JSON.stringify({ ...body, placeId: reviewMatch[1] }),
        });
      }
    }

    if (pathname === "/api/rooms" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const name = (body.name || "").toString().trim().slice(0, 30) || "이름 없는 방";
      const gameType = (body.gameType || "").toString();
      const id = randomRoomId();
      const room = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(id));
      await room.fetch("https://room/init", {
        method: "POST",
        body: JSON.stringify({ id, name, gameType }),
      });
      return json({ id });
    }

    const wsMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/ws$/);
    if (wsMatch) {
      const room = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(wsMatch[1]));
      return room.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },

  // Weekly report batch. A failure here must never surface to visitors, so it
  // is logged and swallowed — the ranking page simply shows no report.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      generateWeeklyReport(env).catch((err) => {
        console.error("weekly report failed", err);
      }),
    );
  },
};
