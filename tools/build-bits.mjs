/* Re-make the "best bits" list in site/data/index.json from the tiles already there, without downloading
 * anything: node tools/build-bits.mjs. (build-tiles.mjs does this too, as part of a full rebuild.) */
import { readFile, writeFile } from "node:fs/promises";
import { scoreRoad } from "../site/core/twisty.js";
import { bitEntry, topBits } from "./tiles.mjs";

const data = new URL("../site/data/", import.meta.url);
const index = JSON.parse(await readFile(new URL("index.json", data), "utf8"));
const entries = [];
for (const { key } of index.tiles) {
  const tile = JSON.parse(await readFile(new URL(`tiles/${key}.json`, data), "utf8"));
  for (const road of tile.roads) { const fx = scoreRoad(road); if (fx.bit) entries.push(bitEntry(road, key, fx)); }
}
index.bits = topBits(entries);
await writeFile(new URL("index.json", data), JSON.stringify(index));
console.log(`${index.bits.length} best bits; top: ${index.bits.slice(0, 5).map((b) => `${b.name} ${b.bit.score}`).join(", ")}`);
