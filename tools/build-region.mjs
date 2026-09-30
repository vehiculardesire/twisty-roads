/* Pre-build the home region so the site opens instantly: node tools/build-region.mjs
 *
 * Runs the same engine as the browser scanner (site/core/twisty.js) over a grid of cells, so each
 * Overpass query stays small. Run monthly by .github/workflows/refresh-data.yml. Needs Node 20+.
 * If any cell fails the script exits non-zero and the old data stays in place.
 */
import { readFile, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { ALGO_VERSION, fetchOverpass, findTwisties, Terrain, TERRAIN_URL, terrariumToMetres } from "../site/core/twisty.js";
import { decodePNG } from "./png.mjs";

const root = new URL("../", import.meta.url);
const region = JSON.parse(await readFile(new URL("tools/region.json", root), "utf8"));
const headers = { "User-Agent": "twisty-roads (https://github.com/vehiculardesire/twisty-roads)" };
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

const [S, W, N, E] = region.bbox, step = region.cellDeg;
const cells = [];
for (let lat = S; lat < N - 1e-9; lat += step) {
  for (let lon = W; lon < E - 1e-9; lon += step) cells.push([lat, lon, Math.min(lat + step, N), Math.min(lon + step, E)]);
}

const elements = new Map();
for (const [i, cell] of cells.entries()) {
  const t = Date.now();
  const els = await fetchOverpass(cell, { headers, attempts: 15, onProgress: (m) => m.includes("busy") && log(`  ${m}`) });
  for (const el of els) elements.set(`${el.type}/${el.id}`, el);
  log(`cell ${i + 1}/${cells.length}: ${els.length} elements in ${Math.round((Date.now() - t) / 1000)}s`);
  await new Promise((r) => setTimeout(r, 3000));          // be polite to the public Overpass servers
}

const terrain = new Terrain(async (z, x, y) => {
  const r = await fetch(TERRAIN_URL(z, x, y), { headers });
  if (!r.ok) throw new Error(`terrain ${r.status}`);
  return terrariumToMetres(decodePNG(new Uint8Array(await r.arrayBuffer()), inflateSync).rgba);
});

let lastLog = 0;
const { roads, passes } = await findTwisties([...elements.values()], region.bbox, terrain, {
  maxRoads: region.maxRoads,
  onProgress: (m) => { if (Date.now() - lastLog > 5000 || !m.startsWith("Loading")) { log(m); lastLog = Date.now(); } },
});

const out = { version: ALGO_VERSION, generated: new Date().toISOString().slice(0, 10), bbox: region.bbox, roads, passes };
await writeFile(new URL(region.out, root), JSON.stringify(out));
log(`wrote ${roads.length} roads, ${passes.length} passes to ${region.out}`);
for (const r of roads.slice(0, 15)) log(`  ${String(r.score).padStart(3)}  ${r.name}  (${(r.len / 1000).toFixed(1)} km, ${r.hairpins} hairpins)`);
