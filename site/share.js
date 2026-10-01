/* Share a road as an image card (map + profile + score) and a link. */

const W = 1200, H = 630, MAP_W = 720;

/** Wait until the map has drawn everything it needs, or give up after `ms`. */
function idle(map, ms = 6000) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    map.once("idle", () => { clearTimeout(t); resolve(); });
    map.triggerRepaint();
  });
}

/** Snapshot the map framed on the road, then put the camera back where it was. */
async function mapSnapshot(map, road) {
  const cam = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
  const [w, s, e, n] = road.bb;
  map.fitBounds([[w, s], [e, n]], { padding: 50, duration: 0, pitch: Math.min(cam.pitch, 45), bearing: 0 });
  await idle(map);
  map.redraw();                                        // the WebGL buffer is only readable right after a draw
  const url = map.getCanvas().toDataURL("image/png");
  map.jumpTo(cam);
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

function wrap(g, text, maxW) {
  const words = text.split(" "), lines = [];
  let line = "";
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (g.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * card: { name, sub, score, factors: [[label, value text, share 0..1]], stats: [[label, value]], profile: [[distance m, elevation m]] }
 * Returns a PNG Blob. Gulf livery: navy panel, orange for the score and its bars.
 */
const NAVY = "#101c27", INK = "#eef3f7", INK2 = "#a7b7c6", MUTED = "#7f93a6", LINE = "#1c2c3b", ORANGE = "#f26b1d";
const SANS = '"Geist", system-ui, sans-serif', MONO = '"Geist Mono", ui-monospace, monospace';

export async function makeCard(map, road, card) {
  await document.fonts.ready;
  const c = new OffscreenCanvas(W, H), g = c.getContext("2d");
  g.fillStyle = NAVY;
  g.fillRect(0, 0, W, H);

  // map, cropped to fill the left side
  const img = await mapSnapshot(map, road);
  const k = Math.max(MAP_W / img.width, H / img.height), sw = MAP_W / k, sh = H / k;
  g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, MAP_W, H);

  const x = MAP_W + 40, maxW = W - x - 40;
  let y = 64;
  g.fillStyle = INK;
  g.font = `600 32px ${SANS}`;
  for (const l of wrap(g, card.name, maxW).slice(0, 2)) { g.fillText(l, x, y); y += 38; }
  g.fillStyle = MUTED;
  g.font = `16px ${SANS}`;
  if (card.sub) { g.fillText(wrap(g, card.sub, maxW)[0], x, y); y += 26; }

  // score, and the four parts as small bars
  y += 52;
  g.fillStyle = INK;
  g.font = `500 64px ${MONO}`;
  g.fillText(String(card.score), x, y);
  g.fillStyle = MUTED;
  g.font = `14px ${SANS}`;
  g.fillText("Fun score", x, y + 24);
  const bx = x + 150, bw = maxW - 150 - 56;
  card.factors.forEach(([label, val, share], i) => {
    const by = y - 52 + i * 20;
    g.fillStyle = INK2; g.font = `13px ${SANS}`; g.textAlign = "left"; g.fillText(label, bx, by + 4);
    g.fillStyle = ORANGE; g.fillRect(bx + 70, by - 2, Math.max(4, Math.min(1, share) * (bw - 70)), 4);
    g.fillStyle = INK; g.font = `13px ${MONO}`; g.textAlign = "right"; g.fillText(val, x + maxW, by + 4);
    g.textAlign = "left";
  });

  y += 64;
  g.fillStyle = LINE;
  g.fillRect(x, y - 24, maxW, 1);
  card.stats.forEach(([label, val], i) => {
    const cx = x + i * (maxW / card.stats.length);
    g.fillStyle = MUTED; g.font = `13px ${SANS}`; g.fillText(label, cx, y);
    g.fillStyle = INK; g.font = `500 20px ${MONO}`; g.fillText(val, cx, y + 26);
  });

  // elevation profile along the bottom of the panel
  const pTop = H - 140, pH = 72, pts = card.profile;
  const lo = Math.min(...pts.map((q) => q[1])), hi = Math.max(...pts.map((q) => q[1])) || lo + 1, tot = pts[pts.length - 1][0] || 1;
  const PX = (d) => x + (d / tot) * maxW, PY = (e) => pTop + pH - ((e - lo) / (hi - lo || 1)) * pH;
  g.beginPath();
  g.moveTo(PX(0), pTop + pH);
  for (const [d, e] of pts) g.lineTo(PX(d), PY(e));
  g.lineTo(PX(tot), pTop + pH);
  g.closePath();
  g.fillStyle = LINE;
  g.fill();
  g.strokeStyle = ORANGE;
  g.lineWidth = 2;
  g.beginPath();
  pts.forEach(([d, e], i) => (i ? g.lineTo(PX(d), PY(e)) : g.moveTo(PX(d), PY(e))));
  g.stroke();
  g.fillStyle = MUTED;
  g.font = `12px ${MONO}`;
  g.fillText(`${Math.round(lo)} m`, x, pTop + pH + 16);
  g.textAlign = "right";
  g.fillText(`${Math.round(hi)} m`, x + maxW, pTop - 6);

  // footer: name and credits
  g.fillStyle = INK2;
  g.font = `600 13px ${SANS}`;
  g.fillText("Twisty Roads", x + maxW, H - 28);
  g.textAlign = "left";
  g.fillStyle = MUTED;
  g.font = `11px ${SANS}`;
  g.fillText("Map © OpenFreeMap, © OpenStreetMap contributors. Terrain: AWS Terrain Tiles", x, H - 12);

  return c.convertToBlob({ type: "image/png" });
}

/** System share sheet if the browser can share files; otherwise download the image and copy the link. */
export async function share(blob, fileName, title, link) {
  const file = new File([blob], fileName, { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text: `${title}\n${link}` });
      return "shared";
    } catch (e) {
      if (e.name === "AbortError") return "cancelled";
    }
  }
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: fileName });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  let copied = false;
  try { await navigator.clipboard.writeText(link); copied = true; } catch { /* clipboard blocked */ }
  return copied ? "saved+copied" : "saved";
}
