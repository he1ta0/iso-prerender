// Interior layout QA.
//
// A furniture plan is easy to get 95% right and impossible to eyeball: two
// pieces sharing a tile, a chair inside a wall, a wardrobe parked in the only
// doorway. This runs the REAL makeInterior (same atlas manifest the game loads)
// and checks the plan as a plan.
//
//   node tools/check-interior.mjs
//   node tools/check-interior.mjs --map          # ASCII occupancy map
//   node tools/check-interior.mjs --storey upper # check the upper floor instead
//
// It reports:
//   * overlapping footprints
//   * pieces standing outside the floor
//   * whether every walkable tile is reachable from the door
//   * wall-mounted pieces that are not actually against their wall

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeInterior } from '../src/interior.js';
import { makeUpperInterior } from '../src/interior_upper.js';
import { makeChapelInterior, CHAPEL_H } from '../src/interior_chapel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/int/sprites.json'), 'utf8'));
const atlas = {
  m: manifest,
  sprites: manifest.sprites,
  has(id) { return !!manifest.sprites[id]; },
  get(id) { return manifest.sprites[id]; },
  spriteId(id, rot = 0) {
    if (!id) return null;
    const r = rot | 0;
    if (manifest.sprites[`${id}#${r}`]) return `${id}#${r}`;
    if (manifest.sprites[id]) return id;
    if (manifest.sprites[`${id}#0`]) return `${id}#0`;
    return null;
  },
  first(...ids) {
    for (const id of ids) {
      if (!id) continue;
      if (manifest.sprites[id] || manifest.sprites[`${id}#0`]) return id;
    }
    return null;
  },
};

const argv = process.argv.slice(2);
const STOREY = argv.includes('--storey') ? argv[argv.indexOf('--storey') + 1] : 'ground';
const BUILD = {
  ground: () => ({ room: makeInterior(atlas), ceiling: null }),
  upper: () => ({ room: makeUpperInterior(atlas), ceiling: null }),
  chapel: () => ({ room: makeChapelInterior(atlas), ceiling: CHAPEL_H }),
};
if (!BUILD[STOREY]) { console.error(`unknown storey: ${STOREY} (ground | upper | chapel)`); process.exit(1); }
const built = BUILD[STOREY]();
const room = built.room;
if (!room) { console.error(`makeInterior(${STOREY}) returned null`); process.exit(1); }
const w = room.w, h = room.h;

// ---- footprint of a placed object, in tiles --------------------------------
function footprint(o) {
  const sid = atlas.spriteId(o.id, o.rot);
  const sp = atlas.get(sid);
  const [fw, fd] = sp.fp;
  const odd = o.rot & 1;
  const rw = odd ? fd : fw, rd = odd ? fw : fd;
  // place() put the sprite so its ROTATED rect starts at (X,Y); recover (X,Y)
  const cx = o.gx + fw / 2, cy = o.gy + fd / 2;
  const X = Math.round((cx - rw / 2) * 1000) / 1000;
  const Y = Math.round((cy - rd / 2) * 1000) / 1000;
  return { X, Y, rw, rd, sp, name: sp.name || o.id };
}

const cell = new Map();       // "x,y" -> [entries]
const problems = [];
const flush = [];
const SKIP_SOLID = new Set([
  'wall_solid', 'wall_window', 'wall_window_tall', 'wall_window_arch',
  'wall_door', 'wall_int', 'wall_int_door', 'wall_stub',
  // the chapel's runs. A free-standing pier is deliberately NOT in this list:
  // a colonnade is architecture the player walks around, not a perimeter.
  'wall_stone', 'wall_stone_lancet', 'wall_stone_great', 'wall_stone_rose', 'wall_door_chapel',
]);
// pieces that HANG on a wall sit at a negative tile offset on purpose: their own
// back plane is at y~0.6 of their tile, so the tile that puts that plane against
// the wall has to start outside the floor
const HUNG = /CURTAIN|CLOCK|PAINTING|SHELF_PLATES|BANNER/;
/** decor that hangs above head height and must never count as blocking a floor */
const NONBLOCK = /RUG|CURTAIN|SHELF|CLOCK|PAINTING|HERBS|CHANDELIER|BANNER/i;

for (const o of room.objects) {
  const f = footprint(o);
  if (SKIP_SOLID.has(o.id)) continue;                         // walls own their tile
  const hung = HUNG.test(f.name);
  const x0 = Math.floor(f.X + 0.02), x1 = Math.ceil(f.X + f.rw - 0.02) - 1;
  const y0 = Math.floor(f.Y + 0.02), y1 = Math.ceil(f.Y + f.rd - 0.02) - 1;
  const slack = hung ? 0.7 : 0.35;
  if (f.X < -slack || f.Y < -slack || f.X + f.rw > w + slack || f.Y + f.rd > h + slack) {
    problems.push(`outside the floor: ${o.id} at ${f.X.toFixed(2)},${f.Y.toFixed(2)} (${f.rw}x${f.rd})`);
  }
  const touchWall = f.X < 0.05 || f.Y < 0.05 || f.X + f.rw > w - 0.05 || f.Y + f.rd > h - 0.05;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const k = `${x},${y}`;
      if (!cell.has(k)) cell.set(k, []);
      cell.get(k).push({ o, f, touchWall });
    }
  }
}

for (const [k, list] of cell) {
  // the tile map still draws the plan and still decides what is walkable, so it
  // deliberately keeps counting by tiles; the geometry report above is what
  // decides whether two pieces actually collide
  const solid = list.filter((e) => !NONBLOCK.test(e.f.name) && !/CANDLE|LAMP|BASKET|SACK/i.test(e.f.name));
  if (solid.length > 1) {
    flush.push(`tile ${k} carries ${solid.length} pieces: ` + solid.map((e) => e.o.id).join(' + '));
  }
}

// ---- overlaps, MEASURED rather than counted ---------------------------------
//
// The tile map above is the right bookkeeping for a plan drawn on a grid: it
// decides what is walkable and it draws the map. It is the WRONG test for
// anything placed at a half tile, and the chapel is the map that proves it — a
// colonnade stands on the line BETWEEN two tiles, so every pier shares a tile
// with whatever is half a metre away from it on either side, and eight
// perfectly good pieces came back as overlaps the first time this ran.
//
// So the overlap report measures the real geometry instead. `bb` is the rotated
// mesh's bounding box, baked by tools/build-assets.mjs out of the very vertices
// that were rasterised, so this is the footprint of the THING rather than of the
// grid cell it was dropped into. Two pieces that share a tile are fine; two
// pieces that share space are a bug, and 4 cm is the threshold because that is
// about a pixel at this scale.
const placed = [];
for (const o of room.objects) {
  if (SKIP_SOLID.has(o.id)) continue;
  const sp = atlas.get(atlas.spriteId(o.id, o.rot));
  if (!sp) continue;
  const bb = sp.bb || [0, 0, sp.fp[0], sp.fp[1]];
  placed.push({
    o, name: sp.name || o.id,
    x0: o.gx + bb[0], y0: o.gy + bb[1], x1: o.gx + bb[2], y1: o.gy + bb[3],
  });
}
const solidPiece = (e) => !NONBLOCK.test(e.name);
for (let i = 0; i < placed.length; i++) {
  for (let j = i + 1; j < placed.length; j++) {
    const a = placed[i], b = placed[j];
    if (!solidPiece(a) || !solidPiece(b)) continue;
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (ox > 0.04 && oy > 0.04) {
      problems.push(`overlap: ${a.o.id} x ${b.o.id} share ${ox.toFixed(2)}x${oy.toFixed(2)} units `
        + `around ${Math.max(a.x0, b.x0).toFixed(2)},${Math.max(a.y0, b.y0).toFixed(2)}`);
    }
  }
}

// ---- reachability from the door --------------------------------------------
const blocked = new Uint8Array(w * h);
for (const [k, list] of cell) {
  const [x, y] = k.split(',').map(Number);
  // a rug or a ceiling lamp does not block a floor
  const solid = list.filter((e) => !NONBLOCK.test(e.f.name));
  if (solid.length) blocked[y * w + x] = 1;
}
const start = [Math.round(room.door[0]), Math.round(room.door[1])];
const seen = new Uint8Array(w * h);
const q = [[Math.min(w - 1, start[0]), Math.min(h - 1, start[1] + 1)]];
seen[q[0][1] * w + q[0][0]] = 1;
let reached = 0;
while (q.length) {
  const [x, y] = q.pop();
  reached++;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
    const i = ny * w + nx;
    if (seen[i] || blocked[i]) continue;
    seen[i] = 1;
    q.push([nx, ny]);
  }
}
const free = blocked.reduce((a, b) => a + (b ? 0 : 1), 0);
// name the tiles, do not just count them: "6 unreachable" is not actionable,
// "(7,2) is walled in by the rocker, the dresser and the bench" is
const stranded = [];
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    if (!seen[y * w + x] && !blocked[y * w + x]) stranded.push(`${x},${y}`);
  }
}

// ---- wall pieces, by the tile they sit on -----------------------------------
// (wall runs are placed on the tile whose edge they fill, so this is a lookup
// from "which tile is this wall on" to "what kind of wall is it")
const wallAt = new Map();
for (const o of room.objects) {
  if (!SKIP_SOLID.has(o.id)) continue;
  wallAt.set(`${o.gx},${o.gy}`, o.id);
}

// ---- hung pieces: right wall, and nothing tall in front of them -------------
// These two rules come straight from bugs that a top-down plan hides:
//   * a painting leaning against a WINDOW, and
//   * a wall clock hung inside the bookshelf that stands against that wall.
const hungProblems = [];
const isHung = (name) => /CURTAIN|CLOCK|PAINTING|WALL SHELF/.test(name);
for (const o of room.objects) {
  const f = footprint(o);
  if (!isHung(f.name)) continue;
  let side = null, wx = 0, wy = 0, fx = 0, fy = 0;
  if (f.Y < 0.5) { side = '-y'; wx = Math.round(f.X); wy = 0; fx = wx; fy = 1; }
  else if (f.X < 0.5) { side = '-x'; wx = 0; wy = Math.round(f.Y); fx = 1; fy = wy; }
  else if (f.Y + f.rd > h - 0.5) { side = '+y'; wx = Math.round(f.X); wy = h - 1; fx = wx; fy = h - 2; }
  else if (f.X + f.rw > w - 0.5) { side = '+x'; wx = w - 1; wy = Math.round(f.Y); fx = w - 2; fy = wy; }
  if (!side) { hungProblems.push(`${f.name} is not against any wall`); continue; }

  const wallId = wallAt.get(`${wx},${wy}`) || '?';
  // A curtain belongs ON a window —that is what a curtain is for. Everything
  // else hung on a wall needs wall behind it.
  if (/window|door/.test(wallId) && !/CURTAIN/.test(f.name)) {
    hungProblems.push(`${f.name} hangs on a ${wallId} at ${wx},${wy}`);
  }
  // What hides it? Anything in the tile in front that is tall enough to cover
  // most of it —which is exactly the armchair that was parked in front of the
  // bookshelf, and the armchair that was parked in front of the painting.
  const front = cell.get(`${fx},${fy}`) || [];
  const mine = atlas.get(atlas.spriteId(o.id, o.rot));
  const myCap = mine?.cap ?? 1;
  for (const e of front) {
    const cap = e.f.sp.cap ?? 1;
    if (cap > myCap * 0.65) {
      hungProblems.push(`${f.name} at ${wx},${wy} is hidden by ${e.f.name} (cap ${cap} vs ${myCap})`);
    }
  }
  flush.push(`${f.name} on ${side} ${wx},${wy} -> ${wallId}`);
}

// ---- ceiling vs wall tops ---------------------------------------------------
// A room's height lives in two places and they have to agree: the ceiling is
// stamped by finishRoom at the scene's `wallH`, and the wall pieces are drawn as
// tall as the model kit says they are. Stamp the ceiling BELOW the top of the
// walls and the sun leaks in over them at a shallow angle, which is invisible in
// a manifest and very visible at 07:00. Measured here rather than trusted to a
// comment, because the two numbers are in different files on purpose.
if (built.ceiling != null) {
  let tallest = 0, who = '';
  for (const o of room.objects) {
    const sid = atlas.spriteId(o.id, o.rot);
    const sp = sid && atlas.get(sid);
    if (!sp || sp.cat !== 'wall') continue;
    if ((sp.cap ?? 0) > tallest) { tallest = sp.cap; who = o.id; }
  }
  const wallTop = tallest - 0.13;                       // cap board is not wall
  const gap = built.ceiling - wallTop;
  const verdict = gap < -0.02
    ? `** CEILING ${(-gap).toFixed(2)} BELOW THE WALL TOP (${who}) —the sun will leak over it **`
    : `OK (${gap.toFixed(2)} of wall above the window heads left un-lit)`;
  console.log(`ceiling ${built.ceiling.toFixed(2)} vs tallest wall piece ${tallest.toFixed(2)} (${who}): ${verdict}`);
}

// ---- report ----------------------------------------------------------------
console.log(`interior ${STOREY} ${w}x${h}: ${room.objects.length} objects, ${room.marks.length} volume marks`);
console.log(`walkable tiles: ${free}, reachable from the door: ${reached}`
  + (reached >= free ? '  OK' : `  ** ${stranded.length} stranded: ${stranded.join(' ')} **`));
if (hungProblems.length) {
  console.log(`\n${hungProblems.length} wall-hanging problem(s):`);
  for (const p of hungProblems) console.log('  ! ' + p);
}
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log('  ! ' + p);
} else {
  console.log('\nno overlaps, nothing outside the floor');
}
if (flush.length) {
  console.log(`\n${flush.length} shared-tile note(s) — not errors, see the note at the tile map:`);
  for (const p of flush) console.log('  . ' + p);
}

if (process.argv.includes('--map')) {
  console.log('\noccupancy map (first letter of the piece; # = unreachable, . = free floor)');
  for (let y = 0; y < h; y++) {
    let line = '';
    for (let x = 0; x < w; x++) {
      const list = cell.get(`${x},${y}`) || [];
      const top = list.find((e) => !/RUG|SHELF|CLOCK|PAINTING|HERBS|CHANDELIER/i.test(e.f.name));
      if (top) line += top.o.id.replace('furn_', '').slice(0, 1);
      else if (list.length) line += ',';
      else if (!seen[y * w + x] && !blocked[y * w + x]) line += '#';
      else line += '.';
    }
    console.log('  ' + line);
  }
}
