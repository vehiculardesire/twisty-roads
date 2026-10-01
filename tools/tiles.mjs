/* Tile helpers shared by fetch-tile.mjs and build-tiles.mjs (no Node imports, so they also run in a browser). */

/** "45_6" -> [south, west, north, east] of that 1° tile. */
export const tileBbox = (key) => { const [lat, lon] = key.split("_").map(Number); return [lat, lon, lat + 1, lon + 1]; };

export const padBbox = ([s, w, n, e], pad) => [s - pad, w - pad, n + pad, e + pad];

/** Split a bbox into cells of about `deg` degrees, so each Overpass query stays small. */
export function cellsOf([s, w, n, e], deg) {
  const rows = Math.ceil((n - s) / deg - 1e-9), cols = Math.ceil((e - w) / deg - 1e-9), out = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      out.push([s + ((n - s) * i) / rows, w + ((e - w) * j) / cols, s + ((n - s) * (i + 1)) / rows, w + ((e - w) * (j + 1)) / cols]);
    }
  }
  return out;
}

const inside = ([s, w, n, e], lat, lon) => lat >= s && lat <= n && lon >= w && lon <= e;

/** Whether an Overpass element (a node, or a way with geometry) touches a bbox. */
export const touches = (box, el) => (el.type === "way" ? (el.geometry || []).some((p) => inside(box, p.lat, p.lon)) : inside(box, el.lat, el.lon));

/** The tile that owns a road: the one holding its middle point. */
export const ownsRoad = (box, road) => { const [lon, lat] = road.coords[road.coords.length >> 1]; return lat >= box[0] && lat < box[2] && lon >= box[1] && lon < box[3]; };

/** The tiles around a tile, itself included. */
export function neighbours(key) {
  const [lat, lon] = key.split("_").map(Number), out = [];
  for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) out.push(`${lat + dy}_${lon + dx}`);
  return out;
}

/** The "best bits" list in index.json: the best 5 km stretches across all tiles, so the site can rank the whole
 *  region without loading every tile. Each entry carries just enough to show it in the list. */
const BITS_KEPT = 300;
const r4 = (v) => +v.toFixed(4);
export function bitEntry(road, tile, fx) {
  const lons = road.coords.map((c) => c[0]), lats = road.coords.map((c) => c[1]);
  return {
    id: road.id, tile, name: road.name, road: road.road, from: road.from, to: road.to, len: road.len,
    hairpins: road.hairpins, eleMax: road.eleMax, pass: road.pass ? { name: road.pass.name } : null,
    bb: [r4(Math.min(...lons)), r4(Math.min(...lats)), r4(Math.max(...lons)), r4(Math.max(...lats))],
    score: fx.score, bit: fx.bit,
  };
}
export const topBits = (entries) => entries.sort((a, b) => b.bit.score - a.bit.score || b.score - a.score).slice(0, BITS_KEPT);
