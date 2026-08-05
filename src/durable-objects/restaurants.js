// Team restaurant registry: ratings and reviews the team writes itself.
//
// Only three fields ever come from Kakao — the place id, the name the user
// picked, and the kakaomap link. Addresses, coordinates and Kakao's own
// category strings are deliberately NOT stored: Kakao's operating policy
// requires those to be fetched live on every use. Categorisation is done with
// our own tags instead, which are user input and carry no such restriction.

const ORDER_TYPES = ["dine_in", "delivery"];
const TAGS = ["korean", "chinese", "japanese", "western", "snack", "etc"];

// A single 5-star review would otherwise top the chart, so a place needs this
// many reviews (both order types combined) before it can be ranked.
const MIN_REVIEWS_FOR_RANKING = 2;

const MAX_NAME_LEN = 60;
const MAX_TEXT_LEN = 300;

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
}

function emptyBuckets() {
  return { dine_in: { count: 0, sum: 0 }, delivery: { count: 0, sum: 0 } };
}

// Ranking uses the combined average, never per-type. Splitting the threshold by
// order type would leave one review in each bucket and the chart permanently empty.
function withStats(place) {
  const dineIn = place.buckets.dine_in;
  const delivery = place.buckets.delivery;
  const reviewCount = dineIn.count + delivery.count;
  const sum = dineIn.sum + delivery.sum;
  return {
    id: place.id,
    name: place.name,
    placeUrl: place.placeUrl,
    tag: place.tag,
    addedBy: place.addedBy,
    addedByName: place.addedByName,
    addedAt: place.addedAt,
    dineIn: { count: dineIn.count, avg: dineIn.count ? dineIn.sum / dineIn.count : null },
    delivery: { count: delivery.count, avg: delivery.count ? delivery.sum / delivery.count : null },
    reviewCount,
    rating: reviewCount ? sum / reviewCount : null,
    ranked: reviewCount >= MIN_REVIEWS_FOR_RANKING,
  };
}

export class Restaurants {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  placeKey(placeId) {
    return "place:" + placeId;
  }

  reviewKey(placeId, deviceId, orderType) {
    return "review:" + placeId + ":" + deviceId + ":" + orderType;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/list" && request.method === "GET") {
      const stored = await this.state.storage.list({ prefix: "place:" });
      const places = Array.from(stored.values())
        .map(withStats)
        .sort((a, b) => b.addedAt - a.addedAt); // newest first; the client re-sorts
      return json({ places, minReviewsForRanking: MIN_REVIEWS_FOR_RANKING });
    }

    if (path === "/place" && request.method === "GET") {
      const placeId = url.searchParams.get("id") || "";
      const place = await this.state.storage.get(this.placeKey(placeId));
      if (!place) return json({ error: "not_found" }, { status: 404 });
      const stored = await this.state.storage.list({ prefix: "review:" + placeId + ":" });
      const reviews = Array.from(stored.values()).sort((a, b) => b.updatedAt - a.updatedAt);
      return json({ place: withStats(place), reviews });
    }

    // Get-or-create. The first reviewer of a place implicitly registers it, so
    // the client never has to distinguish "add" from "review".
    if (path === "/place" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const placeId = (body.placeId || "").toString().trim().slice(0, 32);
      const name = (body.name || "").toString().trim().slice(0, MAX_NAME_LEN);
      if (!placeId || !name) return json({ error: "bad_request" }, { status: 400 });

      const key = this.placeKey(placeId);
      let place = await this.state.storage.get(key);

      if (!place) {
        place = {
          id: placeId,
          name,
          placeUrl: (body.placeUrl || "").toString().slice(0, 200),
          tag: TAGS.includes(body.tag) ? body.tag : "etc",
          addedBy: (body.deviceId || "").toString().slice(0, 64),
          addedByName: (body.authorName || "").toString().trim().slice(0, 12),
          addedAt: Date.now(),
          buckets: emptyBuckets(),
        };
      } else {
        // Refresh the snapshot from whatever the user just picked in search, so a
        // renamed or relocated place doesn't stay stale forever.
        place.name = name;
        if (body.placeUrl) place.placeUrl = body.placeUrl.toString().slice(0, 200);
        if (TAGS.includes(body.tag)) place.tag = body.tag;
      }

      await this.state.storage.put(key, place);
      return json({ place: withStats(place) });
    }

    // One rating per person per order type — the key includes orderType, so the
    // same person can rate a place separately for dine-in and delivery.
    if (path === "/review" && request.method === "PUT") {
      const body = await request.json().catch(() => ({}));
      const placeId = (body.placeId || "").toString().trim().slice(0, 32);
      const deviceId = (body.deviceId || "").toString().trim().slice(0, 64);
      const orderType = (body.orderType || "").toString();
      const rating = Number(body.rating);

      if (!placeId || !deviceId || !ORDER_TYPES.includes(orderType)) {
        return json({ error: "bad_request" }, { status: 400 });
      }
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return json({ error: "bad_rating" }, { status: 400 });
      }

      const placeKey = this.placeKey(placeId);
      let place = await this.state.storage.get(placeKey);

      // A place comes into existence with its first rating, in this same DO
      // invocation. Registering it in a separate request would leave an orphan
      // whenever the follow-up rating never arrived — someone picking a place
      // and then closing the tab was exactly how empty places appeared.
      if (!place) {
        const name = (body.name || "").toString().trim().slice(0, MAX_NAME_LEN);
        if (!name) return json({ error: "place_info_required" }, { status: 400 });
        place = {
          id: placeId,
          name,
          placeUrl: (body.placeUrl || "").toString().slice(0, 200),
          tag: TAGS.includes(body.tag) ? body.tag : "etc",
          addedBy: deviceId,
          addedByName: (body.authorName || "").toString().trim().slice(0, 12),
          addedAt: Date.now(),
          buckets: emptyBuckets(),
        };
      }

      const reviewKey = this.reviewKey(placeId, deviceId, orderType);
      const existing = await this.state.storage.get(reviewKey);
      const bucket = place.buckets[orderType];

      // Aggregates are maintained on write: DO storage has no sort or sum query,
      // so recomputing an average on every read would mean scanning everything.
      if (existing) {
        bucket.sum += rating - existing.rating;
      } else {
        bucket.count += 1;
        bucket.sum += rating;
      }

      const now = Date.now();
      const review = {
        placeId,
        deviceId,
        orderType,
        rating,
        authorName: (body.authorName || "").toString().trim().slice(0, 12),
        // Omitting text keeps whatever was there. Defaulting it to "" would mean
        // changing a star silently wipes the comment that came with it.
        text:
          body.text !== undefined
            ? body.text.toString().trim().slice(0, MAX_TEXT_LEN)
            : existing
              ? existing.text || ""
              : "",
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
      };

      await this.state.storage.put(reviewKey, review);
      await this.state.storage.put(placeKey, place);
      return json({ place: withStats(place), review });
    }

    if (path === "/review" && request.method === "DELETE") {
      const body = await request.json().catch(() => ({}));
      const placeId = (body.placeId || "").toString().trim().slice(0, 32);
      const deviceId = (body.deviceId || "").toString().trim().slice(0, 64);
      const orderType = (body.orderType || "").toString();

      if (!placeId || !deviceId || !ORDER_TYPES.includes(orderType)) {
        return json({ error: "bad_request" }, { status: 400 });
      }

      const reviewKey = this.reviewKey(placeId, deviceId, orderType);
      const existing = await this.state.storage.get(reviewKey);
      if (!existing) return json({ error: "not_found" }, { status: 404 });

      await this.state.storage.delete(reviewKey);

      const placeKey = this.placeKey(placeId);

      // A place is registered implicitly by its first reviewer, so removing the
      // last review has to undo that too — otherwise a mistaken registration
      // leaves an empty place in the list that nobody can get rid of. Scanning
      // the remaining review keys rather than trusting the counters keeps this
      // from deleting a place that still has someone else's rating.
      const remaining = await this.state.storage.list({ prefix: "review:" + placeId + ":" });
      if (remaining.size === 0) {
        await this.state.storage.delete(placeKey);
        return json({ place: null, placeRemoved: true });
      }

      const place = await this.state.storage.get(placeKey);
      if (place) {
        const bucket = place.buckets[orderType];
        bucket.count = Math.max(0, bucket.count - 1);
        bucket.sum = bucket.count === 0 ? 0 : Math.max(0, bucket.sum - existing.rating);
        await this.state.storage.put(placeKey, place);
      }

      return json({ place: place ? withStats(place) : null, placeRemoved: false });
    }

    return new Response("not found", { status: 404 });
  }
}
