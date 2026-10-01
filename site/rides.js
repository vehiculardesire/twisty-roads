/* Your recorded rides (GPX): parse, keep in this browser, and work out which scored roads you've ridden. */
import { idb } from "./db.js";

const MATCH_M = 35;          // a road point counts as ridden if a track point is this close
const RIDDEN_SHARE = 0.6;    // ...and a road is ridden if this much of it was
const CELL = 0.001;          // ~100 m grid for lookups
const LAT_PAD = MATCH_M / 111320;
const lonPad = (lat) => LAT_PAD / Math.max(1e-6, Math.cos((lat * Math.PI) / 180));

/** Read a GPX file into { name, points: [[lon, lat], ...] }, thinned to a point every ~20 m. */
export function parseGPX(text, fileName) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error(`${fileName} isn't a valid GPX file`);
  const pts = [...doc.querySelectorAll("trkpt, rtept")].map((p) => [+p.getAttribute("lon"), +p.getAttribute("lat")])
    .filter(([lo, la]) => Number.isFinite(lo) && Number.isFinite(la));
  if (pts.length < 2) throw new Error(`${fileName} has no track points`);
  const thin = [pts[0]];
  for (const p of pts) if (dist(p, thin[thin.length - 1]) >= 20) thin.push(p);
  const name = doc.querySelector("trk > name, metadata > name, rte > name")?.textContent?.trim() || fileName.replace(/\.gpx$/i, "");
  return { name, points: thin.map(([lo, la]) => [+lo.toFixed(5), +la.toFixed(5)]) };
}

function dist(a, b) {
  const k = Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111320;
}

export const loadRides = () => idb("rides", "getAll").catch(() => []);

export async function addRide(ride) {
  const rec = { key: `ride-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, date: Date.now(), ...ride };
  await idb("rides", "put", rec);
  return rec;
}

export const removeRide = (key) => idb("rides", "delete", key);

/** Set of road ids at least 60% covered by any of your rides. */
export function riddenRoads(roads, rides) {
  const grid = new Map();
  for (const ride of rides) for (const p of ride.points) {
    const k = `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(p);
  }
  if (!grid.size) return new Set();
  const near = (p) => {
    const i = Math.floor(p[0] / CELL), j = Math.floor(p[1] / CELL);
    const dx = Math.ceil(lonPad(p[1]) / CELL), dy = Math.ceil(LAT_PAD / CELL);
    for (let a = i - dx; a <= i + dx; a++) for (let b = j - dy; b <= j + dy; b++) {
      for (const q of grid.get(`${a},${b}`) || []) if (dist(p, q) <= MATCH_M) return true;
    }
    return false;
  };
  const boxes = rides.map((ride) => {
    const lo = ride.points.map((p) => p[0]), la = ride.points.map((p) => p[1]);
    return [Math.min(...lo), Math.min(...la), Math.max(...lo), Math.max(...la)];
  });
  const out = new Set();
  for (const r of roads) {
    // Allow the same GPS offset here as in the point-distance check below.
    const [w, s, e, n] = r.bb;
    const dx = Math.max(lonPad(s), lonPad(n));
    if (!boxes.some(([bw, bs, be, bn]) => bw <= e + dx && be >= w - dx && bs <= n + LAT_PAD && bn >= s - LAT_PAD)) continue;
    // sample the road every ~50 m
    let hit = 0, total = 0;
    for (let k = 1; k < r.coords.length; k++) {
      const a = r.coords[k - 1], b = r.coords[k], steps = Math.max(1, Math.round(dist(a, b) / 50));
      for (let t = 0; t < steps; t++) {
        const p = [a[0] + ((b[0] - a[0]) * t) / steps, a[1] + ((b[1] - a[1]) * t) / steps];
        total++;
        if (near(p)) hit++;
      }
    }
    if (total && hit / total >= RIDDEN_SHARE) out.add(r.id);
  }
  return out;
}
