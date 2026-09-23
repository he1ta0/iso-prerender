// Pixel loupe: crop a rectangle out of a PNG and integer-scale it with nearest
// neighbour, so a 640x360 screenshot can be inspected at 4x without the image
// viewer resampling it into mush.
//
//   node tools/crop.mjs work/shots/x.png 200,120,160,90 4 work/shots/x_zoom.png
//
// Pure Node builtins (see lib/png.mjs); no image library involved.

import fs from 'node:fs';
import path from 'node:path';
import { decodePNG, encodePNG } from './lib/png.mjs';

const [src, rectArg, scaleArg, dstArg] = process.argv.slice(2);
if (!src || !rectArg) {
  console.error('usage: node tools/crop.mjs <src.png> <x,y,w,h> [scale=4] [dst.png]');
  process.exit(1);
}
const [x, y, w, h] = rectArg.split(',').map(Number);
const scale = Math.max(1, Number(scaleArg) || 4);
const img = decodePNG(fs.readFileSync(src));
const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
const cw = Math.min(w | 0, img.width - x0), ch = Math.min(h | 0, img.height - y0);
const out = new Uint8Array(cw * scale * ch * scale * 4);
for (let sy = 0; sy < ch * scale; sy++) {
  const srcY = y0 + ((sy / scale) | 0);
  for (let sx = 0; sx < cw * scale; sx++) {
    const srcX = x0 + ((sx / scale) | 0);
    const s = (srcY * img.width + srcX) * 4;
    const d = (sy * cw * scale + sx) * 4;
    out[d] = img.rgba[s]; out[d + 1] = img.rgba[s + 1];
    out[d + 2] = img.rgba[s + 2]; out[d + 3] = 255;
  }
}
const dst = dstArg || src.replace(/\.png$/i, `_${x0}_${y0}_${cw}x${ch}@${scale}.png`);
fs.writeFileSync(dst, encodePNG({ width: cw * scale, height: ch * scale, data: out, colorType: 6 }));
console.log(`${path.relative(process.cwd(), dst)}  ${cw * scale}x${ch * scale} (from ${cw}x${ch} at ${x0},${y0})`);
