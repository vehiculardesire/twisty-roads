/* Places to stop along a road: cafés, food, huts and fuel within 200 m, from OpenStreetMap (one query per road). */
import { overpassServers } from "./core/twisty.js";

const KINDS = [
  ["cafe", "☕", "Café"], ["restaurant", "🍽", "Restaurant"], ["fast_food", "🍔", "Snack"], ["ice_cream", "🍦", "Ice cream"],
  ["biergarten", "🍺", "Beer garden"], ["pub", "🍺", "Pub"], ["fuel", "⛽", "Fuel"], ["alpine_hut", "🏠", "Mountain hut"],
];
const cache = new Map();

/** [{ lon, lat, icon, kind, name }], cached per road. Throws if every server is busy. */
export async function findStops(road) {
  if (cache.has(road.id)) return cache.get(road.id);
  const step = Math.max(1, Math.ceil(road.coords.length / 120));      // keep the query short
  const line = road.coords.filter((_, i) => i % step === 0 || i === road.coords.length - 1)
    .map(([lo, la]) => `${la.toFixed(5)},${lo.toFixed(5)}`).join(",");
  const q = `[out:json][timeout:25];
(
  nwr(around:200,${line})["amenity"~"^(cafe|restaurant|fast_food|ice_cream|biergarten|pub|fuel)$"];
  nwr(around:200,${line})["tourism"="alpine_hut"];
);
out center 80;`;
  let data = null;
  const servers = await overpassServers();
  for (let attempt = 0; attempt < servers.length && !data; attempt++) {
    try {
      const r = await fetch(servers[attempt], { method: "POST", body: new URLSearchParams({ data: q }), signal: AbortSignal.timeout(60000) });
      if (r.ok) data = await r.json();
    } catch { /* next server */ }
  }
  if (!data) throw new Error("busy");
  const stops = data.elements.map((el) => {
    const t = el.tags || {};
    const [, icon, kind] = KINDS.find(([k]) => t.amenity === k || t.tourism === k) || [null, "📍", "Stop"];
    return { lon: el.lon ?? el.center?.lon, lat: el.lat ?? el.center?.lat, icon, kind, name: t.name || null };
  }).filter((s) => Number.isFinite(s.lon))
    // the same place is often mapped twice (a point and a building outline): keep one per name within ~100 m
    .filter((s, i, all) => !all.slice(0, i).some((o) => o.name && o.name === s.name && Math.abs(o.lat - s.lat) < 0.001 && Math.abs(o.lon - s.lon) < 0.0013));
  cache.set(road.id, stops);
  return stops;
}
