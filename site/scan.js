/* Web Worker: find twisty roads in a bounding box, entirely in the browser.
 *
 * A port of pipeline/build.py (keep the two in step):
 *   Overpass roads -> chain ways -> 10 m resample -> bend radius bands -> sections
 *   -> Terrarium elevation -> climb / gradient -> passes, towns, names -> score
 *
 * in:  { bbox: [south, west, north, east] }
 * out: { type: "progress", msg } ... then { type: "done", roads, passes } or { type: "error", message }
 */

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const TERRAIN = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const R_EARTH = 6371008.8;
const STEP = 10;
const RADIUS_OFFSET = 2;
const BANDS = [[30, 2.0], [60, 1.6], [100, 1.3], [175, 1.0]];
const SPLIT_STRAIGHT = 2500;
const PAD = 150;
const MIN_LEN = 2500;
const MIN_CURVY_KM = 1.2;
const MIN_DENSITY = 0.12;
const MAX_ROADS = 400;
const DEM_ZOOM = 12;
const MAX_ROAD_GRADE = 0.22;
const SCORE_REF = 65.0;          // Cormet de Roselend = 100

const UNPAVED = new Set(["unpaved", "gravel", "fine_gravel", "dirt", "ground", "compacted", "grass", "sand",
  "earth", "mud", "pebblestone", "rock", "grass_paver", "wood"]);
const BLOCKED = new Set(["no", "private", "agricultural", "forestry", "delivery", "permit"]);

const progress = (msg) => postMessage({ type: "progress", msg });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rad = (d) => (d * Math.PI) / 180;

self.onmessage = async ({ data }) => {
  try {
    postMessage({ type: "done", ...(await scan(data.bbox)) });
  } catch (e) {
    postMessage({ type: "error", message: e.message });
  }
};

// ------------------------------------------------------------------ download

async function overpass(bbox) {
  const [s, w, n, e] = bbox.map((v) => v.toFixed(4));
  const q = `[out:json][timeout:180];
(
  way["highway"~"^(trunk|primary|secondary|tertiary|unclassified)$"](${s},${w},${n},${e});
  node["mountain_pass"="yes"](${s},${w},${n},${e});
  node["place"~"^(city|town|village)$"](${s},${w},${n},${e});
);
out body geom qt;`;
  for (let attempt = 0; attempt < 9; attempt++) {
    const url = OVERPASS[attempt % OVERPASS.length];
    const host = new URL(url).host;
    progress(attempt ? `Map server busy, trying ${host}…` : `Downloading roads from OpenStreetMap…`);
    try {
      const r = await fetch(url, { method: "POST", body: new URLSearchParams({ data: q }), signal: AbortSignal.timeout(200000) });
      if (r.ok) return await r.json();
    } catch { /* timeout / network: try the next server */ }
    await sleep(Math.min(30, 4 * (attempt + 1)) * 1000);
  }
  throw new Error("The OpenStreetMap servers are busy right now. Try again in a minute.");
}

// ------------------------------------------------------------------ filters

function rideable(t) {
  if (UNPAVED.has(t.surface) || t.junction === "roundabout" || t.junction === "circular") return false;
  if (t.area === "yes" || t.motorroad === "yes") return false;
  for (const k of ["motorcycle", "motor_vehicle", "vehicle", "access"]) {
    if (k in t) return !t[k].replace(/ /g, "").split(";").every((v) => BLOCKED.has(v));
  }
  return true;
}

const isOffGround = (t) =>
  (t.tunnel && t.tunnel !== "no") || (t.bridge && t.bridge !== "no") || t.covered === "yes" ||
  (t.layer && t.layer !== "0" && /^-?\d+$/.test(t.layer));

const roadKey = (t) => (t.ref ? t.ref.split(";")[0].replace(/ /g, "").toUpperCase() : t.name || null);

// ------------------------------------------------------------------ chaining

function endDirection(way, atStart) {
  const g = way.geometry, n = g.length;
  const [a, b] = atStart ? [g[0], g[Math.min(3, n - 1)]] : [g[n - 1], g[Math.max(n - 4, 0)]];
  const c = Math.cos(rad(a.lat));
  const dx = (a.lon - b.lon) * c, dy = a.lat - b.lat, L = Math.hypot(dx, dy) || 1;
  return [dx / L, dy / L];
}

function chainWays(ways) {
  const ends = new Map();       // node -> [[wid, atStart]]
  const interior = new Set();
  for (const [wid, w] of ways) {
    const nd = w.nodes;
    for (const [node, atStart] of [[nd[0], true], [nd[nd.length - 1], false]]) {
      if (!ends.has(node)) ends.set(node, []);
      ends.get(node).push([wid, atStart]);
    }
    for (let i = 1; i < nd.length - 1; i++) interior.add(nd[i]);
  }

  const link = new Map();
  const key = (wid, s) => `${wid}:${s ? 1 : 0}`;
  const pair = (a, b) => { link.set(key(...a), b); link.set(key(...b), a); };

  for (const [node, all] of ends) {
    const es = all.filter(([wid]) => { const nd = ways.get(wid).nodes; return nd[0] !== nd[nd.length - 1]; });
    if (es.length === 2 && !interior.has(node) && es[0][0] !== es[1][0]) { pair(es[0], es[1]); continue; }
    const byKey = new Map();
    for (const e of es) {
      const k = roadKey(ways.get(e[0]).tags || {});
      if (k) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(e); }
    }
    for (let free of byKey.values()) {
      while (free.length >= 2) {
        let best = null;
        for (let i = 0; i < free.length; i++) {
          for (let j = i + 1; j < free.length; j++) {
            if (free[i][0] === free[j][0]) continue;
            const u = endDirection(ways.get(free[i][0]), free[i][1]), v = endDirection(ways.get(free[j][0]), free[j][1]);
            const straight = -(u[0] * v[0] + u[1] * v[1]);
            if (!best || straight > best[0]) best = [straight, i, j];
          }
        }
        if (!best) break;
        const [, i, j] = best;
        pair(free[i], free[j]);
        free = free.filter((_, k) => k !== i && k !== j);
      }
    }
  }

  const seen = new Set(), chains = [];
  for (const wid of ways.keys()) {
    if (seen.has(wid)) continue;
    let cur = wid, curStart = true, guard = 0;
    while (link.has(key(cur, curStart)) && guard++ < 100000) {
      const [nxt, nxtStart] = link.get(key(cur, curStart));
      if (nxt === wid) break;
      cur = nxt; curStart = !nxtStart;
    }
    const chain = [];
    let way = cur, entryStart = curStart;
    while (!seen.has(way)) {
      seen.add(way);
      chain.push([way, !entryStart]);                 // reversed if entered at its end
      const exit = key(way, !entryStart);
      if (!link.has(exit)) break;
      [way, entryStart] = link.get(exit);
    }
    chains.push(chain);
  }
  return chains;
}

// ------------------------------------------------------------------ geometry

function interp(xs, xp, fp) {
  // numpy.interp for sorted xp; xs may be a number or an array
  const one = (x) => {
    if (x <= xp[0]) return fp[0];
    const n = xp.length;
    if (x >= xp[n - 1]) return fp[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xp[m] <= x) lo = m; else hi = m; }
    const t = (x - xp[lo]) / (xp[hi] - xp[lo] || 1);
    return fp[lo] + (fp[hi] - fp[lo]) * t;
  };
  return typeof xs === "number" ? one(xs) : Array.from(xs, one);
}

function searchsorted(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

function radii(x, y) {
  const k = RADIUS_OFFSET, n = x.length, r = new Float64Array(n).fill(Infinity);
  for (let i = k; i < n - k; i++) {
    const ax = x[i - k], ay = y[i - k], bx = x[i], by = y[i], cx = x[i + k], cy = y[i + k];
    const ab = Math.hypot(bx - ax, by - ay), bc = Math.hypot(cx - bx, cy - by), ca = Math.hypot(ax - cx, ay - cy);
    const cross = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
    const rr = (ab * bc * ca) / (2 * cross);
    r[i] = Number.isFinite(rr) ? rr : Infinity;
  }
  return r;
}

function weights(r) {
  const w = new Float64Array(r.length), cls = new Uint8Array(r.length);
  const bands = [...BANDS].reverse();                 // 175, 100, 60, 30
  for (let i = 0; i < r.length; i++) {
    bands.forEach(([limit, weight], b) => { if (r[i] < limit) { w[i] = weight; cls[i] = b + 1; } });
  }
  return [w, cls];
}

function countHairpins(x, y) {
  const h = [];
  for (let i = 0; i < x.length - 1; i++) h.push(Math.atan2(y[i + 1] - y[i], x[i + 1] - x[i]));
  if (h.length) h.push(h[h.length - 1]);
  const dh = [];
  for (let i = 0; i < h.length - 1; i++) { let d = h[i + 1] - h[i]; d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; dh.push(d); }
  const cs = [0];
  for (const d of dh) cs.push(cs[cs.length - 1] + d);
  const win = Math.round(120 / STEP), lim = rad(150);
  let count = 0, i = 0;
  while (i < dh.length) {
    const j = Math.min(i + win, dh.length);
    let hit = -1;
    for (let k = i + 1; k <= j; k++) if (Math.abs(cs[k] - cs[i]) >= lim) { hit = k - (i + 1); break; }
    if (hit >= 0) { count++; i += hit + 1; } else i++;
  }
  return count;
}

function sections(w) {
  const split = SPLIT_STRAIGHT / STEP, pad = PAD / STEP, n = w.length;
  const curvy = [];
  for (let i = 0; i < n; i++) if (w[i] > 0) curvy.push(i);
  if (!curvy.length) return [];
  const out = [];
  let start = curvy[0], last = curvy[0];
  for (const i of curvy.slice(1)) {
    if (i - last > split) { out.push([start, last]); start = i; }
    last = i;
  }
  out.push([start, last]);
  return out.map(([a, b]) => [Math.max(0, a - pad), Math.min(n - 1, b + pad)]);
}

function simplify(x, y, tol = 2) {
  const keep = new Uint8Array(x.length);
  keep[0] = keep[x.length - 1] = 1;
  const stack = [[0, x.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    if (j - i < 2) continue;
    const dx = x[j] - x[i], dy = y[j] - y[i], L = Math.hypot(dx, dy) || 1e-9;
    let best = -1, bd = -1;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs(dy * (x[k] - x[i]) - dx * (y[k] - y[i])) / L;
      if (d > bd) { bd = d; best = k; }
    }
    if (bd > tol) { keep[best] = 1; stack.push([i, best], [best, j]); }
  }
  return keep;
}

// ------------------------------------------------------------------ elevation

const tiles = new Map();

function tileCoords(lon, lat) {
  const n = 2 ** DEM_ZOOM;
  const X = ((lon + 180) / 360) * n * 256 - 0.5;
  const lr = rad(lat);
  const Y = ((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n * 256 - 0.5;
  return [X, Y];
}

async function loadTiles(keys) {
  const todo = [...keys].filter((k) => !tiles.has(k));
  let done = 0;
  const one = async (k) => {
    const [tx, ty] = k.split("/").map(Number);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const blob = await (await fetch(TERRAIN(DEM_ZOOM, tx, ty))).blob();
        const bmp = await createImageBitmap(blob);
        const ctx = new OffscreenCanvas(256, 256).getContext("2d", { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        const px = ctx.getImageData(0, 0, 256, 256).data, e = new Float32Array(65536);
        for (let i = 0; i < 65536; i++) e[i] = px[4 * i] * 256 + px[4 * i + 1] + px[4 * i + 2] / 256 - 32768;
        tiles.set(k, e);
        break;
      } catch { await sleep(1000); }
    }
    if (!tiles.has(k)) tiles.set(k, new Float32Array(65536));   // give up: flat, rather than fail the scan
    progress(`Loading elevation… ${++done}/${todo.length} tiles`);
  };
  for (let i = 0; i < todo.length; i += 8) await Promise.all(todo.slice(i, i + 8).map(one));
}

function neededTiles(lon, lat, into) {
  for (let i = 0; i < lon.length; i++) {
    const [X, Y] = tileCoords(lon[i], lat[i]);
    for (const gx of [Math.floor(X), Math.floor(X) + 1]) for (const gy of [Math.floor(Y), Math.floor(Y) + 1]) into.add(`${gx >> 8}/${gy >> 8}`);
  }
}

function elevation(lon, lat) {
  const px = (gx, gy) => tiles.get(`${gx >> 8}/${gy >> 8}`)[(gy & 255) * 256 + (gx & 255)];
  return Array.from(lon, (lo, i) => {
    const [X, Y] = tileCoords(lo, lat[i]);
    const x0 = Math.floor(X), y0 = Math.floor(Y), fx = X - x0, fy = Y - y0;
    return px(x0, y0) * (1 - fx) * (1 - fy) + px(x0 + 1, y0) * fx * (1 - fy) + px(x0, y0 + 1) * (1 - fx) * fy + px(x0 + 1, y0 + 1) * fx * fy;
  });
}

function smooth(e, medianN = 11, meanN = 25) {
  if (e.length < meanN) return e;
  const padEdge = (a, p) => [...Array(p).fill(a[0]), ...a, ...Array(p).fill(a[a.length - 1])];
  let p = padEdge(e, medianN >> 1);
  let m = e.map((_, i) => { const s = p.slice(i, i + medianN).sort((a, b) => a - b); return s[medianN >> 1]; });
  // slope limit, forwards and backwards, averaged
  const dmax = MAX_ROAD_GRADE * STEP, f = [...m], b = [...m];
  for (let i = 1; i < f.length; i++) f[i] = Math.min(Math.max(f[i], f[i - 1] - dmax), f[i - 1] + dmax);
  for (let i = b.length - 2; i >= 0; i--) b[i] = Math.min(Math.max(b[i], b[i + 1] - dmax), b[i + 1] + dmax);
  m = f.map((v, i) => (v + b[i]) / 2);
  p = padEdge(m, meanN >> 1);
  const out = [];
  let sum = 0;
  for (let i = 0; i < meanN; i++) sum += p[i];
  for (let i = 0; i < m.length; i++) { out.push(sum / meanN); sum += p[i + meanN] - p[i]; }
  return out;
}

function climbStats(e) {
  let up = 0, down = 0, ref = e[0];
  for (const v of e.slice(1)) {
    if (v - ref >= 3) { up += v - ref; ref = v; } else if (ref - v >= 3) { down += ref - v; ref = v; }
  }
  const win = 300 / STEP;
  let g = 0;
  for (let i = 0; i + win < e.length; i++) g = Math.max(g, Math.abs(e[i + win] - e[i]) / (win * STEP));
  return [up, down, g];
}

// ------------------------------------------------------------------ main

async function scan(bbox) {
  const [s, w, n, e] = bbox;
  const osm = await overpass(bbox);
  progress("Finding the twisty bits…");

  const ways = new Map(), passes = [], places = [];
  for (const el of osm.elements) {
    const t = el.tags || {};
    if (el.type === "way") { if (el.nodes.length >= 2 && rideable(t)) ways.set(el.id, el); }
    else if ("mountain_pass" in t) passes.push(el);
    else if ("place" in t && t.name) places.push(el);
  }
  const roadNodes = new Set();
  for (const wy of ways.values()) for (const nd of wy.nodes) roadNodes.add(nd);
  const passList = passes.filter((p) => p.tags?.name && roadNodes.has(p.id));

  const candidates = [];
  for (const chain of chainWays(ways)) {
    let lon = [], lat = [], segWay = [];
    for (const [wid, reverse] of chain) {
      let g = ways.get(wid).geometry;
      if (reverse) g = [...g].reverse();
      for (const p of g.slice(lon.length ? 1 : 0)) { lon.push(p.lon); lat.push(p.lat); segWay.push(wid); }
    }
    if (lon.length < 3) continue;
    const lat0 = lat.reduce((a, b) => a + b, 0) / lat.length, cos0 = Math.cos(rad(lat0));
    let x = lon.map((v) => rad(v) * R_EARTH * cos0), y = lat.map((v) => rad(v) * R_EARTH);
    const keep = x.map((_, i) => i === 0 || Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]) > 0.01);
    const f = (a) => a.filter((_, i) => keep[i]);
    [lon, lat, x, y, segWay] = [f(lon), f(lat), f(x), f(y), f(segWay)];

    const vd = [0];
    for (let i = 1; i < x.length; i++) vd.push(vd[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]));
    const sr = [];
    for (let d = 0; d < vd[vd.length - 1]; d += STEP) sr.push(d);
    if (sr.length < 10) continue;
    const rx = interp(sr, vd, x), ry = interp(sr, vd, y);
    const [wts, cls] = weights(radii(rx, ry));

    for (const [a, b] of sections(wts)) {
      const length = (b - a) * STEP;
      let curvy = 0;
      for (let i = a; i < b; i++) curvy += wts[i];
      curvy = (curvy * STEP) / 1000;
      if (length < MIN_LEN || curvy < MIN_CURVY_KM || curvy / (length / 1000) < MIN_DENSITY) continue;
      candidates.push({ lon, lat, vd, segWay, cos0, a, b, rx, ry, cls, length, curvy });
    }
  }
  candidates.sort((p, q) => q.curvy - p.curvy);
  candidates.length = Math.min(candidates.length, Math.round(MAX_ROADS * 1.6));
  if (!candidates.length) return { roads: [], passes: [] };

  // elevation: fetch every tile we'll need up front
  const need = new Set();
  const rsLonLat = (c) => {
    const lo = [], la = [];
    for (let i = c.a; i <= c.b; i++) { lo.push((c.rx[i] / (R_EARTH * c.cos0)) * 180 / Math.PI); la.push((c.ry[i] / R_EARTH) * 180 / Math.PI); }
    return [lo, la];
  };
  for (const c of candidates) { c.rs = rsLonLat(c); neededTiles(...c.rs, need); }
  for (const p of passList) neededTiles([p.lon], [p.lat], need);
  await loadTiles(need);
  progress(`Scoring ${candidates.length} roads…`);

  const roads = [];
  for (const c of candidates) {
    const d0 = c.a * STEP, d1 = c.b * STEP;
    const inside = [];
    for (let i = 0; i < c.vd.length; i++) if (c.vd[i] > d0 && c.vd[i] < d1) inside.push(i);
    let outLon = [interp(d0, c.vd, c.lon), ...inside.map((i) => c.lon[i]), interp(d1, c.vd, c.lon)];
    let outLat = [interp(d0, c.vd, c.lat), ...inside.map((i) => c.lat[i]), interp(d1, c.vd, c.lat)];
    let outD = [d0, ...inside.map((i) => c.vd[i]), d1];
    const k = simplify(outLon.map((v) => rad(v) * R_EARTH * c.cos0), outLat.map((v) => rad(v) * R_EARTH));
    [outLon, outLat, outD] = [outLon, outLat, outD].map((arr) => arr.filter((_, i) => k[i]));

    // elevation; tunnels & bridges interpolated between their ends
    const raw = elevation(...c.rs);
    const rsD = raw.map((_, i) => (c.a + i) * STEP);
    const owner = (d) => c.segWay[Math.min(c.segWay.length - 1, searchsorted(c.vd, d))];
    const off = rsD.map((d) => isOffGround(ways.get(owner(d)).tags || {}));
    if (off.some(Boolean) && !off.every(Boolean)) {
      const gd = rsD.filter((_, i) => !off[i]), ge = raw.filter((_, i) => !off[i]);
      off.forEach((o, i) => { if (o) raw[i] = interp(rsD[i], gd, ge); });
    }
    const ele = smooth(raw);
    let [up, down, maxGrad] = climbStats(ele);
    const eleV = interp(outD, rsD, ele);

    let curve = "";
    for (let j = 0; j < outD.length - 1; j++) {
      const i0 = Math.floor(outD[j] / STEP), i1 = Math.max(Math.ceil(outD[j + 1] / STEP), i0 + 1);
      let m = 0;
      for (let i = i0; i < i1 && i < c.cls.length; i++) m = Math.max(m, c.cls[i]);
      curve += m;
    }
    const hairpins = countHairpins(c.rx.slice(c.a, c.b + 1), c.ry.slice(c.a, c.b + 1));

    // naming, weighted by length
    const nameLen = new Map(), refLen = new Map(), owners = new Set();
    for (let j = 0; j < outD.length - 1; j++) {
      const wid = owner((outD[j] + outD[j + 1]) / 2), t = ways.get(wid).tags || {}, L = outD[j + 1] - outD[j];
      owners.add(wid);
      if (t.name) nameLen.set(t.name, (nameLen.get(t.name) || 0) + L);
      if (t.ref) refLen.set(t.ref, (refLen.get(t.ref) || 0) + L);
    }
    const top = (m) => [...m].sort((p, q) => q[1] - p[1])[0]?.[0] ?? null;
    const name = top(nameLen), ref = top(refLen), nameShare = name ? nameLen.get(name) / c.length : 0;
    const seasonal = [...owners].some((wid) => Object.keys(ways.get(wid).tags || {}).some((k) =>
      k.endsWith(":conditional") && ["access", "vehicle", "motor_vehicle", "motorcycle"].includes(k.split(":")[0])));

    let bestPass = null;
    for (const p of passList) {
      const cc = Math.cos(rad(p.lat));
      let dd = Infinity;
      for (let i = 0; i < outLon.length; i++) dd = Math.min(dd, Math.hypot((outLon[i] - p.lon) * cc, outLat[i] - p.lat));
      if (dd * rad(1) * R_EARTH >= 80) continue;
      let pe = parseFloat((p.tags.ele || "").split(" ")[0].replace(",", "."));
      if (!Number.isFinite(pe)) pe = elevation([p.lon], [p.lat])[0];
      const cand = { name: p.tags.name, ele: Math.round(pe), lon: +p.lon.toFixed(5), lat: +p.lat.toFixed(5) };
      if (!bestPass || cand.ele > bestPass.ele) bestPass = cand;
    }

    let towns = [[outLon[0], outLat[0]], [outLon[outLon.length - 1], outLat[outLat.length - 1]]].map(([lo, la]) => {
      const cc = Math.cos(rad(la));
      let best = null, bd = 6000;
      for (const p of places) {
        const d = Math.hypot((p.lon - lo) * cc, p.lat - la) * rad(1) * R_EARTH;
        if (d <= bd) { bd = d; best = p.tags.name; }
      }
      return best;
    });

    const title = bestPass ? bestPass.name : name && (nameShare >= 0.6 || !ref) ? name : ref || name || "Unnamed road";
    const sub = [ref !== title ? ref : null, name && name !== title && nameShare >= 0.3 ? name : null].filter(Boolean).join(" · ");

    let coords = outLon.map((lo, i) => [+lo.toFixed(5), +outLat[i].toFixed(5), Math.round(eleV[i])]);
    if (down > up) {
      coords = coords.reverse(); curve = [...curve].reverse().join(""); towns = towns.reverse(); [up, down] = [down, up];
    }
    const eleMin = Math.round(Math.min(...ele)), eleMax = Math.round(Math.max(...ele));
    const relief = eleMax - eleMin;
    const raw_ = c.curvy * (1 + Math.min(relief, 1200) / 1200) * (1 + Math.min(hairpins, 20) / 40);
    roads.push({
      name: title, road: sub || null,
      from: towns[0], to: towns[1] !== towns[0] ? towns[1] : null,
      len: Math.round(c.length), curvy: +c.curvy.toFixed(2), density: +(c.curvy / (c.length / 1000)).toFixed(3),
      hairpins, climb: Math.round(up), descent: Math.round(down), eleMin, eleMax,
      maxGrad: +(maxGrad * 100).toFixed(1), pass: bestPass, seasonal, coords, curve,
      score: Math.round((100 * raw_) / SCORE_REF),
    });
  }
  roads.sort((p, q) => q.score - p.score);
  roads.length = Math.min(roads.length, MAX_ROADS);

  const passOut = passList
    .filter((p) => p.lat >= s && p.lat <= n && p.lon >= w && p.lon <= e)
    .map((p) => {
      const pe = parseInt(p.tags.ele, 10);
      return { name: p.tags.name, ele: Number.isFinite(pe) ? pe : null, lon: +p.lon.toFixed(5), lat: +p.lat.toFixed(5) };
    });
  return { roads, passes: passOut };
}
