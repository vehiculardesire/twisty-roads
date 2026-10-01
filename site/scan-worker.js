/* Module worker: scan a bbox for twisty roads in the browser.
 * in:  { bbox: [south, west, north, east], maxRoads }
 * out: { type: "progress", msg } ... then { type: "done", roads, passes, missing } or { type: "error", message }
 *
 * Roads are downloaded in squares on a fixed grid and kept in the browser, so a bigger or overlapping scan only
 * downloads the squares it doesn't have yet. Terrain tiles never change, so they're kept too.
 */
import { fetchOverpass, findTwisties, Terrain, TERRAIN_URL, terrariumToMetres } from "./core/twisty.js";
import { idb } from "./db.js";

const progress = (msg) => postMessage({ type: "progress", msg });
const GRID = 0.25;                     // degrees: squares of about 28 x 20 km
const PIECE = [3, 4];                  // at most this many squares (rows, columns) per download, ~80 km a side
const FRESH = 90 * 864e5;              // re-download squares older than this
const KEEP = 160;                      // squares kept in the browser (a few hundred MB at most); oldest go first
const OSM_V = 1;                       // bump if what's stored per square changes

const terrain = new Terrain(async (z, x, y) => {
  const url = TERRAIN_URL(z, x, y);
  const cache = await caches.open("terrain-v1").catch(() => null);
  let r = await cache?.match(url);
  if (!r) {
    r = await fetch(url);
    if (!r.ok) throw new Error(`terrain ${r.status}`);
    cache?.put(url, r.clone()).catch(() => {});
  }
  const bmp = await createImageBitmap(await r.blob());
  const ctx = new OffscreenCanvas(256, 256).getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return terrariumToMetres(ctx.getImageData(0, 0, 256, 256).data);
});

// ------------------------------------------------------------------ grid squares, stored compactly

const cellOf = (lat, lon) => `${Math.floor(lat / GRID)}_${Math.floor(lon / GRID)}`;
const slim = (el) => (el.type === "way"
  ? { type: "way", id: el.id, nodes: el.nodes, tags: el.tags, g: el.geometry.flatMap((p) => [p.lat, p.lon]) }
  : { type: el.type, id: el.id, lat: el.lat, lon: el.lon, tags: el.tags });
function unslim(el) {
  if (!el.g) return el;
  const geometry = [];
  for (let i = 0; i < el.g.length; i += 2) geometry.push({ lat: el.g[i], lon: el.g[i + 1] });
  return { type: "way", id: el.id, nodes: el.nodes, tags: el.tags, geometry };
}

/** Which squares an element lies in (a way can cross several). */
function cellsOfElement(el) {
  if (el.type !== "way") return [cellOf(el.lat, el.lon)];
  return [...new Set((el.geometry || []).map((p) => cellOf(p.lat, p.lon)))];
}

const touches = ([s, w, n, e], el) => {
  const inside = (lat, lon) => lat >= s && lat <= n && lon >= w && lon <= e;
  return el.type === "way" ? (el.geometry || []).some((p) => inside(p.lat, p.lon)) : inside(el.lat, el.lon);
};

/** Group the missing squares into downloads of at most PIECE squares, each shrunk to the squares it needs. */
function pieces(missing) {
  const byBlock = new Map();
  for (const k of missing) {
    const [i, j] = k.split("_").map(Number), b = `${Math.floor(i / PIECE[0])}_${Math.floor(j / PIECE[1])}`;
    if (!byBlock.has(b)) byBlock.set(b, []);
    byBlock.get(b).push([i, j]);
  }
  return [...byBlock.values()].map((ij) => {
    const is = ij.map(([i]) => i), js = ij.map(([, j]) => j);
    const [i0, i1, j0, j1] = [Math.min(...is), Math.max(...is), Math.min(...js), Math.max(...js)];
    const keys = [];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) keys.push(`${i}_${j}`);
    return { bbox: [i0 * GRID, j0 * GRID, (i1 + 1) * GRID, (j1 + 1) * GRID], keys };
  });
}

/** All elements in the bbox, and how many pieces couldn't be downloaded (a scan keeps what it got). */
async function download(bbox) {
  const [s, w, n, e] = bbox, want = [];
  for (let i = Math.floor(s / GRID); i <= Math.floor(n / GRID); i++) {
    for (let j = Math.floor(w / GRID); j <= Math.floor(e / GRID); j++) want.push(`${i}_${j}`);
  }
  const meta = await idb("osmMeta", "getAll").catch(() => []);
  const fresh = new Set(meta.filter((m) => m.v === OSM_V && Date.now() - m.date < FRESH).map((m) => m.key));
  const have = want.filter((k) => fresh.has(k)), todo = pieces(want.filter((k) => !fresh.has(k)));

  const elements = new Map();
  const add = (els) => { for (const el of els) elements.set(`${el.type}/${el.id}`, el); };   // roads on a square edge come twice
  for (const k of have) {
    const rec = await idb("osm", "get", k).catch(() => null);
    if (rec) add(rec.els.map(unslim)); else todo.push(...pieces([k]));
  }

  let done = 0, missing = 0;
  const reused = have.length ? `, ${have.length} of ${want.length} map squares already here` : "";
  const status = () => progress(todo.length
    ? `Downloading roads from OpenStreetMap… ${done}/${todo.length} piece${todo.length > 1 ? "s" : ""}${reused}`
    : "Using the roads you've already downloaded…");
  status();
  const one = async (piece) => {
    try {
      const els = await fetchOverpass(piece.bbox, { attempts: todo.length > 1 ? 6 : 9, onProgress: (m) => m.includes("busy") && progress(m) });
      add(els);
      // file each element under every square it touches, then save the squares
      const bySquare = new Map(piece.keys.map((k) => [k, []]));
      for (const el of els) for (const k of cellsOfElement(el)) bySquare.get(k)?.push(slim(el));
      for (const [key, list] of bySquare) {
        await idb("osm", "put", { key, els: list }).catch(() => {});
        await idb("osmMeta", "put", { key, v: OSM_V, date: Date.now() }).catch(() => {});
      }
    } catch { missing++; }
    done++;
    status();
  };
  for (let i = 0; i < todo.length; i += 2) await Promise.all(todo.slice(i, i + 2).map(one));   // two at a time, to be polite
  if (todo.length && missing === todo.length && !have.length) {
    throw new Error("The OpenStreetMap servers are busy right now. Try again in a minute.");
  }
  forgetOld().catch(() => {});
  return { elements: [...elements.values()].filter((el) => touches(bbox, el)), missing };
}

/** Keep the browser's copy bounded: drop stale squares and the oldest beyond KEEP. */
async function forgetOld() {
  const meta = (await idb("osmMeta", "getAll")).sort((a, b) => b.date - a.date);
  for (const [i, m] of meta.entries()) {
    if (i < KEEP && m.v === OSM_V && Date.now() - m.date < FRESH) continue;
    await idb("osm", "delete", m.key);
    await idb("osmMeta", "delete", m.key);
  }
}

self.onmessage = async ({ data }) => {
  try {
    const { elements, missing } = await download(data.bbox);
    postMessage({ type: "done", missing, ...(await findTwisties(elements, data.bbox, terrain, { maxRoads: data.maxRoads, onProgress: progress })) });
  } catch (e) {
    postMessage({ type: "error", message: e.message });
  }
};
