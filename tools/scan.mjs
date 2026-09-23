// Print raw pixels along a row or column so a hard boundary can be located
// exactly, instead of by eye on a resized crop.
//
//   node tools/scan.mjs <img.png> row <y> <x0> <x1> [step]
//   node tools/scan.mjs <img.png> col <x> <y0> <y1> [step]
//   node tools/scan.mjs <img.png> edge <y> <x0> <x1>     # only big jumps

import fs from 'node:fs';
import { decodePNG } from './lib/png.mjs';

const [file, mode, aArg, bArg, cArg, stepArg] = process.argv.slice(2);
const img = decodePNG(fs.readFileSync(file));
const at = (x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]];
};
const a = Number(aArg), b = Number(bArg), c = Number(cArg);
const step = Number(stepArg || 1);

if (mode === 'row' || mode === 'col') {
  const [p0, p1] = mode === 'row' ? [a, a] : [a, a];
  for (let t = b; t <= c; t += step) {
    const [x, y] = mode === 'row' ? [t, p0] : [p0, t];
    const p = at(x, y);
    console.log(`${mode === 'row' ? 'x' : 'y'}=${String(t).padStart(5)}  ${p.map((v) => String(v).padStart(4)).join(' ')}`);
  }
} else if (mode === 'edge') {
  const y = a;
  let prev = at(b, y);
  for (let x = b + 1; x <= c; x++) {
    const p = at(x, y);
    const d = Math.abs(p[0] - prev[0]) + Math.abs(p[1] - prev[1]) + Math.abs(p[2] - prev[2]);
    if (d > 30) console.log(`x=${String(x).padStart(5)}  jump ${String(d).padStart(4)}   ${prev.join(',')} -> ${p.join(',')}`);
    prev = p;
  }
} else if (mode === 'rect') {
  // rect x,y,w,h  -> mean colour of one rectangle in one image
  const [x0, y0, w, h] = [a, b, c, Number(stepArg)];
  let r = 0, g = 0, bl = 0, n = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const p = at(x, y);
      r += p[0]; g += p[1]; bl += p[2]; n++;
    }
  }
  r /= n; g /= n; bl /= n;
  console.log(`mean rgb ${r.toFixed(1)} ${g.toFixed(1)} ${bl.toFixed(1)}  lum ${(r * 0.3 + g * 0.59 + bl * 0.11).toFixed(1)}  (${n} px)`);
} else {
  console.error('usage: scan.mjs <img.png> row|col|edge|rect ...');
  process.exit(1);
}
