/* A partial scan adds discoveries, but must not erase roads from earlier downloads.
 * Older saved scans have no `missing` field, so their coverage is treated as unknown.
 */
const complete = (area) => area.missing === 0;
const covers = ([s, w, n, e], [s2, w2, n2, e2]) => s <= s2 + 1e-6 && w <= w2 + 1e-6 && n >= n2 - 1e-6 && e >= e2 - 1e-6;
const midIn = ([s, w, n, e], road) => {
  const [lon, lat] = road.coords[road.coords.length >> 1];
  return lat > s && lat < n && lon > w && lon < e;
};

/** Merge a scan, retaining same-area results on partial retries. Complete scans replace covered areas. */
export function mergeAreas(areas, incoming) {
  const previous = areas.find((a) => a.key === incoming.key);
  let area = incoming;
  if (!complete(incoming) && previous) {
    area = {
      ...incoming,
      // Prefer the existing road when both contain it; incomplete input may truncate its description.
      roads: [...new Map([...incoming.roads, ...previous.roads].map((r) => [r.id, r])).values()],
      passes: [...new Map([...incoming.passes, ...previous.passes].map((p) => [`${p.lon},${p.lat}`, p])).values()],
    };
  }
  return [...areas.filter((a) => a.key !== area.key && !(complete(area) && covers(area.bbox, a.bbox))), area];
}

/** Only known-complete scans hide prior coverage. Deduplicate roads also returned by partial scans. */
export function collectRoads(tiles, areas) {
  const roads = new Map();
  const hidden = (road, newer) => newer.some((a) => complete(a) && midIn(a.bbox, road));
  for (const tile of tiles) for (const road of tile.roads) {
    if (!hidden(road, areas)) roads.set(road.id, road);
  }
  areas.forEach((area, i) => {
    for (const road of area.roads) {
      if (hidden(road, areas.slice(i + 1))) continue;
      if (complete(area) || !roads.has(road.id)) roads.set(road.id, road);
    }
  });
  return [...roads.values()];
}
