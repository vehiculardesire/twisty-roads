/* Minimal PNG decoder for 8-bit, non-interlaced RGB / RGBA / palette images (what terrain tiles use).
 * Pure JS: pass in a zlib inflate function (node:zlib inflateSync in Node). Returns RGBA bytes. */

export function decodePNG(buf, inflate) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let pos = 8, width, height, depth, type, interlace, palette, alpha;
  const idat = [];
  while (pos < u8.length) {
    const len = view.getUint32(pos), kind = String.fromCharCode(...u8.subarray(pos + 4, pos + 8));
    const body = u8.subarray(pos + 8, pos + 8 + len);
    if (kind === "IHDR") {
      const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
      [width, height, depth, type, interlace] = [v.getUint32(0), v.getUint32(4), body[8], body[9], body[12]];
    } else if (kind === "PLTE") palette = body;
    else if (kind === "tRNS") alpha = body;
    else if (kind === "IDAT") idat.push(body);
    else if (kind === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error(`unsupported PNG (depth ${depth}, interlace ${interlace})`);
  const channels = { 2: 3, 6: 4, 3: 1, 0: 1, 4: 2 }[type];
  if (!channels) throw new Error(`unsupported PNG colour type ${type}`);

  const joined = new Uint8Array(idat.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of idat) { joined.set(c, o); o += c.length; }
  const raw = inflate(joined);

  // undo per-scanline filters
  const stride = width * channels, px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[row + x - channels] : 0;
      const b = y ? px[prev + x] : 0;
      const c = x >= channels && y ? px[prev + x - channels] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[row + x] = v & 255;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (type === 2) { rgba.set(px.subarray(i * 3, i * 3 + 3), i * 4); rgba[i * 4 + 3] = 255; }
    else if (type === 6) rgba.set(px.subarray(i * 4, i * 4 + 4), i * 4);
    else if (type === 3) { const p = px[i]; rgba.set(palette.subarray(p * 3, p * 3 + 3), i * 4); rgba[i * 4 + 3] = alpha?.[p] ?? 255; }
    else { const g = px[i * channels]; rgba.set([g, g, g, type === 4 ? px[i * 2 + 1] : 255], i * 4); }
  }
  return { width, height, rgba };
}
