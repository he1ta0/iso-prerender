// Sprite-level regression: does the NEW interior atlas draw the OLD sprites with
// the same pixels?
//
// The atlas is shelf-packed, so adding models re-lays-out every rectangle in it.
// That is exactly the kind of change that is invisible in a manifest diff and
// very visible on screen if a rect or an anchor is off by a pixel, so this
// compares the pixels UNDER the rects rather than the rects themselves:
//
//   node tools/sprite-diff.mjs work/baseline-m7 assets/int
//
// For every sprite id present in both manifests it decodes the four AOV images
// and compares the sprite's own rectangle, channel by channel. A sprite that
// moved in the atlas is fine; a sprite whose pixels changed is a regression.

import fs from 'node:fs';
import path from 'node:path';
import { decodePNG } from './lib/png.mjs';

const [baseDir, newDir] = process.argv.slice(2);
const load = (dir) => {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'sprites.json'), 'utf8'));
  const img = {};
  for (const n of ['albedo', 'nrm', 'mat']) img[n] = decodePNG(fs.readFileSync(path.join(dir, `${n}.png`)));
  return { m, img };
};
const A = load(baseDir), B = load(newDir);
const px = (im, x, y) => (y * im.width + x) * 4;

const chans = ['albedo', 'nrm', 'mat'];
const KEY = ['a', 'n', 'm'];
let compared = 0, moved = 0, changed = 0, added = 0, gone = 0;
const worst = [];
for (const [id, sa] of Object.entries(A.m.sprites)) {
  const sb = B.m.sprites[id];
  if (!sb) { gone++; continue; }
  compared++;
  let maxD = 0, nDiff = 0;
  for (let c = 0; c < chans.length; c++) {
    const ra = sa[KEY[c]], rb = sb[KEY[c]];
    if (!ra || !rb) continue;
    if (ra[2] !== rb[2] || ra[3] !== rb[3]) { maxD = Math.max(maxD, 255); nDiff += ra[2] * ra[3]; continue; }
    if (ra[0] !== rb[0] || ra[1] !== rb[1]) moved++;
    const ia = A.img[chans[c]], ib = B.img[chans[c]];
    for (let y = 0; y < ra[3]; y++) {
      for (let x = 0; x < ra[2]; x++) {
        const oa = px(ia, ra[0] + x, ra[1] + y), ob = px(ib, rb[0] + x, rb[1] + y);
        for (let k = 0; k < 4; k++) {
          const d = Math.abs(ia.rgba[oa + k] - ib.rgba[ob + k]);
          if (d > maxD) maxD = d;
          if (d > 0) nDiff++;
        }
      }
    }
  }
  if (maxD > 0) { changed++; worst.push({ id, maxD, nDiff }); }
}
for (const id of Object.keys(B.m.sprites)) if (!A.m.sprites[id]) added++;
worst.sort((a, b) => b.maxD - a.maxD || b.nDiff - a.nDiff);

console.log(`compared ${compared} sprites   added ${added}   removed ${gone}   re-packed ${moved} rects`);
console.log(`pixel-identical: ${compared - changed}   CHANGED: ${changed}`);
for (const w of worst.slice(0, 15)) console.log(`  ! ${w.id.padEnd(28)} maxDelta ${String(w.maxD).padStart(3)}  ${w.nDiff} channel samples`);
process.exit(changed ? 1 : 0);
