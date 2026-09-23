// Print pixel values at a list of screen coordinates (or a scanline), so a
// render can be sampled numerically instead of eyeballed.
//
//   node tools/pix.mjs work/shots/x.png 320,180 344,168
//   node tools/pix.mjs work/shots/x.png --row 168

import fs from 'node:fs';
import { decodePNG } from './lib/png.mjs';

const [file, ...rest] = process.argv.slice(2);
if (!file) { console.error('usage: node tools/pix.mjs <png> [x,y ...] [--row N] [--col N]'); process.exit(1); }
const img = decodePNG(fs.readFileSync(file));
const at = (x, y) => {
  const i = ((y | 0) * img.width + (x | 0)) * 4;
  return `${img.rgba[i]},${img.rgba[i + 1]},${img.rgba[i + 2]}`;
};
for (let a = 0; a < rest.length; a++) {
  if (rest[a] === '--row') {
    const y = Number(rest[++a]);
    let s = [];
    for (let x = 0; x < img.width; x += 8) s.push(`${x}:${at(x, y)}`);
    console.log(`row ${y}\n  ` + s.join('  '));
  } else if (rest[a] === '--col') {
    const x = Number(rest[++a]);
    let s = [];
    for (let y = 0; y < img.height; y += 8) s.push(`${y}:${at(x, y)}`);
    console.log(`col ${x}\n  ` + s.join('  '));
  } else {
    const [x, y] = rest[a].split(',').map(Number);
    console.log(`${x},${y} = ${at(x, y)}`);
  }
}
