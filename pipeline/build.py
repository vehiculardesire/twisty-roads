"""Turn cached OSM data into a ranked list of twisty road sections with elevation.

Steps
  1. load roads, drop unpaved / private / roundabouts
  2. chain OSM way fragments into continuous roads
  3. resample every road to 10 m and measure the bend radius at each point
  4. cut roads into sections at long straights; score each section
  5. sample elevation (AWS Terrarium DEM) -> climb, altitude range, gradient
  6. attach mountain passes and nearby towns, write site/data/roads.json
"""
import io
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import requests
from PIL import Image

from region import BBOX

HERE = Path(__file__).parent
OSM_CACHE = HERE / "cache" / "osm"
DEM_CACHE = HERE / "cache" / "dem"
OUT = HERE.parent / "site" / "data" / "roads.json"

R_EARTH = 6371008.8
STEP = 10.0                # resample spacing, m
RADIUS_OFFSET = 2          # radius from points i-2, i, i+2 (40 m chord)
# (max radius m, weight) - the same banding roadcurvature.com uses
BANDS = [(30, 2.0), (60, 1.6), (100, 1.3), (175, 1.0)]
SPLIT_STRAIGHT = 2500      # a straight longer than this ends a section, m (pass-top plateaus can be ~2 km)
PAD = 150                  # straight kept either side of a section, m
MIN_LEN = 2500             # m
MIN_CURVY_KM = 1.2         # weighted curvy km
MIN_DENSITY = 0.12         # curvy km per km
MAX_ROADS = 900
DEM_ZOOM = 12
SCORE_REF = 65.0           # raw score of Cormet de Roselend = 100, so scores compare across regions (same in site/scan.js)

UNPAVED = {"unpaved", "gravel", "fine_gravel", "dirt", "ground", "compacted", "grass", "sand",
           "earth", "mud", "pebblestone", "rock", "grass_paver", "wood"}
BLOCKED = {"no", "private", "agricultural", "forestry", "delivery", "permit"}


# ---------------------------------------------------------------- load

def load_osm():
    ways, passes, places = {}, {}, {}
    for f in sorted(OSM_CACHE.glob("cell_*.json")):
        for el in json.loads(f.read_text(encoding="utf-8"))["elements"]:
            t = el.get("tags", {})
            if el["type"] == "way":
                ways[el["id"]] = el
            elif "mountain_pass" in t:
                passes[el["id"]] = el
            elif "place" in t:
                places[el["id"]] = el
    return ways, passes, places


def rideable(t):
    if t.get("surface") in UNPAVED or t.get("junction") in ("roundabout", "circular"):
        return False
    if t.get("area") == "yes" or t.get("motorroad") == "yes":
        return False
    def blocked(k):
        v = t.get(k)
        return bool(v) and set(v.replace(" ", "").split(";")) <= BLOCKED

    # most specific tag wins: motorcycle > motor_vehicle > vehicle > access
    for k in ("motorcycle", "motor_vehicle", "vehicle", "access"):
        if k in t:
            return not blocked(k)
    return True


def is_off_ground(t):
    return (t.get("tunnel") not in (None, "no") or t.get("bridge") not in (None, "no")
            or t.get("covered") == "yes" or t.get("layer", "0").lstrip("-").isdigit() and t.get("layer", "0") != "0")


def road_key(t):
    ref = t.get("ref")
    if ref:
        return ref.split(";")[0].replace(" ", "").upper()
    return t.get("name")


# ---------------------------------------------------------------- chaining

def unit(dx, dy):
    n = math.hypot(dx, dy) or 1.0
    return dx / n, dy / n


def end_direction(way, at_start):
    """Unit vector pointing *out of* the way at the given end (lon/lat space, lat-scaled)."""
    g = way["geometry"]
    a, b = (g[0], g[min(3, len(g) - 1)]) if at_start else (g[-1], g[max(-4, -len(g))])
    c = math.cos(math.radians(a["lat"]))
    return unit((a["lon"] - b["lon"]) * c, a["lat"] - b["lat"])


def chain_ways(ways):
    ends = defaultdict(list)        # node id -> [(way id, at_start)]
    interior = set()
    for wid, w in ways.items():
        nd = w["nodes"]
        ends[nd[0]].append((wid, True))
        ends[nd[-1]].append((wid, False))
        interior.update(nd[1:-1])

    link = {}                       # (way, at_start) -> (way, at_start)

    def pair(a, b):
        link[a] = b
        link[b] = a

    for node, es in ends.items():
        es = [e for e in es if ways[e[0]]["nodes"][0] != ways[e[0]]["nodes"][-1]]  # skip closed loops
        if len(es) == 2 and node not in interior and es[0][0] != es[1][0]:
            pair(*es)
            continue
        by_key = defaultdict(list)
        for e in es:
            k = road_key(ways[e[0]].get("tags", {}))
            if k:
                by_key[k].append(e)
        for group in by_key.values():
            free = list(group)
            while len(free) >= 2:
                best = None
                for i in range(len(free)):
                    for j in range(i + 1, len(free)):
                        if free[i][0] == free[j][0]:
                            continue
                        u, v = end_direction(ways[free[i][0]], free[i][1]), end_direction(ways[free[j][0]], free[j][1])
                        straightness = -(u[0] * v[0] + u[1] * v[1])   # 1 = perfectly continuing
                        if best is None or straightness > best[0]:
                            best = (straightness, i, j)
                if best is None:
                    break
                _, i, j = best
                pair(free[i], free[j])
                free = [f for k, f in enumerate(free) if k not in (i, j)]

    seen, chains = set(), []
    for wid in ways:
        if wid in seen:
            continue
        # walk backwards to the start of this chain
        cur, cur_start = wid, True
        guard = 0
        while (cur, cur_start) in link and guard < 100000:
            nxt, nxt_start = link[(cur, cur_start)]
            if nxt == wid:
                break
            cur, cur_start = nxt, not nxt_start
            guard += 1
        # cur_start is the free end of the first way; walk forward
        chain = []
        way, entry_start = cur, cur_start
        while way not in seen:
            seen.add(way)
            chain.append((way, not entry_start))   # reversed if we enter at its end
            exit_end = (way, not entry_start)
            if exit_end not in link:
                break
            way, entry_start = link[exit_end]
        chains.append(chain)
    return chains


def chain_geometry(chain, ways):
    lon, lat, seg_way = [], [], []
    for wid, reverse in chain:
        g = ways[wid]["geometry"]
        if reverse:
            g = g[::-1]
        start = 1 if lon else 0
        for p in g[start:]:
            lon.append(p["lon"])
            lat.append(p["lat"])
            seg_way.append(wid)
    return np.array(lon), np.array(lat), seg_way


# ---------------------------------------------------------------- geometry

def to_xy(lon, lat, lat0):
    x = np.radians(lon) * R_EARTH * math.cos(math.radians(lat0))
    y = np.radians(lat) * R_EARTH
    return x, y


def resample(x, y):
    d = np.concatenate([[0], np.cumsum(np.hypot(np.diff(x), np.diff(y)))])
    s = np.arange(0, d[-1], STEP)
    return np.interp(s, d, x), np.interp(s, d, y), s, d


def radii(x, y):
    k = RADIUS_OFFSET
    r = np.full(len(x), np.inf)
    if len(x) < 2 * k + 1:
        return r
    ax, ay = x[:-2 * k], y[:-2 * k]
    bx, by = x[k:-k], y[k:-k]
    cx, cy = x[2 * k:], y[2 * k:]
    ab = np.hypot(bx - ax, by - ay)
    bc = np.hypot(cx - bx, cy - by)
    ca = np.hypot(ax - cx, ay - cy)
    cross = np.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax))
    with np.errstate(divide="ignore", invalid="ignore"):
        rr = ab * bc * ca / (2 * cross)
    rr[~np.isfinite(rr)] = np.inf
    r[k:-k] = rr
    return r


def weights(r):
    w = np.zeros_like(r)
    cls = np.zeros(len(r), dtype=np.int8)       # 0 straight, 1 sweeping ... 4 tight
    for i, (limit, weight) in enumerate(reversed(BANDS)):
        m = r < limit
        w[m] = weight
        cls[m] = i + 1
    return w, cls


def headings(x, y):
    h = np.arctan2(np.diff(y), np.diff(x))
    return np.append(h, h[-1] if len(h) else 0)


def count_hairpins(h):
    """A hairpin: >=150 deg of same-direction turning within 120 m."""
    dh = np.diff(h)
    dh = (dh + np.pi) % (2 * np.pi) - np.pi
    win = int(120 / STEP)
    count, i = 0, 0
    cs = np.concatenate([[0], np.cumsum(dh)])
    while i < len(dh):
        j = min(i + win, len(dh))
        seg = cs[i + 1:j + 1] - cs[i]
        hit = np.nonzero(np.abs(seg) >= math.radians(150))[0]
        if len(hit):
            count += 1
            i += hit[0] + 1
        else:
            i += 1
    return count


def sections(w):
    """Index ranges (in resampled steps) of curvy stretches separated by long straights."""
    split = int(SPLIT_STRAIGHT / STEP)
    pad = int(PAD / STEP)
    curvy = np.nonzero(w > 0)[0]
    if not len(curvy):
        return []
    out, start, last = [], curvy[0], curvy[0]
    for i in curvy[1:]:
        if i - last > split:
            out.append((start, last))
            start = i
        last = i
    out.append((start, last))
    n = len(w)
    return [(max(0, a - pad), min(n - 1, b + pad)) for a, b in out]


def simplify(x, y, tol=2.0):
    """Douglas-Peucker: indices of the vertices needed to stay within tol metres of the original line."""
    keep = np.zeros(len(x), dtype=bool)
    keep[[0, -1]] = True
    stack = [(0, len(x) - 1)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        dx, dy = x[j] - x[i], y[j] - y[i]
        L = math.hypot(dx, dy) or 1e-9
        d = np.abs(dy * (x[i + 1:j] - x[i]) - dx * (y[i + 1:j] - y[i])) / L
        k = int(np.argmax(d))
        if d[k] > tol:
            keep[i + 1 + k] = True
            stack += [(i, i + 1 + k), (i + 1 + k, j)]
    return keep


# ---------------------------------------------------------------- elevation

_tiles = {}


def dem_tile(x, y):
    key = (x, y)
    if key in _tiles:
        return _tiles[key]
    f = DEM_CACHE / f"{DEM_ZOOM}_{x}_{y}.png"
    if not f.exists():
        DEM_CACHE.mkdir(parents=True, exist_ok=True)
        url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{DEM_ZOOM}/{x}/{y}.png"
        r = requests.get(url, timeout=60)
        r.raise_for_status()
        f.write_bytes(r.content)
    a = np.asarray(Image.open(io.BytesIO(f.read_bytes())).convert("RGB"), dtype=np.float64)
    e = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
    _tiles[key] = e
    return e


def elevation(lon, lat):
    """Bilinear DEM sample at each (lon, lat)."""
    n = 2 ** DEM_ZOOM
    X = (np.asarray(lon, dtype=float) + 180) / 360 * n * 256 - 0.5
    lr = np.radians(np.asarray(lat, dtype=float))
    Y = (1 - np.log(np.tan(lr) + 1 / np.cos(lr)) / math.pi) / 2 * n * 256 - 0.5
    x0, y0 = np.floor(X).astype(np.int64), np.floor(Y).astype(np.int64)
    fx, fy = X - x0, Y - y0

    def pixel(gx, gy):
        v = np.empty(len(gx))
        tiles = (gx // 256) * 1_000_000 + gy // 256
        for t in np.unique(tiles):
            m = tiles == t
            v[m] = dem_tile(int(t // 1_000_000), int(t % 1_000_000))[gy[m] % 256, gx[m] % 256]
        return v

    return (pixel(x0, y0) * (1 - fx) * (1 - fy) + pixel(x0 + 1, y0) * fx * (1 - fy)
            + pixel(x0, y0 + 1) * (1 - fx) * fy + pixel(x0 + 1, y0 + 1) * fx * fy)


MAX_ROAD_GRADE = 0.22   # paved roads basically never exceed this; steeper = DEM hitting a cliff beside the road


def slope_limit(e):
    """Clamp step-to-step change forwards and backwards, then average (both passes obey the limit, so does the mean)."""
    dmax = MAX_ROAD_GRADE * STEP
    f, b = e.copy(), e.copy()
    for i in range(1, len(e)):
        f[i] = min(max(f[i], f[i - 1] - dmax), f[i - 1] + dmax)
    for i in range(len(e) - 2, -1, -1):
        b[i] = min(max(b[i], b[i + 1] - dmax), b[i + 1] + dmax)
    return (f + b) / 2


def smooth(e, median_n=11, mean_n=25):
    """Roads cut across steep slopes, so a 25 m DEM jumps around; median kills spikes, mean rounds off."""
    if len(e) < mean_n:
        return e
    p = np.pad(e, median_n // 2, mode="edge")
    e = np.median(np.lib.stride_tricks.sliding_window_view(p, median_n), axis=1)
    e = slope_limit(e)
    p = np.pad(e, mean_n // 2, mode="edge")
    return np.convolve(p, np.ones(mean_n) / mean_n, mode="valid")


def climb_stats(e):
    up = down = 0.0
    ref = e[0]
    for v in e[1:]:          # hysteresis so DEM noise doesn't add phantom climbing
        if v - ref >= 3:
            up += v - ref
            ref = v
        elif ref - v >= 3:
            down += ref - v
            ref = v
    win = int(300 / STEP)   # steepest sustained gradient over 300 m
    grad = np.abs(e[win:] - e[:-win]) / (win * STEP) if len(e) > win else np.array([0.0])
    return up, down, float(grad.max()) if len(grad) else 0.0


# ---------------------------------------------------------------- main

def nearest(points_ll, lon, lat, max_m):
    if not len(points_ll):
        return None, None
    c = math.cos(math.radians(lat))
    d = np.hypot((points_ll[:, 0] - lon) * c, points_ll[:, 1] - lat) * math.radians(1) * R_EARTH
    i = int(np.argmin(d))
    return (i, d[i]) if d[i] <= max_m else (None, None)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ways, passes, places = load_osm()
    print(f"loaded {len(ways)} ways, {len(passes)} passes, {len(places)} places")
    ways = {k: w for k, w in ways.items() if rideable(w.get("tags", {})) and len(w["nodes"]) >= 2}
    print(f"{len(ways)} rideable ways")
    chains = chain_ways(ways)
    print(f"{len(chains)} chained roads")

    # only passes that are a node on a rideable road (drops the hundreds of hiking cols)
    road_nodes = {nd for w in ways.values() for nd in w["nodes"]}
    pass_list = [p for p in passes.values() if p.get("tags", {}).get("name") and p["id"] in road_nodes]
    pass_ll = np.array([[p["lon"], p["lat"]] for p in pass_list]) if pass_list else np.zeros((0, 2))
    place_list = [p for p in places.values() if p.get("tags", {}).get("name")]
    place_ll = np.array([[p["lon"], p["lat"]] for p in place_list])

    s, w_, n, e_ = BBOX
    candidates = []
    for chain in chains:
        lon, lat, seg_way = chain_geometry(chain, ways)
        if len(lon) < 3:
            continue
        lat0 = float(lat.mean())
        x, y = to_xy(lon, lat, lat0)
        keep = np.concatenate([[True], np.hypot(np.diff(x), np.diff(y)) > 0.01])   # drop duplicate points
        lon, lat, x, y = lon[keep], lat[keep], x[keep], y[keep]
        seg_way = [sw for sw, k in zip(seg_way, keep) if k]
        rx, ry, rs, vd = resample(x, y)
        if len(rx) < 10:
            continue
        r = radii(rx, ry)
        wts, cls = weights(r)
        for a, b in sections(wts):
            length = (b - a) * STEP
            curvy_km = float(wts[a:b].sum() * STEP / 1000)
            if length < MIN_LEN or curvy_km < MIN_CURVY_KM or curvy_km / (length / 1000) < MIN_DENSITY:
                continue
            candidates.append(dict(lon=lon, lat=lat, vd=vd, seg_way=seg_way, lat0=lat0,
                                   a=a, b=b, rx=rx, ry=ry, cls=cls, length=length, curvy_km=curvy_km))
    print(f"{len(candidates)} twisty sections before ranking")

    # Pre-rank on curvature alone so we only fetch elevation for the ones we'll keep.
    candidates.sort(key=lambda c: c["curvy_km"], reverse=True)
    candidates = candidates[: int(MAX_ROADS * 1.6)]

    roads = []
    for i, c in enumerate(candidates):
        a, b = c["a"], c["b"]
        lon_k, lat_k, seg_way_k = c["lon"], c["lat"], c["seg_way"]
        d0, d1 = a * STEP, b * STEP
        inside = np.nonzero((c["vd"] > d0) & (c["vd"] < d1))[0]
        out_lon = np.concatenate([[np.interp(d0, c["vd"], lon_k)], lon_k[inside], [np.interp(d1, c["vd"], lon_k)]])
        out_lat = np.concatenate([[np.interp(d0, c["vd"], lat_k)], lat_k[inside], [np.interp(d1, c["vd"], lat_k)]])
        out_d = np.concatenate([[d0], c["vd"][inside], [d1]])
        keep = simplify(*to_xy(out_lon, out_lat, c["lat0"]))
        out_lon, out_lat, out_d = out_lon[keep], out_lat[keep], out_d[keep]

        # elevation on the 10 m resample for stats, on vertices for display
        lat0 = c["lat0"]
        rs_lon = np.degrees(c["rx"][a:b + 1] / (R_EARTH * math.cos(math.radians(lat0))))
        rs_lat = np.degrees(c["ry"][a:b + 1] / R_EARTH)
        raw = elevation(rs_lon, rs_lat)
        # in tunnels / galleries / on bridges the DEM is the mountain above or the valley below:
        # ignore it there and interpolate between the portals
        rs_d = np.arange(a, b + 1) * STEP
        owner_rs = np.clip(np.searchsorted(c["vd"], rs_d), 0, len(seg_way_k) - 1)
        off_ground = np.array([is_off_ground(ways[seg_way_k[k]].get("tags", {})) for k in owner_rs])
        if off_ground.any() and not off_ground.all():
            raw[off_ground] = np.interp(rs_d[off_ground], rs_d[~off_ground], raw[~off_ground])
        ele_rs = smooth(raw)
        up, down, max_grad = climb_stats(ele_rs)
        ele_v = np.interp(out_d, np.arange(a, b + 1) * STEP, ele_rs)

        # curve class per display segment = tightest bend inside it
        curve = []
        for j in range(len(out_d) - 1):
            i0, i1 = int(out_d[j] // STEP), int(math.ceil(out_d[j + 1] / STEP))
            curve.append(str(int(c["cls"][i0:max(i1, i0 + 1)].max())))

        hairpins = count_hairpins(headings(c["rx"][a:b + 1], c["ry"][a:b + 1]))

        # naming: weight each way's name/ref by how much of the section it covers
        seg_len = np.diff(out_d)
        owner = [seg_way_k[min(len(seg_way_k) - 1, int(np.searchsorted(c["vd"], (out_d[j] + out_d[j + 1]) / 2)))]
                 for j in range(len(seg_len))]
        name_len, ref_len = defaultdict(float), defaultdict(float)
        for wid, L in zip(owner, seg_len):
            t = ways[wid].get("tags", {})
            if t.get("name"):
                name_len[t["name"]] += L
            if t.get("ref"):
                ref_len[t["ref"]] += L
        tags = [ways[wid].get("tags", {}) for wid in set(owner)]
        name = max(name_len, key=name_len.get) if name_len else None
        ref = max(ref_len, key=ref_len.get) if ref_len else None
        name_share = name_len[name] / c["length"] if name else 0
        seasonal = any(k.endswith(":conditional") and k.split(":")[0] in ("access", "vehicle", "motor_vehicle", "motorcycle")
                       for t in tags for k in t)

        best_pass = None
        if len(pass_ll):
            sl = (out_lon.min() - 0.01, out_lat.min() - 0.01, out_lon.max() + 0.01, out_lat.max() + 0.01)
            near = np.nonzero((pass_ll[:, 0] > sl[0]) & (pass_ll[:, 0] < sl[2]) & (pass_ll[:, 1] > sl[1]) & (pass_ll[:, 1] < sl[3]))[0]
            for pi in near:
                pl = pass_list[pi]
                cc = math.cos(math.radians(pl["lat"]))
                dd = np.hypot((out_lon - pl["lon"]) * cc, out_lat - pl["lat"]).min() * math.radians(1) * R_EARTH
                if dd < 80:
                    pe = pl["tags"].get("ele")
                    try:
                        pe = int(float(pe.split()[0].replace(",", "."))) if pe else None
                    except ValueError:
                        pe = None
                    cand = {"name": pl["tags"]["name"], "ele": pe or int(elevation([pl["lon"]], [pl["lat"]])[0]),
                            "lon": round(pl["lon"], 5), "lat": round(pl["lat"], 5)}
                    if best_pass is None or cand["ele"] > best_pass["ele"]:
                        best_pass = cand

        towns = []
        for lo, la in ((out_lon[0], out_lat[0]), (out_lon[-1], out_lat[-1])):
            k, _ = nearest(place_ll, lo, la, 6000)
            towns.append(place_list[k]["tags"]["name"] if k is not None else None)

        # title: pass > a name covering most of it > road number > any name
        if best_pass:
            title = best_pass["name"]
        elif name and (name_share >= 0.6 or not ref):
            title = name
        else:
            title = ref or name or "Unnamed road"
        sub = " · ".join(x for x in (ref if ref != title else None, name if name not in (title, None) and name_share >= 0.3 else None) if x)

        coords = [[round(float(lo), 5), round(float(la), 5), round(float(el))] for lo, la, el in zip(out_lon, out_lat, ele_v)]
        curve = "".join(curve)
        if down > up:   # present every road uphill-first
            coords, curve, towns, up, down = coords[::-1], curve[::-1], towns[::-1], down, up

        roads.append({
            "name": title,
            "road": sub or None,
            "from": towns[0], "to": towns[1] if towns[1] != towns[0] else None,
            "len": round(c["length"]),
            "curvy": round(c["curvy_km"], 2),
            "density": round(c["curvy_km"] / (c["length"] / 1000), 3),
            "hairpins": hairpins,
            "climb": round(up), "descent": round(down),
            "eleMin": round(float(ele_rs.min())), "eleMax": round(float(ele_rs.max())),
            "maxGrad": round(max_grad * 100, 1),
            "pass": best_pass,
            "seasonal": seasonal,
            "coords": coords,
            "curve": curve,
        })
        if (i + 1) % 100 == 0:
            print(f"  scored {i + 1}/{len(candidates)} (dem tiles cached: {len(_tiles)})", flush=True)

    # Fun score: curvy km, boosted by how mountainous the road is (up to 2x at 1200 m relief).
    for rd in roads:
        relief = rd["eleMax"] - rd["eleMin"]
        rd["raw"] = rd["curvy"] * (1 + min(relief, 1200) / 1200) * (1 + min(rd["hairpins"], 20) / 40)
    roads.sort(key=lambda rd: rd["raw"], reverse=True)
    roads = roads[:MAX_ROADS]
    for i, rd in enumerate(roads):
        rd["id"] = i + 1
        rd["score"] = round(100 * rd.pop("raw") / SCORE_REF)

    pass_out = []
    for p in pass_list:
        if not (s <= p["lat"] <= n and w_ <= p["lon"] <= e_):
            continue
        pe = p["tags"].get("ele")
        try:
            pe = int(float(pe.split()[0].replace(",", "."))) if pe else None
        except ValueError:
            pe = None
        pass_out.append({"name": p["tags"]["name"], "ele": pe, "lon": round(p["lon"], 5), "lat": round(p["lat"], 5)})

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"bbox": BBOX, "roads": roads, "passes": pass_out}, separators=(",", ":"), ensure_ascii=False),
                   encoding="utf-8")
    print(f"wrote {len(roads)} roads, {len(pass_out)} passes -> {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")
    for rd in roads[:25]:
        print(f"  {rd['score']:3d}  {rd['name'][:34]:34s} {rd['road'] or '':18s} {rd['len'] / 1000:5.1f} km  "
              f"hp {rd['hairpins']:2d}  climb {rd['climb']:4d}  {rd['eleMin']}-{rd['eleMax']} m  {rd['from']} -> {rd['to']}")


if __name__ == "__main__":
    main()
