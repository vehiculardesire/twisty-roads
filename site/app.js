/* Twisty Roads: MapLibre + 3D terrain + elevation profile. No build step. */
import { ALGO_VERSION, BENDS, bendsAlong, scoreRoad } from "./core/twisty.js";

const $ = (s) => document.querySelector(s);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => Math.round(n).toLocaleString("en");
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const km = (m) => (m / 1000).toFixed(1);
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const TERRAIN_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const BEND_NAMES = ["Straight", ...BENDS.map(([, n]) => n)];
const BEND_RADII = ["", ...BENDS.map(([r]) => `under ${r} m radius`)];
const RIDING_SPEED = 80;   // km/h, for "feels like"

// ------------------------------------------------------------------ data: built-in region + saved scans

const [home, baseStyle, savedAreas] = await Promise.all([
  fetch("data/home.json").then((r) => r.json()),
  fetch("https://tiles.openfreemap.org/styles/positron").then((r) => r.json()),
  areasDB("getAll").catch(() => []),
]);
// Drop the style's low-zoom shaded-relief raster: we draw our own hillshade, and when its server is slow
// MapLibre waits on it forever.
delete baseStyle.sources.ne2_shaded;
baseStyle.layers = baseStyle.layers.filter((l) => l.source !== "ne2_shaded");

const state = {
  sort: "score", query: "", passesOnly: false, inView: true,
  taste: store.get("taste", 0.5),
  sel: null, view: null, hover: null, is3d: true, exag: 1.4,
};

let roads = [], passes = [], byId = new Map();
let areas = [];                   // saved scans, newest last
addArea({ key: "home", roads: home.roads, passes: home.passes, bbox: home.bbox });
for (const a of savedAreas.filter((a) => a.v === ALGO_VERSION).sort((a, b) => a.date - b.date)) addArea(a);

/** Merge an area's roads in, replacing whatever we had inside its box. */
function addArea(area) {
  const [s, w, n, e] = area.bbox;
  const inBox = (r) => { const [lo, la] = r.coords[r.coords.length >> 1]; return la > s && la < n && lo > w && lo < e; };
  if (area.key !== "home") {
    roads = roads.filter((r) => r.area !== area.key && !inBox(r));
    areas = [...areas.filter((a) => a.key !== area.key), area];
  }
  for (const r of area.roads) {
    r.area = area.key;
    const lons = r.coords.map((c) => c[0]), lats = r.coords.map((c) => c[1]);
    r.bb = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
    r.inBends = r.bends.reduce((a, b) => a + b, 0) / (r.len / 1000);   // share of the road that's bends
  }
  roads.push(...area.roads);
  const known = new Set(passes.map((p) => `${p.lon},${p.lat}`));
  passes.push(...area.passes.filter((p) => !known.has(`${p.lon},${p.lat}`)));
  rescore();
}

function removeArea(key) {
  roads = roads.filter((r) => r.area !== key);
  areas = areas.filter((a) => a.key !== key);
  areasDB("delete", key).catch(() => {});
  rescore();
  refreshMapData();
  renderAreas();
}

function rescore() {
  for (const r of roads) {
    r.fx = scoreRoad(r, state.taste);      // score + best stretch + hot spots, for this taste
    r.score = r.fx.score;
    r.scenery = r.fx.scenery.score;
  }
  byId = new Map(roads.map((r) => [r.id, r]));
}

/** Tiny IndexedDB wrapper for saved scans (they're too big for localStorage). */
function areasDB(op, arg) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("twisty-roads", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("areas", { keyPath: "key" });
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction("areas", op === "getAll" ? "readonly" : "readwrite");
      const st = tx.objectStore("areas");
      const r = op === "getAll" ? st.getAll() : op === "put" ? st.put(arg) : st.delete(arg);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    };
  });
}

// ------------------------------------------------------------------ geometry helpers

function haversine(a, b) {
  const R = 6371008.8, toR = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toR, dLon = (b[0] - a[0]) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearing(a, b) {
  const toR = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * toR) * Math.cos(b[1] * toR);
  const x = Math.cos(a[1] * toR) * Math.sin(b[1] * toR) - Math.sin(a[1] * toR) * Math.cos(b[1] * toR) * Math.cos((b[0] - a[0]) * toR);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/**
 * Smooth line through every stored point (centripetal Catmull-Rom, which passes exactly through each
 * point and doesn't overshoot), sampled every ~2 m. Used for the selected road only.
 */
function smoothPath(coords, spacing = 2) {
  const kx = 111320 * Math.cos((coords[0][1] * Math.PI) / 180), ky = 110540;
  const P = coords.map((c) => [c[0] * kx, c[1] * ky, c[2]]);
  const d = (a, b) => Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), 1e-6);
  const lerp = (a, b, ta, tb, t) => [0, 1].map((k) => ((tb - t) * a[k] + (t - ta) * b[k]) / (tb - ta));
  const out = [];
  for (let i = 0; i < P.length - 1; i++) {
    const p1 = P[i], p2 = P[i + 1];
    const p0 = P[i - 1] ?? [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]];
    const p3 = P[i + 2] ?? [2 * p2[0] - p1[0], 2 * p2[1] - p1[1]];
    const t1 = Math.sqrt(d(p0, p1)), t2 = t1 + Math.sqrt(d(p1, p2)), t3 = t2 + Math.sqrt(d(p2, p3));
    const steps = Math.max(1, Math.ceil(d(p1, p2) / spacing));
    for (let s = 0; s < steps; s++) {
      const t = t1 + ((t2 - t1) * s) / steps;
      const a1 = lerp(p0, p1, 0, t1, t), a2 = lerp(p1, p2, t1, t2, t), a3 = lerp(p2, p3, t2, t3, t);
      const b1 = lerp(a1, a2, 0, t2, t), b2 = lerp(a2, a3, t1, t3, t);
      const c = lerp(b1, b2, t1, t2, t);
      out.push([c[0] / kx, c[1] / ky, p1[2] + ((p2[2] - p1[2]) * s) / steps]);
    }
  }
  const last = coords[coords.length - 1];
  out.push([last[0], last[1], last[2]]);
  return out;
}

/**
 * Bend classes every 10 m flicker (a 10 m wobble in a sweeper reads as "tight"). A rider feels a bend over
 * tens of metres, so: majority vote over 70 m, then fold any run shorter than 40 m into the one before it.
 */
function steadyBends(raw) {
  const n = raw.length, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const counts = [0, 0, 0, 0, 0];
    for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) counts[raw[j]]++;
    out[i] = counts.reduce((best, c, k) => (c >= counts[best] ? k : best), 0);   // ties go to the tighter bend
  }
  for (let i = 0, prev = out[0]; i < n;) {
    let j = i;
    while (j < n && out[j] === out[i]) j++;
    if (j - i < 4 && i > 0) out.fill(prev, i, j); else prev = out[i];
    i = j;
  }
  return out;
}

/** A road in the chosen direction, on its smoothed line: coords, cumulative distance, lookups, bends. */
function makeView(road, reversed) {
  const coords = smoothPath(reversed ? [...road.coords].reverse() : road.coords);
  const dist = [0];
  for (let i = 1; i < coords.length; i++) dist.push(dist[i - 1] + haversine(coords[i - 1], coords[i]));
  const total = dist[dist.length - 1];
  const bends = bendsAlong(coords);
  const cls = steadyBends(bends.cls);
  const bendAt = (dd) => cls[clamp(Math.round(dd / bends.step), 0, cls.length - 1)];

  function at(dd) {
    dd = clamp(dd, 0, total);
    let lo = 0, hi = dist.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (dist[mid] <= dd) lo = mid; else hi = mid; }
    const t = (dd - dist[lo]) / (dist[hi] - dist[lo] || 1), a = coords[lo], b = coords[hi];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  const gradeAt = (dd) => (at(dd + 150)[2] - at(dd - 150)[2]) / (Math.min(total, dd + 150) - Math.max(0, dd - 150) || 1);
  const nearest = (lng, lat) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < coords.length; i += 4) {
      const q = (coords[i][0] - lng) ** 2 + (coords[i][1] - lat) ** 2;
      if (q < bd) { bd = q; best = i; }
    }
    return dist[best];
  };

  return {
    road, reversed, coords, dist, total, at, gradeAt, bendAt, nearest,
    from: reversed ? road.to : road.from,
    to: reversed ? road.from : road.to,
    climb: reversed ? road.descent : road.climb,
    descent: reversed ? road.climb : road.descent,
  };
}

/** The selected road as runs of one bend class each: smooth colours, no joints every few metres. */
function bendRuns(v) {
  const feats = [];
  let run = [v.coords[0]], cls = v.bendAt(0);
  for (let i = 1; i < v.coords.length; i++) {
    const c = v.bendAt(v.dist[i]);
    run.push(v.coords[i]);
    if (c !== cls || i === v.coords.length - 1) {
      feats.push({ type: "Feature", properties: { c: cls }, geometry: { type: "LineString", coordinates: run.map((p) => [p[0], p[1]]) } });
      run = [v.coords[i]];
      cls = c;
    }
  }
  return { type: "FeatureCollection", features: feats };
}

// ------------------------------------------------------------------ map

const map = new maplibregl.Map({
  container: "map",
  style: baseStyle,
  bounds: [[home.bbox[1], home.bbox[0]], [home.bbox[3], home.bbox[2]]],
  fitBoundsOptions: { padding: 20 },
  pitch: 40,
  maxPitch: 80,
  attributionControl: { compact: true },
});
window.map = map; // handy in the devtools console
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

/**
 * Rotate and tilt around the point you grabbed (right-drag or Ctrl+drag), not the middle of the screen.
 * MapLibre's own handler always pivots on the centre, so it's swapped for this one.
 */
map.dragRotate.disable();
map.getCanvasContainer().addEventListener("contextmenu", (e) => e.preventDefault());
map.getCanvasContainer().addEventListener("mousedown", (e) => {
  if (!(e.button === 2 || (e.button === 0 && e.ctrlKey))) return;
  e.preventDefault();
  const rect = map.getCanvas().getBoundingClientRect();
  const point = [e.clientX - rect.left, e.clientY - rect.top];
  let around = map.unproject(point);
  // grabbed the sky (or something absurdly far away at a steep pitch): fall back to the centre
  if (!around || around.distanceTo(map.getCenter()) > 200000) around = map.getCenter();
  const start = { x: e.clientX, y: e.clientY, bearing: map.getBearing(), pitch: map.getPitch() };
  map.getCanvas().style.cursor = "grabbing";

  const move = (ev) => {
    map.easeTo({
      bearing: start.bearing + (ev.clientX - start.x) * 0.8,
      pitch: clamp(start.pitch - (ev.clientY - start.y) * 0.5, 0, map.getMaxPitch()),
      around, duration: 0,
    });
  };
  const up = () => {
    removeEventListener("mousemove", move);
    removeEventListener("mouseup", up);
    map.getCanvas().style.cursor = "";
  };
  addEventListener("mousemove", move);
  addEventListener("mouseup", up);
});

const rider = new maplibregl.Marker({ element: Object.assign(document.createElement("div"), { className: "rider" }) });
let riderOn = false;
function showRider(p) {
  rider.setLngLat([p[0], p[1]]);
  if (!riderOn) { rider.addTo(map); riderOn = true; }
}
function hideRider() { if (riderOn) { rider.remove(); riderOn = false; } }
const peakMarker = new maplibregl.Marker({
  element: Object.assign(document.createElement("div"), { className: "peak", textContent: "★", title: "The best bit" }),
});

const emptyFC = { type: "FeatureCollection", features: [] };

// Set up as soon as the style is parsed; don't wait for every tile ("load") - one slow tile server shouldn't block the app.
const mapReady = new Promise((resolve) => map.once("style.load", resolve));
mapReady.then(() => {
  const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;

  map.addSource("dem", { type: "raster-dem", tiles: [TERRAIN_TILES], encoding: "terrarium", tileSize: 256, maxzoom: 15 });
  map.addSource("hs", { type: "raster-dem", tiles: [TERRAIN_TILES], encoding: "terrarium", tileSize: 256, maxzoom: 15 });
  map.addLayer({
    id: "hillshade", type: "hillshade", source: "hs",
    paint: { "hillshade-exaggeration": 0.45, "hillshade-shadow-color": "#5a5a55", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#8a8a84" },
  }, firstSymbol);
  map.setTerrain({ source: "dem", exaggeration: state.exag });
  map.setSky({
    "sky-color": "#b9d3ee", "horizon-color": "#eef2f5", "fog-color": "#f3f3f1",
    "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.7, "fog-ground-blend": 0.85,
  });

  map.addSource("roads", { type: "geojson", data: roadsGeoJSON() });
  // zoom must be the outermost interpolation; per-road score scales the width inside each stop
  const scoreWidth = ["interpolate", ["linear"], ["get", "score"], 0, 1, 100, 2.2];
  const width = (base, byScore = false) => ["interpolate", ["linear"], ["zoom"],
    ...[[7, 0.8], [10, 1.6], [14, 3.2], [17, 6]].flatMap(([z, k]) => [z, byScore ? ["*", scoreWidth, base * k] : base * k])];
  map.addLayer({
    id: "roads-casing", type: "line", source: "roads",
    layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["get", "score"] },
    paint: { "line-color": "#ffffff", "line-width": width(1.7, true), "line-opacity": 0.9 },
  }, firstSymbol);
  map.addLayer({
    id: "roads", type: "line", source: "roads",
    layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["get", "score"] },
    paint: {
      "line-color": ["interpolate", ["linear"], ["get", "score"], 0, css("--s1"), 35, css("--s2"), 65, css("--s3"), 100, css("--s4")],
      "line-width": width(1, true),
    },
  }, firstSymbol);
  map.addLayer({
    id: "roads-hover", type: "line", source: "roads", filter: ["==", ["get", "id"], ""],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#0b0b0b", "line-width": width(2.6), "line-opacity": 0.85 },
  }, "roads");

  // selected road: one continuous white casing under runs coloured by bend tightness
  map.addSource("sel", { type: "geojson", data: emptyFC });
  map.addSource("sel-runs", { type: "geojson", data: emptyFC });
  map.addSource("hot", { type: "geojson", data: emptyFC });
  map.addLayer({
    id: "hot-glow", type: "line", source: "hot",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": css("--accent"), "line-width": width(11), "line-opacity": 0.45, "line-blur": 3 },
  });
  map.addLayer({
    id: "sel-casing", type: "line", source: "sel",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": width(5) },
  });
  map.addLayer({
    id: "sel-line", type: "line", source: "sel-runs",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["match", ["get", "c"], 1, css("--c1"), 2, css("--c2"), 3, css("--c3"), 4, css("--c4"), css("--c0")],
      "line-width": width(3.2),
    },
  });

  map.addSource("passes", { type: "geojson", data: passesGeoJSON() });
  map.addSource("scan-area", { type: "geojson", data: emptyFC });
  map.addLayer({
    id: "scan-area", type: "line", source: "scan-area",
    paint: { "line-color": css("--accent"), "line-width": 2, "line-dasharray": [3, 2] },
  });
  map.addLayer({
    id: "passes", type: "symbol", source: "passes", minzoom: 9,
    layout: {
      "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 11,
      "text-anchor": "top", "text-offset": [0, 0.6], "symbol-sort-key": ["-", 0, ["get", "ele"]],
    },
    paint: { "text-color": "#3a2a1a", "text-halo-color": "#ffffff", "text-halo-width": 1.6 },
  });
  map.addLayer({
    id: "pass-dots", type: "circle", source: "passes", minzoom: 8,
    paint: { "circle-radius": 3.5, "circle-color": "#3a2a1a", "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5 },
  }, "passes");

  // ---- hover & click on roads
  const tip = $("#tip");
  const topFeature = (e) => e.features.reduce((a, b) => (b.properties.score > a.properties.score ? b : a));
  map.on("mousemove", "roads", (e) => {
    const r = byId.get(topFeature(e).properties.id);
    if (!r) return;
    map.getCanvas().style.cursor = "pointer";
    setHover(r.id, "map");
    tip.hidden = false;
    tip.innerHTML = `<b>${esc(r.name)}</b>Fun ${r.score} · ${km(r.len)} km · ${r.hairpins} hairpins`;
    tip.style.left = `${e.point.x + 14}px`;
    tip.style.top = `${e.point.y + 14}px`;
  });
  map.on("mouseleave", "roads", () => {
    map.getCanvas().style.cursor = "";
    tip.hidden = true;
    setHover(null);
  });
  map.on("click", "roads", (e) => {
    if (state.sel && map.queryRenderedFeatures(e.point, { layers: ["sel-line"] }).length) return;
    select(byId.get(topFeature(e).properties.id));
  });

  // hovering the selected road moves the profile crosshair
  map.on("mousemove", "sel-line", (e) => { if (state.view && !fly) setCursor(state.view.nearest(e.lngLat.lng, e.lngLat.lat)); });
  map.on("mouseleave", "sel-line", () => { if (!fly) setCursor(null); });

  let moveTimer;
  map.on("moveend", () => { clearTimeout(moveTimer); moveTimer = setTimeout(() => state.inView && renderList(), 120); });

  applyFilter();
  const scanArg = location.hash.match(/scan=(-?[\d.]+),(-?[\d.]+),(\d+)/);
  const roadArg = location.hash.match(/road=(\w+)/);
  if (scanArg && !areas.some((a) => a.key === areaKey(+scanArg[1], +scanArg[2], +scanArg[3]))) {
    runScan(+scanArg[1], +scanArg[2], +scanArg[3], null, roadArg?.[1]);
  } else if (roadArg && byId.has(roadArg[1])) {
    select(byId.get(roadArg[1]));
  }
});

function roadsGeoJSON() {
  return {
    type: "FeatureCollection",
    features: roads.map((r) => ({
      type: "Feature",
      properties: { id: r.id, score: r.score },
      geometry: { type: "LineString", coordinates: r.coords.map((c) => [c[0], c[1]]) },
    })),
  };
}

function passesGeoJSON() {
  return {
    type: "FeatureCollection",
    features: passes.map((p) => ({
      type: "Feature",
      properties: { label: p.ele ? `${p.name}\n${fmt(p.ele)} m` : p.name, ele: p.ele || 0 },
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
    })),
  };
}

function refreshMapData() {
  map.getSource("roads")?.setData(roadsGeoJSON());
  map.getSource("passes")?.setData(passesGeoJSON());
  applyFilter();
}

// ------------------------------------------------------------------ scan anywhere

let scanning = false;
const areaKey = (lat, lon, r) => `${lat.toFixed(3)},${lon.toFixed(3)},${r}`;

/** Download + score roads within radiusKm of a point, in a worker, then merge them in and save them. */
function runScan(lat, lon, radiusKm, label, selectId = null) {
  if (!map.getSource("scan-area")) { mapReady.then(() => runScan(lat, lon, radiusKm, label, selectId)); return; }
  if (scanning) return;
  scanning = true;
  const dLat = radiusKm / 111.32, dLon = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  const bbox = [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
  showScanBox(bbox);
  map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]], { padding: 40, pitch: state.is3d ? 40 : 0, duration: 1200 });
  setScanUI(true, "Starting…");

  const worker = new Worker("scan-worker.js", { type: "module" });
  worker.onmessage = ({ data: msg }) => {
    if (msg.type === "progress") return setScanUI(true, msg.msg);
    worker.terminate();
    scanning = false;
    if (msg.type === "error") return setScanUI(false, msg.message, true);

    const area = {
      key: areaKey(lat, lon, radiusKm), v: ALGO_VERSION, date: Date.now(),
      label: label || `${lat.toFixed(2)}, ${lon.toFixed(2)}`, radius: radiusKm, bbox,
      roads: msg.roads, passes: msg.passes,
    };
    addArea(area);
    areasDB("put", { ...area, roads: msg.roads.map(({ area: _a, bb: _b, inBends: _i, fx: _f, scenery: _s, ...r }) => r) }).catch(() => {});
    refreshMapData();
    renderAreas();

    const best = [...msg.roads].sort((a, b) => b.score - a.score)[0];
    setScanUI(false, msg.roads.length
      ? `Found ${msg.roads.length} twisty roads around ${area.label}. Best: ${best.name} (${best.score}).`
      : "No twisty paved roads found here. Try a bigger radius or a hillier area.");
    history.replaceState(null, "", `#scan=${lat.toFixed(3)},${lon.toFixed(3)},${radiusKm}`);
    if (selectId && byId.has(selectId)) select(byId.get(selectId));
  };
  worker.onerror = (e) => { scanning = false; worker.terminate(); setScanUI(false, `Scan failed: ${e.message}`, true); };
  worker.postMessage({ bbox });
}

function showScanBox(bbox) {
  const [s, w, n, e] = bbox;
  map.getSource("scan-area").setData({ type: "Feature", geometry: { type: "LineString", coordinates: [[w, s], [e, s], [e, n], [w, n], [w, s]] } });
}

function setScanUI(busy, msg, isError = false) {
  for (const b of ["#scanGo", "#scanView", "#nearMe"]) $(b).disabled = busy;
  $("#scanGo").textContent = busy ? "Scanning…" : "Find twisties";
  const st = $("#scanStatus");
  st.hidden = !msg;
  st.textContent = msg || "";
  st.classList.toggle("error", isError);
  st.classList.toggle("busy", busy);
}

$("#scanForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#place").value.trim(), radius = +$("#radius").value;
  if (!q) { const c = map.getCenter(); return runScan(c.lat, c.lng, radius, null); }
  setScanUI(true, `Looking up "${q}"…`);
  let f;
  try {
    // prefer the biggest real place among the top matches (the village, not a hamlet or a street of the same name)
    const found = (await fetch(`https://photon.komoot.io/api/?limit=6&q=${encodeURIComponent(q)}`).then((r) => r.json())).features || [];
    const rank = (x) => x.properties.osm_key !== "place" ? 9
      : ["city", "town", "village", "municipality", "suburb", "hamlet"].indexOf(x.properties.osm_value) + 1 || 8;
    f = found.map((x, i) => [rank(x), i, x]).sort((a, b) => a[0] - b[0] || a[1] - b[1])[0]?.[2];
  } catch {
    return setScanUI(false, "Place search is unavailable right now.", true);
  }
  if (!f) return setScanUI(false, `Couldn't find "${q}".`, true);
  const [lon, lat] = f.geometry.coordinates;
  setScanUI(false, "");
  runScan(lat, lon, radius, f.properties.name || q);
});
$("#scanView").addEventListener("click", () => {
  const c = map.getCenter();
  runScan(c.lat, c.lng, +$("#radius").value, null);
});
$("#nearMe").addEventListener("click", () => {
  if (!navigator.geolocation) return setScanUI(false, "Your browser can't share its location.", true);
  setScanUI(true, "Finding you…");
  navigator.geolocation.getCurrentPosition(
    (p) => { setScanUI(false, ""); runScan(p.coords.latitude, p.coords.longitude, +$("#radius").value, "you"); },
    () => setScanUI(false, "Location not available. Allow it in the browser, or type a place instead.", true),
    { timeout: 15000, maximumAge: 600000 },
  );
});

function renderAreas() {
  const el = $("#areas");
  el.hidden = !areas.length;
  el.innerHTML = areas.length ? `<span class="areas-label">Your areas</span>` + [...areas].reverse().map((a) => `
    <span class="area-chip" data-key="${esc(a.key)}">
      <button class="area-go" title="Show on map">${esc(a.label)} <small>${a.radius} km · ${a.roads.length}</small></button>
      <button class="area-x" title="Forget this area" aria-label="Forget ${esc(a.label)}">✕</button>
    </span>`).join("") : "";
}
$("#areas").addEventListener("click", (e) => {
  const chip = e.target.closest(".area-chip");
  if (!chip) return;
  const a = areas.find((x) => x.key === chip.dataset.key);
  if (e.target.closest(".area-x")) return removeArea(a.key);
  showScanBox(a.bbox);
  map.fitBounds([[a.bbox[1], a.bbox[0]], [a.bbox[3], a.bbox[2]]], { padding: 40, duration: 1000 });
});
renderAreas();

// ------------------------------------------------------------------ list & filters

function matchingRoads() {
  const q = state.query.trim().toLowerCase();
  return roads.filter((r) =>
    (!state.passesOnly || r.pass) &&
    (!q || [r.name, r.road, r.from, r.to, r.pass?.name].some((s) => s && s.toLowerCase().includes(q))));
}

function inViewport(r) {
  const b = map.getBounds();
  return !(r.bb[0] > b.getEast() || r.bb[2] < b.getWest() || r.bb[1] > b.getNorth() || r.bb[3] < b.getSouth());
}

/** Map shows everything that matches the search; the list can also be limited to the map view. */
function applyFilter() {
  if (map.getLayer("roads")) {
    const f = ["in", ["get", "id"], ["literal", matchingRoads().map((r) => r.id)]];
    map.setFilter("roads", f);
    map.setFilter("roads-casing", f);
  }
  renderList();
}

function renderList() {
  let list = matchingRoads();
  if (state.inView) list = list.filter(inViewport);
  const k = state.sort;
  list.sort((a, b) => (b[k] ?? 0) - (a[k] ?? 0));
  $("#count").textContent = state.inView ? `${list.length} roads in view` : `${list.length} roads`;
  $("#list").innerHTML = list.slice(0, 300).map((r, i) => `
    <li class="item${state.sel?.id === r.id ? " active" : ""}" data-id="${r.id}">
      <span class="rank">${i + 1}</span>
      <span class="name">${esc(r.name)}</span>
      <span class="meta">${esc([r.road, route(r.from, r.to)].filter(Boolean).join(" · ") || " ")}</span>
      <span class="nums">
        <span class="bar" title="Fun score ${r.score}"><b style="width:${Math.min(100, r.score)}%"></b></span><span class="score">${r.score}</span>
        <span>${km(r.len)} km</span>
        <span>${r.hairpins} hairpins</span>
        <span>▲ ${fmt(r.eleMax)} m</span>
      </span>
    </li>`).join("") || `<li class="empty">${state.inView ? "No scored roads in this part of the map. Zoom out, or scan it." : "No roads match."}</li>`;
}

function route(a, b) {
  if (a && b) return `${a} → ${b}`;
  return a || b || "";
}

$("#search").addEventListener("input", (e) => { state.query = e.target.value; applyFilter(); });
$("#sort").addEventListener("change", (e) => { state.sort = e.target.value; renderList(); });
$("#passesOnly").addEventListener("change", (e) => { state.passesOnly = e.target.checked; applyFilter(); });
$("#inView").addEventListener("change", (e) => { state.inView = e.target.checked; renderList(); });

const tasteEl = $("#taste");
tasteEl.value = Math.round(state.taste * 100);
let tasteTimer;
tasteEl.addEventListener("input", () => {
  state.taste = tasteEl.value / 100;
  store.set("taste", state.taste);
  $("#tasteLabel").textContent = tasteLabel();
  clearTimeout(tasteTimer);
  tasteTimer = setTimeout(() => {
    rescore();
    map.getSource("roads")?.setData(roadsGeoJSON());
    renderList();
    if (state.sel) { renderDetail(); renderHot(); drawProfile(); }
  }, 120);
});
const tasteLabel = () => (state.taste < 0.35 ? "Fast sweepers" : state.taste > 0.65 ? "Tight hairpins" : "A bit of everything");
$("#tasteLabel").textContent = tasteLabel();

const listEl = $("#list");
listEl.addEventListener("click", (e) => {
  const li = e.target.closest(".item");
  if (li) select(byId.get(li.dataset.id));
});
listEl.addEventListener("mouseover", (e) => {
  const li = e.target.closest(".item");
  if (li) setHover(li.dataset.id, "list");
});
listEl.addEventListener("mouseleave", () => setHover(null));

function setHover(id, from) {
  if (state.hover === id) return;
  state.hover = id;
  if (map.getLayer("roads-hover")) map.setFilter("roads-hover", ["==", ["get", "id"], id ?? ""]);
  document.querySelectorAll(".item.hover").forEach((el) => el.classList.remove("hover"));
  if (id != null && from === "map") listEl.querySelector(`[data-id="${id}"]`)?.classList.add("hover");
}

// ------------------------------------------------------------------ selection

function select(road, reversed = false) {
  if (!road) return;
  if (!map.getSource("sel")) { mapReady.then(() => select(road, reversed)); return; }  // clicked before the map was ready
  stopFly();
  state.sel = road;
  state.view = makeView(road, reversed);
  const v = state.view;

  map.getSource("sel").setData({ type: "Feature", geometry: { type: "LineString", coordinates: v.coords.map((p) => [p[0], p[1]]) } });
  map.getSource("sel-runs").setData(bendRuns(v));
  renderHot();
  map.setPaintProperty("roads", "line-opacity", 0.45);
  map.setPaintProperty("roads-casing", "line-opacity", 0.4);

  renderDetail();
  loadWeather(road);

  const at = (f) => v.at(v.total * f);
  const pt = (p) => `${p[1].toFixed(5)},${p[0].toFixed(5)}`;
  $("#nav").href = `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${pt(v.coords[0])}` +
    `&destination=${pt(v.coords[v.coords.length - 1])}&waypoints=${[0.25, 0.5, 0.75].map((f) => pt(at(f))).join("%7C")}`;

  $("#detail").hidden = false;
  drawProfile();
  renderLegend();
  document.querySelectorAll(".item.active").forEach((el) => el.classList.remove("active"));
  listEl.querySelector(`[data-id="${road.id}"]`)?.classList.add("active");
  if (innerWidth <= 760) scrollTo({ top: 0, behavior: "smooth" });   // phone: the map is above the list
  else listEl.querySelector(`[data-id="${road.id}"]`)?.scrollIntoView({ block: "nearest" });
  history.replaceState(null, "", `#road=${road.id}`);

  if (!reversed) {
    const narrow = innerWidth <= 760;
    map.fitBounds([[road.bb[0], road.bb[1]], [road.bb[2], road.bb[3]]], {
      padding: narrow ? { top: 60, left: 30, right: 50, bottom: 30 } : { top: 70, left: 50, right: 60, bottom: $("#detail").offsetHeight + 40 },
      pitch: state.is3d ? 50 : 0, duration: 1200, maxZoom: 14.5,
    });
  }
}

/** "week 46-20" / "nov-may" / "winter" (OSM conditional-access wording) -> something readable. */
function closureText(c) {
  if (!c) return null;
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const wk = c.match(/week\s*(\d+)\s*-\s*(\d+)/i);
  if (wk) return `Closed about ${M[Math.min(11, Math.floor(((+wk[1] - 1) * 7) / 30.5))]}–${M[Math.min(11, Math.floor(((+wk[2] - 1) * 7) / 30.5))]}`;
  if (/^[a-z]{3}\b.*-\s*[a-z]{3}/i.test(c)) return `Closed ${c.replace(/\b([a-z])([a-z]{2})\b/gi, (_, a, b) => a.toUpperCase() + b.toLowerCase()).replace(/\s*-\s*/, "–")}`;
  if (/winter/i.test(c)) return "Closed in winter";
  if (/snow/i.test(c)) return "Closed when snowy";
  return "Seasonal closures";
}

/** Engine distances (along the stored road, uphill-first) -> distances along the view's smoothed line. */
function toView(v, d) {
  const x = (d * v.total) / (v.road.fx.length || v.total);
  return clamp(v.reversed ? v.total - x : x, 0, v.total);
}
const span = (v, [a, b]) => [toView(v, a), toView(v, b)].sort((p, q) => p - q);

/** Hot spots as a glow under the selected road, and a star on its single best point. */
function renderHot() {
  const v = state.view;
  const lines = v.road.fx.hot.map((h) => {
    const [a, b] = span(v, h);
    const pts = [v.at(a)];
    for (let i = 0; i < v.dist.length; i++) if (v.dist[i] > a && v.dist[i] < b) pts.push(v.coords[i]);
    pts.push(v.at(b));
    return { type: "Feature", geometry: { type: "LineString", coordinates: pts.map((p) => [p[0], p[1]]) } };
  });
  map.getSource("hot").setData({ type: "FeatureCollection", features: lines });
  const p = v.at(toView(v, v.road.fx.peak));
  peakMarker.setLngLat([p[0], p[1]]).addTo(map);
}

function renderDetail() {
  const road = state.sel, v = state.view, fx = road.fx, parts = fx.parts;
  $("#dName").textContent = road.name;
  $("#dSub").textContent = [road.road, route(v.from, v.to)].filter(Boolean).join(" · ");

  // why it's fun: bend mix, the four factors of the best stretch, then length and sustain
  const totalBends = road.bends.reduce((a, b) => a + b, 0);
  const [s0, s1] = span(v, fx.stretch);
  const whole = s1 - s0 >= v.total - 300;
  const notes = [
    whole ? "Scored on the whole road" : `Scored on its best ${km(s1 - s0)} km (km ${km(s0)}–${km(s1)})`,
    `${fx.goodKm.toFixed(fx.goodKm < 10 ? 1 : 0)} km of good riding ×${fx.lengthF.toFixed(2)}`,
  ].join(" · ");
  const hot = fx.hot.map((h) => span(v, h)).sort((a, b) => a[0] - b[0]);
  const sc = fx.scenery;
  const scen = [
    sc.alpineKm >= 0.4 && `high alpine for ${sc.alpineKm.toFixed(1)} km`,
    sc.viewKm >= 0.4 && `open views for ${sc.viewKm.toFixed(1)} km`,
    sc.dropKm >= 0.4 && `drop-offs for ${sc.dropKm.toFixed(1)} km`,
    sc.viewpoints && `${sc.viewpoints} viewpoint${sc.viewpoints > 1 ? "s" : ""}`,
    sc.builtPct >= 10 && `${sc.builtPct}% through villages (bends there count less)`,
  ].filter(Boolean);
  $("#dFun").innerHTML = `
    <div class="fun-score"><b>${road.score}</b><span>fun</span></div>
    <div class="fun-why">
      <div class="mix" title="How the ${totalBends.toFixed(1)} km of bends split by tightness">
        ${road.bends.map((k, i) => `<i style="flex:${k};--c:var(--c${i + 1})" title="${BEND_NAMES[i + 1]}: ${k.toFixed(1)} km"></i>`).join("")}
      </div>
      <div class="mix-keys">${road.bends.map((k, i) => `<span><i style="--c:var(--c${i + 1})"></i>${BEND_NAMES[i + 1]} ${k.toFixed(1)}</span>`).join("")}</div>
      <div class="factors">
        <span title="Weighted km of bends in the best stretch, for your taste">${parts.bends.toFixed(1)} <small>bends</small></span>
        <span class="x">× (1</span>
        <span title="${fx.rolling ? "Rolling: crests and dips" : "Climb within the stretch"}">+${(parts.terrain - 1).toFixed(2)} <small>${fx.rolling ? "rolling" : "terrain"}</small></span>
        <span title="Views, drop-offs, viewpoints and high alpine terrain">+${(parts.scenery - 1).toFixed(2)} <small>scenery</small></span>
        <span title="Hairpins in the stretch">+${(parts.hairpins - 1).toFixed(2)} <small>hairpins</small></span>
        <span class="x">)</span>
      </div>
      <div class="fun-note">${notes}</div>
      ${hot.length ? `<div class="fun-note"><b class="hot-key">Hot spot${hot.length > 1 ? "s" : ""}</b> ${hot.map(([a, b]) => `km ${km(a)}–${km(b)}`).join(", ")}</div>` : ""}
      ${scen.length ? `<div class="fun-note">Scenery: ${scen.join(" · ")}</div>` : ""}
    </div>`;

  $("#dStats").innerHTML = [
    ["Length", `${km(road.len)} km`],
    ["Bends", `${Math.round(road.inBends * 100)}% of it`],
    ["Hairpins", road.hairpins],
    ["Climb", `↑${fmt(v.climb)} ↓${fmt(v.descent)} m`],
    ["Altitude", `${fmt(road.eleMin)}–${fmt(road.eleMax)} m`],
    ["Steepest", `${road.maxGrad}%`, "Steepest 300 m stretch, estimated from ~25 m terrain data"],
  ].map(([k, val, t]) => `<div${t ? ` title="${t}"` : ""}><dt>${k}</dt><dd>${val}</dd></div>`).join("");

  const w = road.warn || {};
  const warns = [
    closureText(w.closed) && [closureText(w.closed), "From OpenStreetMap's access rules. Check the current status before you go."],
    w.narrow >= 20 && [`Narrow for ${w.narrow}%`, "Single lane or under 4.5 m wide: expect oncoming traffic in the bends"],
    w.toll && ["Toll road", ""],
    w.tunnel >= 10 && [`${w.tunnel}% in tunnels`, ""],
  ].filter(Boolean);
  $("#dWarn").innerHTML = warns.map(([t, title]) => `<span class="badge" title="${esc(title)}">${esc(t)}</span>`).join("");
  $("#dWarn").hidden = !warns.length;
}

function deselect() {
  stopFly();
  state.sel = state.view = null;
  map.getSource("sel").setData(emptyFC);
  map.getSource("sel-runs").setData(emptyFC);
  map.getSource("hot").setData(emptyFC);
  peakMarker.remove();
  map.setPaintProperty("roads", "line-opacity", 1);
  map.setPaintProperty("roads-casing", "line-opacity", 0.9);
  $("#detail").hidden = true;
  hideRider();
  renderLegend();
  document.querySelectorAll(".item.active").forEach((el) => el.classList.remove("active"));
  history.replaceState(null, "", location.pathname);
}

$("#close").addEventListener("click", deselect);
$("#reverse").addEventListener("click", () => state.sel && select(state.sel, !state.view.reversed));
addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || $("#about").open) return;
  fly ? stopFly() : deselect();
});

$("#gpx").addEventListener("click", () => {
  const v = state.view, r = v.road;
  const src = v.reversed ? [...r.coords].reverse() : r.coords;
  const pts = src.map((c) => `<trkpt lat="${c[1]}" lon="${c[0]}"><ele>${c[2]}</ele></trkpt>`).join("\n");
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Twisty Roads" xmlns="http://www.topografix.com/GPX/1/1">
<trk><name>${esc(r.name)}</name><trkseg>
${pts}
</trkseg></trk></gpx>`;
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([gpx], { type: "application/gpx+xml" })),
    download: `${r.name.replace(/[^\w\-]+/g, "_").toLowerCase()}.gpx`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

// ------------------------------------------------------------------ weather at the top

const WEATHER = [
  [[0], "☀", "Clear"], [[1, 2], "⛅", "Partly cloudy"], [[3], "☁", "Overcast"], [[45, 48], "🌫", "Fog"],
  [[51, 53, 55, 56, 57], "🌦", "Drizzle"], [[61, 63, 65, 66, 67], "🌧", "Rain"], [[71, 73, 75, 77], "❄", "Snow"],
  [[80, 81, 82], "🌦", "Showers"], [[85, 86], "🌨", "Snow showers"], [[95, 96, 99], "⛈", "Thunderstorms"],
];
const weatherOf = (code) => WEATHER.find(([codes]) => codes.includes(code)) ?? [[], "·", "—"];
const weatherCache = new Map();

/** Wind chill at riding speed (Environment Canada formula; only meaningful when it's cool). */
function feelsLike(t) {
  if (t > 15) return null;
  const v = RIDING_SPEED ** 0.16;
  return Math.min(t, 13.12 + 0.6215 * t - 11.37 * v + 0.3965 * t * v);
}

async function loadWeather(road) {
  const el = $("#dWeather");
  const top = road.coords.reduce((a, b) => (b[2] > a[2] ? b : a));
  el.innerHTML = `<div class="w-head">At the top · ${fmt(top[2])} m</div><div class="w-loading">Loading forecast…</div>`;
  let w = weatherCache.get(road.id);
  if (!w || Date.now() - w.at > 30 * 60 * 1000) {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${top[1]}&longitude=${top[0]}&elevation=${top[2]}` +
        "&current=temperature_2m,weather_code,wind_speed_10m" +
        "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,snowfall_sum,wind_gusts_10m_max,sunset" +
        "&timezone=auto&forecast_days=3";
      w = { at: Date.now(), data: await fetch(url).then((r) => r.json()) };
      weatherCache.set(road.id, w);
    } catch {
      if (state.sel === road) el.querySelector(".w-loading").textContent = "Forecast unavailable right now.";
      return;
    }
  }
  if (state.sel !== road) return;          // user moved on while we were loading
  const { current: c, daily: d } = w.data;
  const [, icon, label] = weatherOf(c.weather_code);
  const fl = feelsLike(c.temperature_2m);
  const days = d.time.map((day, i) => {
    const [, ic, lb] = weatherOf(d.weather_code[i]);
    const name = i === 0 ? "Today" : new Date(day + "T12:00").toLocaleDateString("en", { weekday: "short" });
    const snow = d.snowfall_sum[i] > 0.2 ? ` · ${d.snowfall_sum[i].toFixed(0)} cm snow` : "";
    return `<div class="w-day" title="${lb}${snow} · gusts ${Math.round(d.wind_gusts_10m_max[i])} km/h · sunset ${d.sunset[i].slice(11)}">
      <span>${name}</span><span class="w-ic">${ic}</span>
      <span>${Math.round(d.temperature_2m_max[i])}° <small>${Math.round(d.temperature_2m_min[i])}°</small></span>
      <small>${d.precipitation_probability_max[i] ?? 0}% rain</small></div>`;
  }).join("");
  el.innerHTML = `
    <div class="w-head">At the top · ${fmt(top[2])} m</div>
    <div class="w-now"><span class="w-ic">${icon}</span><b>${Math.round(c.temperature_2m)}°</b>
      <span>${label}${fl != null ? ` · feels ${Math.round(fl)}° at ${RIDING_SPEED} km/h` : ""} · wind ${Math.round(c.wind_speed_10m)} km/h</span></div>
    <div class="w-days">${days}</div>`;
}

// ------------------------------------------------------------------ legend & scoring explainer

function renderLegend() {
  const el = $("#legend");
  if (state.sel) {
    el.innerHTML = `Bend tightness<div class="keys">${BEND_NAMES.map((n, i) =>
      `<span title="${BEND_RADII[i]}"><i style="--c:var(--c${i})"></i>${n}</span>`).join("")}</div>
      <div class="keys"><span><i class="glow"></i>Hot spot</span><span><b class="star">★</b> Best bit</span></div>`;
  } else {
    el.innerHTML = `Fun score
      <div class="ramp" style="background:linear-gradient(90deg,var(--s1),var(--s2),var(--s3),var(--s4))"></div>
      <div class="ends"><span>mild</span><span>wild</span></div>`;
  }
}
renderLegend();

$("#aboutBtn").addEventListener("click", () => $("#about").showModal());
$("#about").addEventListener("click", (e) => { if (e.target === e.currentTarget || e.target.closest(".about-close")) $("#about").close(); });

// ------------------------------------------------------------------ 3D controls

$("#toggle3d").addEventListener("click", (e) => {
  state.is3d = !state.is3d;
  e.currentTarget.classList.toggle("on", state.is3d);
  e.currentTarget.setAttribute("aria-pressed", state.is3d);
  map.setTerrain(state.is3d ? { source: "dem", exaggeration: state.exag } : null);
  map.easeTo({ pitch: state.is3d ? 55 : 0, duration: 800 });
});
$("#exag").addEventListener("input", (e) => {
  state.exag = +e.target.value;
  if (state.is3d) map.setTerrain({ source: "dem", exaggeration: state.exag });
});

// ------------------------------------------------------------------ elevation profile

const canvas = $("#profile");
const pTip = $("#pTip");
let cursorD = null;

function gradeColor(g) {
  g = Math.abs(g);
  return css(g < 0.04 ? "--g1" : g < 0.07 ? "--g2" : g < 0.1 ? "--g3" : "--g4");
}

function niceStep(range, target) {
  const raw = range / target, p = 10 ** Math.floor(Math.log10(raw)), n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}

function drawProfile() {
  const v = state.view;
  if (!v) return;
  const dpr = devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const M = { l: 44, r: 8, t: 16, b: 20 };
  const lo = v.road.eleMin, hi = v.road.eleMax;
  const eStep = niceStep(hi - lo || 50, 3);
  const e0 = Math.floor(lo / eStep) * eStep, e1 = Math.ceil(hi / eStep) * eStep || e0 + eStep;
  const X = (d) => M.l + (d / v.total) * (W - M.l - M.r);
  const Y = (e) => H - M.b - ((e - e0) / (e1 - e0)) * (H - M.t - M.b);

  g.font = "11px system-ui, sans-serif";
  g.fillStyle = css("--muted");
  g.strokeStyle = css("--line");
  g.lineWidth = 1;
  g.textAlign = "right";
  g.textBaseline = "middle";
  for (let e = e0; e <= e1 + 1e-6; e += eStep) {
    g.beginPath(); g.moveTo(M.l, Math.round(Y(e)) + 0.5); g.lineTo(W - M.r, Math.round(Y(e)) + 0.5); g.stroke();
    g.fillText(`${fmt(e)} m`, M.l - 6, Y(e));
  }
  const kmTotal = v.total / 1000, xs = niceStep(kmTotal, Math.max(2, Math.floor(W / 90)));
  g.textAlign = "center";
  g.textBaseline = "top";
  for (let k = 0; k <= kmTotal + 1e-6; k += xs) g.fillText(`${+k.toFixed(1)} km`, X(k * 1000), H - M.b + 5);

  // hot spots: a soft band behind the profile
  g.fillStyle = css("--hot");
  for (const h of v.road.fx.hot) {
    const [a, b] = span(v, h);
    g.fillRect(X(a), M.t, X(b) - X(a), H - M.t - M.b);
  }

  // area in bands of ~1/60 of the road (200 m - 1 km), each coloured by its own average gradient
  const n = Math.max(2, Math.round(v.total / clamp(v.total / 60, 200, 1000)));
  for (let i = 0; i < n; i++) {
    const d0 = (v.total * i) / n, d1 = (v.total * (i + 1)) / n, steps = 12;
    g.fillStyle = gradeColor((v.at(d1)[2] - v.at(d0)[2]) / (d1 - d0));
    g.beginPath();
    g.moveTo(X(d0), Y(e0));
    for (let s = 0; s <= steps; s++) { const dd = d0 + ((d1 - d0) * s) / steps; g.lineTo(X(dd) + (s === steps ? 0.5 : 0), Y(v.at(dd)[2])); }
    g.lineTo(X(d1) + 0.5, Y(e0));
    g.fill();
  }
  g.beginPath();
  for (let px = 0; px <= W - M.l - M.r; px++) {
    const dd = (px / (W - M.l - M.r)) * v.total;
    px ? g.lineTo(X(dd), Y(v.at(dd)[2])) : g.moveTo(X(dd), Y(v.at(dd)[2]));
  }
  g.strokeStyle = css("--ink");
  g.lineWidth = 1.5;
  g.stroke();

  const ps = v.road.pass;
  if (ps) {
    const pd = v.nearest(ps.lon, ps.lat), p = v.at(pd), px = X(pd), py = Y(p[2]);
    g.fillStyle = css("--ink");
    g.beginPath(); g.arc(px, py, 3.5, 0, Math.PI * 2); g.fill();
    g.textAlign = px > W - 120 ? "right" : px < M.l + 120 ? "left" : "center";
    g.textBaseline = "bottom";
    g.font = "600 11px system-ui, sans-serif";
    g.fillText(`${ps.name} ${fmt(ps.ele)} m`, px, py - 6);
  }

  // the single best point
  {
    const pd = toView(v, v.road.fx.peak), p = v.at(pd);
    g.fillStyle = css("--accent");
    g.font = "15px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "bottom";
    g.fillText("★", X(pd), Y(p[2]) - 3);
  }

  if (cursorD != null) {
    const p = v.at(cursorD), cx = Math.round(X(cursorD)) + 0.5;
    g.strokeStyle = css("--ink-2");
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(cx, M.t); g.lineTo(cx, H - M.b); g.stroke();
    g.fillStyle = css("--accent");
    g.strokeStyle = css("--surface");
    g.lineWidth = 2;
    g.beginPath(); g.arc(cx, Y(p[2]), 5, 0, Math.PI * 2); g.fill(); g.stroke();
    const gr = v.gradeAt(cursorD) * 100;
    pTip.hidden = false;
    pTip.textContent = `${km(cursorD)} km · ${fmt(p[2])} m · ${gr >= 0 ? "↗" : "↘"} ${Math.abs(gr).toFixed(0)}% · ${BEND_NAMES[v.bendAt(cursorD)].toLowerCase()}`;
    const tw = pTip.offsetWidth;
    pTip.style.left = `${cx + 10 + tw > W ? Math.max(0, cx - tw - 10) : cx + 10}px`;
  } else {
    pTip.hidden = true;
  }
}

function setCursor(d) {
  cursorD = d;
  drawProfile();
  if (d == null) hideRider();
  else showRider(state.view.at(d));
}

function profileD(e) {
  const r = canvas.getBoundingClientRect();
  return clamp((e.clientX - r.left - 44) / (r.width - 52), 0, 1) * state.view.total;
}
canvas.addEventListener("pointermove", (e) => { if (!fly) setCursor(profileD(e)); });
canvas.addEventListener("pointerleave", () => { if (!fly) setCursor(null); });
canvas.addEventListener("click", (e) => {
  if (fly) return;
  const p = state.view.at(profileD(e));
  map.easeTo({ center: [p[0], p[1]], zoom: Math.max(map.getZoom(), 13.5), duration: 700 });
});
new ResizeObserver(() => drawProfile()).observe(canvas);

// ------------------------------------------------------------------ fly along

let fly = null;

function startFly() {
  const v = state.view;
  if (!v) return;
  if (!state.is3d) $("#toggle3d").click();
  const duration = clamp((v.total / 1000) * 1800, 15000, 80000);
  const start = v.at(0);
  let cam = bearing(start, v.at(300));
  fly = { raf: 0 };
  $("#fly").textContent = "■ Stop";
  showRider(start);

  // pin the camera to the road's own height so the rider stays centred even before terrain tiles arrive
  map.setCenterClampedToGround(false);
  map.easeTo({ center: [start[0], start[1]], elevation: start[2] * state.exag, zoom: 14.3, pitch: 65, bearing: cam, duration: 1600,
    padding: { top: 0, left: 0, right: 0, bottom: innerWidth <= 760 ? 0 : $("#detail").offsetHeight } });  // keep the rider above the card
  map.once("moveend", () => {
    if (!fly) return;
    let t0 = null;
    const frame = (ts) => {
      if (!fly) return;
      t0 ??= ts;
      const k = Math.min(1, (ts - t0) / duration), d = v.total * k, p = v.at(d);
      if (d < v.total - 30) {
        const diff = ((bearing(p, v.at(d + 350)) - cam + 540) % 360) - 180;
        cam += diff * 0.045;
      }
      map.jumpTo({ center: [p[0], p[1]], elevation: p[2] * state.exag, bearing: cam, pitch: 65, zoom: 14.3 });
      cursorD = d;
      drawProfile();
      showRider(p);
      if (k < 1) fly.raf = requestAnimationFrame(frame);
      else stopFly();
    };
    fly.raf = requestAnimationFrame(frame);
  });
}

function stopFly() {
  if (!fly) return;
  cancelAnimationFrame(fly.raf);
  fly = null;
  map.setCenterClampedToGround(true);
  map.setPadding({ top: 0, left: 0, right: 0, bottom: 0 });
  $("#fly").textContent = "▶ Fly along";
}

$("#fly").addEventListener("click", () => (fly ? stopFly() : startFly()));
for (const ev of ["pointerdown", "wheel", "touchstart"]) map.getCanvas().addEventListener(ev, stopFly, { passive: true });

applyFilter();
