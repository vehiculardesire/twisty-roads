/* Module worker: scan a bbox for twisty roads in the browser.
 * in:  { bbox: [south, west, north, east], maxRoads }
 * out: { type: "progress", msg } ... then { type: "done", roads, passes, missing } or { type: "error", message }
 */
import { fetchOverpass, findTwisties, Terrain, TERRAIN_URL, terrariumToMetres } from "./core/twisty.js";

const progress = (msg) => postMessage({ type: "progress", msg });
const CELL_KM = 70;   // big scans are split into pieces about the size of a 30 km scan, which the servers handle well

const terrain = new Terrain(async (z, x, y) => {
  const r = await fetch(TERRAIN_URL(z, x, y));
  if (!r.ok) throw new Error(`terrain ${r.status}`);
  const bmp = await createImageBitmap(await r.blob());
  const ctx = new OffscreenCanvas(256, 256).getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return terrariumToMetres(ctx.getImageData(0, 0, 256, 256).data);
});

function cells([s, w, n, e]) {
  const rows = Math.ceil(((n - s) * 111.32) / CELL_KM);
  const cols = Math.ceil(((e - w) * 111.32 * Math.cos((((s + n) / 2) * Math.PI) / 180)) / CELL_KM);
  const out = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      out.push([s + ((n - s) * i) / rows, w + ((e - w) * j) / cols, s + ((n - s) * (i + 1)) / rows, w + ((e - w) * (j + 1)) / cols]);
    }
  }
  return out;
}

/** All elements in the bbox, and how many pieces couldn't be downloaded (a big scan keeps what it got). */
async function download(bbox) {
  const todo = cells(bbox);
  if (todo.length === 1) return { elements: await fetchOverpass(bbox, { onProgress: progress }), missing: 0 };
  const elements = new Map();
  let done = 0, missing = 0;
  const one = async (cell) => {
    try {
      const els = await fetchOverpass(cell, { attempts: 6, onProgress: (m) => m.includes("busy") && progress(m) });
      for (const el of els) elements.set(`${el.type}/${el.id}`, el);   // roads crossing a cell edge come twice
    } catch { missing++; }
    progress(`Downloading roads from OpenStreetMap… ${++done}/${todo.length} pieces`);
  };
  progress(`Downloading roads from OpenStreetMap… 0/${todo.length} pieces`);
  for (let i = 0; i < todo.length; i += 2) await Promise.all(todo.slice(i, i + 2).map(one));   // two at a time, to be polite
  if (missing === todo.length) throw new Error("The OpenStreetMap servers are busy right now. Try again in a minute.");
  return { elements: [...elements.values()], missing };
}

self.onmessage = async ({ data }) => {
  try {
    const { elements, missing } = await download(data.bbox);
    postMessage({ type: "done", missing, ...(await findTwisties(elements, data.bbox, terrain, { maxRoads: data.maxRoads, onProgress: progress })) });
  } catch (e) {
    postMessage({ type: "error", message: e.message });
  }
};
