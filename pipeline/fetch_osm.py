"""Download drivable roads, mountain passes and place names for the region from Overpass.

The region is split into cells so each query stays small; responses are cached in
pipeline/cache/ so re-running only fetches what's missing.
"""
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

from region import BBOX, CELL_DEG, HOME

CACHE = Path(__file__).parent / "cache" / "osm"
ENDPOINTS = [
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

QUERY = """
[out:json][timeout:240];
(
  way["highway"~"^(trunk|primary|secondary|tertiary|unclassified)$"]({s},{w},{n},{e});
  node["mountain_pass"="yes"]({s},{w},{n},{e});
  node["place"~"^(city|town|village)$"]({s},{w},{n},{e});
);
out body geom qt;
"""


def cells():
    s, w, n, e = BBOX
    lat = s
    while lat < n:
        lon = w
        while lon < e:
            yield (round(lat, 3), round(lon, 3), round(min(lat + CELL_DEG, n), 3), round(min(lon + CELL_DEG, e), 3))
            lon += CELL_DEG
        lat += CELL_DEG


def fetch(cell, first=0):
    s, w, n, e = cell
    q = QUERY.format(s=s, w=w, n=n, e=e)
    for attempt in range(15):
        url = ENDPOINTS[(first + attempt) % len(ENDPOINTS)]
        try:
            r = requests.post(url, data={"data": q}, timeout=300,
                              headers={"User-Agent": "twisty-roads/0.1 (hobby project)"})
            if r.status_code == 200:
                return r.json()
            print(f"  {url} -> HTTP {r.status_code}, retrying", flush=True)
        except requests.RequestException as ex:
            print(f"  {url} -> {ex.__class__.__name__}, retrying", flush=True)
        time.sleep(min(60, 10 * (attempt + 1)))
    return None


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    todo = [c for c in cells() if not (CACHE / ("cell_%s_%s_%s_%s.json" % c)).exists()]
    todo.sort(key=lambda c: ((c[0] + c[2]) / 2 - HOME[0]) ** 2 + ((c[1] + c[3]) / 2 - HOME[1]) ** 2)  # home first
    print(f"{len(todo)} cells to fetch", flush=True)

    def worker(k):
        # one worker per server, each starting on a different endpoint; 1 request at a time per server
        for cell in todo[k::len(ENDPOINTS)]:
            t = time.time()
            data = fetch(cell, first=k)
            if data is None:
                print(f"{cell}: gave up for now - re-run to retry", flush=True)
                continue
            out = CACHE / ("cell_%s_%s_%s_%s.json" % cell)
            tmp = out.with_suffix(".tmp")
            tmp.write_text(json.dumps(data), encoding="utf-8")
            tmp.replace(out)
            print(f"{cell}: {len(data['elements'])} elements in {time.time() - t:.0f}s", flush=True)
            time.sleep(3)  # be polite to the public Overpass servers

    with ThreadPoolExecutor(len(ENDPOINTS)) as pool:
        list(pool.map(worker, range(len(ENDPOINTS))))
    print("done", flush=True)


if __name__ == "__main__":
    sys.exit(main())
