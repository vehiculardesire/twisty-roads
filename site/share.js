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
 * card: { name, sub, score, factors, stats: [[label, value]], profile: [[distance m, elevation m]], link }
 * Returns a PNG Blob.
 */
export async function makeCard(map, road, card) {
  const c = new OffscreenCanvas(W, H), g = c.getContext("2d");
  g.fillStyle = "#111110";
  g.fillRect(0, 0, W, H);

  // map, cropped to fill the left side
  const img = await mapSnapshot(map, road);
  const k = Math.max(MAP_W / img.width, H / img.height), sw = MAP_W / k, sh = H / k;
  g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, MAP_W, H);

  const x = MAP_W + 36, maxW = W - x - 36;
  let y = 58;
  g.fillStyle = "#ffffff";
  g.font = "700 34px system-ui, sans-serif";
  for (const l of wrap(g, card.name, maxW).slice(0, 2)) { g.fillText(l, x, y); y += 40; }
  g.fillStyle = "#c3c2b7";
  g.font = "16px system-ui, sans-serif";
  if (card.sub) { g.fillText(wrap(g, card.sub, maxW)[0], x, y); y += 30; }

  y += 34;
  g.fillStyle = "#f16913";
  g.font = "800 72px system-ui, sans-serif";
  g.fillText(String(card.score), x, y + 20);
  const sw2 = g.measureText(String(card.score)).width;
  g.font = "600 15px system-ui, sans-serif";
  g.fillStyle = "#898781";
  g.fillText("FUN", x + sw2 + 10, y + 18);
  y += 52;
  g.fillStyle = "#c3c2b7";
  g.font = "14px system-ui, sans-serif";
  for (const l of wrap(g, card.factors, maxW)) { g.fillText(l, x, y); y += 20; }

  y += 16;
  card.stats.forEach(([label, val], i) => {
    const cx = x + (i % 2) * (maxW / 2), cy = y + Math.floor(i / 2) * 50;
    g.fillStyle = "#898781"; g.font = "600 12px system-ui, sans-serif"; g.fillText(label.toUpperCase(), cx, cy);
    g.fillStyle = "#ffffff"; g.font = "600 20px system-ui, sans-serif"; g.fillText(val, cx, cy + 24);
  });

  // elevation profile along the bottom of the panel
  const pTop = H - 150, pH = 80, pts = card.profile;
  const lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1])) || lo + 1, tot = pts[pts.length - 1][0] || 1;
  const PX = (d) => x + (d / tot) * maxW, PY = (e) => pTop + pH - ((e - lo) / (hi - lo || 1)) * pH;
  g.beginPath();
  g.moveTo(PX(0), pTop + pH);
  for (const [d, e] of pts) g.lineTo(PX(d), PY(e));
  g.lineTo(PX(tot), pTop + pH);
  g.closePath();
  g.fillStyle = "rgba(241, 105, 19, 0.35)";
  g.fill();
  g.strokeStyle = "#f16913";
  g.lineWidth = 2;
  g.beginPath();
  pts.forEach(([d, e], i) => (i ? g.lineTo(PX(d), PY(e)) : g.moveTo(PX(d), PY(e))));
  g.stroke();
  g.fillStyle = "#898781";
  g.font = "12px system-ui, sans-serif";
  g.fillText(`${Math.round(lo)} m`, x, pTop + pH + 16);
  g.textAlign = "right";
  g.fillText(`${Math.round(hi)} m`, x + maxW, pTop - 4);

  // footer: link and credits
  g.fillStyle = "#c3c2b7";
  g.font = "600 13px system-ui, sans-serif";
  g.fillText("Twisty Roads", x + maxW, H - 30);
  g.textAlign = "left";
  g.fillStyle = "#898781";
  g.font = "11px system-ui, sans-serif";
  g.fillText("Map © OpenFreeMap, © OpenStreetMap contributors · Terrain: AWS Terrain Tiles", x, H - 12);

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
