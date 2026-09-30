/* Twisty roads viewer: MapLibre + 3D terrain + elevation profile. No build step. */

const $ = (s) => document.querySelector(s);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => Math.round(n).toLocaleString("en");
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const TERRAIN_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const BEND_NAMES = ["Straight", "Sweeping", "Flowing", "Tight", "Hairpin-tight"];
const BEND_RADII = ["", "under 175 m radius", "under 100 m", "under 60 m", "under 30 m"];

const [data, baseStyle] = await Promise.all([
  fetch("data/roads.json").then((r) => r.json()),
  fetch("https://tiles.openfreemap.org/styles/positron").then((r) => r.json()),
]);
// Drop the style's low-zoom shaded-relief raster: we draw our own hillshade, and when its server is slow
// MapLibre waits on it forever before firing "load".
delete baseStyle.sources.ne2_shaded;
baseStyle.layers = baseStyle.layers.filter((l) => l.source !== "ne2_shaded");
let roads = data.roads;          // grows when you scan somewhere new
let passes = data.passes;
let byId = new Map(roads.map((r) => [r.id, r]));

const state = { sort: "score", query: "", passesOnly: false, sel: null, view: null, hover: null, is3d: true, exag: 1.4 };

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

/** Build a view of a road in the chosen direction: coords, cumulative distance, lookup helpers. */
function makeView(road, reversed) {
  const coords = reversed ? [...road.coords].reverse() : road.coords;
  const curve = reversed ? [...road.curve].reverse().join("") : road.curve;
  const dist = [0];
  for (let i = 1; i < coords.length; i++) dist.push(dist[i - 1] + haversine(coords[i - 1], coords[i]));
  const total = dist[dist.length - 1];

  function at(d) {
    d = clamp(d, 0, total);
    let lo = 0, hi = dist.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (dist[mid] <= d) lo = mid; else hi = mid;
    }
    const span = dist[hi] - dist[lo] || 1, t = (d - dist[lo]) / span;
    const a = coords[lo], b = coords[hi];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  const gradeAt = (d) => (at(d + 150)[2] - at(d - 150)[2]) / (Math.min(total, d + 150) - Math.max(0, d - 150) || 1);

  return {
    road, reversed, coords, curve, dist, total, at, gradeAt,
    from: reversed ? road.to : road.from,
    to: reversed ? road.from : road.to,
    climb: reversed ? road.descent : road.climb,
    descent: reversed ? road.climb : road.descent,
  };
}

// ------------------------------------------------------------------ map

const map = new maplibregl.Map({
  container: "map",
  style: baseStyle,
  bounds: [[data.bbox[1], data.bbox[0]], [data.bbox[3], data.bbox[2]]],
  fitBoundsOptions: { padding: 20 },
  pitch: 40,
  maxPitch: 80,
  attributionControl: { compact: true },
});
window.map = map; // handy in the devtools console
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

const rider = new maplibregl.Marker({ element: Object.assign(document.createElement("div"), { className: "rider" }) });
let riderOn = false;
function showRider(p) {
  rider.setLngLat([p[0], p[1]]);
  if (!riderOn) { rider.addTo(map); riderOn = true; }
}
function hideRider() { if (riderOn) { rider.remove(); riderOn = false; } }

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
    ...[[7, 0.8], [10, 1.6], [14, 3.2]].flatMap(([z, k]) => [z, byScore ? ["*", scoreWidth, base * k] : base * k])];
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
    id: "roads-hover", type: "line", source: "roads", filter: ["==", ["get", "id"], -1],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#0b0b0b", "line-width": width(2.6), "line-gap-width": 0, "line-opacity": 0.85 },
  }, "roads");

  map.addSource("sel", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "sel-casing", type: "line", source: "sel",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": width(5) },
  });
  map.addLayer({
    id: "sel-line", type: "line", source: "sel",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["match", ["get", "c"], 1, css("--c1"), 2, css("--c2"), 3, css("--c3"), 4, css("--c4"), css("--c0")],
      "line-width": width(3.2),
    },
  });

  map.addSource("passes", { type: "geojson", data: passesGeoJSON() });
  map.addSource("scan-area", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "scan-area", type: "line", source: "scan-area",
    paint: { "line-color": css("--accent"), "line-width": 2, "line-dasharray": [3, 2] },
  });
  map.addLayer({
    id: "passes", type: "symbol", source: "passes", minzoom: 9,
    layout: {
      "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 11,
      "text-anchor": "top", "text-offset": [0, 0.6], "symbol-sort-key": ["-", 0, ["get", "ele"]],
      "icon-optional": true,
    },
    paint: { "text-color": "#3a2a1a", "text-halo-color": "#ffffff", "text-halo-width": 1.6 },
  });
  map.addLayer({
    id: "pass-dots", type: "circle", source: "passes", minzoom: 8,
    paint: { "circle-radius": 3.5, "circle-color": "#3a2a1a", "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5 },
  }, "passes");

  // ---- hover & click on roads
  const tip = $("#tip");
  map.on("mousemove", "roads", (e) => {
    const f = e.features.reduce((a, b) => (b.properties.score > a.properties.score ? b : a));
    const r = byId.get(f.properties.id);
    map.getCanvas().style.cursor = "pointer";
    setHover(r.id, "map");
    tip.hidden = false;
    tip.innerHTML = `<b>${esc(r.name)}</b>Score ${r.score} · ${(r.len / 1000).toFixed(1)} km · ${r.hairpins} hairpins`;
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
    const f = e.features.reduce((a, b) => (b.properties.score > a.properties.score ? b : a));
    select(byId.get(f.properties.id));
  });

  // hovering the selected road moves the profile crosshair
  map.on("mousemove", "sel-line", (e) => {
    if (!state.view || fly) return;
    const v = state.view, p = [e.lngLat.lng, e.lngLat.lat];
    let best = 0, bd = Infinity;
    v.coords.forEach((c, i) => {
      const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    setCursor(v.dist[best]);
  });
  map.on("mouseleave", "sel-line", () => { if (!fly) setCursor(null); });

  applyFilter();
  const scanArg = location.hash.match(/scan=(-?[\d.]+),(-?[\d.]+),(\d+)/);
  const roadArg = location.hash.match(/road=(\d+)/);
  if (scanArg) runScan(+scanArg[1], +scanArg[2], +scanArg[3], null, roadArg && +roadArg[1]);
  else if (roadArg && byId.has(+roadArg[1])) select(byId.get(+roadArg[1]));
});

function roadsGeoJSON() {
  return {
    type: "FeatureCollection",
    features: roads.map((r) => ({
      type: "Feature", id: r.id,
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

// ------------------------------------------------------------------ scan anywhere

let scanning = false;

/** Download + score roads within radiusKm of a point, in a worker, then merge them into the map. */
function runScan(lat, lon, radiusKm, label, selectId = null) {
  if (!map.getSource("scan-area")) { mapReady.then(() => runScan(lat, lon, radiusKm, label, selectId)); return; }
  if (scanning) return;
  scanning = true;
  const dLat = radiusKm / 111.32, dLon = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  const bbox = [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
  const ring = [[bbox[1], bbox[0]], [bbox[3], bbox[0]], [bbox[3], bbox[2]], [bbox[1], bbox[2]], [bbox[1], bbox[0]]];
  map.getSource("scan-area").setData({ type: "Feature", geometry: { type: "LineString", coordinates: ring } });
  map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]], { padding: 40, pitch: state.is3d ? 40 : 0, duration: 1200 });
  setScanUI(true, "Starting…");

  const worker = new Worker("scan.js");
  worker.onmessage = ({ data: msg }) => {
    if (msg.type === "progress") return setScanUI(true, msg.msg);
    worker.terminate();
    scanning = false;
    if (msg.type === "error") return setScanUI(false, msg.message, true);

    // replace whatever we had inside the scanned box with the fresh results
    const inBox = (r) => {
      const [lo, la] = r.coords[r.coords.length >> 1];
      return la > bbox[0] && la < bbox[2] && lo > bbox[1] && lo < bbox[3];
    };
    let nextId = Math.max(0, ...roads.map((r) => r.id)) + 1;
    msg.roads.forEach((r) => (r.id = nextId++));
    roads = [...roads.filter((r) => !inBox(r)), ...msg.roads];
    const passKey = (p) => `${p.lon},${p.lat}`;
    const known = new Set(passes.map(passKey));
    passes = [...passes, ...msg.passes.filter((p) => !known.has(passKey(p)))];
    byId = new Map(roads.map((r) => [r.id, r]));
    map.getSource("roads").setData(roadsGeoJSON());
    map.getSource("passes").setData(passesGeoJSON());
    applyFilter();

    const best = msg.roads[0];
    setScanUI(false, msg.roads.length
      ? `Found ${msg.roads.length} twisty roads${label ? ` around ${label}` : ""}. Best: ${best.name} (${best.score}).`
      : "No twisty paved roads found here. Try a bigger radius or a hillier area.");
    history.replaceState(null, "", `#scan=${lat.toFixed(4)},${lon.toFixed(4)},${radiusKm}`);
    if (selectId && byId.has(selectId)) select(byId.get(selectId));
  };
  worker.onerror = (e) => { scanning = false; worker.terminate(); setScanUI(false, `Scan failed: ${e.message}`, true); };
  worker.postMessage({ bbox });
}

function setScanUI(busy, msg, isError = false) {
  $("#scanGo").disabled = $("#scanView").disabled = busy;
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
  if (!q) {
    const c = map.getCenter();
    return runScan(c.lat, c.lng, radius, null);
  }
  setScanUI(true, `Looking up "${q}"…`);
  let f;
  try {
    const res = await fetch(`https://photon.komoot.io/api/?limit=1&q=${encodeURIComponent(q)}`).then((r) => r.json());
    f = res.features?.[0];
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

// ------------------------------------------------------------------ list & filters

function visibleRoads() {
  const q = state.query.trim().toLowerCase();
  let list = roads.filter((r) =>
    (!state.passesOnly || r.pass) &&
    (!q || [r.name, r.road, r.from, r.to, r.pass?.name].some((s) => s && s.toLowerCase().includes(q))));
  const k = state.sort;
  list.sort((a, b) => (b[k] ?? 0) - (a[k] ?? 0));
  return list;
}

function applyFilter() {
  const list = visibleRoads();
  $("#count").textContent = `${list.length} of ${roads.length} roads`;
  $("#list").innerHTML = list.map((r, i) => `
    <li class="item${state.sel?.id === r.id ? " active" : ""}" data-id="${r.id}">
      <span class="rank">${i + 1}</span>
      <span class="name">${esc(r.name)}</span>
      <span class="meta">${esc([r.road, route(r.from, r.to)].filter(Boolean).join(" · ") || " ")}</span>
      <span class="nums">
        <span class="bar" title="Fun score ${r.score}/100"><b style="width:${r.score}%"></b></span><span class="score">${r.score}</span>
        <span>${(r.len / 1000).toFixed(1)} km</span>
        <span>${r.hairpins} hairpins</span>
        <span>▲ ${fmt(r.eleMax)} m</span>
      </span>
    </li>`).join("");
  if (map.getLayer("roads")) {
    const ids = list.map((r) => r.id);
    const f = ["in", ["get", "id"], ["literal", ids]];
    map.setFilter("roads", f);
    map.setFilter("roads-casing", f);
  }
}

function route(a, b) {
  if (a && b) return `${a} → ${b}`;
  return a || b || "";
}

$("#search").addEventListener("input", (e) => { state.query = e.target.value; applyFilter(); });
$("#sort").addEventListener("change", (e) => { state.sort = e.target.value; applyFilter(); });
$("#passesOnly").addEventListener("change", (e) => { state.passesOnly = e.target.checked; applyFilter(); });

const listEl = $("#list");
listEl.addEventListener("click", (e) => {
  const li = e.target.closest(".item");
  if (li) select(byId.get(+li.dataset.id));
});
listEl.addEventListener("mouseover", (e) => {
  const li = e.target.closest(".item");
  if (li) setHover(+li.dataset.id, "list");
});
listEl.addEventListener("mouseleave", () => setHover(null));

function setHover(id, from) {
  if (state.hover === id) return;
  state.hover = id;
  if (map.getLayer("roads-hover")) map.setFilter("roads-hover", ["==", ["get", "id"], id ?? -1]);
  document.querySelectorAll(".item.hover").forEach((el) => el.classList.remove("hover"));
  if (id != null && from === "map") listEl.querySelector(`[data-id="${id}"]`)?.classList.add("hover");
}

// ------------------------------------------------------------------ selection

function select(road, reversed = false) {
  if (!map.getSource("sel")) { mapReady.then(() => select(road, reversed)); return; }  // clicked before the map finished loading
  stopFly();
  state.sel = road;
  state.view = makeView(road, reversed);
  const v = state.view;

  const feats = [];
  for (let i = 0; i < v.coords.length - 1; i++) {
    feats.push({
      type: "Feature", properties: { c: +v.curve[i] || 0 },
      geometry: { type: "LineString", coordinates: [v.coords[i].slice(0, 2), v.coords[i + 1].slice(0, 2)] },
    });
  }
  map.getSource("sel").setData({ type: "FeatureCollection", features: feats });
  map.setPaintProperty("roads", "line-opacity", 0.45);
  map.setPaintProperty("roads-casing", "line-opacity", 0.4);

  $("#dName").textContent = road.name;
  $("#dSub").textContent = [road.road, route(v.from, v.to)].filter(Boolean).join(" · ");
  const stats = [
    ["Fun score", `${road.score}/100`],
    ["Length", `${(road.len / 1000).toFixed(1)} km`],
    ["Hairpins", road.hairpins],
    ["Climb", `↑${fmt(v.climb)} ↓${fmt(v.descent)} m`],
    ["Altitude", `${fmt(road.eleMin)}–${fmt(road.eleMax)} m`],
    ["Steepest", `${road.maxGrad}%`],
    ["Curves", `${road.density.toFixed(2)} /km`],
  ];
  $("#dStats").innerHTML = stats.map(([k, val]) => `<div${k === "Steepest" ? ' title="Steepest 300 m stretch, estimated from ~25 m terrain data"' : ""}><dt>${k}</dt><dd>${val}</dd></div>`).join("") +
    (road.seasonal ? `<span class="badge" title="OSM has a conditional access restriction on this road">May close in winter</span>` : "");

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
    const lons = v.coords.map((c) => c[0]), lats = v.coords.map((c) => c[1]);
    const narrow = innerWidth <= 760;
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], {
      padding: narrow ? { top: 60, left: 30, right: 50, bottom: 30 } : { top: 70, left: 50, right: 60, bottom: $("#detail").offsetHeight + 40 },
      pitch: state.is3d ? 50 : 0, duration: 1200, maxZoom: 14.5,
    });
  }
}

function deselect() {
  stopFly();
  state.sel = state.view = null;
  map.getSource("sel").setData({ type: "FeatureCollection", features: [] });
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
addEventListener("keydown", (e) => { if (e.key === "Escape") (fly ? stopFly() : deselect()); });

$("#gpx").addEventListener("click", () => {
  const v = state.view;
  const pts = v.coords.map((c) => `<trkpt lat="${c[1]}" lon="${c[0]}"><ele>${c[2]}</ele></trkpt>`).join("\n");
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Twisty roads" xmlns="http://www.topografix.com/GPX/1/1">
<trk><name>${esc(v.road.name)}</name><trkseg>
${pts}
</trkseg></trk></gpx>`;
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([gpx], { type: "application/gpx+xml" })),
    download: `${v.road.name.replace(/[^\w\-]+/g, "_").toLowerCase()}.gpx`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

// ------------------------------------------------------------------ legend

function renderLegend() {
  const el = $("#legend");
  if (state.sel) {
    el.innerHTML = `Bend tightness<div class="keys">${BEND_NAMES.map((n, i) =>
      `<span title="${BEND_RADII[i]}"><i style="--c:var(--c${i})"></i>${n}</span>`).join("")}</div>`;
  } else {
    el.innerHTML = `Fun score (curves × climb)
      <div class="ramp" style="background:linear-gradient(90deg,var(--s1),var(--s2),var(--s3),var(--s4))"></div>
      <div class="ends"><span>mild</span><span>wild</span></div>`;
  }
}
renderLegend();

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
  const eles = v.coords.map((c) => c[2]);
  const eStep = niceStep(Math.max(...eles) - Math.min(...eles) || 50, 3);
  const e0 = Math.floor(Math.min(...eles) / eStep) * eStep;
  const e1 = Math.ceil(Math.max(...eles) / eStep) * eStep || e0 + eStep;
  const X = (d) => M.l + (d / v.total) * (W - M.l - M.r);
  const Y = (e) => H - M.b - ((e - e0) / (e1 - e0)) * (H - M.t - M.b);
  const muted = css("--muted"), line = css("--line");

  // grid + y labels
  g.font = "11px system-ui, sans-serif";
  g.fillStyle = muted;
  g.strokeStyle = line;
  g.lineWidth = 1;
  g.textAlign = "right";
  g.textBaseline = "middle";
  for (let e = e0; e <= e1 + 1e-6; e += eStep) {
    g.beginPath(); g.moveTo(M.l, Math.round(Y(e)) + 0.5); g.lineTo(W - M.r, Math.round(Y(e)) + 0.5); g.stroke();
    g.fillText(`${fmt(e)} m`, M.l - 6, Y(e));
  }
  // x labels
  const km = v.total / 1000, xs = niceStep(km, Math.max(2, Math.floor(W / 90)));
  g.textAlign = "center";
  g.textBaseline = "top";
  for (let k = 0; k <= km + 1e-6; k += xs) g.fillText(`${+k.toFixed(1)} km`, X(k * 1000), H - M.b + 5);

  // area, in bands of ~1/60 of the road (200 m - 1 km), each coloured by its own average gradient
  const n = Math.max(2, Math.round(v.total / clamp(v.total / 60, 200, 1000)));
  for (let i = 0, vi = 0; i < n; i++) {
    const d0 = (v.total * i) / n, d1 = (v.total * (i + 1)) / n;
    const a = v.at(d0), b = v.at(d1);
    g.fillStyle = gradeColor((b[2] - a[2]) / (d1 - d0));
    g.beginPath();
    g.moveTo(X(d0), Y(e0));
    g.lineTo(X(d0), Y(a[2]));
    while (vi < v.dist.length && v.dist[vi] <= d0) vi++;
    for (let j = vi; j < v.dist.length && v.dist[j] < d1; j++) g.lineTo(X(v.dist[j]), Y(v.coords[j][2]));
    g.lineTo(X(d1) + 0.5, Y(b[2]));
    g.lineTo(X(d1) + 0.5, Y(e0));
    g.fill();
  }
  g.beginPath();
  v.coords.forEach((c, i) => (i ? g.lineTo(X(v.dist[i]), Y(c[2])) : g.moveTo(X(0), Y(c[2]))));
  g.strokeStyle = css("--ink");
  g.lineWidth = 1.5;
  g.stroke();

  // the pass
  const ps = v.road.pass;
  if (ps) {
    let bi = 0, bd = Infinity;
    v.coords.forEach((c, i) => { const d = (c[0] - ps.lon) ** 2 + (c[1] - ps.lat) ** 2; if (d < bd) { bd = d; bi = i; } });
    const px = X(v.dist[bi]), py = Y(v.coords[bi][2]);
    g.fillStyle = css("--ink");
    g.beginPath(); g.arc(px, py, 3.5, 0, Math.PI * 2); g.fill();
    g.textAlign = px > W - 120 ? "right" : px < M.l + 120 ? "left" : "center";
    g.textBaseline = "bottom";
    g.font = "600 11px system-ui, sans-serif";
    g.fillText(`${ps.name} ${fmt(ps.ele)} m`, px, py - 6);
  }

  // crosshair
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
    pTip.textContent = `${(cursorD / 1000).toFixed(1)} km · ${fmt(p[2])} m · ${gr >= 0 ? "↗" : "↘"} ${Math.abs(gr).toFixed(0)}%`;
    const tw = pTip.offsetWidth;
    pTip.style.left = `${clamp(cx + 10, 0, W - tw - 4)}px`;
    if (cx + 10 + tw > W) pTip.style.left = `${Math.max(0, cx - tw - 10)}px`;
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
    padding: { top: 0, left: 0, right: 0, bottom: innerWidth <= 760 ? 0 : $("#detail").offsetHeight } });  // keep the rider above the detail card
  map.once("moveend", () => {
    if (!fly) return;
    let t0 = null;
    const frame = (ts) => {
      if (!fly) return;
      t0 ??= ts;
      const k = Math.min(1, (ts - t0) / duration);
      const d = v.total * k;
      const p = v.at(d);
      if (d < v.total - 30) {
        const target = bearing(p, v.at(d + 350));
        const diff = ((target - cam + 540) % 360) - 180;
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
