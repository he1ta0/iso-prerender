// The atlas, channel by channel — the figure that explains why the depth buffer
// costs nothing.
//
//   node tools/aov-sheet.mjs                 # -> docs/img/atlas-channels.png
//   node tools/aov-sheet.mjs --scale 3
//
// `npm run build` writes four images that share ONE packing layout, so a single
// UV set addresses all of them. This tool puts the first three side by side for
// the same sprites, because the interesting claim is not "we have a normal map":
//
//   * albedo   — the colour you see
//   * normal   — rgb is the surface normal, and **a is the world height** of the
//                surface that texel draws
//   * material — specular / emissive / pattern id
//
// That alpha channel is the whole trick. The projection is orthographic and
// invertible, so "screen pixel + height" pins down the world position, and depth
// then falls out as a closed form (README section 2). There is no separately
// baked depth map anywhere in this repository, and this sheet is the evidence:
// look for the depth map in the third column and you will not find one.
//
// The bottom strip is the same idea on a real surface: one cottage wall, zoomed
// far enough that the height gradient in normal.a becomes visible as a gradient.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG } from './lib/png.mjs';
import { surface, fillRect, strokeRect, blit, text, textWidth } from './lib/canvas.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const getFlag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const SCALE = Number(getFlag('scale', 2));
const WIDTH = Number(getFlag('width', 1180));
const SET = getFlag('set', 'outdoor');
// One place to rename the project. The sprites are the demo's; the title is the
// pipeline's, because that is what the figures are documenting.
const TITLE = getFlag('title', 'ISO-PRERENDER');
const OUT = path.resolve(ROOT, getFlag('out', 'docs/img/atlas-channels.png'));

const BG = [11, 14, 24];
const PLATE = [17, 22, 36];
const RULE = [30, 38, 56];
const INK = [232, 238, 246];
const DIM = [125, 144, 168];
const ACCENT = [232, 180, 92];

// One sprite per channel-interesting shape: a building (flat walls, pitched roof),
// foliage (noisy normals), a round object (smooth gradient), a character.
const CAST = [
  ['bld_cottage', 'COTTAGE'],
  ['tree_pine_tall', 'PINE'],
  ['well_stone', 'WELL'],
  ['char_idle_00#1', 'VILLAGER'],
];

const CHANNELS = [
  ['albedo', 'ALBEDO', 'the colour you see'],
  ['nrm', 'NORMAL', 'rgb = facing, a = world height'],
  ['mat', 'MATERIAL', 'specular / emissive / pattern'],
];

const PAD = 24;
const ROW_GAP = 14;
const LABEL_W = 96;
const HEAD_H = 30;

const dir = path.join(ROOT, SET === 'interior' ? 'assets/int' : 'assets');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'sprites.json'), 'utf8'));
const chan = Object.fromEntries(CHANNELS.map(([k]) => [k, decodePNG(fs.readFileSync(path.join(dir, `${k}.png`)))]));

const picked = CAST.map(([id, label]) => {
  const s = manifest.sprites[id];
  if (!s) throw new Error(`no such sprite: ${id}`);
  return { id, label, s };
});

// ---- measure
const colW = Math.max(...picked.map((p) => p.s.w)) * SCALE + 22;
const rowH = Math.max(...picked.map((p) => p.s.h)) * SCALE + 22;
const HEAD = 96;
const NOTES = 116;
const W = WIDTH;
const H = HEAD + HEAD_H + picked.length * (rowH + ROW_GAP) + NOTES;

const buf = surface(W, H, BG);

// ---- header
text(buf, W, H, TITLE, PAD, PAD - 4, { scale: 3, color: INK });
const [aw, ah] = manifest.atlas.albedo;
text(buf, W, H, `ONE PACKING LAYOUT, FOUR IMAGES / ATLAS ${aw}X${ah} / ${Object.keys(manifest.sprites).length} SPRITES`,
  PAD, PAD + 34, { scale: 1, color: DIM });
text(buf, W, H, `EVERY SPRITE BELOW IS SHOWN AT ${SCALE}X`, PAD, PAD + 50, { scale: 1, color: ACCENT });
fillRect(buf, W, H, PAD, PAD + 70, W - PAD * 2, 1, RULE);

// ---- column headers
const gridX = PAD + LABEL_W;
for (let c = 0; c < CHANNELS.length; c++) {
  const x = gridX + c * colW;
  text(buf, W, H, CHANNELS[c][1], x + 11, HEAD, { scale: 2, color: ACCENT });
  text(buf, W, H, CHANNELS[c][2], x + 11, HEAD + 17, { scale: 1, color: DIM });
}

// ---- rows
let y = HEAD + HEAD_H;
for (const p of picked) {
  const { s } = p;
  fillRect(buf, W, H, PAD, y, W - PAD * 2, rowH, PLATE);
  strokeRect(buf, W, H, PAD, y, W - PAD * 2, rowH, RULE);
  text(buf, W, H, p.label, PAD + 10, y + rowH / 2 - 8, { scale: 1, color: INK });
  for (let c = 0; c < CHANNELS.length; c++) {
    const img = chan[CHANNELS[c][0]];
    const x = gridX + c * colW + 11;
    // centre within the cell so the three channels line up on the same sprite
    const ox = x + Math.floor((colW - 22 - s.w * SCALE) / 2);
    const oy = y + Math.floor((rowH - s.h * SCALE) / 2);
    blit(buf, W, H, img.rgba, img.width, s.a, ox, oy, SCALE);
  }
  y += rowH + ROW_GAP;
}

// ---- notes
fillRect(buf, W, H, PAD, y + 6, W - PAD * 2, 1, RULE);
const notes = [
  ['THE NORMAL MAP IS A NORMAL MAP *AND* A HEIGHT MAP.', INK],
  ['Its alpha channel holds the world height of the surface each texel draws. The projection is orthographic and', DIM],
  ['invertible, so screen position + height fixes the world point, and view depth falls out in closed form:', DIM],
  ['', DIM],
  ['    dep = (x + y) + (2*HH / ZPX) * z          and x + y drops straight out of the projection', INK],
  ['', DIM],
  ['So there is no baked depth map in this repository, and nothing extra in the atlas. Two lines of fragment', DIM],
  ['shader turn these four images into a real 24-bit depth buffer over all geometry. See README section 2.', DIM],
];
let ny = y + 22;
for (const [line, color] of notes) {
  if (line) text(buf, W, H, line, PAD, ny, { scale: 1, color });
  ny += 12;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, encodePNG({ width: W, height: H, data: buf, colorType: 6 }));
console.log(`· ${path.relative(ROOT, OUT)}  ${W}x${H}  ${(fs.statSync(OUT).size / 1024).toFixed(0)} kB`);
