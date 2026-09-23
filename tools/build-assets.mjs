// Offline pre-render entry point.
//
//   node tools/build-assets.mjs                    # both sets
//   node tools/build-assets.mjs --set outdoor      # just the 32x16 world
//   node tools/build-assets.mjs --set interior     # just the 48x24 interiors
//   node tools/build-assets.mjs --only bld_ --sheet
//   node tools/build-assets.mjs --stamp            # record a build time in the manifest
//
// REPRODUCIBLE BY DEFAULT
//   Every byte this writes is a pure function of the source — the four atlas
//   PNGs come out bit-identical across runs (verified by hashing them). The one
//   exception used to be a `generated: new Date()` field in sprites.json, which
//   made two builds of the same source differ and turned "did my change alter
//   the atlas?" into a question you could not answer by diffing. That field is
//   now opt-in via --stamp.
//
// TWO SETS, TWO SCALES
//   The outdoor world is authored at 32x16 tiles so a lot of it fits on screen.
//   An interior is a small, close, detailed space, and at 32 px per tile it was
//   simply unreadable. Rather than compromise on either, the same procedural
//   models are rendered twice: once at 1x for the world and once at 1.5x
//   (48x24 tiles) for interiors. No model code is duplicated — `setScale()` does
//   the work — and each set gets its own atlas, so the runtime just swaps
//   projection and texture together.
//
// For every model this builds the mesh, bakes per-vertex ambient occlusion,
// rasterises the sprite and resolves four AOV channels:
//
//   albedo  RGB = unlit material colour (display space), A = coverage
//   nrm     RGB = world-space *shading* normal (geometry + procedural relief),
//           A   = surface height inside the sprite
//   mat     R = AO | detail flag, G = specular, B = emissive, A = face-group id
//   stamp   top-down height + coverage, for the runtime shadow ray-march
//
// Everything is written as plain RGBA PNGs — this project has no palette
// quantisation, because the whole point is to let the runtime lighting breathe.
// The lighting is done in linear space, so the albedo is stored in display
// space (the runtime squares it) which keeps far more precision in the darks.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Builder } from './lib/geom.mjs';
import { MAT_LIST } from './lib/materials.mjs';
import { encodePNG } from './lib/png.mjs';
import {
  setScale, setPatternPhase, setBump, renderSprite, renderTopStamp,
  bakeAO, bakeGrime, rotMesh,
} from './lib/render.mjs';
import { ALL } from './models/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, 'work');
fs.mkdirSync(WORK, { recursive: true });

const argv = process.argv.slice(2);
const argVal = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ONLY = argVal('--only', null);
const WANT_SHEET = argv.includes('--sheet');
const STAMP = argv.includes('--stamp');
const ATLAS_W = Number(argVal('--atlas', 2048));
const SS = Number(argVal('--ss', 2));
const ZSCALE = Number(argVal('--zscale', 8));

/**
 * A set is a scale + the categories that belong to it + where it lands.
 * `stamp` off for interiors: they are lit by the 3D transmittance volume, not by
 * the outdoor height field, so building a height field for them is waste.
 */
export const SETS = {
  outdoor: {
    scale: 1, out: 'assets', ppc: 20, stamp: true, label: '32x16 world',
    cats: ['ground', 'water', 'build', 'crop', 'tree', 'prop', 'char'],
  },
  interior: {
    scale: 1.5, out: 'assets/int', ppc: 0, stamp: false, label: '48x24 interiors',
    cats: ['wall', 'floor', 'furn', 'char'],
  },
};

setBump(true);

/**
 * Which sprites the runtime is allowed to GHOST when they stand between the
 * camera and whatever you are looking at.
 *
 * This is not a rendering trick, it is scene data: a wall is a wall whether or
 * not the camera can see through it, and the sun must keep treating it as one.
 * The runtime reads this flag to decide which sprites go into the transparent
 * layer — everything else about them (normals, volume marks, height stamps) is
 * unchanged. See the cutaway note in src/main.js.
 *
 * A model can force its own answer with `cut: true` / `cut: false`.
 */
const CUT_BY_CAT = { wall: 1, roof: 1, build: 1 };
const cutOf = (m) => (m.cut === undefined ? (CUT_BY_CAT[m.cat || 'prop'] ? 1 : 0) : (m.cut ? 1 : 0));

/**
 * WHAT a piece is, in the one vocabulary a player-facing switch can use.
 *
 * `cat` says how the renderer should treat a model; `role` says what it IS, and
 * it exists so the game can offer "hide the windows", "hide the lamps" without
 * the renderer having to guess from sprite ids or from categories. A window and
 * a wall are both `cat: 'wall'`, and they want completely different switches.
 *
 * This is also the honest place for it: the mapping lives next to the model
 * descriptors it describes, so a new model cannot quietly fall outside every
 * switch. An id that matches nothing gets role `null` and is never hidden.
 */
const ROLE_BY_ID = [
  [/^wall_window/, 'window'],
  [/^wall_door/, 'door'],
  [/^wall_/, 'wall'],
  [/^roof/, 'roof'],
  [/lamp|lantern|candle|chandelier/, 'lamp'],
  [/curtain/, 'curtain'],
  [/painting|clock|shelf_plates/, 'hang'],
];
const roleOf = (id) => {
  for (const [re, role] of ROLE_BY_ID) if (re.test(id)) return role;
  return null;
};

// AO ray distance is per-category: a character is 1.25 world units tall, so the
// building-scale default (2.2 units to the first sample) is coarse enough that
// it produces almost no self-occlusion and the figure reads flat.
const AO_DEFAULT = { rays: 10, dist: 2.2, steps: 12, strength: 0.88 };
const AO_BY_CAT = {
  char: { rays: 14, dist: 0.6, steps: 10, strength: 0.92 },
  crop: { rays: 12, dist: 0.9, steps: 10, strength: 0.9 },
  furn: { rays: 10, dist: 1.2, steps: 10, strength: 0.9 },
};

function shelfPack(items, width) {
  const order = items.slice().sort((a, b) => (b.h - a.h) || (b.w - a.w));
  let x = 0, y = 0, rowH = 0;
  for (const it of order) {
    if (x + it.w + 1 > width) { y += rowH + 1; x = 0; rowH = 0; }
    it.x = x; it.y = y;
    x += it.w + 1;
    if (it.h > rowH) rowH = it.h;
  }
  let h = 1;
  while (h < y + rowH + 1) h *= 2;
  const buf = new Uint8Array(width * h * 4);
  for (const it of order) {
    for (let r = 0; r < it.h; r++) {
      const s = r * it.w * 4;
      buf.set(it.data.subarray(s, s + it.w * 4), ((it.y + r) * width + it.x) * 4);
    }
  }
  return { width, height: h, data: buf };
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

// ---------------------------------------------------------------- one set
function buildSet(name) {
  const cfg = SETS[name];
  const OUT = path.join(ROOT, cfg.out);
  fs.mkdirSync(OUT, { recursive: true });
  setScale(cfg.scale);

  let list = ALL.filter((m) => cfg.cats.includes(m.cat || 'prop'));
  if (ONLY) list = list.filter((m) => m.id.includes(ONLY));
  if (!list.length) { console.error(`set ${name}: no models`); return null; }

  const tileW = 32 * cfg.scale, tileH = 16 * cfg.scale, zpx = 22 * cfg.scale;
  console.log(`\n[${name}] ${cfg.label} — tile ${tileW}x${tileH} zpx ${zpx}, ${list.length} models`);
  const t0 = Date.now();

  const A = { albedo: [], nrm: [], mat: [], stamp: [] };
  const beauty = [];
  const sprites = {};
  const volumes = {};
  const warns = [];
  let done = 0;

  for (const m of list) {
    const rots = Math.max(1, m.rots || 1);
    const fp = m.fp || [1, 1];
    const anchor = m.anchor || [fp[0] / 2, fp[1] / 2, 0];
    setPatternPhase(m.phase || 0);

    for (let rot = 0; rot < rots; rot++) {
      const b = new Builder(fp[0], fp[1], m.seed || 1);
      m.build(b);
      const mesh = b.mesh;
      if (!mesh.faces.length) { warns.push(`${m.id}: empty mesh`); continue; }
      let bounds = [0, 0, fp[0], fp[1]];
      const sink = m.sink ?? (m.cat === 'ground' || m.cat === 'water' || m.cat === 'floor');
      const vw = mesh.validate(fp).filter((w) => !(sink && w.startsWith('mesh below ground')));
      if (vw.length) warns.push(`${m.id}: ${vw.join('; ')}`);
      if (rot === 0 && mesh.vol.length) volumes[m.id] = mesh.vol;

      // ---- world-space XY bounds of the ROTATED mesh ------------------------
      //
      // The runtime draws the world in painter's order, and the only sort key it
      // has is x+y. Using the footprint's CENTRE is what made a bed's foot
      // disappear behind a wall tile two rows further along: the bed spans two
      // tiles of depth, so half of it is nearer the camera than its centre says.
      //
      // Storing the real bounds lets the runtime sort by the object's FRONT-most
      // point, which is the correct key for an isometric painter's algorithm and
      // costs one line at runtime. The geometry is already built and rotated
      // here, so the bounds are free.
      {
        const { P } = rotMesh(mesh, rot, anchor);
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (let i = 0; i < P.length; i += 3) {
          if (P[i] < bx0) bx0 = P[i];
          if (P[i] > bx1) bx1 = P[i];
          if (P[i + 1] < by0) by0 = P[i + 1];
          if (P[i + 1] > by1) by1 = P[i + 1];
        }
        bounds = [bx0, by0, bx1, by1];
      }

      bakeAO(mesh, AO_BY_CAT[m.cat] || AO_DEFAULT);
      if (m.grime !== false) bakeGrime(mesh, { lo: 0.82, hi: 1.0 });

      let spr;
      try {
        spr = renderSprite(mesh, { rotation: rot, ss: SS, pad: 3, anchor, aov: true, outline: false });
      } catch (e) {
        warns.push(`${m.id} rot${rot}: render failed: ${e.message}`);
        continue;
      }
      if (!spr.aov) { warns.push(`${m.id} rot${rot}: no AOV`); continue; }

      const id = rots > 1 ? `${m.id}#${rot}` : m.id;
      // The AOV buffers are ALREADY 8-bit (resolveAOV returns Uint8Array); only
      // the CPU-lit beauty buffer is float.
      const rA = { x: 0, y: 0, w: spr.w, h: spr.h, data: spr.aov.albedo };
      const rN = { x: 0, y: 0, w: spr.w, h: spr.h, data: spr.aov.nrm };
      const rM = { x: 0, y: 0, w: spr.w, h: spr.h, data: spr.aov.mat };
      A.albedo.push(rA); A.nrm.push(rN); A.mat.push(rM);

      let rS = null;
      if (cfg.stamp && m.stamp !== false && m.cat !== 'ground' && m.cat !== 'water' && m.cat !== 'floor') {
        const st = renderTopStamp(mesh, { rotation: rot, ppc: cfg.ppc, anchor, pad: 0.3, zScale: ZSCALE });
        if (st) { rS = { x: 0, y: 0, w: st.w, h: st.h, data: st.buf, x0: st.x0, y0: st.y0, ppc: st.ppc, zs: st.zScale }; A.stamp.push(rS); }
      }

      beauty.push({ id, cat: m.cat || 'prop', spr });

      sprites[id] = {
        _ra: rA, _rn: rN, _rm: rM, _rs: rS,
        ax: spr.anchorX, ay: spr.anchorY,
        w: spr.w, h: spr.h,
        z0: +spr.aov.z0.toFixed(4), z1: +spr.aov.z1.toFixed(4),
        fp, cat: m.cat || 'prop', name: m.name || m.id,
        cap: m.cap ?? 1,
        cut: cutOf(m),
        role: roleOf(m.id),
        bb: bounds.map((v) => +v.toFixed(4)),
        phase: m.phase ?? 0,
        action: m.action ?? null, frame: m.frame ?? null, fps: m.fps ?? 0, frames: m.frames ?? 0,
        rot,
      };
    }
    done++;
    if (done % 40 === 0 || done === list.length) {
      process.stdout.write(`\r  ${done}/${list.length} models  (${((Date.now() - t0) / 1000).toFixed(1)}s)   `);
    }
  }
  process.stdout.write('\n');

  const writeAtlas = (nm, items) => {
    if (!items.length) {
      // a set with no height stamps still ships a 1x1 black one, so the loader
      // and the renderer never have to special-case a missing file
      const blank = { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) };
      fs.writeFileSync(path.join(OUT, `${nm}.png`), encodePNG({ ...blank, colorType: 6 }));
      return blank;
    }
    const packed = shelfPack(items, ATLAS_W);
    fs.writeFileSync(path.join(OUT, `${nm}.png`), encodePNG({ ...packed, colorType: 6 }));
    return packed;
  };
  const pa = writeAtlas('albedo', A.albedo);
  const pn = writeAtlas('nrm', A.nrm);
  const pm = writeAtlas('mat', A.mat);
  const ps = writeAtlas('stamp', A.stamp);

  for (const s of Object.values(sprites)) {
    const { _ra: ra, _rn: rn, _rm: rm, _rs: rs } = s;
    s.a = [ra.x, ra.y, ra.w, ra.h];
    s.n = [rn.x, rn.y, rn.w, rn.h];
    s.m = [rm.x, rm.y, rm.w, rm.h];
    s.s = rs ? [rs.x, rs.y, rs.w, rs.h] : null;
    s.sx = rs ? +rs.x0.toFixed(4) : 0;
    s.sy = rs ? +rs.y0.toFixed(4) : 0;
    s.ppc = rs ? rs.ppc : 0;
    s.zs = rs ? rs.zs : 0;
    delete s._ra; delete s._rn; delete s._rm; delete s._rs;
  }

  const manifest = {
    version: 2,
    set: name,
    scale: cfg.scale,
    // Absent unless --stamp: see the reproducibility note at the top of the file.
    ...(STAMP ? { generated: new Date().toISOString() } : {}),
    tile: { w: tileW, h: tileH, zpx },
    atlas: {
      albedo: pa ? [pa.width, pa.height] : null,
      nrm: pn ? [pn.width, pn.height] : null,
      mat: pm ? [pm.width, pm.height] : null,
      stamp: ps ? [ps.width, ps.height] : null,
      ppc: cfg.ppc, zScale: ZSCALE,
    },
    materials: MAT_LIST.map((x) => ({ name: x.name, spec: x.spec, emissive: x.emissive })),
    volumes,
    sprites,
  };
  fs.writeFileSync(path.join(OUT, 'sprites.json'), JSON.stringify(manifest));

  console.log(`  ${cfg.out}/`);
  let totalBytes = 0;
  for (const [n, p] of [['albedo', pa], ['nrm', pn], ['mat', pm], ['stamp', ps]]) {
    if (!p) continue;
    const sz = fs.statSync(path.join(OUT, `${n}.png`)).size;
    totalBytes += sz;
    console.log(`    ${n.padEnd(7)} ${String(p.width).padStart(4)}x${String(p.height).padEnd(5)} ${kb(sz)}`);
  }
  const jsz = fs.statSync(path.join(OUT, 'sprites.json')).size;
  totalBytes += jsz;
  console.log(`    sprites ${Object.keys(sprites).length} entries, ${kb(jsz)}`);
  console.log(`    total   ${(totalBytes / 1048576).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (warns.length) {
    console.log(`  ${warns.length} warning(s):`);
    for (const w of warns.slice(0, 12)) console.log(`    ! ${w}`);
    if (warns.length > 12) console.log(`    ... ${warns.length - 12} more`);
  }
  if (WANT_SHEET) writeSheets(beauty, name);
  return { name, sprites: Object.keys(sprites).length, bytes: totalBytes };
}

// ---------------------------------------------------------------- QA sheets
function writeSheets(entries, setName) {
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.cat)) groups.set(e.cat, []);
    groups.get(e.cat).push(e);
  }
  for (const [cat, list2] of groups) {
    const cols = Math.min(list2.length, cat === 'ground' || cat === 'water' ? 8 : 6);
    const maxAbove = Math.max(...list2.map((e) => e.spr.anchorY));
    const maxBelow = Math.max(...list2.map((e) => e.spr.h - e.spr.anchorY));
    const cw = Math.max(...list2.map((e) => e.spr.w)) + 10;
    const chh = maxAbove + maxBelow + 10;
    const rows = Math.ceil(list2.length / cols);
    const W = cw * cols, H = chh * rows;
    const img = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = ((x >> 3) + (y >> 3)) & 1 ? 46 : 62;
        const i = (y * W + x) * 4;
        img[i] = c; img[i + 1] = c + 4; img[i + 2] = c + 12; img[i + 3] = 255;
      }
    }
    list2.forEach((e, n) => {
      const cx = (n % cols) * cw + 5, cy = Math.floor(n / cols) * chh + 5;
      const s = e.spr;
      const ox = cx + Math.floor((cw - 10 - s.w) / 2);
      const oy = cy + (maxAbove - s.anchorY);
      for (let y = 0; y < s.h; y++) {
        for (let x = 0; x < s.w; x++) {
          const dx = ox + x, dy = oy + y;
          if (dx < 0 || dy < 0 || dx >= W || dy >= H) continue;
          const a = s.rgba[(y * s.w + x) * 4 + 3];
          if (a <= 0.004) continue;
          const di = (dy * W + dx) * 4, si = (y * s.w + x) * 4;
          for (let k = 0; k < 3; k++) img[di + k] = Math.round(img[di + k] * (1 - a) + Math.round(s.rgba[si + k] * 255) * a);
        }
      }
    });
    const file = path.join(WORK, `sheet_${setName}_${cat}.png`);
    fs.writeFileSync(file, encodePNG({ width: W, height: H, data: img, colorType: 6 }));
    console.log(`    sheet ${path.relative(ROOT, file)} (${list2.length} ${cat}, ${W}x${H})`);
  }
}

// ---------------------------------------------------------------- driver
const which = argVal('--set', 'all');
const names = which === 'all' ? Object.keys(SETS) : [which];
const results = [];
for (const n of names) {
  if (!SETS[n]) { console.error(`unknown set: ${n}`); process.exit(1); }
  const r = buildSet(n);
  if (r) results.push(r);
}
console.log(`\nbuilt ${results.length} set(s): ${results.map((r) => `${r.name}(${r.sprites})`).join(', ')}`);
