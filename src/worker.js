import listHtml from "../public/list.html";
import roomHtml from "../public/room.html";
import rankingHtml from "../public/ranking.html";

//.gg

export { GameRoom } from "./durable-objects/gameRoom.js";
export { Directory } from "./durable-objects/directory.js";
export { Leaderboard } from "./durable-objects/leaderboard.js";

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
    if (/^\/r\/[A-Za-z0-9]+$/.test(pathname)) return html(roomHtml);

    if (pathname === "/api/rooms" && request.method === "GET") {
      const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
      return dir.fetch("https://directory/list");
    }

    if (pathname === "/api/leaderboard" && request.method === "GET") {
      const lb = env.LEADERBOARD.get(env.LEADERBOARD.idFromName("global"));
      return lb.fetch("https://leaderboard/current");
    }

    if (pathname === "/api/rooms" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const name = (body.name || "").toString().trim().slice(0, 30) || "이름 없는 방";
      const id = randomRoomId();
      const room = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(id));
      await room.fetch("https://room/init", {
        method: "POST",
        body: JSON.stringify({ id, name }),
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
};
