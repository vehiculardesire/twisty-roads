# Twisty Roads

Finds the most fun roads anywhere: every paved road in OpenStreetMap scored on its bends, hairpins and climb,
shown on a 3D terrain map with an elevation profile, bend-by-bend colouring, weather at the top, a fly-along
camera and GPX export.

**Live:** https://vehiculardesire.github.io/twisty-roads/

Static site, no backend, no API keys: it runs on GitHub Pages.

- **Scan anywhere**: type a town, use *Near me* or *Map view*. The browser downloads that area's roads and
  terrain and scores them in a Web Worker (20 s to 2 min, depending on how busy the public Overpass servers are).
  Scans are saved in your browser (*Your areas*) and shareable (`#scan=lat,lon,radius`).
- **Built-in region**: one region is pre-built so the site opens instantly, and refreshed monthly by a
  GitHub Action.
- **Taste slider**: from fast sweepers to tight hairpins; re-ranks everything.
- **Selected road**: drawn as a smooth curve through the OSM points and re-measured every 10 m, with weather at
  its highest point (Open-Meteo) and warnings for narrow stretches, tolls, tunnels and seasonal closures.

```
site/                 the app (plain HTML/JS, MapLibre GL from a CDN, no build step)
site/core/twisty.js   the engine: OSM + terrain -> scored road sections (browser and Node)
site/scan-worker.js   runs the engine in the browser
tools/                Node script that pre-builds the built-in region (tools/region.json)
```

## What makes a road fun

The fun score multiplies three things (the site's *How it's scored* explains it for riders):

1. **Bends.** Each road is resampled every 10 m; the circle through the points 20 m either side gives the
   bend radius, banded as sweeping (< 175 m), flowing (< 100 m), tight (< 60 m) and hairpin-tight (< 30 m).
   Every km in a bend counts, weighted by taste:

   | taste        | sweeping | flowing | tight | hairpin-tight | hairpin bonus |
   |--------------|---------:|--------:|------:|--------------:|--------------:|
   | sweepers     | 1.6      | 1.4     | 1.0   | 0.6           | none          |
   | balanced     | 1.0      | 1.3     | 1.6   | 2.0           | up to ×1.5    |
   | hairpins     | 0.6      | 1.0     | 1.7   | 2.4           | up to ×2      |

   This builds on the approach of [roadcurvature.com](https://roadcurvature.com/) (Adam Franco).
2. **Mountain.** ×1 to ×2 for 0 to 1,200 m between the lowest and highest point.
3. **Hairpins.** 150° or more of turning within 120 m.

Scale: Cormet de Roselend at balanced taste = 100, so scores compare across regions.

How the raw data becomes roads:

- **Roads:** `trunk / primary / secondary / tertiary / unclassified`, minus unpaved, private, farm-only and
  roundabouts.
- **Chaining:** OSM ways are joined into continuous roads where two meet end to end, or where the same road
  number or name continues through a junction.
- **Sections:** a road is cut wherever it has more than 2.5 km of straight.
- **Elevation:** AWS Terrain Tiles (zoom 12, about 25 m). Tunnels and bridges are bridged over, and the profile is
  median-filtered, slope-limited to 22% and smoothed, because a road cut into a cliff otherwise picks up the cliff.

## Run locally

```bash
python -m http.server 8765 --directory site
```

Rebuild the built-in region (Node 20+; about 30 queries to Overpass, so be patient):

```bash
node tools/build-region.mjs
```

## Deploy

Push to `main`. `pages.yml` publishes `site/` to GitHub Pages (Settings → Pages → Source: GitHub Actions).
`refresh-data.yml` rebuilds `site/data/home.json` monthly and whenever the engine changes, then redeploys.

## Data & credits

- Roads and passes © OpenStreetMap contributors (ODbL)
- Terrain: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen/Tilezen)
- Base map: [OpenFreeMap](https://openfreemap.org)
- Weather: [Open-Meteo](https://open-meteo.com)
- Place search: [Photon](https://photon.komoot.io) (komoot)
- Road queries: public Overpass API servers (overpass-api.de, private.coffee, kumi.systems). Please keep scans
  occasional.
- Map library: [MapLibre GL JS](https://maplibre.org)
