// Hand-written isometric sprite renderer.
//  * fixed 2:1 dimetric orthographic projection
//  * flat-shaded Lambert + hemispheric ambient + world-space procedural surface detail
//  * per-vertex ray-marched ambient occlusion baked offline
//  * supersampled with alpha-weighted resolve, then a face-id edge pass for
//    crisp pre-rendered outlines
//  * a second pass projects the mesh along the sun vector to bake drop shadows
//
// Nothing here needs a GPU, a browser or Blender: it is plain JS arrays + math.

export let TILE_W = 32;
export let TILE_H = 16;
export let ZPX = 22;

import { MAT_LIST, PAT } from './materials.mjs';
import { patternMul, patternHeight, setPatternPhase, getPatternPhase } from './patterns.mjs';
export { setPatternPhase, getPatternPhase };

let HW = TILE_W / 2, HH = TILE_H / 2;
let SCALE = 1;

/** switch the whole renderer to another pre-rendered zoom level (1 = near, 0.5 = far) */
export function setScale(s) {
  SCALE = s;
  TILE_W = 32 * s;
  TILE_H = 16 * s;
  ZPX = 22 * s;
  HW = TILE_W / 2;
  HH = TILE_H / 2;
}
export const getScale = () => SCALE;

const nrm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const SUN = nrm3([0.44, 0.30, 0.85]);
export const EYE = nrm3([1, 1, 1]);
export const HALF = nrm3([SUN[0] + EYE[0], SUN[1] + EYE[1], SUN[2] + EYE[2]]);
const SKY_TINT = [0.76, 0.87, 1.10];
const SUN_TINT = [1.20, 1.06, 0.84];

export function project(x, y, z) { return [(x - y) * HW, (x + y) * HH - z * ZPX]; }
/** depth along the view axis: larger = closer to the eye */
const depthOf = (x, y, z) => x + y + z;

// ---------------------------------------------------------------- hashing
// (procedural surface detail itself lives in patterns.mjs, shared with the
//  model kit so a pattern can be previewed without the rasteriser)
function h2(a, b, s = 0) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) ^ 0x27d4eb2f, 0xc2b2ae35);
  h ^= (s * 0x9e3779b1) | 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2545f491); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
const fract = (v) => v - Math.floor(v);

// ---------------------------------------------------------------- detail normals
// Perturb a surface normal by the gradient of the material's procedural pattern.
// Geometry alone gives one constant normal per face, so without this a wooden
// wall lit by a carried lantern is a dead flat gradient. Here a pattern value
// below 1 counts as a groove, so the height signal is (pattern - 1) and the
// surface tilts along -grad(h).
//
// The response saturates: the raw finite difference of a hard-edged pattern
// (brick joint, plank seam) is ~100x that of a soft one (thatch, cloth weave),
// and without saturation the hard ones explode while the soft ones do nothing.
// After saturation the strength argument is directly the maximum tangent tilt
// as a ratio, so strength 0.75 means "up to ~37 degrees off the face".
const GRAD_E = 0.0035;
let BUMP_ON = true;
export function setBump(on) { BUMP_ON = !!on; }
export const getBump = () => BUMP_ON;

function bumpNormal(pid, x, y, z, n, strength) {
  const e = GRAD_E;
  const gx = patternHeight(pid, x + e, y, z, n) - patternHeight(pid, x - e, y, z, n);
  const gy = patternHeight(pid, x, y + e, z, n) - patternHeight(pid, x, y - e, z, n);
  const gz = patternHeight(pid, x, y, z + e, n) - patternHeight(pid, x, y, z - e, n);
  let vx = gx, vy = gy, vz = gz;
  const vd = vx * n[0] + vy * n[1] + vz * n[2];
  vx -= vd * n[0]; vy -= vd * n[1]; vz -= vd * n[2];   // keep the tangential part
  const gm = Math.hypot(vx, vy, vz);
  if (!(gm > 1e-7)) return null;
  const k = strength * (gm / (gm + 0.09)) / gm;
  const nx = n[0] - vx * k, ny = n[1] - vy * k, nz = n[2] - vz * k;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

// ---------------------------------------------------------------- AO baking
function buildGrid(occluders, cell = 0.5) {
  const map = new Map();
  const key = (i, j, k) => `${i|0},${j|0},${k|0}`;
  occluders.forEach((b, bi) => {
    const i0 = Math.floor(b.mn[0] / cell), i1 = Math.floor(b.mx[0] / cell);
    const j0 = Math.floor(b.mn[1] / cell), j1 = Math.floor(b.mx[1] / cell);
    const k0 = Math.floor(b.mn[2] / cell), k1 = Math.floor(b.mx[2] / cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) {
      const kk = key(i, j, k);
      let arr = map.get(kk);
      if (!arr) { arr = []; map.set(kk, arr); }
      arr.push(bi);
    }
  });
  return { map, cell, key };
}

const HEMI = (() => {
  const n = 24, out = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const phi = Math.acos(1 - t * 0.985);
    const theta = i * 2.399963;
    out.push([Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi)]);
  }
  return out;
})();

export function bakeAO(mesh, opts = {}) {
  const rays = opts.rays || 12;
  const dist = opts.dist || 2.0;
  const steps = opts.steps || 14;
  const strength = opts.strength ?? 0.86;
  const grid = buildGrid(mesh.occluders);
  const P = mesh.pos, VN = mesh.ao;
  const vcount = P.length / 3;
  // average face normal per vertex
  const vn = new Float32Array(vcount * 3);
  for (const f of mesh.faces) {
    for (const vi of f.v) { vn[vi * 3] += f.n[0]; vn[vi * 3 + 1] += f.n[1]; vn[vi * 3 + 2] += f.n[2]; }
  }
  for (let i = 0; i < vcount; i++) {
    const l = Math.hypot(vn[i * 3], vn[i * 3 + 1], vn[i * 3 + 2]) || 1;
    vn[i * 3] /= l; vn[i * 3 + 1] /= l; vn[i * 3 + 2] /= l;
  }
  const selfSkip = mesh.occluders.map(() => -1);
  for (let i = 0; i < vcount; i++) {
    const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
    const nx = vn[i * 3], ny = vn[i * 3 + 1], nz = vn[i * 3 + 2];
    // tangent frame
    let tx = Math.abs(nx) < 0.9 ? 1 : 0, ty = Math.abs(nx) < 0.9 ? 0 : 1, tz = 0;
    let bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    const bl = Math.hypot(bx, by, bz) || 1; bx /= bl; by /= bl; bz /= bl;
    let ux = ny * bz - nz * by, uy = nz * bx - nx * bz, uz = nx * by - ny * bx;
    const ox = px + nx * 0.035, oy = py + ny * 0.035, oz = pz + nz * 0.035;
    let occ = 0, wsum = 0;
    // which occluder contains this vertex? skip it (self shadowing of thin parts)
    const gi = Math.floor(px / grid.cell), gj = Math.floor(py / grid.cell), gk = Math.floor(pz / grid.cell);
    const here = grid.map.get(grid.key(gi, gj, gk));
    let selfIdx = -1;
    if (here) {
      for (const bi of here) {
        const b = mesh.occluders[bi];
        if (px > b.mn[0] + 0.02 && px < b.mx[0] - 0.02 && py > b.mn[1] + 0.02 && py < b.mx[1] - 0.02 && pz > b.mn[2] + 0.02 && pz < b.mx[2] - 0.02) { selfIdx = bi; break; }
      }
    }
    for (let r = 0; r < rays; r++) {
      const dir = HEMI[r % HEMI.length];
      const dx = dir[0] * bx + dir[1] * ux + dir[2] * nx;
      const dy = dir[0] * by + dir[1] * uy + dir[2] * ny;
      const dz = dir[0] * bz + dir[1] * uz + dir[2] * nz;
      if (dx * nx + dy * ny + dz * nz <= 0.02) continue;
      const w = dir[2];
      wsum += w;
      for (let s = 1; s <= steps; s++) {
        const t = (s / steps) * dist;
        const sx = ox + dx * t, sy = oy + dy * t, sz = oz + dz * t;
        const arr = grid.map.get(grid.key(Math.floor(sx / grid.cell), Math.floor(sy / grid.cell), Math.floor(sz / grid.cell)));
        if (!arr) continue;
        let hit = false;
        for (const bi of arr) {
          if (bi === selfIdx) continue;
          const b = mesh.occluders[bi];
          if (sx > b.mn[0] && sx < b.mx[0] && sy > b.mn[1] && sy < b.mx[1] && sz > b.mn[2] && sz < b.mx[2]) { hit = true; break; }
        }
        if (hit) { occ += w * (1 - (s - 1) / steps); break; }
      }
    }
    const a = wsum > 0 ? 1 - strength * (occ / wsum) : 1;
    VN[i] = Math.max(0.06, Math.min(1, a));
  }
  return mesh;
}

/** vertical grime: bases are darker than tops */
export function bakeGrime(mesh, opts = {}) {
  const P = mesh.pos;
  let zmax = 0.001;
  for (let i = 2; i < P.length; i += 3) if (P[i] > zmax) zmax = P[i];
  const lo = opts.lo ?? 0.76, hi = opts.hi ?? 1.0;
  const pow = opts.pow ?? 0.7;
  for (let i = 0; i < P.length / 3; i++) {
    const t = Math.pow(Math.max(0, Math.min(1, P[i * 3 + 2] / zmax)), pow);
    mesh.tint[i] *= lo + (hi - lo) * t;
  }
  return mesh;
}

// ---------------------------------------------------------------- rasteriser
export function rotMesh(mesh, rot, pivot) {
  const P = mesh.pos;
  const n = P.length / 3;
  const out = new Float64Array(n * 3);
  const cx = pivot ? pivot[0] : 0, cy = pivot ? pivot[1] : 0;
  const c = Math.cos((rot * Math.PI) / 2), s = Math.sin((rot * Math.PI) / 2);
  for (let i = 0; i < n; i++) {
    const x = P[i * 3] - cx, y = P[i * 3 + 1] - cy, z = P[i * 3 + 2];
    out[i * 3] = cx + x * c - y * s;
    out[i * 3 + 1] = cy + x * s + y * c;
    out[i * 3 + 2] = z;
  }
  mesh.faces.forEach((f) => {
    const x = f.n[0], y = f.n[1], z = f.n[2];
    f.rn = [x * c - y * s, x * s + y * c, z];
  });
  return { P: out };
}

// ---------------------------------------------------------------- night lights
// A window or lamp that is switched on at night. Warm interior light dominates,
// with a few cool fluorescent panes and the occasional dark window.
const LIGHT_TINTS = [
  [1.00, 0.78, 0.42], [1.00, 0.72, 0.34], [1.00, 0.86, 0.58],
  [0.86, 0.92, 1.00], [1.00, 0.62, 0.28], [0.78, 0.92, 0.96],
];
let LIGHTS = false;
export function setLightsMode(on) { LIGHTS = !!on; }

function lightColor(mat, wx, wy, wz, mul, n) {
  if (mat.emissive > 0) {
    const k = 0.34 + mat.emissive * 0.7;
    const c = mat.color;
    return [Math.min(0.95, c[0] * k * 1.12), Math.min(0.95, c[1] * k * 1.02), Math.min(0.95, c[2] * k * 0.92)];
  }
  if (mat.pattern === PAT.GLASS) {
    // whole floors tend to be dark or lit together, with a few dark panes inside.
    // Deliberately sparse: a calm skyline reads better than a wall of light.
    const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
    const top = az >= ax && az >= ay;
    const u = ax >= ay ? wy : wx;
    const gu = Math.floor((top ? wx : u) / 0.155), gz = Math.floor((top ? wy : wz) / 0.24);
    const floor = h2(Math.floor(gu / 3), gz, 91);
    if (floor < 0.74) return null;                 // dark floor
    if (h2(gu, gz, 31) < 0.42) return null;        // dark window inside a lit floor
    const t = LIGHT_TINTS[(h2(gu, gz, 77) * LIGHT_TINTS.length) | 0];
    const k = (0.20 + 0.17 * h2(gu, gz, 53)) * mul;
    return [t[0] * k, t[1] * k, t[2] * k];
  }
  return null;
}

/** separable box blur used to bake a soft glow around night lights */
function blurAdd(buf, w, h, radius, weight) {
  const tmp = new Float32Array(buf.length);
  const tmp2 = new Float32Array(buf.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let d = -radius; d <= radius; d++) {
        const xx = x + d;
        if (xx < 0 || xx >= w) continue;
        const i = (y * w + xx) * 4;
        r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3]; n++;
      }
      const o = (y * w + x) * 4;
      tmp[o] = r / n; tmp[o + 1] = g / n; tmp[o + 2] = b / n; tmp[o + 3] = a / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let d = -radius; d <= radius; d++) {
        const yy = y + d;
        if (yy < 0 || yy >= h) continue;
        const i = (yy * w + x) * 4;
        r += tmp[i]; g += tmp[i + 1]; b += tmp[i + 2]; a += tmp[i + 3]; n++;
      }
      const o = (y * w + x) * 4;
      tmp2[o] = r / n; tmp2[o + 1] = g / n; tmp2[o + 2] = b / n; tmp2[o + 3] = a / n;
    }
  }
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] += tmp2[i] * weight;
    buf[i + 1] += tmp2[i + 1] * weight;
    buf[i + 2] += tmp2[i + 2] * weight;
    buf[i + 3] = Math.min(1, buf[i + 3] + tmp2[i + 3] * weight * 1.15);
  }
}

/**
 * Per-vertex averaged normals, rotated with the model — used for "detail" faces
 * (foliage, canopies) so a moving light reads them as rounded blobs.
 * Cached per rotation on the mesh.
 */
function detailNormals(mesh, rot) {
  if (!mesh._vnrm) mesh._vnrm = new Map();
  const hit = mesh._vnrm.get(rot);
  if (hit) return hit;
  const n = mesh.pos.length / 3;
  const vn = new Float32Array(n * 3);
  for (const f of mesh.faces) {
    for (const vi of f.v) { vn[vi * 3] += f.n[0]; vn[vi * 3 + 1] += f.n[1]; vn[vi * 3 + 2] += f.n[2]; }
  }
  const c = Math.cos((rot * Math.PI) / 2), s = Math.sin((rot * Math.PI) / 2);
  for (let i = 0; i < n; i++) {
    let x = vn[i * 3], y = vn[i * 3 + 1], z = vn[i * 3 + 2];
    const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
    vn[i * 3] = x * c - y * s; vn[i * 3 + 1] = x * s + y * c; vn[i * 3 + 2] = z;
  }
  mesh._vnrm.set(rot, vn);
  return vn;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const byte = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * Resolve the supersampled AOV buffers into atlas-ready 8-bit images.
 *   albedo : RGB = unlit material colour (display space), A = coverage
 *   nrm    : RGB = world-space normal,                    A = surface height
 *   mat    : R = AO(7bit)|detail(1bit), G = specular, B = emissive, A = face-group id
 * Returns per-sprite height range so the consumer can de-normalise `nrm.a`.
 */
function resolveAOV(st) {
  const { W, H, ss, w, h, ab, zb, gid, detail, aLb, aNr, aMt, aHz } = st;
  const albedo = new Uint8Array(w * h * 4);
  const nrm = new Uint8Array(w * h * 4);
  const mat = new Uint8Array(w * h * 4);
  const cov = new Uint8Array(w * h);
  const hraw = new Float32Array(w * h);
  const best = new Int32Array(w * h).fill(-1);
  const flags = new Uint8Array(w * h);
  const aoraw = new Float32Array(w * h);
  const spraw = new Float32Array(w * h);
  const emraw = new Float32Array(w * h);
  const gidSet = new Set();
  let z0 = Infinity, z1 = -Infinity;
  const inv = 1 / (ss * ss);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * w + x;
      let r = 0, g = 0, b = 0, nx = 0, ny = 0, nz = 0, ao = 0, sp = 0, em = 0, hz = 0, a = 0;
      let bestZ = -1e9, bestGid = -1, bestDet = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const di = (y * ss + sy) * W + (x * ss + sx);
          if (ab[di] <= 0) continue;
          a++;
          r += aLb[di * 3]; g += aLb[di * 3 + 1]; b += aLb[di * 3 + 2];
          nx += aNr[di * 3]; ny += aNr[di * 3 + 1]; nz += aNr[di * 3 + 2];
          ao += aMt[di * 4]; sp += aMt[di * 4 + 1]; em += aMt[di * 4 + 2];
          hz += aHz[di];
          if (zb[di] > bestZ) { bestZ = zb[di]; bestGid = gid[di]; bestDet = detail[di]; }
        }
      }
      if (a <= 0) { nrm[o * 4] = 128; nrm[o * 4 + 1] = 128; nrm[o * 4 + 2] = 255; continue; }
      const nl = Math.hypot(nx, ny, nz) || 1;
      albedo[o * 4] = byte((r / a) * 255);
      albedo[o * 4 + 1] = byte((g / a) * 255);
      albedo[o * 4 + 2] = byte((b / a) * 255);
      albedo[o * 4 + 3] = byte(Math.min(1, a * inv * 1.06) * 255);
      nrm[o * 4] = byte((nx / nl * 0.5 + 0.5) * 255);
      nrm[o * 4 + 1] = byte((ny / nl * 0.5 + 0.5) * 255);
      nrm[o * 4 + 2] = byte((nz / nl * 0.5 + 0.5) * 255);
      aoraw[o] = ao / a; spraw[o] = sp / a; emraw[o] = em / a;
      hraw[o] = hz / a;
      best[o] = bestGid;
      flags[o] = bestDet;
      cov[o] = albedo[o * 4 + 3];
      if (bestGid >= 0) gidSet.add(bestGid);
      if (hraw[o] < z0) z0 = hraw[o];
      if (hraw[o] > z1) z1 = hraw[o];
    }
  }
  if (!isFinite(z0)) { z0 = 0; z1 = 1; }
  if (z1 - z0 < 1e-4) z1 = z0 + 1e-4;
  // local face-group ids: any injective-enough numbering works for the outline pass
  const gidMap = new Map();
  let next = 1;
  for (const gv of gidSet) { gidMap.set(gv, next < 255 ? next++ : 255); }
  const invZ = 1 / (z1 - z0);
  for (let o = 0; o < w * h; o++) {
    mat[o * 4] = byte(clamp01(aoraw[o]) * 127) | (flags[o] ? 128 : 0);
    mat[o * 4 + 1] = byte(clamp01(spraw[o]) * 255);
    mat[o * 4 + 2] = byte(clamp01(emraw[o]) * 255);
    mat[o * 4 + 3] = cov[o] > 0 ? (gidMap.get(best[o]) || 1) : 0;
    nrm[o * 4 + 3] = cov[o] > 0 ? byte(clamp01((hraw[o] - z0) * invZ) * 255) : 0;
  }
  // ---- dilate colour/normal/material 2px into transparent neighbours so nearest
  // sampling never picks up a black halo at the sprite border
  const filled = new Uint8Array(w * h);
  for (let o = 0; o < w * h; o++) filled[o] = cov[o] > 0 ? 1 : 0;
  for (let pass = 0; pass < 2; pass++) {
    const srcA = albedo.slice(), srcN = nrm.slice(), srcM = mat.slice(), srcF = filled.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = y * w + x;
        if (srcF[o]) continue;
        let from = -1;
        if (x > 0 && srcF[o - 1]) from = o - 1;
        else if (x < w - 1 && srcF[o + 1]) from = o + 1;
        else if (y > 0 && srcF[o - w]) from = o - w;
        else if (y < h - 1 && srcF[o + w]) from = o + w;
        if (from < 0) continue;
        for (let k = 0; k < 3; k++) {
          albedo[o * 4 + k] = srcA[from * 4 + k];
          nrm[o * 4 + k] = srcN[from * 4 + k];
        }
        nrm[o * 4 + 3] = srcN[from * 4 + 3];
        for (let k = 0; k < 4; k++) mat[o * 4 + k] = srcM[from * 4 + k];
        filled[o] = 1;
      }
    }
  }
  return { albedo, nrm, mat, z0, z1 };
}

/**
 * Top-down height stamp for the runtime shadow caster: the model rendered
 * orthographically from above into a small image, keeping the topmost surface
 * height per cell (world y up, 8 px per world unit by default).
 *
 *   R = surface height / ZSCALE   G = coverage   B/A = 0
 *
 * The stamp is world-space, so one atlas serves every zoom level.
 * @returns {{w,h,buf,x0,y0,ppc,zScale}} x0/y0 are the stamp's world origin
 *          relative to the sprite anchor (the same pivot the sprite uses).
 */
export function renderTopStamp(mesh, opts = {}) {
  const rot = opts.rotation || 0;
  const PPC = opts.ppc || 8;
  const anchor = opts.anchor || [0, 0, 0];
  const { P } = rotMesh(mesh, rot, anchor);
  const nv = P.length / 3;
  let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
  for (let i = 0; i < nv; i++) {
    const x = P[i * 3], y = P[i * 3 + 1];
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
  }
  if (!isFinite(minx)) return null;
  const pad = opts.pad ?? 0.5;
  const x0 = minx - pad, y0 = miny - pad;
  const w = Math.max(1, Math.ceil((maxx + pad - x0) * PPC));
  const h = Math.max(1, Math.ceil((maxy + pad - y0) * PPC));
  const zScale = opts.zScale || 8;             // world units covered by the 0..255 range
  const zbuf = new Float32Array(w * h).fill(-1e9);
  const cov = new Uint8Array(w * h);
  for (const f of mesh.faces) {
    const v = f.v;
    for (let i = 1; i < v.length - 1; i++) {
      const ia = v[0], ib = v[i], ic = v[i + 1];
      const ax = (P[ia * 3] - x0) * PPC, ay = (P[ia * 3 + 1] - y0) * PPC;
      const bx = (P[ib * 3] - x0) * PPC, by = (P[ib * 3 + 1] - y0) * PPC;
      const cx = (P[ic * 3] - x0) * PPC, cy = (P[ic * 3 + 1] - y0) * PPC;
      const bminx = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const bmaxx = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
      const bminy = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const bmaxy = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
      if (bminx > bmaxx || bminy > bmaxy) continue;
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-9) continue;
      const inv = 1 / area;
      for (let py = bminy; py <= bmaxy; py++) {
        for (let px = bminx; px <= bmaxx; px++) {
          const fx = px + 0.5, fy = py + 0.5;
          const w0 = ((bx - fx) * (cy - fy) - (by - fy) * (cx - fx)) * inv;
          const w1 = ((cx - fx) * (ay - fy) - (cy - fy) * (ax - fx)) * inv;
          const w2 = 1 - w0 - w1;
          if (w0 < -0.001 || w1 < -0.001 || w2 < -0.001) continue;
          const z = P[ia * 3 + 2] * w0 + P[ib * 3 + 2] * w1 + P[ic * 3 + 2] * w2;
          const di = py * w + px;
          if (z > zbuf[di]) { zbuf[di] = z; cov[di] = 1; }
        }
      }
    }
  }
  const buf = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (!cov[i]) continue;
    const v = Math.max(0, Math.min(255, Math.round((zbuf[i] / zScale) * 255)));
    buf[i * 4] = v;
    buf[i * 4 + 1] = 255;
    // alpha MUST be opaque: the runtime reads this atlas back through a 2D
    // canvas (drawImage + getImageData), which premultiplies and would destroy
    // the height stored in RGB for any transparent texel.
    buf[i * 4 + 3] = 255;
  }
  return { w, h, buf, x0, y0, ppc: PPC, zScale };
}

/**
 * Render one sprite.
 * @returns {{w,h,anchorX,anchorY,rgba:Float32Array,lines:Int32Array,shadow:{w,h,anchorX,anchorY,alpha:Float32Array}}}
 */
export function renderSprite(mesh, opts = {}) {
  const rot = opts.rotation || 0;
  const ss = opts.ss || 2;
  const pad = opts.pad ?? 3;
  const anchor = opts.anchor || [0, 0, 0];
  const { P } = rotMesh(mesh, rot, anchor);
  const nv = P.length / 3;
  // screen positions relative to the anchor
  const A = project(anchor[0], anchor[1], anchor[2]);
  const SX = new Float64Array(nv), SY = new Float64Array(nv);
  let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
  for (let i = 0; i < nv; i++) {
    const p = project(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    SX[i] = p[0] - A[0]; SY[i] = p[1] - A[1];
    if (SX[i] < minx) minx = SX[i];
    if (SX[i] > maxx) maxx = SX[i];
    if (SY[i] < miny) miny = SY[i];
    if (SY[i] > maxy) maxy = SY[i];
  }
  const x0 = Math.floor(minx) - pad, y0 = Math.floor(miny) - pad;
  const w = Math.ceil(maxx) + pad - x0 + 1, h = Math.ceil(maxy) + pad - y0 + 1;
  const W = w * ss, H = h * ss;
  const cb = new Float32Array(W * H * 3);
  const ab = new Float32Array(W * H);
  const zb = new Float32Array(W * H).fill(-1e9);
  const gid = new Int32Array(W * H).fill(-1);
  const detail = new Uint8Array(W * H);
  // ---- v4 AOV buffers: unlit albedo, world normal, material params, surface height.
  // Allocated only when the caller asks for them, so the legacy path stays untouched.
  const AOV = !!opts.aov && !LIGHTS;
  const aLb = AOV ? new Float32Array(W * H * 3) : null;
  const aNr = AOV ? new Float32Array(W * H * 3) : null;
  const aMt = AOV ? new Float32Array(W * H * 4) : null;
  const aHz = AOV ? new Float32Array(W * H) : null;

  const tris = [];
  for (const f of mesh.faces) {
    const v = f.v;
    for (let i = 1; i < v.length - 1; i++) tris.push([v[0], v[i], v[i + 1], f]);
  }
  const MATS = opts.mats;
  for (const [ia, ib, ic, f] of tris) {
    const ax = SX[ia] * ss - x0 * ss, ay = SY[ia] * ss - y0 * ss;
    const bx = SX[ib] * ss - x0 * ss, by = SY[ib] * ss - y0 * ss;
    const cx2 = SX[ic] * ss - x0 * ss, cy2 = SY[ic] * ss - y0 * ss;
    let bminx = Math.max(0, Math.floor(Math.min(ax, bx, cx2)));
    let bmaxx = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx2)));
    let bminy = Math.max(0, Math.floor(Math.min(ay, by, cy2)));
    let bmaxy = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy2)));
    if (bminx > bmaxx || bminy > bmaxy) continue;
    const area = (bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax);
    if (Math.abs(area) < 1e-9) continue;
    const inv = 1 / area;
    const mat = MAT_LIST[f.m];
    const base = mat.color;
    const nx = f.rn[0], ny = f.rn[1], nz = f.rn[2];
    const nrmIn = [nx, ny, nz];
    const bumpK = BUMP_ON ? (mat.bump || 0) : 0;
    const specK = mat.spec;
    const pz0 = P[ia * 3 + 2], pz1 = P[ib * 3 + 2], pz2 = P[ic * 3 + 2];
    const ao0 = mesh.ao[ia], ao1 = mesh.ao[ib], ao2 = mesh.ao[ic];
    const t0 = mesh.tint[ia], t1 = mesh.tint[ib], t2 = mesh.tint[ic];
    const emis = mat.emissive;
    // smooth (per-vertex averaged) normals for "detail" faces such as foliage,
    // so leaves read as rounded blobs under a moving light instead of flat facets
    const vnrm = AOV && f.detail ? detailNormals(mesh, rot) : null;
    for (let py = bminy; py <= bmaxy; py++) {
      const fy = py + 0.5;
      for (let px = bminx; px <= bmaxx; px++) {
        const fx = px + 0.5;
        const w0 = ((bx - fx) * (cy2 - fy) - (by - fy) * (cx2 - fx)) * inv;
        const w1 = ((cx2 - fx) * (ay - fy) - (cy2 - fy) * (ax - fx)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const wx = P[ia * 3] * w0 + P[ib * 3] * w1 + P[ic * 3] * w2;
        const wy = P[ia * 3 + 1] * w0 + P[ib * 3 + 1] * w1 + P[ic * 3 + 1] * w2;
        const wz = pz0 * w0 + pz1 * w1 + pz2 * w2;
        const dz = depthOf(wx, wy, wz);
        const di = py * W + px;
        if (dz <= zb[di]) continue;
        zb[di] = dz;
        const ao = ao0 * w0 + ao1 * w1 + ao2 * w2;
        const tn = t0 * w0 + t1 * w1 + t2 * w2;
        const mul = mat.pattern ? patternMul(mat.pattern, wx, wy, wz, nrmIn) : 1;
        // ---- effective shading normal
        // geometric normal, optionally averaged per-vertex (foliage reads as a
        // rounded blob instead of flat facets), then perturbed by the gradient
        // of the procedural pattern so the surface has real relief under a
        // moving light.
        let snx = nx, sny = ny, snz = nz;
        if (vnrm) {
          snx = vnrm[ia * 3] * w0 + vnrm[ib * 3] * w1 + vnrm[ic * 3] * w2;
          sny = vnrm[ia * 3 + 1] * w0 + vnrm[ib * 3 + 1] * w1 + vnrm[ic * 3 + 1] * w2;
          snz = vnrm[ia * 3 + 2] * w0 + vnrm[ib * 3 + 2] * w1 + vnrm[ic * 3 + 2] * w2;
          const sl = Math.hypot(snx, sny, snz) || 1;
          snx /= sl; sny /= sl; snz /= sl;
        }
        if (bumpK > 0 && mat.pattern) {
          const bn = bumpNormal(mat.pattern, wx, wy, wz, [snx, sny, snz], bumpK);
          if (bn) { snx = bn[0]; sny = bn[1]; snz = bn[2]; }
        }
        if (LIGHTS) {
          // night pass: keep only self-luminous pixels, everything else stays clear
          const lc = lightColor(mat, wx, wy, wz, mul, nrmIn);
          if (!lc) continue;
          cb[di * 3] = lc[0]; cb[di * 3 + 1] = lc[1]; cb[di * 3 + 2] = lc[2];
          ab[di] = 1;
          gid[di] = f.gid;
          detail[di] = f.detail ? 1 : 0;
          continue;
        }
        const ndl = Math.max(0, snx * SUN[0] + sny * SUN[1] + snz * SUN[2]);
        const ndh = Math.max(0, snx * HALF[0] + sny * HALF[1] + snz * HALF[2]);
        const spec = specK > 0 ? specK * Math.pow(ndh, 26) : 0;
        const sky = 0.5 + 0.5 * snz;
        // linear-ish lighting (gamma 2 approximation keeps this cheap)
        const bl0 = base[0] * mul * tn, bl1 = base[1] * mul * tn, bl2 = base[2] * mul * tn;
        const amb = (0.235 + 0.31 * sky) * (0.28 + 0.72 * ao) + 0.032;
        const dif = ndl * (0.30 + 0.70 * ao);
        let r = bl0 * bl0 * (amb * SKY_TINT[0] + dif * SUN_TINT[0]) + spec * 0.9 + bl0 * emis;
        let g = bl1 * bl1 * (amb * SKY_TINT[1] + dif * SUN_TINT[1]) + spec * 0.92 + bl1 * emis;
        let b = bl2 * bl2 * (amb * SKY_TINT[2] + dif * SUN_TINT[2]) + spec * 1.0 + bl2 * emis;
        r = r < 0 ? 0 : r; g = g < 0 ? 0 : g; b = b < 0 ? 0 : b;
        cb[di * 3] = r; cb[di * 3 + 1] = g; cb[di * 3 + 2] = b;
        ab[di] = 1;
        gid[di] = f.gid;
        detail[di] = f.detail ? 1 : 0;
        if (AOV) {
          aLb[di * 3] = bl0; aLb[di * 3 + 1] = bl1; aLb[di * 3 + 2] = bl2;
          aNr[di * 3] = snx; aNr[di * 3 + 1] = sny; aNr[di * 3 + 2] = snz;
          aMt[di * 4] = ao; aMt[di * 4 + 1] = specK; aMt[di * 4 + 2] = emis; aMt[di * 4 + 3] = f.gid;
          aHz[di] = wz;
        }
      }
    }
  }

  // ---- supersample resolve (alpha weighted)
  const rgba = new Float32Array(w * h * 4);
  const lines = new Int32Array(w * h).fill(-1);
  const detailMap = new Uint8Array(w * h);
  const inv = 1 / (ss * ss);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, bestZ = -1e9, bestGid = -1, bestDet = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const di = (y * ss + sy) * W + (x * ss + sx);
          const al = ab[di];
          if (al > 0) {
            r += cb[di * 3]; g += cb[di * 3 + 1]; b += cb[di * 3 + 2];
            a += al;
            if (zb[di] > bestZ) { bestZ = zb[di]; bestGid = gid[di]; bestDet = detail[di]; }
          }
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        const cov = a * inv;
        if (LIGHTS) {
          // lights keep additive HDR values: no gamma, no clamp to 1
          rgba[o] = r / a; rgba[o + 1] = g / a; rgba[o + 2] = b / a;
          rgba[o + 3] = Math.min(1, cov * 1.1);
        } else {
          rgba[o] = Math.sqrt(r / a); rgba[o + 1] = Math.sqrt(g / a); rgba[o + 2] = Math.sqrt(b / a);
          rgba[o + 3] = Math.min(1, cov * 1.06);
        }
        lines[y * w + x] = bestGid;
        detailMap[y * w + x] = bestDet;
      } else {
        rgba[o + 3] = 0;
      }
    }
  }

  // ---- night lights: bake a soft glow around every lamp / lit window
  if (LIGHTS) {
    blurAdd(rgba, w, h, 1, 0.22);
    blurAdd(rgba, w, h, 3, 0.12);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = Math.min(1.0, rgba[i]);
      rgba[i + 1] = Math.min(1.0, rgba[i + 1]);
      rgba[i + 2] = Math.min(1.0, rgba[i + 2]);
    }
    return { w, h, anchorX: -x0, anchorY: -y0, rgba, lines, aov: null, shadow: null };
  }

  // ---- pre-rendered edge lines (creases + silhouettes)
  // Applied to the shaded sprite (which feeds the UI thumbnails and card art).
  // The AOV albedo stays un-outlined: v4 draws the outline in the screen-space
  // pass instead, where it can be tuned at runtime.
  const aov = AOV ? resolveAOV({ W, H, ss, w, h, ab, zb, gid, detail, aLb, aNr, aMt, aHz }) : null;
  if (opts.outline !== false) {
    const kk = typeof opts.outline === 'number' ? opts.outline : 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (rgba[i * 4 + 3] <= 0) continue;
        const me = lines[i], myDetail = detailMap[i];
        let f = 1;
        for (let d = 0; d < 4; d++) {
          let ni;
          if (d === 0) ni = x > 0 ? i - 1 : -1;
          else if (d === 1) ni = x < w - 1 ? i + 1 : -1;
          else if (d === 2) ni = y > 0 ? i - w : -1;
          else ni = y < h - 1 ? i + w : -1;
          if (ni < 0) { if (f > 0.60) f = 0.60; continue; }
          const other = lines[ni];
          if (other === me) continue;
          const soft = myDetail || detailMap[ni];
          const dark = other === -1 ? 0.66 : (soft ? 0.90 : 0.74);
          if (dark < f) f = dark;
        }
        if (f < 1) {
          const amt = 1 - (1 - f) * kk;
          rgba[i * 4] *= amt; rgba[i * 4 + 1] *= amt; rgba[i * 4 + 2] *= amt;
        }
      }
    }
  }

  return { w, h, anchorX: -x0, anchorY: -y0, rgba, lines, aov, shadow: renderShadow(mesh, { rotation: rot, ss: Math.min(ss, 2), pad, anchor }) };
}

/** Project the mesh along -SUN onto the ground plane and accumulate coverage. */
export function renderShadow(mesh, opts = {}) {
  const rot = opts.rotation ?? opts.rot ?? 0;
  const ss = opts.ss || 2;
  const pad = opts.pad ?? 3;
  const anchor = opts.anchor || [0, 0, 0];
  const { P } = rotMesh(mesh, rot, anchor);
  const nv = P.length / 3;
  const A = project(anchor[0], anchor[1], anchor[2]);
  // shadow vertices on z = 0
  const SP = new Float64Array(nv * 2);
  let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
  for (let i = 0; i < nv; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const t = z / SUN[2];
    const sxw = x - SUN[0] * t, syw = y - SUN[1] * t;
    const p = project(sxw, syw, 0);
    const sx = p[0] - A[0], sy = p[1] - A[1];
    SP[i * 2] = sx; SP[i * 2 + 1] = sy;
    if (sx < minx) minx = sx;
    if (sx > maxx) maxx = sx;
    if (sy < miny) miny = sy;
    if (sy > maxy) maxy = sy;
  }
  const x0 = Math.floor(minx) - pad, y0 = Math.floor(miny) - pad;
  const w = Math.ceil(maxx) + pad - x0 + 1, h = Math.ceil(maxy) + pad - y0 + 1;
  if (w <= 0 || h <= 0 || !isFinite(w) || !isFinite(h)) return null;
  const W = w * ss, H = h * ss;
  const cov = new Float32Array(W * H);
  for (const f of mesh.faces) {
    const v = f.v;
    for (let i = 1; i < v.length - 1; i++) {
      const ia = v[0], ib = v[i], ic = v[i + 1];
      const ax = (SP[ia * 2] - x0) * ss, ay = (SP[ia * 2 + 1] - y0) * ss;
      const bx = (SP[ib * 2] - x0) * ss, by = (SP[ib * 2 + 1] - y0) * ss;
      const cx2 = (SP[ic * 2] - x0) * ss, cy2 = (SP[ic * 2 + 1] - y0) * ss;
      const bminx = Math.max(0, Math.floor(Math.min(ax, bx, cx2)));
      const bmaxx = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx2)));
      const bminy = Math.max(0, Math.floor(Math.min(ay, by, cy2)));
      const bmaxy = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy2)));
      if (bminx > bmaxx || bminy > bmaxy) continue;
      const area = (bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax);
      if (Math.abs(area) < 1e-9) continue;
      const inv = 1 / area;
      for (let py = bminy; py <= bmaxy; py++) {
        for (let px = bminx; px <= bmaxx; px++) {
          const fx = px + 0.5, fy = py + 0.5;
          const w0 = ((bx - fx) * (cy2 - fy) - (by - fy) * (cx2 - fx)) * inv;
          const w1 = ((cx2 - fx) * (ay - fy) - (cy2 - fy) * (ax - fx)) * inv;
          const w2 = 1 - w0 - w1;
          if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
          const di = py * W + px;
          if (cov[di] < 1) cov[di] = Math.min(1, cov[di] + 0.34);
        }
      }
    }
  }
  // resolve + slight blur so the contact shadow reads as soft
  const alpha = new Float32Array(w * h);
  const inv2 = 1 / (ss * ss);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) s += cov[(y * ss + sy) * W + (x * ss + sx)];
      alpha[y * w + x] = Math.min(1, s * inv2 * 1.25);
    }
  }
  const blurred = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, wsum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ww = dx === 0 && dy === 0 ? 3 : 1;
        s += alpha[ny * w + nx] * ww; wsum += ww;
      }
      blurred[y * w + x] = Math.pow(Math.min(1, s / wsum), 0.85) * 0.9;
    }
  }
  return { w, h, anchorX: -x0, anchorY: -y0, alpha: blurred };
}
