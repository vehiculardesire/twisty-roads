/* Module worker: scan a bbox for twisty roads in the browser.
 * in:  { bbox: [south, west, north, east] }
 * out: { type: "progress", msg } ... then { type: "done", roads, passes } or { type: "error", message }
 */
import { fetchOverpass, findTwisties, Terrain, TERRAIN_URL, terrariumToMetres } from "./core/twisty.js";

const progress = (msg) => postMessage({ type: "progress", msg });

const terrain = new Terrain(async (z, x, y) => {
  const r = await fetch(TERRAIN_URL(z, x, y));
  if (!r.ok) throw new Error(`terrain ${r.status}`);
  const bmp = await createImageBitmap(await r.blob());
  const ctx = new OffscreenCanvas(256, 256).getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return terrariumToMetres(ctx.getImageData(0, 0, 256, 256).data);
});

self.onmessage = async ({ data }) => {
  try {
    const elements = await fetchOverpass(data.bbox, { onProgress: progress });
    postMessage({ type: "done", ...(await findTwisties(elements, data.bbox, terrain, { onProgress: progress })) });
  } catch (e) {
    postMessage({ type: "error", message: e.message });
  }
};
