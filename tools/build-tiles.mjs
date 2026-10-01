/* Score the downloaded tiles (osm/*.json, from fetch-tile.mjs) into site/data/tiles/ + site/data/index.json.
 *
 * Each tile is scored with a margin of its neighbours' roads, so a pass crossing a tile edge is seen whole; a road
 * then belongs to the tile holding its middle. Same engine as the browser scanner (site/core/twisty.js). Needs Node 20+.
 */
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { ALGO_VERSION, findTwisties, Terrain, TERRAIN_URL, terrariumToMetres } from "../site/core/twisty.js";
import { decodePNG } from "./png.mjs";
import { neighbours, ownsRoad, padBbox, tileBbox, touches } from "./tiles.mjs";

const root = new URL("../", import.meta.url);
const region = JSON.parse(await readFile(new URL("tools/region.json", root), "utf8"));
const headers = { "User-Agent": "twisty-roads (https://github.com/vehiculardesire/twisty-roads)" };
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

// every tile must be there: a missing one would silently drop its roads (and its neighbours' edges)
const osm = async (key) => JSON.parse(await readFile(new URL(`osm/${key}.json`, root), "utf8"));
for (const key of region.tiles) await access(new URL(`osm/${key}.json`, root));

const terrain = new Terrain(async (z, x, y) => {
  const r = await fetch(TERRAIN_URL(z, x, y), { headers });
  if (!r.ok) throw new Error(`terrain ${r.status}`);
  return terrariumToMetres(decodePNG(new Uint8Array(await r.arrayBuffer()), inflateSync).rgba);
});

const out = new URL("site/data/tiles/", root);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const index = { version: ALGO_VERSION, generated: new Date().toISOString().slice(0, 10), start: region.start, tiles: [], ids: {} };

for (const key of region.tiles) {
  const box = tileBbox(key), padded = padBbox(box, region.pad);
  const elements = new Map();
  for (const k of neighbours(key).filter((k) => region.tiles.includes(k))) {
    for (const el of await osm(k)) if (touches(padded, el)) elements.set(`${el.type}/${el.id}`, el);
  }
  let lastLog = 0;
  const found = await findTwisties([...elements.values()], box, terrain, {
    maxRoads: region.maxRoadsPerTile * 2,
    onProgress: (m) => { if (Date.now() - lastLog > 10000) { log(`  ${key}: ${m}`); lastLog = Date.now(); } },
  });
  const roads = found.roads.filter((r) => ownsRoad(box, r) && r.score >= region.minScore).slice(0, region.maxRoadsPerTile);
  await writeFile(new URL(`${key}.json`, out), JSON.stringify({ version: ALGO_VERSION, key, bbox: box, roads, passes: found.passes }));
  index.tiles.push({ key, bbox: box, roads: roads.length });
  index.ids[key] = roads.map((r) => r.id).join(",");
  log(`${key}: ${roads.length} roads, ${found.passes.length} passes; best ${roads.slice(0, 3).map((r) => `${r.name} ${r.score}`).join(", ")}`);
  terrain.tiles.clear();                                  // keep memory flat; neighbours re-load their own
}
await writeFile(new URL("site/data/index.json", root), JSON.stringify(index));
log(`wrote ${index.tiles.length} tiles, ${index.tiles.reduce((a, t) => a + t.roads, 0)} roads`);
