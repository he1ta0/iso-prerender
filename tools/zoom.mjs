// Nearest-neighbour magnifier for QA crops.
//
//   node tools/zoom.mjs <src.png> <out.png> <x0> <y0> <w> <h> <scale>
//
// The magnification is exact integer nearest-neighbour with no smoothing, so a
// 1-pixel pattern stays a 1-pixel pattern and can be counted.

import fs from 'node:fs';
import { decodePNG, encodePNG } from './lib/png.mjs';

const [src, out, x0s, y0s, ws, hs, ss] = process.argv.slice(2);
const img = decodePNG(fs.readFileSync(src));
const x0 = Number(x0s), y0 = Number(y0s), w = Number(ws), h = Number(hs), s = Number(ss || 6);
const W = w * s, H = h * s;
const o = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const sx = Math.min(img.width - 1, Math.max(0, x0 + Math.floor(x / s)));
    const sy = Math.min(img.height - 1, Math.max(0, y0 + Math.floor(y / s)));
    const so = (sy * img.width + sx) * 4, dof = (y * W + x) * 4;
    o[dof] = img.rgba[so]; o[dof + 1] = img.rgba[so + 1]; o[dof + 2] = img.rgba[so + 2]; o[dof + 3] = 255;
  }
}
fs.writeFileSync(out, encodePNG({ width: W, height: H, data: o, colorType: 6 }));
console.log(`${out}  ${W}x${H}  (${src} ${x0},${y0} ${w}x${h} @${s}x)`);
