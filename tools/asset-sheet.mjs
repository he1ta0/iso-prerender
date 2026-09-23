// Labelled contact sheet of the offline sprite atlas, for the README.
//
//   node tools/asset-sheet.mjs                      # both sets -> docs/img/
//   node tools/asset-sheet.mjs --set outdoor
//   node tools/asset-sheet.mjs --scale 2 --width 1600 --max 60
//
// This is not the same job as `build-assets.mjs --sheet`. That one is a QA aid:
// it dumps *every* sprite of a category onto a checkerboard so you can spot a
// broken bake. This one is for showing the art off, so it:
//
//   * picks one entry per distinct thing — 116 villager sprites are five actions
//     in four facings, not 116 different villagers
//   * stands everything on a shared ground line using each sprite's own anchor,
//     which is what makes a shelf of isometric pieces read as a scene and not as
//     a pile
//   * labels each section in the game's bitmap font, on a background taken from
//     the game's own palette
//
// Everything here is read back out of the built atlas. If a sprite is on this
// sheet, it is on the sheet because `npm run build` put it there.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG } from './lib/png.mjs';
import { surface, fillRect, strokeRect, blit, text, textWidth } from './lib/canvas.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const getFlag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const WIDTH = Number(getFlag('width', 1200));
const SCALE = Number(getFlag('scale', 2));       // sprite zoom; the sheets are unreadable at 1x
const MAX = Number(getFlag('max', 40));          // per-section cap, after de-duplication
const ONLY = getFlag('set', null);
// One place to rename the project (same flag as tools/aov-sheet.mjs).
const TITLE = getFlag('title', 'ISO-PRERENDER');

// The game's own HUD palette (src/ui.js), so a sheet looks like it came from the
// same place as the thing it documents.
const BG = [11, 14, 24];
const PLATE = [17, 22, 36];
const RULE = [30, 38, 56];
const INK = [232, 238, 246];
const DIM = [125, 144, 168];
const ACCENT = [232, 180, 92];

const SETS = {
  outdoor: {
    dir: 'assets', file: 'sprites.json', art: 'albedo.png',
    title: 'OUTDOOR WORLD',
    sections: [
      ['build', 'BUILDINGS'],
      ['tree', 'TREES & FOLIAGE'],
      ['prop', 'PROPS & FENCES'],
      ['crop', 'CROPS'],
      ['char', 'VILLAGERS'],
      ['ground', 'TERRAIN'],
      ['water', 'WATER'],
    ],
  },
  interior: {
    dir: 'assets/int', file: 'sprites.json', art: 'albedo.png',
    title: 'INTERIORS',
    sections: [
      ['wall', 'WALLS, WINDOWS & DOORS'],
      ['furn', 'FURNITURE'],
      ['floor', 'FLOORS'],
      ['char', 'VILLAGERS'],
    ],
  },
};

const PAD = 24;
const GAP = 6;
const SECTION_GAP = 10;
const LABEL_H = 26;

/**
 * One entry per distinct thing.
 *
 * Villagers are the reason this exists: `char_idle_00#2` and `char_idle_00#3` are
 * the same villager turned 90 degrees, and a sheet that shows all 116 of them
 * buries the five poses that are actually different. Collapsing to one per
 * (action, facing) shows what the character system really contains.
 */
function select(entries, max) {
  const base = (id) => id.split('#')[0];
  const byKey = new Map();
  for (const e of entries) {
    const key = e.cat === 'char'
      ? `${e.action || 'x'}|${e.rot || 0}`
      : base(e.id);
    if (!byKey.has(key)) byKey.set(key, e);   // first frame wins: frame 0 reads cleanest
  }
  let out = [...byKey.values()];
  if (out.length > max) {
    // stride rather than truncate: the tail of a category is as interesting as
    // the head (the ripe crops are at the end, the saplings at the start)
    const stride = out.length / max;
    out = Array.from({ length: max }, (_, i) => out[Math.floor(i * stride)]);
  }
  return out;
}

/** Shelf layout: fill a row left to right, wrap, and remember the ground line. */
function shelves(items, maxW) {
  const rows = [];
  let cur = { items: [], w: 0, above: 0, below: 0 };
  for (const s of items) {
    const w = s.w * SCALE, h = s.h * SCALE;
    const need = cur.items.length ? cur.w + GAP + w : w;
    if (cur.items.length && need > maxW) { rows.push(cur); cur = { items: [], w: 0, above: 0, below: 0 }; }
    const x = cur.items.length ? cur.w + GAP : 0;
    cur.items.push({ s, x, w, h });
    cur.w = x + w;
    // anchors are in atlas pixels; scale them so the ground line is shared
    cur.above = Math.max(cur.above, s.ay * SCALE);
    cur.below = Math.max(cur.below, (s.h - s.ay) * SCALE);
  }
  if (cur.items.length) rows.push(cur);
  return rows;
}

function build(setKey) {
  const cfg = SETS[setKey];
  const dir = path.join(ROOT, cfg.dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, cfg.file), 'utf8'));
  const sheet = decodePNG(fs.readFileSync(path.join(dir, cfg.art)));

  const inner = WIDTH - PAD * 2;
  const planned = [];
  for (const [cat, label] of cfg.sections) {
    const all = Object.entries(manifest.sprites)
      .filter(([, s]) => s.cat === cat)
      .map(([id, s]) => ({ id, ...s }));
    if (!all.length) continue;
    const picked = select(all, MAX);
    const rows = shelves(picked, inner);
    planned.push({ label, cat, picked, rows });
  }

  // ---- measure, so the surface can be allocated once
  const HEAD = 74;
  let y = PAD + HEAD;
  for (const sec of planned) {
    y += LABEL_H;
    for (const r of sec.rows) y += r.above + r.below + SECTION_GAP;
    y += 6;
  }
  y += 30;                                  // footer

  const W = WIDTH, H = Math.ceil(y);
  const buf = surface(W, H, BG);

  // ---- header
  text(buf, W, H, TITLE, PAD, PAD - 4, { scale: 3, color: INK });
  const [aw, ah] = manifest.atlas.albedo;
  text(buf, W, H, `${cfg.title} / ${Object.keys(manifest.sprites).length} SPRITES / ATLAS ${aw}X${ah} / ${manifest.tile.w}X${manifest.tile.h} TILE`,
    PAD, PAD + 34, { scale: 1, color: DIM });
  text(buf, W, H, `DRAWN AT ${SCALE}X`, PAD, PAD + 50, { scale: 1, color: ACCENT });
  fillRect(buf, W, H, PAD, PAD + HEAD - 12, inner, 1, RULE);

  // ---- sections
  let cy = PAD + HEAD;
  for (const sec of planned) {
    text(buf, W, H, sec.label, PAD, cy, { scale: 2, color: ACCENT });
    const count = `${sec.picked.length} / ${Object.values(manifest.sprites).filter((s) => s.cat === sec.cat).length}`;
    text(buf, W, H, count, W - PAD - textWidth(count, 1), cy + 5, { scale: 1, color: DIM });
    cy += LABEL_H;

    for (const row of sec.rows) {
      const shelfH = row.above + row.below;
      fillRect(buf, W, H, PAD, cy, inner, shelfH + SECTION_GAP - 4, PLATE);
      strokeRect(buf, W, H, PAD, cy, inner, shelfH + SECTION_GAP - 4, RULE);
      fillRect(buf, W, H, PAD, cy + row.above, inner, 1, RULE);   // the ground line
      for (const it of row.items) {
        const s = it.s;
        blit(buf, W, H, sheet.rgba, sheet.width, s.a,
          PAD + it.x, cy + row.above - s.ay * SCALE, SCALE);
      }
      cy += shelfH + SECTION_GAP;
    }
    cy += 6;
  }

  // ---- footer
  const stat = `${planned.reduce((n, s) => n + s.picked.length, 0)} SPRITES SHOWN - EVERY ONE GENERATED BY npm run build FROM tools/models - NO EXTERNAL ART`;
  text(buf, W, H, stat, PAD, H - 22, { scale: 1, color: DIM });

  return { buf, W, H };
}

// ---------------------------------------------------------------------- run
fs.mkdirSync(path.join(ROOT, 'docs/img'), { recursive: true });
for (const key of Object.keys(SETS)) {
  if (ONLY && ONLY !== key) continue;
  const { buf, W, H } = build(key);
  const out = path.join(ROOT, 'docs/img', `asset-sheet-${key}.png`);
  fs.writeFileSync(out, encodePNG({ width: W, height: H, data: buf, colorType: 6 }));
  console.log(`· ${path.relative(ROOT, out)}  ${W}x${H}  ${(fs.statSync(out).size / 1024).toFixed(0)} kB`);
}
