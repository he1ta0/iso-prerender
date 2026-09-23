// Headless probe for the interior light volume.
//
// The runtime marches a 3D transmittance volume that the OFFLINE models declare.
// When a sun patch lands in the wrong place there are three candidates — the
// marks, the volume raster, or the shader march — and reading the GLSL tells you
// nothing about which one it is. This tool replays the whole CPU side exactly
// (makeInterior -> buildVolume) and marches the very same ray the shader does,
// so the answer is a number rather than a guess.
//
//   node tools/volume-probe.mjs                    # shadow map of the floor
//   node tools/volume-probe.mjs --t 0.5 --grid     # ASCII floor, . = sun, # = shadow
//   node tools/volume-probe.mjs --col 5,3          # vertical column dump
//
// It imports the REAL src/interior.js, so it cannot drift from the game.
//
//   node tools/volume-probe.mjs --storey upper   # the loft instead of the ground floor

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeInterior, ROOM_W, ROOM_D, WALL_H, CAP_H } from '../src/interior.js';
import { makeUpperInterior } from '../src/interior_upper.js';
import { makeChapelInterior } from '../src/interior_chapel.js';
import { daylightAt } from '../src/daylight.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argVal = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const T = Number(argVal('--t', 0.5));
const STOREY = argVal('--storey', 'ground');
const VOX = Number(argVal('--ppu', 14));
const VOZ = Number(argVal('--ppz', 11));

// ---------------------------------------------------------------- fake atlas
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

const MAKERS = {
  ground: () => makeInterior(atlas),
  upper: () => makeUpperInterior(atlas),
  chapel: () => makeChapelInterior(atlas),
};
if (!MAKERS[STOREY]) { console.error(`unknown storey: ${STOREY} (ground | upper | chapel)`); process.exit(1); }
const room = MAKERS[STOREY]();
if (!room) { console.error('makeInterior returned null'); process.exit(1); }

// ---------------------------------------------------------------- buildVolume (mirror of gl/renderer.js)
function buildVolume(bounds, marks, ppu = VOX, ppz = VOZ) {
  const min = bounds.min, max = bounds.max;
  const sx = Math.max(0.5, max[0] - min[0]);
  const sy = Math.max(0.5, max[1] - min[1]);
  const sz = Math.max(0.5, max[2] - min[2]);
  const dx = Math.max(2, Math.ceil(sx * ppu));
  const dy = Math.max(2, Math.ceil(sy * ppu));
  const dz = Math.max(2, Math.ceil(sz * ppz));
  const data = new Uint8Array(dx * dy * dz * 4);
  for (let i = 0; i < dx * dy * dz; i++) {
    data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255; data[i * 4 + 3] = 255;
  }
  const kx = dx / sx, ky = dy / sy, kz = dz / sz;
  // must match src/gl/renderer.js makeVolume(): per-voxel COVERAGE, composed
  // multiplicatively. A binary field quantises every shadow edge to the voxel
  // grid, and that quantisation is the "rows of light bars" artefact.
  const cov = (lo, hi, size, a, b) => {
    const s = Math.min(b, hi) - Math.max(a, lo);
    return s > 0 ? s / size : 0;
  };
  const vx = 1 / kx, vy = 1 / ky, vz = 1 / kz;
  // must match src/gl/renderer.js makeVolume(): coverage ACCUMULATED per kind
  // (solid / glass) and composed once, so marks that overlap in the voxel grid
  // describe one surface instead of being charged twice.
  const n3 = dx * dy * dz;
  const covS = new Float32Array(n3);
  const covG = new Float32Array(n3);
  const tAcc = new Float32Array(n3 * 3);
  const trAcc = new Float32Array(n3);
  let solidVox = 0, glassVox = 0;
  for (const mk of marks) {
    const i0 = Math.max(0, Math.floor((mk.x0 - min[0]) * kx));
    const i1 = Math.min(dx - 1, Math.ceil((mk.x1 - min[0]) * kx) - 1);
    const j0 = Math.max(0, Math.floor((mk.y0 - min[1]) * ky));
    const j1 = Math.min(dy - 1, Math.ceil((mk.y1 - min[1]) * ky) - 1);
    const k0 = Math.max(0, Math.floor((mk.z0 - min[2]) * kz));
    const k1 = Math.min(dz - 1, Math.ceil((mk.z1 - min[2]) * kz) - 1);
    if (i1 < i0 || j1 < j0 || k1 < k0) continue;
    const glass = mk.kind === 'glass';
    const tr = mk.trans ?? 0.9;
    const tint = mk.tint ?? [1, 1, 1];
    for (let k = k0; k <= k1; k++) {
      const fz = cov(min[2] + k / kz, min[2] + (k + 1) / kz, vz, mk.z0, mk.z1);
      if (fz <= 0) continue;
      for (let j = j0; j <= j1; j++) {
        const fy = cov(min[1] + j / ky, min[1] + (j + 1) / ky, vy, mk.y0, mk.y1);
        if (fy <= 0) continue;
        let idx = (k * dy + j) * dx + i0;
        for (let i = i0; i <= i1; i++, idx++) {
          const fx = cov(min[0] + i / kx, min[0] + (i + 1) / kx, vx, mk.x0, mk.x1);
          if (fx <= 0) continue;
          const c = fx * fy * fz;
          if (c <= 0.002) continue;
          if (glass) {
            covG[idx] += c;
            trAcc[idx] += tr * c;
            tAcc[idx * 3] += tint[0] * c;
            tAcc[idx * 3 + 1] += tint[1] * c;
            tAcc[idx * 3 + 2] += tint[2] * c;
          } else {
            covS[idx] += c;
          }
        }
      }
    }
  }
  for (let idx = 0; idx < n3; idx++) {
    const cs = Math.min(1, covS[idx]);
    const cg = Math.min(1, covG[idx]);
    const o = idx * 4;
    const t = cg > 0 ? 1 - cg * (1 - trAcc[idx] / covG[idx]) : 1;
    data[o] = Math.round(Math.max(0, Math.min(1, (1 - cs) * t)) * 255);
    if (cg > 0) {
      data[o + 1] = Math.round(Math.max(0, Math.min(1, tAcc[idx * 3] / covG[idx])) * 255);
      data[o + 2] = Math.round(Math.max(0, Math.min(1, tAcc[idx * 3 + 1] / covG[idx])) * 255);
      data[o + 3] = Math.round(Math.max(0, Math.min(1, tAcc[idx * 3 + 2] / covG[idx])) * 255);
    }
  }
  for (let i = 0; i < dx * dy * dz; i++) {
    if (data[i * 4] === 0) solidVox++;
    else if (data[i * 4] < 250) glassVox++;
  }
  return { data, dx, dy, dz, min, size: [sx, sy, sz], kx, ky, kz, solidVox, glassVox,
    step: 1 / (ppz * 1.6), top: max[2] };
}

const vol = buildVolume(room.bounds, room.marks);

/** the shader's trilinear fetch, in JS (nearest would hide filtering artefacts) */
function fetchVox(p) {
  const fx = (p[0] - vol.min[0]) / vol.size[0] * vol.dx - 0.5;
  const fy = (p[1] - vol.min[1]) / vol.size[1] * vol.dy - 0.5;
  const fz = (p[2] - vol.min[2]) / vol.size[2] * vol.dz - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
  const tx = fx - x0, ty = fy - y0, tz = fz - z0;
  const cl = (v, n) => Math.max(0, Math.min(n - 1, v));
  const at = (i, j, k) => vol.data[((cl(k, vol.dz) * vol.dy + cl(j, vol.dy)) * vol.dx + cl(i, vol.dx)) * 4] / 255;
  const lerp = (a, b, t) => a + (b - a) * t;
  const c00 = lerp(at(x0, y0, z0), at(x0 + 1, y0, z0), tx);
  const c10 = lerp(at(x0, y0 + 1, z0), at(x0 + 1, y0 + 1, z0), tx);
  const c01 = lerp(at(x0, y0, z0 + 1), at(x0 + 1, y0, z0 + 1), tx);
  const c11 = lerp(at(x0, y0 + 1, z0 + 1), at(x0 + 1, y0 + 1, z0 + 1), tx);
  return lerp(lerp(c00, c10, ty), lerp(c01, c11, ty), tz);
}

const inside = (p) => {
  const u = [(p[0] - vol.min[0]) / vol.size[0], (p[1] - vol.min[1]) / vol.size[1], (p[2] - vol.min[2]) / vol.size[2]];
  return u.every((v) => v >= 0 && v <= 1);
};

const sun = daylightAt(T).sunDir;

/**
 * The shader march, mirrored: 3D-DDA over the voxel grid, exactly as
 * LIGHT_FS roomMarch() does it. A step-based march was what leaked at dawn.
 */
function march(x, y, z) {
  const dzS = sun[2];
  if (dzS <= 0.03) return { shadow: 1, steps: 0, why: 'flat', tint: [1, 1, 1] };
  const dir = [sun[0] / dzS, sun[1] / dzS];
  const d = [dir[0] * vol.kx, dir[1] * vol.ky, vol.kz];
  const g = [(x - vol.min[0]) * vol.kx, (y - vol.min[1]) * vol.ky, (z - vol.min[2]) * vol.kz];
  const vi = [Math.floor(g[0]), Math.floor(g[1]), Math.floor(g[2])];
  const ad = d.map((v) => Math.max(Math.abs(v), 1e-5));
  const stp = [d[0] < 0 ? -1 : 1, d[1] < 0 ? -1 : 1, 1];
  const td = [1 / ad[0], 1 / ad[1], 1 / ad[2]];
  const tm = [
    d[0] < 0 ? (g[0] - vi[0]) / ad[0] : (vi[0] + 1 - g[0]) / ad[0],
    d[1] < 0 ? (g[1] - vi[1]) / ad[1] : (vi[1] + 1 - g[1]) / ad[1],
    d[2] < 0 ? (g[2] - vi[2]) / ad[2] : (vi[2] + 1 - g[2]) / ad[2],
  ];
  let trans = 1, steps = 0, why = 'exit', t = 0;
  const tint = [1, 1, 1];
  // must match roomMarch1 in src/gl/shaders.js: the bound is the grid diagonal
  const maxSteps = vol.dx + vol.dy + vol.dz;
  for (let s = 0; s < maxSteps; s++) {
    steps = s;
    if (vi[0] < 0 || vi[1] < 0 || vi[2] < 0 || vi[0] >= vol.dx || vi[1] >= vol.dy || vi[2] >= vol.dz) { why = 'bounds'; break; }
    const o = ((vi[2] * vol.dy + vi[1]) * vol.dx + vi[0]) * 4;
    const r = vol.data[o] / 255;
    if (r < 0.03) return { shadow: 0, steps: s, why: 'solid', t: Math.min(tm[0], tm[1], tm[2]), p: [vi[0], vi[1], vi[2]], tint };
    trans *= r;
    // the colour the light has picked up by the time it reaches this point: the
    // same `tint *= v.gba` the shader does, so this is what the patch on the
    // floor is actually made of rather than what the model file intended
    tint[0] *= vol.data[o + 1] / 255;
    tint[1] *= vol.data[o + 2] / 255;
    tint[2] *= vol.data[o + 3] / 255;
    if (trans < 0.02) return { shadow: 0, steps: s, why: 'glass', t, tint };
    if (tm[0] <= tm[1] && tm[0] <= tm[2]) { t = tm[0]; vi[0] += stp[0]; tm[0] += td[0]; }
    else if (tm[1] <= tm[2]) { t = tm[1]; vi[1] += stp[1]; tm[1] += td[1]; }
    else { t = tm[2]; vi[2] += 1; tm[2] += td[2]; }
  }
  return { shadow: trans, steps, why, t, tint };
}

// ---------------------------------------------------------------- modes
if (argv.includes('--vox')) {
  const [qx, qy, qz] = (argVal('--vox', '10.2,2.34,1.02')).split(',').map(Number);
  const o = ((Math.floor((qz - vol.min[2]) * vol.kz) * vol.dy + Math.floor((qy - vol.min[1]) * vol.ky)) * vol.dx
    + Math.floor((qx - vol.min[0]) * vol.kx)) * 4;
  console.log(`voxel at ${qx},${qy},${qz} -> i=${Math.floor((qx - vol.min[0]) * vol.kx)} j=${Math.floor((qy - vol.min[1]) * vol.ky)} k=${Math.floor((qz - vol.min[2]) * vol.kz)}  R=${vol.data[o]}`);
  console.log('marks covering the point:');
  for (const m of room.marks) {
    if (qx >= m.x0 && qx <= m.x1 && qy >= m.y0 && qy <= m.y1 && qz >= m.z0 && qz <= m.z1) {
      console.log(`  ${m.kind} x[${m.x0.toFixed(2)},${m.x1.toFixed(2)}] y[${m.y0.toFixed(2)},${m.y1.toFixed(2)}] z[${m.z0.toFixed(2)},${m.z1.toFixed(2)}]`);
    }
  }
  const owners = [];
  for (const ob of room.objects) {
    const vols = manifest.volumes[ob.id];
    if (!vols) continue;
    const sid = atlas.spriteId(ob.id, ob.rot);
    const sp = atlas.get(sid);
    const C = [1, 0, -1, 0][ob.rot], S = [0, 1, 0, -1][ob.rot];
    const cx = sp.fp[0] / 2, cy = sp.fp[1] / 2;
    for (const v of vols) {
      const X = (x, y) => cx + (x - cx) * C - (y - cy) * S + ob.gx;
      const Y = (x, y) => cy + (x - cx) * S + (y - cy) * C + ob.gy;
      const xs = [X(v.x0, v.y0), X(v.x1, v.y0), X(v.x0, v.y1), X(v.x1, v.y1)];
      const ys = [Y(v.x0, v.y0), Y(v.x1, v.y0), Y(v.x0, v.y1), Y(v.x1, v.y1)];
      if (qx >= Math.min(...xs) && qx <= Math.max(...xs) && qy >= Math.min(...ys) && qy <= Math.max(...ys)
        && qz >= v.z0 && qz <= v.z1) owners.push(`${ob.id} rot${ob.rot} at ${ob.gx},${ob.gy} cat=${sp.cat}`);
    }
  }
  console.log('placed objects contributing:', owners.length ? owners.join(' | ') : '(none)');
} else if (argv.includes('--tint')) {
  // A colour map of the floor: for every tile, march to the sun and name the
  // colour the light arrives with. This is the readout that says whether the
  // stained glass in tools/models/chapel.mjs is doing anything at all —
  // `glassBox(..., {tint})` is a claim about LIGHT, and a claim about light is
  // only worth anything if something measures it.
  // the palette as the FLOOR receives it: the volume squares the tint once per
  // voxel crossed and a pane is two voxels thick, so compare against tint^2
  const NAMED = [
    ['R', [1.00, 0.30, 0.25]], ['B', [0.30, 0.49, 1.00]], ['Y', [1.00, 0.77, 0.30]],
    ['G', [0.30, 0.90, 0.42]], ['V', [0.64, 0.38, 1.00]], ['W', [1, 1, 1]],
  ];
  const label = (t) => {
    let best = null, bd = 1e9;
    for (const [n, c] of NAMED) {
      const d = (t[0] - c[0]) ** 2 + (t[1] - c[1]) ** 2 + (t[2] - c[2]) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    return bd < 0.15 ? best : '?';
  };
  console.log(`floor light colour  t=${T}  sun=${sun.map((v) => v.toFixed(3)).join(',')}`);
  console.log('  R rose  B azure  Y gold  G verdant  V violet  W unfiltered  # shadow  ? mixed');
  const counts = {};
  for (let y = 0; y < room.h; y++) {
    let line = '  ';
    for (let x = 0; x < room.w; x++) {
      const r = march(x + 0.5, y + 0.5, 0.02);
      if (r.shadow < 0.35) { line += '#'; continue; }
      const ch = label(r.tint);
      counts[ch] = (counts[ch] || 0) + 1;
      line += ch;
    }
    console.log(line);
  }
  console.log('  ' + Object.entries(counts).map(([k, v]) => `${k}:${v}`).join('  '));
} else if (argv.includes('--trace')) {
  const [cx, cy] = (argVal('--trace', '8,2.5')).split(',').map(Number);
  const cz = Number(argVal('--z', 0.001));
  const r = march(cx, cy, cz);
  console.log(`trace from ${cx},${cy},${cz}  sun=${sun.map((v) => v.toFixed(3)).join(',')}`);
  console.log(`  -> ${r.why} after ${r.steps} voxel steps (t=${(r.t || 0).toFixed(2)}), sun reaches ${r.shadow.toFixed(3)}`);
  if (r.tint) {
    const c = r.tint.map((v) => Math.round(Math.min(1, v) * 255));
    console.log(`  light colour after the march: rgb(${c.join(',')})  gain ${(r.shadow * (c[0] + c[1] + c[2]) / 765).toFixed(3)}`);
  }
  if (r.p) console.log(`  first solid voxel ${r.p.join(',')} = world ${r.p.map((v, i) => (vol.min[i] + (v + 0.5) / [vol.kx, vol.ky, vol.kz][i]).toFixed(2)).join(',')}`);
} else if (argv.includes('--col')) {
  const [cx, cy] = (argVal('--trace', '5,3')).split(',').map(Number);
  const cz = Number(argVal('--z', 0.001));
  console.log(`trace from ${cx},${cy},${cz}  sun=${sun.map((v) => v.toFixed(3)).join(',')}`);
  const dzS = sun[2];
  const dir = [sun[0] / dzS, sun[1] / dzS];
  for (let s = 1; s <= 128; s++) {
    const t = s * vol.step;
    const p = [cx + dir[0] * t, cy + dir[1] * t, cz + t];
    const ins = inside(p);
    const r = ins ? fetchVox(p) : -1;
    if (s <= 6 || s % 5 === 0 || (r >= 0 && r < 0.03)) {
      console.log(`  s=${String(s).padStart(3)} t=${t.toFixed(2)} p=(${p.map((v) => v.toFixed(2)).join(',')}) inside=${ins ? 'y' : 'n'} r=${r.toFixed(3)}`);
    }
    if (!ins || p[2] > vol.top) break;
    if (r < 0.03) break;
  }
} else if (argv.includes('--col')) {
  const [cx, cy] = (argVal('--col', '5,3')).split(',').map(Number);
  console.log(`column ${cx},${cy}  t=${T}  sun=${sun.map((v) => v.toFixed(3)).join(',')}`);
  for (let k = vol.dz - 1; k >= 0; k--) {
    const z = vol.min[2] + (k + 0.5) / vol.kz;
    let s = 0, a = 0;
    for (let i = 0; i < vol.dx; i++) {
      const r = vol.data[((k * vol.dy + Math.floor((cy - vol.min[1]) * vol.ky)) * vol.dx + i) * 4];
      if (r === 0) s++; else if (r < 250) a++;
    }
    const here = vol.data[((k * vol.dy + Math.floor((cy - vol.min[1]) * vol.ky)) * vol.dx + Math.floor((cx - vol.min[0]) * vol.kx)) * 4];
    if (k < 4 || k > vol.dz - 12 || s || a) {
      console.log(`  k=${String(k).padStart(3)} z=${z.toFixed(2).padStart(5)}  rowSolid=${String(s).padStart(3)} glass=${String(a).padStart(3)}  here=${here}`);
    }
  }
} else {
  console.log(`volume ${vol.dx}x${vol.dy}x${vol.dz}  solid=${vol.solidVox} glass=${vol.glassVox}  marks=${room.marks.length}`);
  console.log(`t=${T} sunDir=${sun.map((v) => v.toFixed(3)).join(',')}  step=${vol.step.toFixed(4)}`);
  console.log('floor shadow map ("." lit, "#" shadowed, "+" glass path, "o" object tile)');
  const occupied = new Set(room.objects.map((o) => `${o.gx},${o.gy}`));
  let lit = 0, dark = 0;
  for (let y = 0; y < room.h; y++) {
    let line = '';
    for (let x = 0; x < room.w; x++) {
      const r = march(x + 0.5, y + 0.5, 0.001);
      let c = r.shadow > 0.5 ? '.' : '#';
      if (r.why === 'solid' && r.p) {
        const v = fetchVox(r.p);
        if (v > 0.03 && v < 0.97) c = '+';
      }
      if (occupied.has(`${x},${y}`) && c === '.') c = 'o';
      if (r.shadow > 0.5) lit++; else dark++;
      line += c;
    }
    console.log('  ' + line);
  }
  console.log(`  lit ${lit} / ${lit + dark} floor tiles`);
  const worst = [];
  for (let y = 0; y < room.h; y++) {
    for (let x = 0; x < room.w; x++) worst.push([x, y, march(x + 0.5, y + 0.5, 0.001).steps]);
  }
  worst.sort((a, b) => b[2] - a[2]);
  console.log('  longest marches:', worst.slice(0, 5).map((w) => `(${w[0]},${w[1]})=${w[2]}`).join(' '));
}

// wall band: is the room sealed at every height?
if (argv.includes('--seal')) {
  console.log('\nseal test: fraction of upward rays from each wall that escape');
  for (const [name, x, y] of [['back -y', 5.5, 0.3], ['left -x', 0.3, 4.5], ['right +x', 10.7, 4.5], ['front +y', 5.5, 8.7]]) {
    const r = march(x, y, 0.001);
    console.log(`  ${name.padEnd(9)} ${r.why} after ${r.steps} steps (t=${r.t.toFixed(2)})`);
  }
  console.log(`  ceiling z from ${(WALL_H + CAP_H).toFixed(3)} to ${(WALL_H + 0.9).toFixed(3)}`);
}
