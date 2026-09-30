# Twisty roads

Finds the twistiest paved roads and mountain passes around Geneva and shows them on a 3D terrain map,
with an elevation profile, a bend-by-bend colouring, a fly-along camera and GPX export.

Static site, no backend: it runs on GitHub Pages.

**Scan anywhere**: type a town (or use "Scan map view") and the browser downloads that area's roads
from OpenStreetMap and elevation tiles, scores them in a Web Worker (`site/scan.js`) and adds them to the
map. Scans are shareable: the URL becomes `#scan=lat,lon,radius`. It usually takes 20 s to 2 min,
depending on how busy the public Overpass servers are.

```
pipeline/     Python: pre-builds the Geneva region -> site/data/roads.json (instant on page load)
site/         the map (plain HTML/JS, MapLibre GL from a CDN, no build step)
site/scan.js  the same algorithm in JavaScript, for scanning anywhere from the browser
```

`pipeline/build.py` and `site/scan.js` implement the same algorithm; keep the constants in step.
Scores use a fixed scale (Cormet de Roselend = 100), so they're comparable between regions.

## How a road gets its score

1. **Roads**: every `trunk / primary / secondary / tertiary / unclassified` road from OpenStreetMap
   (via Overpass), minus unpaved, private, agricultural-only and roundabouts.
2. **Chaining**: OSM splits roads into many small ways. They're joined back into continuous roads
   where exactly two ways meet end to end, or where the road number / name continues through a junction
   (taking the straightest continuation).
3. **Curvature**: each road is resampled every 10 m. At each point the radius of the circle through the
   points 20 m either side gives the bend radius, which is banded:

   | radius   | band          | weight |
   |----------|---------------|--------|
   | < 30 m   | hairpin-tight | 2.0    |
   | < 60 m   | tight         | 1.6    |
   | < 100 m  | flowing       | 1.3    |
   | < 175 m  | sweeping      | 1.0    |
   | straight |               | 0      |

   *Curvy km* = Σ (length × weight). This is the approach used by
   [roadcurvature.com](https://roadcurvature.com/) (Adam Franco).
4. **Sections**: roads are cut wherever there's more than 2.5 km of straight, so a great pass isn't
   diluted by the valley road leading to it. Sections under 2.5 km, or not curvy enough, are dropped.
5. **Hairpins**: 150° or more of turning in the same direction within 120 m.
6. **Elevation**: sampled from AWS Terrain Tiles (Terrarium, zoom 12, ~25 m). Tunnels and bridges are
   bridged over; the profile is median-filtered, slope-limited to 22 % and smoothed, because a road
   cut into a cliff otherwise picks up the cliff.
7. **Fun score** = curvy km × (1 + relief/1200 m, max 2×) × (1 + hairpins/40, max 1.5×), scaled so
   Cormet de Roselend is 100 (a road can score above 100).

Named mountain passes (`mountain_pass=yes` nodes on the road) name the section; otherwise it's the
road's name or number, with the nearest towns at each end.

## Run the pipeline

```bash
cd pipeline
pip install -r requirements.txt
python fetch_osm.py     # ~28 Overpass queries, cached in pipeline/cache/ (safe to re-run)
python build.py         # ~1 min, writes site/data/roads.json
```

Change the area in `pipeline/region.py`.

## Run the site locally

```bash
python -m http.server 8765 --directory site
```

## Deploy

Push to `main`: `.github/workflows/pages.yml` publishes `site/` to GitHub Pages
(Settings → Pages → Source: GitHub Actions).

## Data & credits

- Roads and passes © OpenStreetMap contributors (ODbL)
- Terrain: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen/Tilezen)
- Base map: [OpenFreeMap](https://openfreemap.org), no API key
- Place search: [Photon](https://photon.komoot.io) (komoot)
- Road queries: public Overpass API servers (overpass-api.de, private.coffee, kumi.systems). Please keep scans occasional.
- Map library: [MapLibre GL JS](https://maplibre.org)
