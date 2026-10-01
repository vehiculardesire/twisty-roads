# Twisty Roads

**Find the most fun roads anywhere.** Every paved road in OpenStreetMap is scored on its bends, hairpins, climb
and views, and shown on a 3D terrain map.

**Try it: https://vehiculardesire.github.io/twisty-roads/**

A static site with no backend, no accounts and no API keys, hosted free on GitHub Pages.

## What it does

- **Ranks roads** by a fun score, with a **taste slider** from fast sweepers to tight hairpins.
- **The Western Alps and the Jura are built in** (from Nice to the Stelvio, and from the Jura to Lake Como), loaded a tile at a time as
  you move the map, so the site opens instantly. Zoomed out, the map only draws the better roads.
- **Scans anywhere else.** Type a town, or use *Near me* or *Map view*, and pick 20 to 100 km. Your browser
  downloads that area's roads and terrain and scores them on the spot (under a minute for 30 km; a few minutes
  for 100 km, longer when the public map servers are busy). Scans are saved and shareable.
- **Shows each road in detail:**
  - bend-by-bend colouring on a smooth line
  - glowing hot spots and a ★ on the best bit
  - an elevation profile coloured by gradient
  - weather at the top, including how cold it feels at riding speed
  - warnings for narrow stretches, tolls, tunnels and seasonal closures
  - cafés, food, huts and fuel along the way
- **Fly along** any road in 3D. Export it as **GPX**, or send it to Google Maps to navigate.
- **Share** a road as an image card plus a link.
- **Learns you:**
  - ☆ favourites
  - import your **GPX rides** to see which roads you've ridden and which you haven't
  - rate roads 👍 / 👎 and it tunes the scoring to your taste

Everything personal (favourites, ratings, rides) stays in your browser and is never uploaded.

## How the fun score works

A road is scored on its **best stretch** (up to 15 km), so a great pass isn't dragged down by the valley road to it:

> **bends × (1 + terrain + scenery + hairpins)** × **good km**

- **Bends:** how tight the road turns every 10 m, from *sweeping* (radius under 175 m) to *hairpin-tight*
  (under 30 m). Every km in a bend counts, weighted by your taste. Bends through villages count 30%: nice to look
  at, not to ride hard.
- **Terrain:** up to +0.5 for a big climb, or +0.3 for rolling crests and dips.
- **Scenery:** up to +0.5 for open views down over the surroundings, steep drop-offs, marked viewpoints and high
  alpine terrain.
- **Hairpins:** up to +0.5 for 20, a bit more for Stelvio-style stacks.
- **Good km:** how much of the road is at least half that good. A 6 km gem counts ×0.63, 15 km ×1, and 30 km of
  greatness ×1.41. Meh stretches neither help nor hurt.

The bonuses add rather than multiply, so a road isn't rewarded just for having a bit of everything.

**Calibration.** 100 is the world's best. Benchmark roads scanned with the app score Stelvio 95, Grossglockner 81,
Transfăgărășan 81 and Tail of the Dragon 71. Around Geneva, the Colle del Nivolet scores 80. Col de L'Arpettaz hits
the ceiling: it packs 57 hairpins into 26 km, more bends per km than the Stelvio.

**What it can't see:** road width (rarely mapped), surface quality, traffic, waterfalls or glaciers, fame, or
whether a road is open today. A high score means "this will be very twisty"; a tight mountain lane and a wide
famous pass can score the same.

<details>
<summary>The details, for the curious</summary>

- **Roads:** `trunk / primary / secondary / tertiary / unclassified` from OpenStreetMap (via Overpass), minus
  unpaved, private, farm-only and roundabouts. OSM ways are chained into continuous roads, and cut into sections at
  straights longer than 4 km.
- **Bend radius:** the circle through the points 20 m either side of each 10 m sample, cross-checked at ±40 m so
  wobble in detailed map data doesn't count as bends. This builds on the approach of
  [roadcurvature.com](https://roadcurvature.com/) (Adam Franco).

  | taste    | sweeping | flowing | tight | hairpin-tight | hairpin bonus |
  |----------|---------:|--------:|------:|--------------:|--------------:|
  | sweepers | 1.6      | 1.4     | 1.0   | 0.6           | none          |
  | balanced | 1.0      | 1.3     | 1.6   | 2.0           | +0.5 at 20    |
  | hairpins | 0.6      | 1.0     | 1.7   | 2.4           | +1.0 at 20    |

- **Hairpins:** 150° or more of turning within 120 m; diminishing returns from 20 up to 60.
- **Built-up:** explicit urban speed zones, or within 350 m of a village, 800 m of a town or 1.8 km of a city.
- **Elevation:** AWS Terrain Tiles (zoom 12, about 25 m). Tunnels and bridges are bridged over, and the profile is
  median-filtered, slope-limited to 22% and smoothed, because a road cut into a cliff otherwise picks up the cliff.
- **Terrain bonus:** 0.5 × max(climb in the stretch ÷ 1,500 m, rolling), where rolling is crests and dips of at
  least 5 m per km, up to 0.3.
- **Scenery bonus**, per 200 m slice:
  - *view:* the share of the horizon 0.8–1.6 km away that lies at least 60 m below the road (half open counts
    as a full view)
  - *drop-off:* the steepest fall-away within 120 m
  - *viewpoints:* `tourism=viewpoint` within 200 m
  - *high alpine:* above a latitude-based treeline, about 2,000 m in the Alps and 950 m in western Norway
- **Good km:** √(min(km, 30) ÷ 15), counting the km at least half as intense as the best stretch.
- **Hot spots:** stretches within 70% of the road's most intense kilometre.
- **Scale:** linear, normalised per taste so the slider reshuffles roads without inflating them, capped at 100.
- **Taste learning:** tries every taste × how much terrain, scenery and hairpins count (×0.5 / ×1 / ×1.5),
  keeping the settings that rank your 👍 roads above your 👎 roads while staying closest to the defaults.

Each road stores its 200 m slices as a compact `bins` string, so the site re-scores for any taste without the engine.
</details>

## For developers

```
site/                 the app: plain HTML/JS, MapLibre GL from a CDN, no build step
site/core/twisty.js   the engine: OSM + terrain -> scored roads (runs in the browser and in Node)
site/scan-worker.js   runs the engine in the browser
site/personal.js      favourites, ratings, taste learning
site/rides.js         GPX import and ridden matching
site/stops.js         cafés, food and fuel along a road
site/share.js         the share card
site/db.js            browser storage for scans and rides
tools/                Node scripts that pre-build the Western Alps tiles (tools/region.json)
site/data/            the pre-built tiles + index.json (which tile holds which road)
```

Run it locally:

```bash
python -m http.server 8765 --directory site
```

Rebuild the pre-built tiles (Node 20+; about 80 Overpass queries, so be patient). Download each tile, then score
them all:

```bash
node tools/fetch-tile.mjs 46_6
node tools/build-tiles.mjs
```

**Deploy:** push to `main`.
- `pages.yml` publishes `site/` to GitHub Pages whenever the site changes.
- `refresh-data.yml` rebuilds the tiles on 1 March and 1 September, when `tools/` changes, or by hand from the
  Actions tab, then redeploys. Each tile downloads in its own job: if the map servers fail one, *Re-run failed
  jobs* redoes just that tile.

## Data & credits

- Roads, passes and stops © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL)
- Terrain: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen/Tilezen)
- Base map: [OpenFreeMap](https://openfreemap.org)
- Weather: [Open-Meteo](https://open-meteo.com)
- Place search: [Photon](https://photon.komoot.io) (komoot)
- Map queries: the public Overpass API servers (overpass-api.de, private.coffee, kumi.systems). Please keep scans
  occasional.
- Map library: [MapLibre GL JS](https://maplibre.org)
