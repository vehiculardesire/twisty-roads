import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { collectRoads, mergeAreas } from "../site/areas.js";
import { scoreRoad } from "../site/core/twisty.js";
import { idb } from "../site/db.js";
import { riddenRoads } from "../site/rides.js";
import { bitEntry, topBits } from "../tools/tiles.mjs";

const scoredRoad = (overrides = {}) => ({
  name: "D 17", road: null, pass: null, warn: { narrow: 0 },
  coords: [[7, 46, 500], [7.08, 46, 1000]], bins: "k000000000".repeat(30), ...overrides,
});

test("best 5 km is independent of whether the reference is a title or subtitle", () => {
  const title = scoreRoad(scoredRoad()).bit;
  const subtitle = scoreRoad(scoredRoad({ name: "Mountain road", road: "D 17 · Mountain road" })).bit;
  const explicit = scoreRoad(scoredRoad({ name: "Mountain road", road: null, ref: "D 17" })).bit;
  assert.ok(title);
  assert.deepEqual(title, subtitle);
  assert.deepEqual(title, explicit);
});

test("explicit references take precedence over display text; other best-bit restrictions remain", () => {
  assert.equal(scoreRoad(scoredRoad({ ref: null })).bit, null);
  assert.equal(scoreRoad(scoredRoad({ name: "Forest lane" })).bit, null);
  assert.equal(scoreRoad(scoredRoad({ warn: { narrow: 20 } })).bit, null);
  assert.equal(scoreRoad(scoredRoad({ bins: "k000000000".repeat(24) })).bit, null);
  assert.equal(scoreRoad(scoredRoad({ bins: "k0000000k0".repeat(30) })).bit, null);
  assert.ok(scoreRoad(scoredRoad({ name: "Named pass", ref: null, pass: { name: "Named pass" } })).bit);
});

const road = (id, lon = 7, lat = 46) => ({ id, coords: [[lon, lat], [lon + 0.01, lat]] });
const area = (key, roads, missing = 0, bbox = [45, 6, 47, 8]) => ({ key, roads, missing, bbox, passes: [] });
const ids = (roads) => roads.map((r) => r.id).sort();

test("a larger partial scan preserves saved and prebuilt roads, even after serialization", () => {
  const base = [{ roads: [road("base")] }];
  const old = area("small", [road("saved")], 0, [45.5, 6.5, 46.5, 7.5]);
  let areas = mergeAreas([old], area("large", [road("new")], 2));
  assert.deepEqual(areas.map((a) => a.key), ["small", "large"]);
  // The complete small scan legitimately covers base; the partial large scan cannot cover saved.
  assert.deepEqual(ids(collectRoads(base, areas)), ["new", "saved"]);
  assert.deepEqual(ids(collectRoads(base, [areas[1]])), ["base", "new"]);
  areas = JSON.parse(JSON.stringify(areas));
  assert.equal(areas[1].missing, 2);
  assert.deepEqual(ids(collectRoads(base, areas)), ["new", "saved"]);
});

test("a partial retry of the same area retains previous roads and passes", () => {
  const oldRoad = { ...road("saved"), name: "Full road" };
  const old = { ...area("same", [oldRoad, road("only-old")]), passes: [{ lon: 7, lat: 46, name: "Pass" }] };
  const incoming = area("same", [{ ...road("saved"), name: "Partial road" }, road("new")], 1);
  const areas = JSON.parse(JSON.stringify(mergeAreas([old], incoming)));
  assert.equal(areas.length, 1);
  assert.deepEqual(ids(areas[0].roads), ["new", "only-old", "saved"]);
  assert.equal(areas[0].roads.find((r) => r.id === "saved").name, "Full road");
  assert.equal(areas[0].passes[0].name, "Pass");
  assert.equal(areas[0].missing, 1);
});

test("a complete retry replaces covered areas and stops retaining stale roads", () => {
  const saved = [area("small", [road("old")], 0, [45.5, 6.5, 46.5, 7.5]), area("large", [road("partial")], 1)];
  const outside = area("outside", [road("outside", 10)], 0, [45, 9, 47, 11]);
  const areas = mergeAreas([...saved, outside], area("large", [road("replacement")]));
  assert.deepEqual(areas.map((a) => a.key), ["outside", "large"]);
  assert.deepEqual(ids(collectRoads([{ roads: [road("base")] }], areas)), ["outside", "replacement"]);
});

test("partial overlaps keep uncovered roads and duplicate IDs appear once", () => {
  const baseRoad = { ...road("duplicate"), name: "Known road" };
  const partial = area("partial", [{ ...baseRoad, name: "Partial" }, road("discovery")], 1);
  const found = collectRoads([{ roads: [baseRoad, road("outside", 10)] }], [partial]);
  assert.deepEqual(ids(found), ["discovery", "duplicate", "outside"]);
  assert.equal(found.find((r) => r.id === "duplicate").name, "Known road");
  const complete = area("complete", [road("fresh")], 0, [45.9, 6.9, 46.1, 7.1]);
  assert.deepEqual(ids(collectRoads([], [area("wide", [road("inside"), road("outside", 10)]), complete])), ["fresh", "outside"]);
});

test("legacy scans with unknown completeness cannot hide prebuilt coverage", () => {
  const legacy = area("legacy", [road("legacy")]);
  delete legacy.missing;
  const areas = mergeAreas([], legacy);
  assert.deepEqual(ids(collectRoads([{ roads: [road("base")] }], areas)), ["base", "legacy"]);
});

function rideFixture(lat = 46, offsetM = 0, axis = "latitude") {
  const vertical = axis === "longitude";
  const coords = vertical ? [[7, lat], [7, lat + 0.01]] : [[7, lat], [7.01, lat]];
  const r = { id: "test-road", coords, bb: [7, lat, coords[1][0], coords[1][1]] };
  const offset = vertical ? offsetM / (111320 * Math.cos(lat * Math.PI / 180)) : offsetM / 111320;
  const points = Array.from({ length: 201 }, (_, i) => vertical
    ? [7 + offset, lat + i * 0.00005]
    : [7 + i * 0.00005, lat + offset]);
  return { r, ride: { points } };
}

test("GPX matches exact and offset tracks within 35 m, in either direction", () => {
  for (const axis of ["latitude", "longitude"]) for (const offset of [0, -11, 11, -34, 34]) {
    const { r, ride } = rideFixture(46, offset, axis);
    assert.ok(riddenRoads([r], [ride]).has(r.id), `${axis}, ${offset} m`);
  }
});

test("GPX matching still rejects tracks outside tolerance or below 60% coverage", () => {
  for (const axis of ["latitude", "longitude"]) {
    const { r, ride } = rideFixture(46, 40, axis);
    assert.equal(riddenRoads([r], [ride]).size, 0);
  }
  const { r, ride } = rideFixture();
  assert.equal(riddenRoads([r], [{ points: ride.points.slice(0, 60) }]).size, 0);
  assert.equal(riddenRoads([r], []).size, 0);
});

test("GPX grid searches far enough east/west at high latitudes", () => {
  const { r, ride } = rideFixture(80, 34, "longitude");
  assert.ok(riddenRoads([r], [ride]).has(r.id));
});

test("storage waits for commit and rejects a transaction aborted after request success", async () => {
  const previous = globalThis.indexedDB;
  try {
    for (const abort of [false, true]) {
      let closed = false, settled = false;
      const request = { result: "saved" };
      const tx = { objectStore: () => ({ put: () => request }) };
      globalThis.indexedDB = { open: () => {
        const open = { result: { transaction: () => tx, close: () => { closed = true; } } };
        queueMicrotask(() => open.onsuccess());
        return open;
      } };
      const pending = idb("areas", "put", { key: "scan" });
      pending.then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve();
      await Promise.resolve();
      request.onsuccess();
      await Promise.resolve();
      assert.equal(settled, false);
      if (abort) {
        tx.error = new Error("Quota exceeded at commit");
        tx.onabort();
        await assert.rejects(pending, /Quota exceeded/);
      } else {
        tx.oncomplete();
        assert.equal(await pending, "saved");
      }
      assert.equal(closed, true);
    }
  } finally {
    if (previous === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = previous;
  }
});

test("bundled roads have bounded scores and the generated best-bits index matches the engine", async () => {
  const data = new URL("../site/data/", import.meta.url);
  const index = JSON.parse(await readFile(new URL("index.json", data), "utf8"));
  const entries = [];
  let count = 0;
  // Preserve index order: equally scored entries retain their input order in the builder.
  for (const { key } of index.tiles) {
    const tile = JSON.parse(await readFile(new URL(`tiles/${key}.json`, data), "utf8"));
    for (const r of tile.roads) {
      count++;
      for (const taste of [0, 0.5, 1]) {
        const fx = scoreRoad(r, taste);
        assert.ok(Number.isFinite(fx.score) && fx.score >= 0 && fx.score <= 100, r.id);
        if (taste === 0.5 && fx.bit) entries.push(bitEntry(r, tile.key, fx));
      }
    }
  }
  assert.ok(count > 0);
  assert.deepEqual(index.bits, topBits(entries));
});
