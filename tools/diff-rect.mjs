// Compare the same rectangle across several screenshots: mean colour per image,
// plus a pairwise "how many pixels changed" count.
//
//   node tools/diff-rect.mjs 450,100,140,140 a.png b.png c.png
//
// Built for one question: "did this region get darker / more opaque between two
// builds", which is not answerable by looking at two crops side by side.

import fs from 'node:fs';
import { decodePNG } from './lib/png.mjs';

const [rectArg, ...files] = process.argv.slice(2);
if (!rectArg || files.length < 2) {
  console.error('usage: node tools/diff-rect.mjs <x,y,w,h> <a.png> <b.png> [...]');
  process.exit(1);
}
const [x0, y0, w, h] = rectArg.split(',').map(Number);
const load = (f) => {
  const img = decodePNG(fs.readFileSync(f));
  const px = [];
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * img.width + x) * 4;
      px.push([img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]]);
    }
  }
  return px;
};
const mean = (px) => {
  let r = 0, g = 0, b = 0;
  for (const p of px) { r += p[0]; g += p[1]; b += p[2]; }
  return [r / px.length, g / px.length, b / px.length];
};
const data = files.map((f) => ({ f, px: load(f) }));
for (const d of data) {
  const m = mean(d.px);
  console.log(`${d.f.padEnd(46)} mean rgb ${m.map((v) => v.toFixed(1).padStart(6)).join(' ')}  `
    + `lum ${(m[0] * 0.3 + m[1] * 0.59 + m[2] * 0.11).toFixed(1)}`);
}
const base = data[0];
for (let i = 1; i < data.length; i++) {
  let n = 0, sum = 0;
  for (let k = 0; k < base.px.length; k++) {
    const a = base.px[k], b = data[i].px[k];
    const d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    if (d > 24) n++;
    sum += d;
  }
  console.log(`  vs ${data[i].f}: ${n}/${base.px.length} px differ (${(n / base.px.length * 100).toFixed(1)}%), mean delta ${(sum / base.px.length).toFixed(1)}`);
}
