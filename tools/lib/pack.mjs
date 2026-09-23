// Shelf packer + indexed-atlas writer (+ QA contact sheet helper).
import { encodePNG } from './png.mjs';

export class Atlas {
  constructor(width = 2048, pad = 1, bpp = 1) {
    this.width = width;
    this.pad = pad;
    this.bpp = bpp;
    this.items = [];
  }
  /** reserve a rect; the position is assigned by pack() (tallest first) */
  add(id, w, h, indices, cols) {
    if (w <= 0 || h <= 0) return null;
    const rect = { x: 0, y: 0, w, h };
    this.items.push({ id, rect, indices, cols: cols || this.width });
    return rect;
  }
  get height() {
    let y = 0, rowH = 0;
    for (const i of this.items) {
      if (!i.placed) continue;
      if (i.rect.y + i.rect.h > y) y = i.rect.y + i.rect.h;
    }
    return y + this.pad;
  }
  pack(pow2 = true) {
    const pad = this.pad, width = this.width;
    const order = this.items.slice().sort((a, b) => (b.rect.h - a.rect.h) || (b.rect.w - a.rect.w));
    let x = 0, y = 0, rowH = 0;
    for (const it of order) {
      const r = it.rect;
      if (x + r.w + pad > width) { y += rowH + pad; x = 0; rowH = 0; }
      r.x = x; r.y = y;
      it.placed = true;
      x += r.w + pad;
      if (r.h > rowH) rowH = r.h;
    }
    let h = this.height;
    if (pow2) { let p = 1; while (p < h) p *= 2; h = p; }
    const W = width, H = h, bpp = this.bpp;
    const buf = new Uint8Array(W * H * bpp);
    for (const it of this.items) {
      const { x: ix, y: iy, w, h: ih } = it.rect;
      const src = it.indices, scols = it.cols;
      for (let r = 0; r < ih; r++) {
        const srow = (r * scols) * bpp;
        const drow = ((iy + r) * W + ix) * bpp;
        for (let c = 0; c < w * bpp; c++) buf[drow + c] = src[srow + c];
      }
    }
    return { width: W, height: H, data: buf };
  }
  toPNG(palette) {
    const a = this.pack();
    return { png: encodePNG({ width: a.width, height: a.height, data: a.data, palette: palette.table, alpha: palette.alpha, colorType: 3 }), width: a.width, height: a.height };
  }
}

/** Contact-sheet helper for QA: composite many RGBA float sprites on a checker. */
export function sheet(sprites, opts = {}) {
  const cellW = Math.max(...sprites.map((s) => s.w)) + 8;
  const cellH = Math.max(...sprites.map((s) => s.h)) + 8;
  const cols = opts.cols || 6;
  const rows = Math.ceil(sprites.length / cols);
  const W = cellW * cols, H = cellH * rows;
  const rgba = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = ((x >> 3) + (y >> 3)) & 1 ? 0.22 : 0.30;
      const i = (y * W + x) * 4;
      rgba[i] = c; rgba[i + 1] = c; rgba[i + 2] = c * 1.1; rgba[i + 3] = 1;
    }
  }
  sprites.forEach((s, n) => {
    const cx = (n % cols) * cellW + 4, cy = Math.floor(n / cols) * cellH + 4;
    for (let y = 0; y < s.h; y++) {
      for (let x = 0; x < s.w; x++) {
        const a = s.rgba[(y * s.w + x) * 4 + 3];
        if (a <= 0) continue;
        const di = ((cy + y) * W + cx + x) * 4;
        for (let k = 0; k < 3; k++) rgba[di + k] = rgba[di + k] * (1 - a) + s.rgba[(y * s.w + x) * 4 + k] * a;
        rgba[di + 3] = 1;
      }
    }
    const ax = cx + s.anchorX, ay = cy + s.anchorY;
    for (let d = -3; d <= 3; d++) {
      const p1 = ((ay) * W + ax + d) * 4, p2 = ((ay + d) * W + ax) * 4;
      if (ax + d >= 0 && ax + d < W) { rgba[p1] = 1; rgba[p1 + 1] = 0.1; rgba[p1 + 2] = 0.1; }
      if (ay + d >= 0 && ay + d < H) { rgba[p2] = 1; rgba[p2 + 1] = 0.1; rgba[p2 + 2] = 0.1; }
    }
  });
  return { width: W, height: H, rgba, cellW, cellH, cols };
}
