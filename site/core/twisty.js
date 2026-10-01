/* Twisty roads engine: OpenStreetMap roads + terrain -> ranked twisty sections.
 *
 * Environment-agnostic ES module, used by the browser scanner (scan-worker.js) and the
 * tile build (tools/build-tiles.mjs). The only environment-specific piece is how a terrain PNG
 * becomes elevations, which the caller passes to `new Terrain(loadTile)`.
 *
 *   OSM ways -> chain into roads -> resample every 10 m -> bend radius at each point
 *   -> cut at long straights -> terrain -> climb, gradient -> passes, towns, names, warnings -> score
 */

export const ALGO_VERSION = 3;          // bump when output changes: saved scans from older versions are dropped

export const TERRAIN_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const OVERPASS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

const R_EARTH = 6371008.8;
const STEP = 10;                 // resample spacing, m
const RADIUS_OFFSET = 2;         // bend radius from points 20 m either side
// Bend kinds, loosest first: [max radius m, name]. Index + 1 is the class stored in `curve`.
export const BENDS = [[175, "Sweeping"], [100, "Flowing"], [60, "Tight"], [30, "Hairpin-tight"]];
const SPLIT_STRAIGHT = 4000;     // a straight longer than this ends a section, m (pass-top plateaus stay in)
const PAD = 150;                 // straight kept at each end of a section, m
const MIN_LEN = 2500;
const MIN_CURVY_KM = 1.2;
const MIN_DENSITY = 0.12;
const DEM_ZOOM = 12;
const MAX_ROAD_GRADE = 0.22;     // steeper than this = the DEM caught a cliff next to the road

const UNPAVED = new Set(["unpaved", "gravel", "fine_gravel", "dirt", "ground", "compacted", "grass", "sand",
  "earth", "mud", "pebblestone", "rock", "grass_paver", "wood"]);
const BLOCKED = new Set(["no", "private", "agricultural", "forestry", "delivery", "permit"]);
const ACCESS_KEYS = ["motorcycle", "motor_vehicle", "vehicle", "access"];

const rad = (d) => (d * Math.PI) / 180;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ scoring (shared with the UI)

// Every road carries a `bins` string: one fixed-width record per 200 m slice (see encodeBins), so the UI
// can re-score for any taste and find the best stretch without the engine.
export const BIN = 200;                  // m per slice
const PER_BIN = BIN / STEP;              // 10 m samples per slice
const BIN_CHARS = 10;
const WINDOW_KM = 15;                    // a road is scored on its best stretch of up to this long
const GOOD_KM_CAP = 30;                  // good riding beyond this adds nothing more
const BUILT_UP_KEEP = 0.3;               // bends in villages count 30%: fun to look at, not to ride hard

// Bend weights per kind (sweeping, flowing, tight, hairpin-tight) at the two ends and middle of the taste slider.
const W_SWEEPERS = [1.6, 1.4, 1.0, 0.6];
const W_BALANCED = [1.0, 1.3, 1.6, 2.0];
const W_HAIRPINS = [0.6, 1.0, 1.7, 2.4];
export const SCORE_REF = 32.2;           // raw fun that scores 100; the Stelvio scores about 95

/**
 * The taste slider should reshuffle roads, not inflate every score. Hairpin-lover weights are bigger, so divide
 * by how a typical great pass (this bend mix over 15 km, 20 hairpins) scores at that taste versus balanced.
 */
const TYPICAL_PASS = { bends: [3.0, 3.0, 2.5, 1.5], hairpins: 20, terrain: 0.35, scenery: 0.3 };
function tasteScale(taste, mix = NO_MIX) {
  const raw = (t, m) => {
    const w = tasteWeights(t), p = TYPICAL_PASS;
    return p.bends.reduce((s, km, i) => s + km * w.bends[i], 0) *
      (1 + m.hairpins * (hairpinFactor(p.hairpins, w.hairpinBonus) - 1) + m.terrain * p.terrain + m.scenery * p.scenery);
  };
  return raw(taste, mix) / raw(0.5, NO_MIX);
}

/** How much each bonus counts for this rider; 1 = as designed. Learned from their yay/nay ratings in the UI. */
export const NO_MIX = Object.freeze({ terrain: 1, scenery: 1, hairpins: 1 });

/** x1.5 at 20 hairpins (balanced), then diminishing returns up to 60 so Stelvio-style stacks still count. */
function hairpinFactor(h, bonus) {
  h = Math.min(h, 60);
  return 1 + bonus * (h <= 20 ? h / 40 : 0.5 * Math.sqrt(h / 20));
}

/** Rough treeline: ~2,000 m in the Alps and Carpathians, falling north of 47° (~950 m in western Norway). */
const treeline = (lat) => Math.max(500, 2000 - 70 * Math.max(0, Math.abs(lat) - 47));

/** Weights for a taste between 0 (fast sweepers) and 1 (tight hairpins); 0.5 is balanced. */
export function tasteWeights(taste = 0.5) {
  const [a, b, u] = taste < 0.5 ? [W_SWEEPERS, W_BALANCED, taste / 0.5] : [W_BALANCED, W_HAIRPINS, (taste - 0.5) / 0.5];
  return {
    bends: a.map((w, i) => w + (b[i] - w) * u),
    hairpinBonus: 2 * taste,             // 0 for sweepers, 1 balanced, 2 hairpin lovers
  };
}

const b36 = (v) => Math.max(0, Math.min(35, Math.round(v))).toString(36);

/** Slice fields: c = samples per bend class [4], h hairpins, r crests+dips, v view 0-9, p drop-off 0-9, u built-up samples, x viewpoint. */
function encodeBins(bins) {
  return bins.map((b) => b.c.map(b36).join("") + b36(b.h) + b36(b.r) + b36(b.v) + b36(b.p) + b36(b.u) + b36(b.x)).join("");
}

const decoded = new WeakMap();
function decode(road) {
  let d = decoded.get(road);
  if (d) return d;
  const s = road.bins, bins = [];
  for (let i = 0; i < s.length; i += BIN_CHARS) {
    const n = [...s.slice(i, i + BIN_CHARS)].map((ch) => parseInt(ch, 36));
    bins.push({ c: n.slice(0, 4), h: n[4], r: n[5], v: n[6] / 9, p: n[7] / 9, u: n[8] / PER_BIN, x: n[9] });
  }
  // elevation at each slice centre, from the stored profile
  const cd = [0];
  for (let i = 1; i < road.coords.length; i++) {
    const [a, b] = [road.coords[i - 1], road.coords[i]];
    cd.push(cd[i - 1] + Math.hypot((b[0] - a[0]) * Math.cos(rad(a[1])), b[1] - a[1]) * rad(1) * R_EARTH);
  }
  const scale = cd[cd.length - 1] / (bins.length * BIN || 1);
  const ele = bins.map((_, i) => interp((i + 0.5) * BIN * scale, cd, road.coords.map((c) => c[2])));
  d = { bins, ele };
  decoded.set(road, d);
  return d;
}

/**
 * Scenery of one slice, 0..1: an open view down over the surroundings, a steep fall-away beside it, a viewpoint,
 * and being up in high alpine terrain (fully counted from 200 m above the treeline).
 */
const sliceScenery = (b, alpine) => Math.min(1, 0.65 * b.v + 0.35 * b.p + (b.x ? 0.3 : 0) + 0.4 * alpine);

/**
 * The fun score and everything the UI needs to explain it.
 *
 * For the best stretch of up to 15 km:  bends x (1 + terrain + scenery + hairpins bonuses)
 * The bonuses add rather than multiply, so a road isn't rewarded for having a bit of everything: the Tail of the
 * Dragon (all bends, low, few hairpins) can stand next to the Stelvio (fewer bends, huge climb, hairpin stacks).
 *   bends     km in bends weighted by tightness for your taste; built-up slices count 30%
 *   terrain   x1..x1.5 for 0..1500 m of climb within the stretch, or up to x1.3 for rolling crests and dips
 *   scenery   x1..x1.5: open views down over the surroundings, drop-offs, viewpoints, high alpine
 *   hairpins  x1.5 at 20 hairpins (balanced), diminishing returns up to 60 (more or less with taste)
 * then x good km: how much of the road is at least half that good, up to 30 km, with diminishing returns
 * (6 km x0.63, 15 km x1, 30 km x1.41). Meh stretches neither help nor hurt.
 * Linear 0-100, where 100 is the world's benchmark roads; anything even better also shows 100.
 */
export function scoreRoad(road, taste = 0.5, mix = NO_MIX) {
  const { bins, ele } = decode(road);
  const w = tasteWeights(taste), nb = bins.length, binKm = BIN / 1000;
  const bend = bins.map((b) => b.c.reduce((s, n, k) => s + n * (STEP / 1000) * w.bends[k], 0) * (1 - (1 - BUILT_UP_KEEP) * b.u));
  const hp = bins.map((b) => b.h * (b.u > 0.5 ? BUILT_UP_KEEP : 1));
  const tl = treeline(road.coords[0][1]);
  const alpine = ele.map((e) => Math.max(0, Math.min(1, (e - tl + 200) / 400)));
  const scen = bins.map((b, i) => sliceScenery(b, alpine[i]));
  const pre = (arr) => arr.reduce((p, v) => (p.push(p[p.length - 1] + v), p), [0]);
  const [pB, pH, pS, pR] = [pre(bend), pre(hp), pre(scen), pre(bins.map((b) => b.r))];
  const sum = (p, i, j) => p[j] - p[i];

  const W = Math.max(1, Math.min(nb, Math.round(WINDOW_KM / binKm)));
  let best = null;
  for (let i = 0; i + W <= nb; i++) {
    const win = ele.slice(i, i + W);
    const relief = Math.max(...win) - Math.min(...win);
    const climb = Math.min(relief, 1500) / 1500;
    const rolling = Math.min(1, sum(pR, i, i + W) / (W * binKm) / 1.5) * 0.6;
    const parts = {
      bends: sum(pB, i, i + W),
      terrain: 1 + mix.terrain * 0.5 * Math.max(climb, rolling),
      scenery: 1 + mix.scenery * 0.5 * (sum(pS, i, i + W) / W),
      hairpins: 1 + mix.hairpins * (hairpinFactor(sum(pH, i, i + W), w.hairpinBonus) - 1),
    };
    const fun = parts.bends * (parts.terrain + parts.scenery + parts.hairpins - 2);
    if (!best || fun > best.fun) best = { fun, i, parts, rolling: rolling > climb };
  }

  // how intense each part of the road is (bends + scenery per km, smoothed over 1 km)
  const raw = bins.map((b, i) => (bend[i] * (1 + 0.5 * scen[i])) / binKm);
  const dens = raw.map((_, i) => { const s = raw.slice(Math.max(0, i - 2), i + 3); return s.reduce((a, b) => a + b, 0) / s.length; });
  // how much of the road is good riding: km anywhere at least half as intense as the best stretch.
  // Meh stretches don't count; up to 30 km counts, with diminishing returns (6 km x0.63, 15 km x1, 30 km x1.41)
  const winMean = dens.slice(best.i, best.i + W).reduce((a, b) => a + b, 0) / W;
  const goodKm = dens.filter((d) => d >= 0.5 * winMean).length * binKm;
  const lengthF = Math.sqrt(Math.min(goodKm, GOOD_KM_CAP) / WINDOW_KM);
  const intensity = best.fun / (W * binKm);
  const linear = (100 * intensity * WINDOW_KM * lengthF) / (SCORE_REF * tasteScale(taste, mix));
  const score = Math.round(Math.min(100, linear));

  // hot spots: stretches within 70% of the road's most intense kilometre, at least 400 m long
  const peakDens = Math.max(...dens), hot = [];
  let start = -1;
  dens.forEach((d, i) => {
    const on = d >= 0.7 * peakDens;
    if (on && start < 0) start = i;
    if ((!on || i === nb - 1) && start >= 0) {
      const end = on ? i + 1 : i;
      if (end - start >= 2) {
        if (hot.length && start - hot[hot.length - 1][1] / BIN <= 1) hot[hot.length - 1][1] = end * BIN;
        else hot.push([start * BIN, end * BIN]);
      }
      start = -1;
    }
  });
  const peak = (dens.indexOf(peakDens) + 0.5) * BIN;

  const count = (f) => bins.filter(f).length * binKm;
  return {
    score, linear, intensity, lengthF, goodKm, parts: best.parts, rolling: best.rolling,
    stretch: [best.i * BIN, (best.i + W) * BIN], hot, peak, length: nb * BIN,
    scenery: {
      score: Math.round((100 * scen.reduce((a, b) => a + b, 0)) / nb),
      viewKm: count((b) => b.v >= 0.5), dropKm: count((b) => b.p >= 0.5),
      alpineKm: alpine.filter((a) => a >= 0.5).length * binKm,
      viewpoints: bins.reduce((a, b) => a + b.x, 0), builtPct: Math.round((100 * bins.reduce((a, b) => a + b.u, 0)) / nb),
    },
  };
}

// ------------------------------------------------------------------ download

let ranked = null, rankedAt = 0;

/** The Overpass servers that are answering right now, quickest first. Which one is busy changes by the hour, so a
 *  scan starts by sending each a trivial query. A server that doesn't answer it tends to hang on real queries too,
 *  so it's left out (unless none answer). Remembered for 5 minutes. */
export async function overpassServers(headers = {}, fresh = false) {
  if (ranked && !fresh && Date.now() - rankedAt < 300000) return ranked;
  const probe = new URLSearchParams({ data: "[out:json][timeout:10];node(1);out ids;" });
  const times = await Promise.all(OVERPASS.map(async (url, i) => {
    const t = Date.now();
    try {
      const r = await fetch(url, { method: "POST", body: probe, headers, signal: AbortSignal.timeout(12000) });
      if (r.ok) { await r.text(); return [Date.now() - t, i]; }
    } catch { /* no answer */ }
    return [1e9 + i, i];
  }));
  const up = times.filter(([t]) => t < 1e9);
  ranked = (up.length ? up : times).sort((a, b) => a[0] - b[0]).map(([, i]) => OVERPASS[i]);
  rankedAt = Date.now();
  return ranked;
}

/** Roads, passes and place names in a bbox [south, west, north, east], from the public Overpass servers. */
export async function fetchOverpass(bbox, { onProgress = () => {}, attempts = 9, headers = {} } = {}) {
  const [s, w, n, e] = bbox.map((v) => v.toFixed(4));
  const q = `[out:json][timeout:180];
(
  way["highway"~"^(trunk|primary|secondary|tertiary|unclassified)$"](${s},${w},${n},${e});
  node["mountain_pass"="yes"](${s},${w},${n},${e});
  node["tourism"="viewpoint"](${s},${w},${n},${e});
  node["place"~"^(city|town|village)$"](${s},${w},${n},${e});
);
out body geom qt;`;
  let servers = await overpassServers(headers);
  for (let attempt = 0; attempt < attempts; attempt++) {
    // after a full round of failures, ask again which servers are answering
    if (attempt && attempt % servers.length === 0) servers = await overpassServers(headers, true);
    const url = servers[attempt % servers.length];
    onProgress(attempt ? `Map server busy, retrying${servers.length > 1 ? ` on ${new URL(url).host}` : ""}…` : "Downloading roads from OpenStreetMap…");
    // a server that's queueing us sends nothing at all: give up on it after 2 minutes, but let a download finish
    const stop = new AbortController();
    let timer = setTimeout(() => stop.abort(), 120000);
    try {
      const r = await fetch(url, { method: "POST", body: new URLSearchParams({ data: q }), headers, signal: stop.signal });
      clearTimeout(timer);
      timer = setTimeout(() => stop.abort(), 180000);
      if (r.ok) return (await r.json()).elements;
    } catch { /* timeout / network: next server */ } finally { clearTimeout(timer); }
    await sleep(Math.min(30, 4 * (attempt + 1)) * 1000);
  }
  throw new Error("The OpenStreetMap servers are busy right now. Try again in a minute.");
}

// ------------------------------------------------------------------ terrain

/** Terrarium elevation tiles. `loadTile(z, x, y)` must resolve to a Float32Array(256*256) of metres. */
export class Terrain {
  constructor(loadTile) {
    this.loadTile = loadTile;
    this.tiles = new Map();
  }

  static pixel(lon, lat) {
    const n = 2 ** DEM_ZOOM, lr = rad(lat);
    return [((lon + 180) / 360) * n * 256 - 0.5, ((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n * 256 - 0.5];
  }

  need(lon, lat, into) {
    for (let i = 0; i < lon.length; i++) {
      const [X, Y] = Terrain.pixel(lon[i], lat[i]);
      for (const gx of [Math.floor(X), Math.floor(X) + 1]) for (const gy of [Math.floor(Y), Math.floor(Y) + 1]) into.add(`${gx >> 8}/${gy >> 8}`);
    }
    return into;
  }

  async load(keys, onProgress = () => {}) {
    const todo = [...keys].filter((k) => !this.tiles.has(k));
    let done = 0;
    const one = async (k) => {
      const [x, y] = k.split("/").map(Number);
      for (let attempt = 0; attempt < 3 && !this.tiles.has(k); attempt++) {
        try { this.tiles.set(k, await this.loadTile(DEM_ZOOM, x, y)); } catch { await sleep(1000); }
      }
      if (!this.tiles.has(k)) throw new Error(`Couldn't load terrain tile ${k}`);
      onProgress(`Loading terrain… ${++done}/${todo.length} tiles`);
    };
    for (let i = 0; i < todo.length; i += 8) await Promise.all(todo.slice(i, i + 8).map(one));
  }

  sample(lon, lat) {
    const px = (gx, gy) => this.tiles.get(`${gx >> 8}/${gy >> 8}`)[(gy & 255) * 256 + (gx & 255)];
    return Array.from(lon, (lo, i) => {
      const [X, Y] = Terrain.pixel(lo, lat[i]);
      const x0 = Math.floor(X), y0 = Math.floor(Y), fx = X - x0, fy = Y - y0;
      return px(x0, y0) * (1 - fx) * (1 - fy) + px(x0 + 1, y0) * fx * (1 - fy) + px(x0, y0 + 1) * (1 - fx) * fy + px(x0 + 1, y0 + 1) * fx * fy;
    });
  }
}

/** Terrarium RGB -> metres. */
export function terrariumToMetres(rgba, channels = 4) {
  const e = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) e[i] = rgba[channels * i] * 256 + rgba[channels * i + 1] + rgba[channels * i + 2] / 256 - 32768;
  return e;
}

// ------------------------------------------------------------------ tag helpers

function rideable(t) {
  if (UNPAVED.has(t.surface) || t.junction === "roundabout" || t.junction === "circular") return false;
  if (t.area === "yes" || t.motorroad === "yes") return false;
  for (const k of ACCESS_KEYS) {       // most specific tag wins
    if (k in t) return !t[k].replace(/ /g, "").split(";").every((v) => BLOCKED.has(v));
  }
  return true;
}

const isTunnel = (t) => (t.tunnel && t.tunnel !== "no") || t.covered === "yes";
const isOffGround = (t) => isTunnel(t) || (t.bridge && t.bridge !== "no") || (t.layer && t.layer !== "0" && /^-?\d+$/.test(t.layer));
const isNarrow = (t) => t.lanes === "1" || t.narrow === "yes" || parseFloat(t.width) <= 4.5;
const roadKey = (t) => (t.ref ? t.ref.split(";")[0].replace(/ /g, "").toUpperCase() : t.name || null);

/** "no @ (Nov 1-May 31)" -> "Nov 1-May 31"; any other seasonal/conditional closure -> a generic note. */
function closure(t) {
  for (const k of ACCESS_KEYS) {
    const v = t[`${k}:conditional`];
    if (!v) continue;
    const m = v.match(/(?:no|private)\s*@\s*\(?([^);]+)\)?/i);
    if (m) return m[1].trim();
  }
  return t.winter_road === "no" || t.seasonal === "yes" ? "seasonal" : null;
}

// ------------------------------------------------------------------ chaining OSM ways into roads

function endDirection(way, atStart) {
  const g = way.geometry, n = g.length;
  const [a, b] = atStart ? [g[0], g[Math.min(3, n - 1)]] : [g[n - 1], g[Math.max(n - 4, 0)]];
  const c = Math.cos(rad(a.lat));
  const dx = (a.lon - b.lon) * c, dy = a.lat - b.lat, L = Math.hypot(dx, dy) || 1;
  return [dx / L, dy / L];
}

/**
 * OSM splits roads into many ways. Join them where exactly two ways meet end to end, or where the same
 * road number / name continues through a junction (taking the straightest continuation).
 */
function chainWays(ways) {
  const ends = new Map();
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
      chain.push([way, !entryStart]);          // reversed if entered at its end
      const exit = key(way, !entryStart);
      if (!link.has(exit)) break;
      [way, entryStart] = link.get(exit);
    }
    chains.push(chain);
  }
  return chains;
}

// ------------------------------------------------------------------ geometry

function interp(xs, xp, fp) {   // numpy.interp; xp sorted
  const one = (x) => {
    const n = xp.length;
    if (x <= xp[0]) return fp[0];
    if (x >= xp[n - 1]) return fp[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xp[m] <= x) lo = m; else hi = m; }
    return fp[lo] + ((fp[hi] - fp[lo]) * (x - xp[lo])) / (xp[hi] - xp[lo] || 1);
  };
  return typeof xs === "number" ? one(xs) : Array.from(xs, one);
}

function searchsorted(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * Bend class per resampled point: 0 straight, 1 sweeping ... 4 hairpin-tight.
 *
 * Radius of the circle through the points 20 m either side, cross-checked at 40 m. On a 40 m chord a 1 m
 * digitising wobble already reads as a 175 m "sweeper", so detailed OSM mapping would invent bends. A real
 * bend has the same radius at both scales; a wobble vanishes at the wider one. The 0.7 lets hairpins (shorter
 * than 80 m) keep their tight radius.
 */
function bendClasses(x, y) {
  const n = x.length, cls = new Uint8Array(n);
  const radius = (i, k) => {
    const ax = x[i - k], ay = y[i - k], bx = x[i], by = y[i], cx = x[i + k], cy = y[i + k];
    const ab = Math.hypot(bx - ax, by - ay), bc = Math.hypot(cx - bx, cy - by), ca = Math.hypot(ax - cx, ay - cy);
    const r = (ab * bc * ca) / (2 * Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)));
    return Number.isFinite(r) ? r : Infinity;
  };
  const k = RADIUS_OFFSET, wide = 2 * RADIUS_OFFSET;
  for (let i = k; i < n - k; i++) {
    let r = radius(i, k);
    if (i >= wide && i < n - wide) r = Math.max(r, 0.7 * radius(i, wide));
    for (let b = 0; b < BENDS.length; b++) if (r < BENDS[b][0]) cls[i] = b + 1;
  }
  return cls;
}

/**
 * Bend class every 10 m along a line of [lon, lat, ...] points. The UI uses this on the smoothed line of the
 * selected road, so its colouring follows the actual bends rather than the stored vertices.
 * Returns { step, cls } where cls[i] is the class at distance i * step.
 */
export function bendsAlong(points) {
  const lat0 = points[0][1], cos0 = Math.cos(rad(lat0));
  const x = points.map((p) => rad(p[0]) * R_EARTH * cos0), y = points.map((p) => rad(p[1]) * R_EARTH);
  const vd = [0];
  for (let i = 1; i < x.length; i++) vd.push(vd[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]));
  const sr = [];
  for (let d = 0; d <= vd[vd.length - 1]; d += STEP) sr.push(d);
  return { step: STEP, cls: bendClasses(interp(sr, vd, x), interp(sr, vd, y)) };
}

/** Where hairpins are (sample index): >= 150 deg of same-direction turning within 120 m. */
function hairpinsAt(x, y) {
  const h = [];
  for (let i = 0; i < x.length - 1; i++) h.push(Math.atan2(y[i + 1] - y[i], x[i + 1] - x[i]));
  const cs = [0];
  for (let i = 0; i < h.length - 1; i++) {
    const d = h[i + 1] - h[i];
    cs.push(cs[i] + ((((d + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI);
  }
  const win = 120 / STEP, lim = rad(150);
  const at = [];
  let i = 0;
  while (i < cs.length - 1) {
    let hit = -1;
    for (let k = i + 1; k <= Math.min(i + win, cs.length - 1); k++) if (Math.abs(cs[k] - cs[i]) >= lim) { hit = k; break; }
    if (hit >= 0) { at.push((i + hit) >> 1); i = hit; } else i++;
  }
  return at;
}

/** Sample indices of crests and dips: the profile turns after rising or falling at least `swing` metres. */
function crestsAndDips(e, swing = 5) {
  const at = [];
  let ext = 0, dir = 0;
  for (let i = 1; i < e.length; i++) {
    if (dir === 0) {
      if (Math.abs(e[i] - e[0]) >= swing) { dir = e[i] > e[0] ? 1 : -1; ext = i; }
    } else if (dir === 1) {
      if (e[i] > e[ext]) ext = i;
      else if (e[ext] - e[i] >= swing) { at.push(ext); ext = i; dir = -1; }
    } else {
      if (e[i] < e[ext]) ext = i;
      else if (e[i] - e[ext] >= swing) { at.push(ext); ext = i; dir = 1; }
    }
  }
  return at;
}

/**
 * Built-up by the road's own tags: only explicit urban markers ("FR:urban", "DE:zone30"...). A plain 40 or
 * 50 limit isn't enough: Alpine passes are often signed that low through their hairpins.
 */
function urbanTags(t) {
  const v = [t["maxspeed:type"], t["zone:maxspeed"], t["source:maxspeed"], t.maxspeed].filter(Boolean).join(" ");
  return /urban|zone/i.test(v);
}

/** Points bucketed into ~2 km cells for "anything within X m?" lookups. */
function pointGrid(points) {
  const g = new Map();
  for (const p of points) {
    const k = `${Math.floor(p.lat / 0.02)},${Math.floor(p.lon / 0.02)}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(p);
  }
  return (lon, lat, fn) => {
    const i = Math.floor(lat / 0.02), j = Math.floor(lon / 0.02), cc = Math.cos(rad(lat));
    for (let a = i - 1; a <= i + 1; a++) for (let b = j - 1; b <= j + 1; b++) {
      for (const p of g.get(`${a},${b}`) || []) fn(p, Math.hypot((p.lon - lon) * cc, p.lat - lat) * rad(1) * R_EARTH);
    }
  };
}

const PLACE_RADIUS = { city: 1800, town: 800, village: 350 };
const RING = [800, 1600];                         // m: "surroundings" for the view measure
const SIDE = [60, 120];                           // m: either side of the road, for drop-offs
const offset = (lon, lat, dx, dy) => [lon + (dx / (R_EARTH * Math.cos(rad(lat)))) * (180 / Math.PI), lat + (dy / R_EARTH) * (180 / Math.PI)];
const ringPoints = (lon, lat) => {
  const lo = [], la = [];
  for (const r of RING) for (let k = 0; k < 8; k++) {
    const [x, y] = offset(lon, lat, r * Math.cos((k * Math.PI) / 4), r * Math.sin((k * Math.PI) / 4));
    lo.push(x); la.push(y);
  }
  return [lo, la];
};

/** Index ranges of curvy stretches, split wherever there's a long straight. */
function sections(cls) {
  const split = SPLIT_STRAIGHT / STEP, pad = PAD / STEP, n = cls.length, out = [];
  let start = -1, last = -1;
  for (let i = 0; i < n; i++) {
    if (!cls[i]) continue;
    if (start < 0) start = i;
    else if (i - last > split) { out.push([start, last]); start = i; }
    last = i;
  }
  if (start >= 0) out.push([start, last]);
  return out.map(([a, b]) => [Math.max(0, a - pad), Math.min(n - 1, b + pad)]);
}

/** Douglas-Peucker: which vertices to keep so the line stays within tol metres. */
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

/** A road cut into a cliff picks up the cliff: median, slope-limit, then average. */
function smoothElevation(e, medianN = 11, meanN = 25) {
  if (e.length < meanN) return e;
  const padEdge = (a, p) => [...Array(p).fill(a[0]), ...a, ...Array(p).fill(a[a.length - 1])];
  let p = padEdge(e, medianN >> 1);
  let m = e.map((_, i) => p.slice(i, i + medianN).sort((a, b) => a - b)[medianN >> 1]);
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
  for (let i = 1; i < e.length; i++) {
    const v = e[i];
    if (v - ref >= 3) { up += v - ref; ref = v; } else if (ref - v >= 3) { down += ref - v; ref = v; }
  }
  const win = 300 / STEP;
  let g = 0;
  for (let i = 0; i + win < e.length; i++) g = Math.max(g, Math.abs(e[i + win] - e[i]) / (win * STEP));
  return [up, down, g];
}

/** Stable id from the road's end points, so links and saved favourites survive re-scans. */
function roadId(coords) {
  const s = `${coords[0][0]},${coords[0][1]},${coords[coords.length - 1][0]},${coords[coords.length - 1][1]}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return "r" + (h >>> 0).toString(36);
}

// ------------------------------------------------------------------ main

/**
 * @param elements  Overpass elements (ways with geometry, pass and place nodes)
 * @param bbox      [south, west, north, east]; passes outside it are dropped
 * @param terrain   a Terrain
 * @returns {roads, passes}
 */
export async function findTwisties(elements, bbox, terrain, { maxRoads = 400, onProgress = () => {} } = {}) {
  onProgress("Finding the twisty bits…");
  const ways = new Map(), passNodes = [], places = [], viewpoints = [];
  for (const el of elements) {
    const t = el.tags || {};
    if (el.type === "way") { if (el.nodes?.length >= 2 && el.geometry && rideable(t)) ways.set(el.id, el); }
    else if ("mountain_pass" in t) passNodes.push(el);
    else if ("place" in t && t.name) places.push(el);
    else if (t.tourism === "viewpoint") viewpoints.push(el);
  }
  const nearPlace = pointGrid(places), nearViewpoint = pointGrid(viewpoints);
  const roadNodes = new Set();
  for (const w of ways.values()) for (const nd of w.nodes) roadNodes.add(nd);
  const passList = passNodes.filter((p) => p.tags?.name && roadNodes.has(p.id));   // road passes, not hiking cols

  // 1. candidate sections
  const candidates = [];
  const mid = tasteWeights(0.5).bends;
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
    const cls = bendClasses(rx, ry);

    for (const [a, b] of sections(cls)) {
      const length = (b - a) * STEP;
      const bends = [0, 0, 0, 0];
      for (let i = a; i < b; i++) if (cls[i]) bends[cls[i] - 1] += STEP / 1000;
      const curvy = bends.reduce((s, km, i) => s + km * mid[i], 0);
      if (length < MIN_LEN || curvy < MIN_CURVY_KM || curvy / (length / 1000) < MIN_DENSITY) continue;
      candidates.push({ lon, lat, vd, segWay, cos0, a, b, rx, ry, cls, length, curvy, bends });
    }
  }
  candidates.sort((p, q) => q.curvy - p.curvy);
  candidates.length = Math.min(candidates.length, Math.round(maxRoads * 1.6));
  if (!candidates.length) return { roads: [], passes: [] };

  // 2. terrain for everything we'll keep
  const need = new Set();
  for (const c of candidates) {
    c.rsLon = []; c.rsLat = [];
    for (let i = c.a; i <= c.b; i++) {
      c.rsLon.push((c.rx[i] / (R_EARTH * c.cos0)) * (180 / Math.PI));
      c.rsLat.push((c.ry[i] / R_EARTH) * (180 / Math.PI));
    }
    terrain.need(c.rsLon, c.rsLat, need);
    // slice centres, and the surroundings we'll sample for the view measure
    c.centres = [];
    for (let i = PER_BIN >> 1; i < c.rsLon.length; i += PER_BIN) {
      c.centres.push(i);
      terrain.need(...ringPoints(c.rsLon[i], c.rsLat[i]), need);
    }
  }
  terrain.need(passList.map((p) => p.lon), passList.map((p) => p.lat), need);
  await terrain.load(need, onProgress);
  onProgress(`Scoring ${candidates.length} roads…`);

  // 3. describe each section
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

    const owner = (d) => c.segWay[Math.min(c.segWay.length - 1, searchsorted(c.vd, d))];
    const tagsAt = (d) => ways.get(owner(d)).tags || {};

    // elevation; in tunnels / on bridges the terrain is the mountain above or valley below, so bridge the gap
    const raw = terrain.sample(c.rsLon, c.rsLat);
    const rsD = raw.map((_, i) => (c.a + i) * STEP);
    const off = rsD.map((d) => isOffGround(tagsAt(d)));
    if (off.some(Boolean) && !off.every(Boolean)) {
      const gd = rsD.filter((_, i) => !off[i]), ge = raw.filter((_, i) => !off[i]);
      off.forEach((o, i) => { if (o) raw[i] = interp(rsD[i], gd, ge); });
    }
    const ele = smoothElevation(raw);
    let [up, down, maxGrad] = climbStats(ele);
    const eleV = interp(outD, rsD, ele);

    const sx = c.rx.slice(c.a, c.b + 1), sy = c.ry.slice(c.a, c.b + 1);
    const pins = hairpinsAt(sx, sy);
    const hairpins = pins.length;

    // 200 m slices: bend mix, hairpins, crests/dips, built-up, views, drop-offs, viewpoints
    const nBins = Math.max(1, Math.ceil((ele.length - 1) / PER_BIN));
    const bins = Array.from({ length: nBins }, () => ({ c: [0, 0, 0, 0], h: 0, r: 0, v: 0, p: 0, u: 0, x: 0 }));
    const binOf = (i) => Math.min(nBins - 1, Math.floor(i / PER_BIN));
    for (let i = 0; i < ele.length - 1; i++) {
      const b = bins[binOf(i)], cl = c.cls[c.a + i];
      if (cl) b.c[cl - 1]++;
      if (urbanTags(tagsAt(rsD[i]))) b.u++;
    }
    for (const i of pins) bins[binOf(i)].h++;
    for (const i of crestsAndDips(ele)) bins[binOf(i)].r++;
    c.centres.forEach((i, bi) => {
      if (bi >= nBins) return;
      const b = bins[bi], lo = c.rsLon[i], la = c.rsLat[i];
      let inPlace = false;
      nearPlace(lo, la, (p, d) => { if (d < (PLACE_RADIUS[p.tags.place] || 0)) inPlace = true; });
      if (inPlace) b.u = PER_BIN;
      nearViewpoint(lo, la, (p, d) => { if (d < 200) b.x = 1; });
      // view: how much of the horizon falls away below the road (half of it open = a full view). A balcony
      // above a lake scores even with vineyards rising behind it; a valley floor doesn't.
      const around = terrain.sample(...ringPoints(lo, la));
      const open = around.filter((h) => h <= ele[i] - 60).length / around.length;
      b.v = Math.min(9, (open / 0.5) * 9);
      // drop-off: the steepest fall-away within 120 m either side
      const j = Math.min(i + 1, sx.length - 1), k0 = Math.max(0, i - 1);
      const hx = sx[j] - sx[k0], hy = sy[j] - sy[k0], hl = Math.hypot(hx, hy) || 1;
      const sl = [], st = [];
      for (const side of [-1, 1]) for (const m of SIDE) {
        const [x, y] = offset(lo, la, (side * -hy * m) / hl, (side * hx * m) / hl);
        sl.push(x); st.push(y);
      }
      const drop = ele[i] - Math.min(...terrain.sample(sl, st));
      b.p = Math.max(0, Math.min(9, ((drop - 25) / 70) * 9));
    });

    // names and warnings, weighted by length
    const nameLen = new Map(), refLen = new Map();
    let narrow = 0, tunnel = 0, toll = false, closed = null;
    for (let j = 0; j < outD.length - 1; j++) {
      const t = tagsAt((outD[j] + outD[j + 1]) / 2), L = outD[j + 1] - outD[j];
      if (t.name) nameLen.set(t.name, (nameLen.get(t.name) || 0) + L);
      if (t.ref) refLen.set(t.ref, (refLen.get(t.ref) || 0) + L);
      if (isNarrow(t)) narrow += L;
      if (isTunnel(t)) tunnel += L;
      if (t.toll === "yes") toll = true;
      closed ??= closure(t);
    }
    const top = (m) => [...m].sort((p, q) => q[1] - p[1])[0]?.[0] ?? null;
    const name = top(nameLen), ref = top(refLen), nameShare = name ? nameLen.get(name) / c.length : 0;

    let pass = null;
    for (const p of passList) {
      const cc = Math.cos(rad(p.lat));
      let dd = Infinity;
      for (let i = 0; i < outLon.length; i++) dd = Math.min(dd, Math.hypot((outLon[i] - p.lon) * cc, outLat[i] - p.lat));
      if (dd * rad(1) * R_EARTH >= 80) continue;
      let pe = parseFloat((p.tags.ele || "").split(" ")[0].replace(",", "."));
      if (!Number.isFinite(pe)) pe = terrain.sample([p.lon], [p.lat])[0];
      const cand = { name: p.tags.name, ele: Math.round(pe), lon: +p.lon.toFixed(5), lat: +p.lat.toFixed(5) };
      if (!pass || cand.ele > pass.ele) pass = cand;
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

    // title: pass > a name covering most of it > road number > any name
    const title = pass ? pass.name : name && (nameShare >= 0.6 || !ref) ? name : ref || name || "Unnamed road";
    const sub = [ref !== title ? ref : null, name && name !== title && nameShare >= 0.3 ? name : null].filter(Boolean).join(" · ");

    let coords = outLon.map((lo, i) => [+lo.toFixed(5), +outLat[i].toFixed(5), Math.round(eleV[i])]);
    if (down > up) {                                   // present every road uphill-first
      coords = coords.reverse(); towns = towns.reverse(); bins.reverse(); [up, down] = [down, up];
    }
    const road = {
      id: roadId(coords),
      name: title, road: sub || null,
      from: towns[0], to: towns[1] !== towns[0] ? towns[1] : null,
      len: Math.round(c.length),
      bends: c.bends.map((km) => +km.toFixed(2)),
      hairpins, climb: Math.round(up), descent: Math.round(down),
      eleMin: Math.round(Math.min(...ele)), eleMax: Math.round(Math.max(...ele)),
      maxGrad: +(maxGrad * 100).toFixed(1),
      pass,
      warn: {
        narrow: Math.round((100 * narrow) / c.length),
        tunnel: Math.round((100 * tunnel) / c.length),
        toll, closed,
      },
      coords,
      bins: encodeBins(bins),
    };
    road.score = scoreRoad(road).score;
    roads.push(road);
  }
  roads.sort((p, q) => q.score - p.score);
  roads.length = Math.min(roads.length, maxRoads);

  const [s, w, n, e] = bbox;
  const passes = passList
    .filter((p) => p.lat >= s && p.lat <= n && p.lon >= w && p.lon <= e)
    .map((p) => {
      const pe = parseInt(p.tags.ele, 10);
      return { name: p.tags.name, ele: Number.isFinite(pe) ? pe : null, lon: +p.lon.toFixed(5), lat: +p.lat.toFixed(5) };
    });
  return { roads, passes };
}
