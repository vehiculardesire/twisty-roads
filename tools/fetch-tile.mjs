/* Download one tile's OpenStreetMap roads, passes, places and viewpoints: node tools/fetch-tile.mjs 45_6
 * Writes osm/45_6.json. Run per tile by .github/workflows/refresh-data.yml, then build-tiles.mjs does the rest.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fetchOverpass } from "../site/core/twisty.js";
import { cellsOf, tileBbox } from "./tiles.mjs";

const root = new URL("../", import.meta.url);
const region = JSON.parse(await readFile(new URL("tools/region.json", root), "utf8"));
const headers = { "User-Agent": "twisty-roads (https://github.com/vehiculardesire/twisty-roads)" };
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

const key = process.argv[2];
if (!region.tiles.includes(key)) throw new Error(`unknown tile ${key}`);
const cells = cellsOf(tileBbox(key), region.cellDeg);
const elements = new Map();
for (const [i, cell] of cells.entries()) {
  const t = Date.now();
  const els = await fetchOverpass(cell, { headers, attempts: 15, onProgress: (m) => m.includes("busy") && log(`  ${m}`) });
  for (const el of els) elements.set(`${el.type}/${el.id}`, el);
  log(`${key} cell ${i + 1}/${cells.length}: ${els.length} elements in ${Math.round((Date.now() - t) / 1000)}s`);
  await new Promise((r) => setTimeout(r, 3000));          // be polite to the public Overpass servers
}
await mkdir(new URL("osm/", root), { recursive: true });
await writeFile(new URL(`osm/${key}.json`, root), JSON.stringify([...elements.values()]));
log(`wrote osm/${key}.json: ${elements.size} elements`);
