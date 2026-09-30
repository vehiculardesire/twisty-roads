/* Your own data, kept in this browser only: favourites, yay/nay ratings, and the taste learned from them. */
import { NO_MIX, scoreRoad } from "./core/twisty.js";

const KEY = "twisty.me";

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && typeof d === "object") return { fav: d.fav || {}, rate: d.rate || {}, tuned: d.tuned || null };
  } catch { /* private mode or bad data */ }
  return { fav: {}, rate: {}, tuned: null };
}

export const me = load();

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(me)); } catch { /* private mode */ }
}

export const isFav = (id) => !!me.fav[id];
export const ratingOf = (id) => me.rate[id] || 0;

export function toggleFav(id) {
  if (me.fav[id]) delete me.fav[id]; else me.fav[id] = true;
  save();
}

/** 1 = yay, -1 = nay; setting the same value again clears it. */
export function rate(id, v) {
  if (me.rate[id] === v) delete me.rate[id]; else me.rate[id] = v;
  save();
}

const TASTES = Array.from({ length: 11 }, (_, i) => i / 10);
const MIXES = [0.5, 1, 1.5];

/**
 * Learn a taste from ratings: try every taste (0..1) and every mix of how much terrain, scenery and hairpins
 * count (x0.5, x1, x1.5), and keep the one that ranks the most yay roads above nay roads. Ties go to the
 * settings closest to the defaults, so a handful of ratings can't push things to extremes.
 * Needs at least 2 yays and 2 nays; returns null otherwise.
 */
export function learnTaste(roadsById) {
  const rated = Object.entries(me.rate).map(([id, v]) => [roadsById.get(id), v]).filter(([r]) => r);
  const yay = rated.filter(([, v]) => v > 0).map(([r]) => r), nay = rated.filter(([, v]) => v < 0).map(([r]) => r);
  if (yay.length < 2 || nay.length < 2) return null;

  let best = null;
  for (const taste of TASTES) for (const terrain of MIXES) for (const scenery of MIXES) for (const hairpins of MIXES) {
    const mix = { terrain, scenery, hairpins };
    const s = (r) => scoreRoad(r, taste, mix).linear;
    const ys = yay.map(s), ns = nay.map(s);
    let agree = 0;
    for (const y of ys) for (const n of ns) agree += y > n ? 1 : 0;
    const drift = Math.abs(taste - 0.5) + Math.abs(terrain - 1) + Math.abs(scenery - 1) + Math.abs(hairpins - 1);
    const key = agree - 0.01 * drift;            // agreement first, then stay near the defaults
    if (!best || key > best.key) best = { key, taste, mix, agree, pairs: ys.length * ns.length };
  }
  return { taste: best.taste, mix: best.mix, agree: best.agree, pairs: best.pairs, yays: yay.length, nays: nay.length };
}

export function setTuned(t) {
  me.tuned = t;
  save();
}

export const currentMix = () => me.tuned?.mix || NO_MIX;

/** "scenery counts more, hairpins less" for the UI. */
export function describeMix(mix) {
  const parts = Object.entries(mix).filter(([, v]) => v !== 1).map(([k, v]) => `${k} ${v > 1 ? "more" : "less"}`);
  return parts.length ? parts.join(", ") : "terrain, scenery and hairpins as designed";
}
