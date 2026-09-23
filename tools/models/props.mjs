// Prop & tree kit — everything that stands on a farm tile that is not a crop.
//
// These are pre-rendered once and then reused across the whole map, so they are
// modelled denser than the crops: a barrel gets staves and iron hoops, a well
// gets a stone ring, two posts, a crossbeam, a rope and a bucket, a scarecrow
// gets a cross frame, straw hands and a patched shirt.
//
// Scale reminders (1 tile = 32x16 px, 1 world unit = 16 px across, 1 z-unit =
// 22 px up): a person is ~1.25 units, a cottage wall ~1.4, a mature tree 2.4-3.2.
// The camera looks from +x +y, so anything that must read (a gate latch, a tap,
// a lamp lens) goes on a +x or +y face, never on -x / -y.
//
// Nothing thinner than ~0.05 units (~1 px) survives the resolve, with the
// deliberate exceptions of ropes, twine and clotheslines, which are meant to be
// hairlines and are given 0.03-0.06 units so they dither rather than vanish.
//
// All randomness is `b.rng()`, seeded per descriptor — never Math.random().

import { Builder } from '../lib/geom.mjs';
import { M } from '../lib/materials.mjs';

// The harness constructs the Builder and passes it into `build(b)`.
void Builder;

const TAU = Math.PI * 2;
const nrm = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

/** Angled tapered prism. Roots, branches, ropes, handles, cobs, spokes. */
function tube(b, p0, p1, r0, r1, sides, mat, o = {}) {
  const d = nrm(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  const ref = Math.abs(d[2]) < 0.92 ? [0, 0, 1] : [1, 0, 0];
  const u = nrm(d[1] * ref[2] - d[2] * ref[1], d[2] * ref[0] - d[0] * ref[2], d[0] * ref[1] - d[1] * ref[0]);
  const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const ring = (p, r) => {
    const out = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      out.push([p[0] + (u[0] * ca + v[0] * sa) * r, p[1] + (u[1] * ca + v[1] * sa) * r, p[2] + (u[2] * ca + v[2] * sa) * r]);
    }
    return out;
  };
  const A = ring(p0, r0), B = ring(p1, r1);
  const gid = b.m.newGid();
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const mx = (A[i][0] + A[j][0]) * 0.5 - p0[0], my = (A[i][1] + A[j][1]) * 0.5 - p0[1], mz = (A[i][2] + A[j][2]) * 0.5 - p0[2];
    b.m.quad(A[i], A[j], B[j], B[i], mat, nrm(mx, my, mz), { gid });
  }
  if (o.cap) b.fan(B, o.capMat === undefined ? mat : o.capMat, d, true, { gid: b.m.newGid() });
  if (o.cap0) b.fan(A, o.capMat === undefined ? mat : o.capMat, [-d[0], -d[1], -d[2]], false, { gid: b.m.newGid() });
  if (o.occ !== false) {
    const r = Math.max(r0, r1);
    b.m.occluders.push({
      mn: [Math.min(p0[0], p1[0]) - r, Math.min(p0[1], p1[1]) - r, Math.min(p0[2], p1[2]) - r],
      mx: [Math.max(p0[0], p1[0]) + r, Math.max(p0[1], p1[1]) + r, Math.max(p0[2], p1[2]) + r],
    });
  }
}

/** Vertical revolve. Barrels, buckets, pots, sacks, skeps, bins. */
function lathe(b, cx, cy, profile, sides, mat, o = {}) {
  const rot = o.rot || 0;
  const P = profile.map(([z, r]) => {
    const row = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * TAU + rot;
      row.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, z]);
    }
    return row;
  });
  for (let j = 0; j < profile.length - 1; j++) {
    const dr = profile[j + 1][1] - profile[j][1], dz = profile[j + 1][0] - profile[j][0];
    const nr = dz, nz = -dr;
    const gid = b.m.newGid();
    for (let i = 0; i < sides; i++) {
      const i2 = (i + 1) % sides;
      const am = ((i + 0.5) / sides) * TAU + rot;
      const m = typeof mat === 'function' ? mat(i, j) : (o.bandMat && o.bandMat[j] !== undefined ? o.bandMat[j] : mat);
      b.m.quad(P[j][i2], P[j][i], P[j + 1][i], P[j + 1][i2], m, nrm(Math.cos(am) * nr, Math.sin(am) * nr, nz), { gid });
    }
  }
  const top = profile[profile.length - 1], bot = profile[0];
  const capMat = o.topMat !== undefined ? o.topMat : (typeof mat === 'function' ? mat(0, profile.length - 2) : mat);
  if (o.top !== false && top[1] > 1e-4) {
    const pts = [];
    for (let i = 0; i < sides; i++) { const a = (i / sides) * TAU + rot; pts.push([cx + Math.cos(a) * top[1], cy + Math.sin(a) * top[1], top[0]]); }
    b.fan(pts, capMat, [0, 0, 1], true, { gid: b.m.newGid() });
  }
  if (o.bottom && bot[1] > 1e-4) {
    const pts = [];
    for (let i = 0; i < sides; i++) { const a = (i / sides) * TAU + rot; pts.push([cx + Math.cos(a) * bot[1], cy + Math.sin(a) * bot[1], bot[0]]); }
    b.fan(pts, capMat, [0, 0, -1], false, { gid: b.m.newGid() });
  }
  let mr = 0;
  for (const p of profile) if (p[1] > mr) mr = p[1];
  if (o.occ !== false) b.m.occluders.push({ mn: [cx - mr, cy - mr, bot[0]], mx: [cx + mr, cy + mr, top[0]] });
}

/** Cone with correctly tilted normals (a `cylinder` with rTop:0 shades wrong). */
function cone(b, cx, cy, z0, z1, r, sides, mat, o = {}) {
  const h = z1 - z0;
  const rr = Math.hypot(h, r) || 1;
  const nr = h / rr, nz = r / rr;
  const rot = o.rot || 0;
  const gid = b.m.newGid();
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * TAU + rot;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, z0]);
  }
  const apex = [cx, cy, z1];
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const am = ((i + 0.5) / sides) * TAU + rot;
    b.m.quad(pts[j], pts[i], apex, apex, typeof mat === 'function' ? mat(i) : mat, nrm(Math.cos(am) * nr, Math.sin(am) * nr, nz), { gid });
  }
  if (o.bottom) b.fan(pts, typeof mat === 'function' ? mat(0) : mat, [0, 0, -1], false, { gid: b.m.newGid() });
  if (o.occ !== false) b.m.occluders.push({ mn: [cx - r, cy - r, z0], mx: [cx + r, cy + r, z1] });
}

/** Hollow ring wall — the well shaft, a stone kerb. */
function ringWall(b, cx, cy, z0, z1, rOut, rIn, sides, mat, o = {}) {
  const rot = o.rot || 0;
  const S = (r, z) => {
    const row = [];
    for (let i = 0; i < sides; i++) { const a = (i / sides) * TAU + rot; row.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, z]); }
    return row;
  };
  const O0 = S(rOut, z0), O1 = S(rOut, z1), I0 = S(rIn, z0), I1 = S(rIn, z1);
  const gOut = b.m.newGid(), gIn = b.m.newGid(), gTop = b.m.newGid();
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const am = ((i + 0.5) / sides) * TAU + rot;
    const m = typeof mat === 'function' ? mat(i) : mat;
    b.m.quad(O0[j], O0[i], O1[i], O1[j], m, [Math.cos(am), Math.sin(am), 0], { gid: gOut });
    b.m.quad(I0[i], I0[j], I1[j], I1[i], m, [-Math.cos(am), -Math.sin(am), 0], { gid: gIn });
    b.m.quad(O1[j], O1[i], I1[i], I1[j], m, [0, 0, 1], { gid: gTop });
  }
  if (o.occ !== false) b.m.occluders.push({ mn: [cx - rOut, cy - rOut, z0], mx: [cx + rOut, cy + rOut, z1] });
}

/** Lumpy rock body. Faceted on purpose — the facets read as stone at 1 tile. */
function blob(b, cx, cy, r, h, mat, o = {}) {
  const seg = o.seg || 7, rings = o.rings || 3, jit = o.jit === undefined ? 0.26 : o.jit;
  const P = [];
  for (let j = 0; j <= rings; j++) {
    const t = j / rings;
    const rr = r * Math.cos((t * Math.PI) / 2) * (1 + (b.rng() - 0.5) * jit * (1 - t) * 1.6);
    const zz = 0.002 + h * Math.sin((t * Math.PI) / 2);
    const row = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * TAU + (o.rot || 0);
      const k = 1 + (b.rng() - 0.5) * jit * (1.25 - t);
      row.push([cx + Math.cos(a) * rr * k, cy + Math.sin(a) * rr * k, zz]);
    }
    P.push(row);
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const i2 = (i + 1) % seg;
      const a = P[j][i], bb = P[j][i2], c = P[j + 1][i2], d = P[j + 1][i];
      b.m.quad(bb, a, d, c, typeof mat === 'function' ? mat(i, j) : mat,
        nrm((a[0] + c[0]) * 0.5 - cx, (a[1] + c[1]) * 0.5 - cy, (a[2] + c[2]) * 0.5 - h * 0.42));
    }
  }
  if (o.occ !== false) b.m.occluders.push({ mn: [cx - r, cy - r, 0], mx: [cx + r, cy + r, h] });
}

/** Rounded (barrel) top spanning x0..x1, arcing over y0..y1. */
function vault(b, x0, x1, y0, y1, z0, h, mat, o = {}) {
  const seg = o.seg || 4;
  const yc = (y0 + y1) / 2, ry = (y1 - y0) / 2;
  const pts = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI;
    pts.push([yc - Math.cos(a) * ry, z0 + Math.sin(a) * h, -Math.cos(a), Math.sin(a)]);
  }
  for (let i = 0; i < seg; i++) {
    const A = pts[i], B = pts[i + 1];
    const n = nrm(0, (A[2] + B[2]) * 0.5, (A[3] + B[3]) * 0.5 + 0.7);
    b.m.quad([x0, A[0], A[1]], [x1, A[0], A[1]], [x1, B[0], B[1]], [x0, B[0], B[1]], mat, n);
  }
  for (const x of [x0, x1]) {
    const n = [x === x0 ? -1 : 1, 0, 0];
    for (let i = 0; i < seg; i++) {
      b.m.tri([x, pts[i][0], pts[i][1]], [x, pts[i + 1][0], pts[i + 1][1]], [x, yc, z0], mat, n);
    }
  }
}

/** Root flare at the base of a trunk. */
function roots(b, x, y, r0, len, mat, n = 4) {
  for (let i = 0; i < n; i++) {
    const a = i * (TAU / n) + 0.6;
    tube(b, [x + Math.cos(a) * r0 * 0.45, y + Math.sin(a) * r0 * 0.45, 0.17],
      [x + Math.cos(a) * len, y + Math.sin(a) * len, 0.05], r0 * 0.44, 0.038, 5, mat, { occ: false });
  }
}

/** Overlapping domes: a lumpy cloud, never a single sphere. */
function clump(b, cx, cy, cz, R, n, mats, o = {}) {
  const flat = o.flat === undefined ? 0.8 : o.flat;
  for (let i = 0; i < n; i++) {
    const a = i * 2.399963 + (o.a0 || 0);
    const dr = i === 0 ? 0 : R * (0.40 + b.rng() * 0.44);
    const dx = Math.cos(a) * dr, dy = Math.sin(a) * dr;
    const dz = i === 0 ? R * 0.12 : (b.rng() - 0.42) * R * 0.8;
    const rl = i === 0 ? R * 0.82 : R * (0.42 + b.rng() * 0.3);
    const hl = rl * flat * (1.1 + b.rng() * 0.55);
    b.dome(cx + dx, cy + dy, Math.max(0.05, cz + dz - hl * 0.5), rl, hl, mats[i % mats.length],
      { seg: o.seg || 10, rings: o.rings || 3 });
  }
}

/** A few leaf plates poking out of a canopy so its silhouette is not a smooth arc. */
function canopyLeaves(b, cx, cy, cz, R, n, mat, o = {}) {
  for (let i = 0; i < n; i++) {
    const a = i * 2.399963 + (o.a0 || 1.2);
    const el = (b.rng() - 0.35) * 1.1;
    const r = R * (0.86 + b.rng() * 0.2);
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    const z = cz + el * R * 0.8;
    const dir = a + (b.rng() - 0.5) * 0.8;
    const L = R * (0.3 + b.rng() * 0.22);
    b.m.quad(
      [x, y, z],
      [x + Math.cos(dir + 1.4) * L * 0.5, y + Math.sin(dir + 1.4) * L * 0.5, z + L * 0.24],
      [x + Math.cos(dir) * L, y + Math.sin(dir) * L, z + L * 0.38],
      [x + Math.cos(dir - 1.4) * L * 0.5, y + Math.sin(dir - 1.4) * L * 0.5, z + L * 0.24],
      mat, nrm(Math.cos(dir) * 0.35, Math.sin(dir) * 0.35, 1), { detail: 1 });
  }
}

/** Scatter of fallen leaves on the ground plane. */
function litter(b, cx, cy, R, n, mat) {
  for (let i = 0; i < n; i++) {
    const a = i * 2.399963 + 0.9;
    const r = R * (0.35 + 0.65 * (((i * 7) % 5) / 4));
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    const L = 0.075 + 0.03 * (((i * 3) % 4) / 3);
    const d = a + 1.1;
    b.m.quad([x, y, 0.008], [x + Math.cos(d + 1.5) * L, y + Math.sin(d + 1.5) * L, 0.008],
      [x + Math.cos(d) * L * 1.7, y + Math.sin(d) * L * 1.7, 0.008],
      [x + Math.cos(d - 1.5) * L, y + Math.sin(d - 1.5) * L, 0.008], mat, [0, 0, 1], { detail: 1 });
  }
}

// ---------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------

function buildOak(b) {
  const L = M('leaf'), LD = M('leafDk'), LL = M('leafLt'), BK = M('bark');
  const x = 1, y = 1;
  b.cylinder(x, y, 0, 1.32, 0.185, 7, BK, { rTop: 0.13 });
  roots(b, x, y, 0.185, 0.36, M('barkDk'));
  const br = [[0.60, 0.50, 1.98], [-0.56, 0.58, 1.9], [0.26, -0.62, 2.02], [-0.5, -0.46, 1.82], [0.1, 0.62, 1.72]];
  for (const [dx, dy, z] of br) tube(b, [x, y, 1.18], [x + dx, y + dy, z], 0.085, 0.042, 5, BK);
  clump(b, x, y, 2.2, 0.68, 8, [L, LD, LL, L, LD, LL, L, LD], { a0: 0.4, flat: 0.8 });
  canopyLeaves(b, x, y, 2.2, 0.68, 7, LL, { a0: 0.8 });
  canopyLeaves(b, x, y, 2.2, 0.68, 5, LD, { a0: 2.4 });
}

function buildOakSmall(b) {
  const L = M('leaf'), LD = M('leafDk'), LL = M('leafLt'), BK = M('bark');
  b.cylinder(0.5, 0.5, 0, 0.82, 0.115, 6, BK, { rTop: 0.085 });
  roots(b, 0.5, 0.5, 0.115, 0.24, M('barkDk'), 4);
  tube(b, [0.5, 0.5, 0.7], [0.72, 0.68, 1.22], 0.055, 0.03, 5, BK);
  tube(b, [0.5, 0.5, 0.66], [0.28, 0.3, 1.18], 0.055, 0.03, 5, BK);
  clump(b, 0.5, 0.5, 1.32, 0.3, 6, [L, LD, LL, L, LD, LL], { a0: 1.1, flat: 0.78 });
  canopyLeaves(b, 0.5, 0.5, 1.32, 0.3, 5, LL, { a0: 0.4 });
}

function buildBirch(b) {
  const L = M('leaf'), LL = M('leafLt'), LD = M('leafDk'), W = M('woodWhite'), BD = M('barkDk');
  b.cylinder(0.5, 0.5, 0, 1.95, 0.098, 7, W, { rTop: 0.062 });
  roots(b, 0.5, 0.5, 0.098, 0.22, M('barkDk'), 4);
  // bark dashes
  for (let i = 0; i < 5; i++) {
    const z = 0.32 + i * 0.32;
    const a = i * 1.9;
    b.box(0.5 + Math.cos(a) * 0.06 - 0.032, 0.5 + Math.sin(a) * 0.06 - 0.032, z, 0.064, 0.064, 0.04, BD, { occ: false });
  }
  for (let i = 0; i < 3; i++) {
    const a = i * 2.1 + 0.4;
    tube(b, [0.5, 0.5, 1.35], [0.5 + Math.cos(a) * 0.4, 0.5 + Math.sin(a) * 0.4, 2.3 - i * 0.08], 0.052, 0.026, 5, W);
  }
  clump(b, 0.5, 0.5, 2.24, 0.44, 7, [LL, L, LL, LD, L, LL, L], { a0: 0.7, flat: 1.05 });
  canopyLeaves(b, 0.5, 0.5, 2.24, 0.33, 7, LL, { a0: 1.7 });
  canopyLeaves(b, 0.5, 0.5, 2.24, 0.3, 4, LD, { a0: 3.1 });
  litter(b, 0.5, 0.5, 0.42, 5, M('leafLt'));
}

function buildPine(b, tall) {
  const C = M('conifer'), CD = M('coniferDk'), BK = M('bark');
  const x = 1, y = 1;
  const H = tall ? 3.55 : 2.85;
  const R0 = tall ? 0.78 : 0.86;
  b.cylinder(x, y, 0, H * 0.34, tall ? 0.15 : 0.17, 7, BK, { rTop: 0.1 });
  roots(b, x, y, 0.16, 0.32, M('barkDk'));
  const tiers = tall ? 9 : 7;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const z0 = 0.28 + t * (H - 0.62);
    const r = R0 * (1 - t * 0.86) * (1 + (b.rng() - 0.5) * 0.1);
    const hNominal = H * (tall ? 0.3 : 0.34) * (0.82 + b.rng() * 0.3);
    const h = Math.min(hNominal, H - z0 + 0.1);
    cone(b, x, y, z0, z0 + h, r, 8, i % 2 ? C : CD, { rot: i * 0.4 });
  }
  cone(b, x, y, H - 0.36, H + 0.06, R0 * 0.2, 8, C, { rot: 0.2 });
  if (tall) canopyLeaves(b, x, y, H * 0.62, R0 * 0.6, 5, CD, { a0: 0.9 });
}

function buildCherry(b) {
  const B1 = M('leafBlossom'), B2 = M('leafBlossomLt'), BK = M('bark');
  const x = 1, y = 1;
  b.cylinder(x, y, 0, 1.05, 0.17, 7, BK, { rTop: 0.125 });
  roots(b, x, y, 0.17, 0.34, M('barkDk'));
  const br = [[0.52, 0.42, 1.72], [-0.5, 0.5, 1.66], [0.22, -0.55, 1.78], [-0.44, -0.4, 1.6]];
  for (const [dx, dy, z] of br) tube(b, [x, y, 0.95], [x + dx, y + dy, z], 0.08, 0.038, 5, BK);
  clump(b, x, y, 1.9, 0.66, 8, [B1, B2, B1, B2, B1, B1, B2, B1], { a0: 1.4, flat: 0.82 });
  // dense blossom tips rather than leaf plates: bright rim on the sun side
  canopyLeaves(b, x, y, 1.9, 0.66, 8, B2, { a0: 2.2 });
  canopyLeaves(b, x, y, 1.9, 0.66, 6, B1, { a0: 0.3 });
  litter(b, x, y, 0.62, 7, B2);
}

function buildAutumn(b) {
  const A = M('leafAutumn'), AD = M('leafAutumnDk'), BK = M('bark');
  const x = 1, y = 1;
  b.cylinder(x, y, 0, 1.28, 0.18, 7, BK, { rTop: 0.125 });
  roots(b, x, y, 0.18, 0.35, M('barkDk'));
  const br = [[0.6, 0.46, 1.94], [-0.54, 0.56, 1.86], [0.3, -0.6, 1.98], [-0.46, -0.44, 1.78]];
  for (const [dx, dy, z] of br) tube(b, [x, y, 1.14], [x + dx, y + dy, z], 0.082, 0.04, 5, BK);
  clump(b, x, y, 2.14, 0.64, 8, [A, AD, A, A, AD, A, AD, A], { a0: 2.1, flat: 0.78 });
  canopyLeaves(b, x, y, 2.14, 0.64, 7, A, { a0: 1.1 });
  canopyLeaves(b, x, y, 2.14, 0.64, 5, AD, { a0: 3.3 });
  litter(b, x, y, 0.7, 9, A);
  litter(b, x, y, 0.85, 5, AD);
}

function buildDeadTree(b) {
  const BK = M('bark'), BD = M('barkDk');
  b.cylinder(0.5, 0.5, 0, 1.15, 0.135, 7, BK, { rTop: 0.085 });
  roots(b, 0.5, 0.5, 0.135, 0.3, BD, 5);
  const br = [
    [0.30, 0.24, 1.95, 0.05], [-0.28, 0.30, 1.82, 0.045], [0.12, -0.30, 2.02, 0.045],
    [-0.26, -0.22, 1.7, 0.04], [0.34, -0.1, 1.6, 0.04], [-0.06, 0.36, 1.5, 0.035],
  ];
  for (const [dx, dy, z, r] of br) {
    tube(b, [0.5, 0.5, 0.95], [0.5 + dx, 0.5 + dy, z], 0.06, r, 5, i2mat(dx, BK, BD));
    tube(b, [0.5 + dx * 0.6, 0.5 + dy * 0.6, z * 0.82], [0.5 + dx * 1.25, 0.5 + dy * 1.25, z + 0.16], 0.03, 0.016, 4, BD, { occ: false });
  }
}
function i2mat(v, a, c) { return v > 0 ? a : c; }

function buildStump(b) {
  const BK = M('bark'), BD = M('barkDk'), LT = M('woodPlankLt');
  b.cylinder(0.5, 0.5, 0, 0.3, 0.24, 9, BK, { rTop: 0.215, topMat: LT });
  b.cylinder(0.5, 0.5, 0.3, 0.325, 0.216, 9, LT, { rTop: 0.155, topMat: M('woodPlank'), occ: false });
  b.cylinder(0.5, 0.5, 0.325, 0.33, 0.156, 8, M('woodPlankDk'), { rTop: 0.07, topMat: M('woodPlank'), occ: false });
  roots(b, 0.5, 0.5, 0.24, 0.44, BD, 5);
  // a split in the rim
  b.box(0.4, 0.18, 0.1, 0.07, 0.18, 0.22, BD, { occ: false });
  b.box(0.42, 0.2, 0.11, 0.05, 0.14, 0.21, M('beamDk'), { occ: false });
  // a sucker sprouting out of the cut
  canopyLeaves(b, 0.5, 0.5, 0.38, 0.13, 4, M('leafLt'), { a0: 0.5 });
  canopyLeaves(b, 0.5, 0.5, 0.36, 0.11, 3, M('leafDk'), { a0: 2.4 });
}

function buildBush(b, flowers) {
  const L = M('leaf'), LD = M('leafDk'), H = M('hedge'), LL = M('leafLt');
  b.cylinder(0.5, 0.5, 0, 0.16, 0.085, 5, M('bark'), { rTop: 0.06 });
  // a ring of lobes rather than one dome: the seams are what make it read as foliage
  const R = flowers ? 6 : 7;
  for (let i = 0; i < R; i++) {
    const a = (i / R) * TAU + 0.35;
    const rr = 0.155 + 0.03 * ((i * 3) % 3);
    const r = 0.15 + 0.045 * (((i * 5) % 4) / 3);
    const z = 0.1 + 0.075 * ((i * 3) % 4) / 3;
    b.dome(0.5 + Math.cos(a) * rr, 0.5 + Math.sin(a) * rr, z, r, r * 0.85,
      [L, LD, H, LL][i % 4], { seg: 8, rings: 3 });
  }
  b.dome(0.5, 0.5, 0.2, 0.21, 0.19, flowers ? H : LD, { seg: 9, rings: 3 });
  b.dome(0.5 - Math.cos(0.8) * 0.1, 0.5 - Math.sin(0.8) * 0.1, 0.16, 0.17, 0.17, LL, { seg: 8, rings: 3 });
  canopyLeaves(b, 0.5, 0.5, 0.36, 0.32, 6, flowers ? LL : LD, { a0: 0.6 });
  canopyLeaves(b, 0.5, 0.5, 0.28, 0.34, 4, L, { a0: 2.6 });
  if (!flowers) return;
  const FM = [M('flowerRed'), M('flowerYellow'), M('flowerWhite'), M('flowerRed'), M('flowerPurple'), M('flowerYellow'), M('flowerRed')];
  for (let i = 0; i < 7; i++) {
    const a = i * 2.399963 + 0.4;
    const r = 0.24 + 0.12 * (((i * 5) % 4) / 3);
    const x = 0.5 + Math.cos(a) * r, y = 0.5 + Math.sin(a) * r;
    const z = 0.34 + 0.14 * (((i * 3) % 5) / 4);
    b.dome(x, y, z, 0.055, 0.04, FM[i % FM.length], { seg: 6, rings: 2 });
    b.dome(x, y, z + 0.014, 0.024, 0.018, M('flowerYellow'), { seg: 5, rings: 1 });
  }
}

function buildHedge(b) {
  const H = M('hedge'), LD = M('leafDk'), L = M('leaf'), LL = M('leafLt');
  b.box(0.06, 0.06, 0, 0.88, 0.88, 0.5, H);
  b.box(0.03, 0.03, 0.48, 0.94, 0.94, 0.07, LD, { occ: false });
  // bumps along all four faces so the sides are not flat planes
  for (let s = 0; s < 4; s++) {
    const ax = s % 2, sgn = s < 2 ? 0 : 1;
    for (let k = 0; k < 3; k++) {
      const u = 0.2 + k * 0.3;
      const at = sgn ? 0.9 : 0.1;
      const x = ax ? u : at, y = ax ? at : u;
      const r = 0.15 + 0.03 * ((k + s) % 2);
      b.dome(x, y, 0.12 + 0.07 * ((k * 3 + s) % 3), r, r * 0.72, [L, LD, H][(k + s) % 3], { seg: 7, rings: 2 });
    }
  }
  const tops = [[0.2, 0.22, 0.18], [0.5, 0.16, 0.2], [0.8, 0.2, 0.19], [0.18, 0.5, 0.2],
    [0.5, 0.5, 0.21], [0.82, 0.52, 0.19], [0.22, 0.8, 0.19], [0.52, 0.84, 0.2], [0.8, 0.8, 0.18]];
  for (let i = 0; i < tops.length; i++) {
    const [x, y, r] = tops[i];
    b.dome(x, y, 0.54 + 0.03 * (i % 3), r, r * 0.6, [H, LD, L][i % 3], { seg: 8, rings: 2 });
  }
  canopyLeaves(b, 0.5, 0.5, 0.62, 0.34, 7, LL, { a0: 1.3 });
  canopyLeaves(b, 0.5, 0.5, 0.56, 0.36, 5, LD, { a0: 3.0 });
}

function buildRockLarge(b) {
  const S = M('stone'), SD = M('stoneDk'), SW = M('stoneWarm');
  blob(b, 0.46, 0.52, 0.42, 0.42, (i, j) => (j === 0 ? SD : (i % 3 === 0 ? SW : S)), { seg: 8, rings: 3, jit: 0.3 });
  blob(b, 0.74, 0.34, 0.19, 0.2, SD, { seg: 6, rings: 2, jit: 0.3 });
}

function buildRockSmall(b) {
  const S = M('stone'), SD = M('stoneDk');
  blob(b, 0.42, 0.44, 0.21, 0.22, SD, { seg: 6, rings: 2, jit: 0.3 });
  blob(b, 0.66, 0.62, 0.15, 0.14, S, { seg: 6, rings: 2, jit: 0.3 });
}

function buildBoulderMossy(b) {
  const S = M('stone'), SD = M('stoneDk'), SW = M('stoneWarm');
  blob(b, 0.86, 0.92, 0.66, 0.84, (i, j) => (i % 4 === 0 ? SW : (j === 0 ? SD : S)), { seg: 9, rings: 4, jit: 0.28 });
  blob(b, 1.44, 1.3, 0.4, 0.46, SD, { seg: 7, rings: 3, jit: 0.3 });
  blob(b, 0.5, 1.44, 0.35, 0.4, SW, { seg: 7, rings: 3, jit: 0.3 });
  // moss cap
  const moss = [[0.86, 0.9, 0.5, 0.44, M('leafDk')], [0.62, 1.12, 0.38, 0.3, M('hedge')],
    [1.18, 0.74, 0.42, 0.32, M('leafDk')], [1.32, 1.34, 0.3, 0.24, M('hedge')]];
  for (let i = 0; i < moss.length; i++) {
    const [x, y, z, r, m] = moss[i];
    b.dome(x, y, z, r, r * 0.45, m, { seg: 8, rings: 2 });
  }
  for (let i = 0; i < 5; i++) {
    const a = i * 2.399963;
    const x = 0.86 + Math.cos(a) * 0.5, y = 0.9 + Math.sin(a) * 0.5;
    b.m.quad([x, y, 0.62], [x + 0.05, y + 0.05, 0.66], [x + Math.cos(a) * 0.14, y + Math.sin(a) * 0.14, 0.78],
      [x - 0.04, y - 0.02, 0.65], M('leafLt'), nrm(Math.cos(a) * 0.5, Math.sin(a) * 0.5, 1), { detail: 1 });
  }
}

// ---------------------------------------------------------------------------
// fences, gates, walls
// ---------------------------------------------------------------------------

function grow(b, x, y, w, h, mat) {
  b.box(x, y, 0, w, w, h, mat);
  b.pyramid(x - 0.012, y - 0.012, h, w + 0.024, w + 0.024, 0.05, mat, { occ: false });
}

function buildFenceWood(b) {
  const W = M('woodWeathered'), WD = M('woodPlankDk');
  for (let i = 0; i < 3; i++) grow(b, 0.02 + i * 0.445, 0.46, 0.085, 0.54 + (i === 1 ? 0.02 : 0), W);
  b.box(0.0, 0.455, 0.21, 1.0, 0.07, 0.085, W, { occ: false });
  b.box(0.0, 0.455, 0.385, 1.0, 0.07, 0.085, WD, { occ: false });
  b.box(0.0, 0.46, 0.30, 1.0, 0.06, 0.06, WD, { occ: false });
}

function buildFenceGate(b) {
  const W = M('woodWeathered'), P = M('woodPlank'), PD = M('woodPlankDk'), I = M('ironBlack');
  grow(b, 0.0, 0.44, 0.1, 0.66, W);
  grow(b, 0.9, 0.44, 0.1, 0.66, W);
  // gate leaf, slightly ajar so it does not read as a solid panel
  const x0 = 0.11, x1 = 0.89;
  b.box(x0, 0.47, 0.15, x1 - x0, 0.06, 0.07, P, { occ: false });
  b.box(x0, 0.47, 0.44, x1 - x0, 0.06, 0.07, P, { occ: false });
  for (let i = 0; i < 5; i++) {
    const x = x0 + 0.02 + i * ((x1 - x0 - 0.06) / 4);
    b.box(x, 0.478, 0.13, 0.062, 0.044, 0.4, i % 2 ? PD : P, { occ: false });
  }
  for (let i = 0; i < 6; i++) {
    b.box(x0 + 0.04 + i * 0.13, 0.474, 0.16 + i * 0.047, 0.1, 0.05, 0.055, PD, { occ: false });
  }
  b.box(0.86, 0.44, 0.24, 0.07, 0.09, 0.05, I, { occ: false });
  b.box(0.86, 0.44, 0.36, 0.07, 0.09, 0.05, I, { occ: false });
  b.box(0.78, 0.42, 0.27, 0.09, 0.09, 0.06, M('metal'), { occ: false });
}

function buildFenceStone(b) {
  const mats = [M('stone'), M('stoneDk'), M('stoneWarm')];
  const rows = [[0, 0.34, 0.15, 5], [0.15, 0.34, 0.13, 5], [0.28, 0.32, 0.1, 6]];
  for (let r = 0; r < rows.length; r++) {
    const [z, depth, h, n] = rows[r];
    const y = 0.5 - depth / 2;
    for (let i = 0; i < n; i++) {
      const w = 1.0 / n;
      const x = i * w + (r % 2 ? 0.02 : -0.01);
      b.box(x, y + (i % 2 ? 0.012 : 0), z, w * 1.02, depth, h, mats[(i + r) % 3], { occ: false });
    }
  }
  b.m.occluders.push({ mn: [0, 0.32, 0], mx: [1, 0.68, 0.4] });
  // a couple of loose stones at the foot
  blob(b, 0.82, 0.34, 0.1, 0.09, M('stoneDk'), { seg: 5, rings: 2, jit: 0.3, occ: false });
  blob(b, 0.16, 0.68, 0.09, 0.08, M('stone'), { seg: 5, rings: 2, jit: 0.3, occ: false });
}

// ---------------------------------------------------------------------------
// light sources
// ---------------------------------------------------------------------------

function buildLampPost(b) {
  const I = M('ironBlack'), G = M('lampGlass');
  b.box(0.34, 0.34, 0, 0.32, 0.32, 0.07, M('stoneDk'));
  b.box(0.4, 0.4, 0.06, 0.2, 0.2, 0.1, I);
  b.cylinder(0.5, 0.5, 0.14, 1.62, 0.052, 6, I, { rTop: 0.038 });
  b.cylinder(0.5, 0.5, 0.5, 0.56, 0.07, 6, I, { rTop: 0.055, top: false, bottom: false, occ: false });
  b.cylinder(0.5, 0.5, 1.1, 1.16, 0.062, 6, I, { rTop: 0.05, top: false, bottom: false, occ: false });
  // lantern: bright glass box framed in iron, corners + top/bottom plates
  const z0 = 1.62;
  b.box(0.5 - 0.13, 0.5 - 0.13, z0, 0.26, 0.26, 0.045, I);
  b.box(0.5 - 0.105, 0.5 - 0.105, z0 + 0.045, 0.21, 0.21, 0.24, G, { occ: false });
  for (let i = 0; i < 4; i++) {
    const dx = i < 2 ? -1 : 1, dy = i % 2 ? -1 : 1;
    b.box(0.5 + dx * 0.105 - 0.02, 0.5 + dy * 0.105 - 0.02, z0 + 0.04, 0.04, 0.04, 0.25, I, { occ: false });
  }
  b.box(0.5 - 0.13, 0.5 - 0.13, z0 + 0.285, 0.26, 0.26, 0.045, I, { occ: false });
  b.pyramid(0.5 - 0.145, 0.5 - 0.145, z0 + 0.33, 0.29, 0.29, 0.1, I, { occ: false });
  b.cylinder(0.5, 0.5, z0 + 0.42, z0 + 0.46, 0.026, 5, I, { rTop: 0.012, occ: false });
}

function buildLanternHanging(b) {
  const W = M('woodWeathered'), I = M('ironBlack'), P = M('lanternPaper');
  b.box(0.36, 0.36, 0, 0.28, 0.28, 0.08, M('stoneDk'));
  b.box(0.4, 0.4, 0.06, 0.2, 0.2, 0.06, W);
  b.box(0.44, 0.44, 0.1, 0.12, 0.12, 1.56, W);
  b.box(0.42, 0.42, 1.5, 0.16, 0.16, 0.06, M('woodPlankDk'), { occ: false });
  // arm + hook
  tube(b, [0.5, 0.5, 1.6], [0.9, 0.5, 1.72], 0.055, 0.04, 6, W);
  tube(b, [0.88, 0.5, 1.71], [0.88, 0.5, 1.6], 0.026, 0.026, 4, I, { occ: false });
  b.box(0.855, 0.475, 1.56, 0.05, 0.05, 0.05, I, { occ: false });
  // paper lantern, hung clear of the post so the glow reads against the sky
  const z0 = 1.13;
  tube(b, [0.88, 0.5, 1.6], [0.88, 0.5, z0 + 0.33], 0.01, 0.01, 4, I, { occ: false });
  lathe(b, 0.88, 0.5, [[z0, 0.035], [z0 + 0.04, 0.1], [z0 + 0.14, 0.135], [z0 + 0.24, 0.115], [z0 + 0.31, 0.06], [z0 + 0.34, 0.032]],
    9, P, { topMat: I, bottom: false, occ: false });
  b.cylinder(0.88, 0.5, z0 - 0.035, z0, 0.04, 5, I, { occ: false });
  b.m.occluders.push({ mn: [0.75, 0.38, 1.0], mx: [1.01, 0.62, 1.62] });
}

// ---------------------------------------------------------------------------
// yard furniture
// ---------------------------------------------------------------------------

function buildWell(b) {
  const S = M('stone'), SD = M('stoneDk'), SW = M('stoneWarm'), W = M('woodWeathered');
  const cx = 1, cy = 1;
  ringWall(b, cx, cy, 0, 0.55, 0.62, 0.42, 12, (i) => [S, SD, SW][i % 3], { rot: 0.26 });
  // coping
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU + 0.26;
    b.box(cx + Math.cos(a) * 0.52 - 0.115, cy + Math.sin(a) * 0.52 - 0.115, 0.55, 0.23, 0.23, 0.07,
      [SW, S, SD][i % 3], { occ: false });
  }
  b.fan([[cx - 0.42, cy - 0.42, 0.2], [cx + 0.42, cy - 0.42, 0.2], [cx + 0.42, cy + 0.42, 0.2], [cx - 0.42, cy + 0.42, 0.2]],
    M('soilWet'), [0, 0, 1], true, { occ: false });
  b.box(0.62 - 0.05, cy - 0.05, 0.4, 0.1, 0.1, 1.18, W);
  b.box(1.38 - 0.05, cy - 0.05, 0.4, 0.1, 0.1, 1.18, W);
  b.box(0.6 - 0.02, cy - 0.09, 1.5, 0.8, 0.18, 0.1, M('woodPlankDk'), { occ: false });
  tube(b, [0.56, cy, 1.47], [1.44, cy, 1.47], 0.055, 0.055, 6, M('woodPlankDk'), { cap: true, cap0: true, occ: false });
  b.gable(0.4, 0.64, 1.58, 1.2, 0.72, 0.3, M('roofShingle'), { axis: 'x', endMat: M('roofShingleDk'), overhang: 0.05 });
  tube(b, [cx, cy, 1.46], [cx, cy, 0.98], 0.028, 0.028, 4, M('beam'), { occ: false });
  tube(b, [cx, cy, 1.46], [cx + 0.06, cy + 0.02, 1.4], 0.028, 0.028, 4, M('beam'), { occ: false });
  lathe(b, cx, cy, [[0.86, 0.07], [0.9, 0.092], [1.0, 0.1], [1.03, 0.095]], 8, M('woodPlank'), { topMat: M('woodPlankDk'), occ: false });
  b.cylinder(cx, cy, 0.99, 1.01, 0.1, 8, M('ironBlack'), { top: false, bottom: false, occ: false });
  tube(b, [cx - 0.09, cy, 1.03], [cx - 0.05, cy, 1.14], 0.012, 0.012, 3, M('ironBlack'), { occ: false });
  tube(b, [cx - 0.05, cy, 1.14], [cx + 0.05, cy, 1.14], 0.012, 0.012, 3, M('ironBlack'), { occ: false });
  tube(b, [cx + 0.05, cy, 1.14], [cx + 0.09, cy, 1.03], 0.012, 0.012, 3, M('ironBlack'), { occ: false });
}

function buildWaterTrough(b) {
  const W = M('woodWeathered'), WD = M('woodPlankDk'), I = M('ironBlack');
  const x0 = 0.06, x1 = 0.94, y0 = 0.28, y1 = 0.72, t = 0.06, h = 0.3;
  b.box(x0, y0, 0.03, x1 - x0, y1 - y0, 0.06, WD);
  b.box(x0, y0, 0.03, t, y1 - y0, h, W, { occ: false });
  b.box(x1 - t, y0, 0.03, t, y1 - y0, h, W, { occ: false });
  b.box(x0, y0, 0.03, x1 - x0, t, h, W, { occ: false });
  b.box(x0, y1 - t, 0.03, x1 - x0, t, h, W, { occ: false });
  b.fan([[x0 + t, y0 + t, 0.29], [x1 - t, y0 + t, 0.29], [x1 - t, y1 - t, 0.29], [x0 + t, y1 - t, 0.29]],
    M('waterShallow'), [0, 0, 1], true, { occ: false });
  for (let i = 0; i < 4; i++) {
    const x = x0 + 0.03 + i * 0.24;
    b.box(x, y0 - 0.012, 0.09, 0.035, y1 - y0 + 0.024, 0.21, I, { occ: false });
  }
  b.box(x0 - 0.03, y0 - 0.02, 0.0, 0.05, 0.05, 0.34, WD);
  b.box(x1 - 0.02, y1 - 0.03, 0.0, 0.05, 0.05, 0.34, WD);
  // a couple of lily pads
  b.m.quad([0.3, 0.44, 0.265], [0.38, 0.42, 0.265], [0.4, 0.5, 0.265], [0.31, 0.52, 0.265], M('leafDk'), [0, 0, 1], { detail: 1 });
  b.m.quad([0.62, 0.56, 0.265], [0.69, 0.54, 0.265], [0.71, 0.61, 0.265], [0.63, 0.63, 0.265], M('leaf'), [0, 0, 1], { detail: 1 });
}

function buildScarecrow(b) {
  const W = M('woodWeathered'), H = M('hay'), HD = M('hayDk'), S = M('shirtRed'), C = M('clothBlue'), SK = M('sack');
  b.box(0.465, 0.465, 0, 0.07, 0.07, 1.62, W);
  b.box(0.07, 0.47, 1.28, 0.86, 0.06, 0.07, W, { occ: false });
  // straw hands
  for (const x of [0.045, 0.855]) {
    b.box(x, 0.44, 1.26, 0.1, 0.12, 0.11, H, { occ: false });
    for (let i = 0; i < 3; i++) b.box(x + (x < 0.5 ? -0.03 : 0.07), 0.435 + i * 0.035, 1.2, 0.06, 0.03, 0.16, HD, { occ: false });
  }
  // shirt
  b.box(0.3, 0.36, 1.0, 0.4, 0.28, 0.34, S);
  b.box(0.28, 0.34, 0.99, 0.44, 0.32, 0.05, M('trimDark'), { occ: false });
  b.m.quad([0.42, 0.345, 1.12], [0.58, 0.345, 1.12], [0.58, 0.345, 1.24], [0.42, 0.345, 1.24], C, [0, -1, 0], { detail: 1 });
  b.m.quad([0.41, 0.38, 1.13], [0.59, 0.38, 1.13], [0.59, 0.38, 1.25], [0.41, 0.38, 1.25], C, [0, 1, 0], { detail: 1 });
  for (let i = 0; i < 4; i++) b.box(0.33 + i * 0.1, 0.62, 1.0, 0.045, 0.04, 0.34, M('shirtRed'), { occ: false });
  // straw bursting out of the sleeves and hem
  for (let i = 0; i < 6; i++) {
    const a = i * 1.05;
    b.box(0.5 + Math.cos(a) * 0.19 - 0.02, 0.5 + Math.sin(a) * 0.17 - 0.02, 0.96, 0.05, 0.05, 0.14, i % 2 ? H : HD, { occ: false });
  }
  b.box(0.36, 0.4, 1.3, 0.28, 0.2, 0.06, HD, { occ: false });
  b.box(0.4, 0.42, 1.33, 0.2, 0.16, 0.16, SK);
  b.dome(0.5, 0.5, 1.47, 0.1, 0.09, SK, { seg: 8, rings: 2 });
  b.box(0.44, 0.36, 1.44, 0.04, 0.03, 0.04, M('black'), { occ: false });
  b.box(0.53, 0.36, 1.44, 0.04, 0.03, 0.04, M('black'), { occ: false });
  // straw hat
  b.cylinder(0.5, 0.5, 1.53, 1.57, 0.26, 10, M('hatStraw'), { rTop: 0.24, bottom: true, occ: false });
  b.cylinder(0.5, 0.5, 1.55, 1.68, 0.14, 9, M('hatStraw'), { rTop: 0.11, occ: false });
  b.cylinder(0.5, 0.5, 1.54, 1.57, 0.15, 9, M('clothRed'), { rTop: 0.15, top: false, bottom: false, occ: false });
}

function buildMailbox(b) {
  const P = M('woodPlankDk'), MTL = M('metal'), MD = M('metalDark');
  b.box(0.42, 0.42, 0, 0.09, 0.09, 1.0, P);
  b.box(0.36, 0.36, 0.98, 0.28, 0.28, 0.05, M('woodPlank'), { occ: false });
  const x0 = 0.37, x1 = 0.63, y0 = 0.32, y1 = 0.68;
  b.box(x0, y0, 1.03, x1 - x0, y1 - y0, 0.16, MD);
  vault(b, x0, x1, y0, y1, 1.19, 0.13, MTL);
  b.box(x0 - 0.012, y0 - 0.012, 1.05, (x1 - x0) + 0.024, 0.02, 0.12, MTL, { occ: false });
  b.box(x0 - 0.012, y1 - 0.008, 1.05, (x1 - x0) + 0.024, 0.02, 0.12, MTL, { occ: false });
  b.box(x0 - 0.02, 0.42, 1.06, 0.04, 0.06, 0.1, M('trimRed'), { occ: false });
  tube(b, [x0 + 0.03, 0.34 - 0.04, 1.06], [x0 + 0.03, 0.34 - 0.04, 1.3], 0.012, 0.012, 4, MTL, { occ: false });
  b.m.quad([x0 + 0.03, 0.34 - 0.045, 1.3], [x0 + 0.1, 0.34 - 0.045, 1.3], [x0 + 0.1, 0.34 - 0.045, 1.24], [x0 + 0.03, 0.34 - 0.045, 1.24],
    M('trimRed'), [0, -1, 0]);
  b.box(x0 - 0.01, y0 + 0.05, 1.1, 0.025, 0.24, 0.012, M('trimDark'), { occ: false });
  b.cylinder(0.5, 0.5, 1.0, 1.03, 0.1, 8, MD, { rTop: 0.085, occ: false });
}

function buildSignpost(b) {
  const W = M('woodWeathered'), L = M('woodPlankLt'), D = M('trimDark');
  b.box(0.46, 0.46, 0, 0.08, 0.08, 1.16, W);
  b.cylinder(0.5, 0.5, 1.16, 1.2, 0.055, 6, W, { rTop: 0.03, occ: false });
  const board = (x, y, z, w, d, mat, flip) => {
    b.box(x, y, z, w, d, 0.19, mat);
    const tip = flip ? x : x + w;
    const s = flip ? -1 : 1;
    b.m.tri([tip, y, z], [tip, y + d, z], [tip + s * 0.1, y + d / 2, z], mat, [0, 0, -1]);
    b.m.tri([tip, y + d, z + 0.19], [tip, y, z + 0.19], [tip + s * 0.1, y + d / 2, z + 0.19], mat, [0, 0, 1]);
    b.m.tri([tip, y, z + 0.19], [tip, y, z], [tip + s * 0.1, y + d / 2, z], mat, [0, 0, 1]);
    b.m.tri([tip, y + d, z], [tip, y + d, z + 0.19], [tip + s * 0.1, y + d / 2, z], mat, [0, 0, 1]);
  };
  board(0.22, 0.42, 0.9, 0.56, 0.16, L, false);
  board(0.3, 0.42, 0.64, 0.42, 0.15, M('woodPlank'), true);
  for (let i = 0; i < 4; i++) b.box(0.28 + i * 0.11, 0.4, 0.96, 0.07, 0.02, 0.03, D, { occ: false });
  for (let i = 0; i < 3; i++) b.box(0.36 + i * 0.1, 0.4, 0.7, 0.06, 0.02, 0.03, D, { occ: false });
  b.box(0.4, 0.44, 1.03, 0.035, 0.035, 0.02, M('metal'), { occ: false });
  b.box(0.4, 0.44, 0.77, 0.035, 0.035, 0.02, M('metal'), { occ: false });
}

// ---------------------------------------------------------------------------
// containers & yard clutter
// ---------------------------------------------------------------------------

function staveMat(i) {
  const a = M('woodPlank'), b2 = M('woodPlankDk'), c = M('woodPlankLt');
  return [a, b2, a, c, a, b2, c, a, b2, a, c, a][i % 12];
}

function buildBarrel(b) {
  const I = M('ironBlack');
  lathe(b, 0.5, 0.5, [[0, 0.185], [0.06, 0.225], [0.28, 0.245], [0.5, 0.225], [0.58, 0.19]], 12, staveMat,
    { topMat: M('woodPlankDk'), bottom: false });
  lathe(b, 0.5, 0.5, [[0.09, 0.238], [0.15, 0.238]], 12, I, { top: false, occ: false });
  lathe(b, 0.5, 0.5, [[0.44, 0.238], [0.5, 0.238]], 12, I, { top: false, occ: false });
  b.cylinder(0.5, 0.5, 0.58, 0.6, 0.16, 12, M('woodPlankLt'), { occ: false });
  b.box(0.35, 0.35, 0.6, 0.3, 0.04, 0.022, M('woodPlankDk'), { occ: false });
}

function buildCrate(b) {
  const C = M('plankCrate'), D = M('woodPlankDk'), P = M('woodPlank');
  b.box(0.06, 0.06, 0.02, 0.88, 0.88, 0.44, D);
  for (let s = 0; s < 4; s++) {
    const ax = s % 2, sgn = s < 2 ? 0 : 1;
    for (let k = 0; k < 3; k++) {
      const z = 0.05 + k * 0.14;
      if (ax === 0) b.box(sgn ? 0.935 : 0.03, 0.06, z, 0.035, 0.88, 0.11, C, { occ: false });
      else b.box(0.06, sgn ? 0.935 : 0.03, z, 0.88, 0.035, 0.11, C, { occ: false });
    }
  }
  for (let i = 0; i < 4; i++) {
    const dx = i < 2 ? 0.03 : 0.905, dy = i % 2 ? 0.03 : 0.905;
    b.box(dx, dy, 0, 0.065, 0.065, 0.48, P, { occ: false });
  }
  for (let i = 0; i < 3; i++) b.box(0.06, 0.1 + i * 0.3, 0.46, 0.88, 0.19, 0.03, C, { occ: false });
  b.box(0.06, 0.06, 0.46, 0.88, 0.05, 0.03, P, { occ: false });
  b.m.quad([0.09, 0.1, 0.5], [0.91, 0.1, 0.5], [0.91, 0.9, 0.5], [0.09, 0.9, 0.5], D, [0, 0, 1], { detail: 1 });
}

function sackShape(b, cx, cy, z, r, h, mat) {
  lathe(b, cx, cy, [[z, r * 0.62], [z + h * 0.16, r * 0.92], [z + h * 0.5, r], [z + h * 0.78, r * 0.72], [z + h * 0.92, r * 0.38], [z + h, r * 0.3]],
    9, mat, { topMat: M('sack'), occ: false });
  b.box(cx - r * 0.28, cy - r * 0.28, z + h * 0.9, r * 0.56, r * 0.56, h * 0.22, M('beam'), { occ: false });
  b.m.occluders.push({ mn: [cx - r, cy - r, z], mx: [cx + r, cy + r, z + h] });
}

function buildSackPile(b) {
  sackShape(b, 0.34, 0.4, 0, 0.24, 0.34, M('sack'));
  sackShape(b, 0.68, 0.58, 0, 0.22, 0.3, M('sack'));
  sackShape(b, 0.5, 0.46, 0.3, 0.2, 0.26, M('sack'));
  b.box(0.4, 0.4, 0.56, 0.14, 0.1, 0.06, M('sack'), { occ: false });
}

function buildHayBale(b) {
  const H = M('hay'), HD = M('hayDk');
  tube(b, [0.14, 0.5, 0.235], [0.86, 0.5, 0.235], 0.215, 0.215, 9, H, { cap: true, cap0: true, capMat: HD });
  tube(b, [0.3, 0.5, 0.235], [0.34, 0.5, 0.235], 0.226, 0.226, 9, HD, { occ: false });
  tube(b, [0.66, 0.5, 0.235], [0.7, 0.5, 0.235], 0.226, 0.226, 9, HD, { occ: false });
  for (let i = 0; i < 7; i++) {
    const a = i * 0.9;
    b.box(0.5 + Math.cos(a) * 0.2 - 0.02, 0.5 + Math.sin(a) * 0.16 - 0.015, 0.06 + (i % 3) * 0.05, 0.045, 0.03, 0.2,
      i % 2 ? H : HD, { occ: false });
  }
}

function buildFlowerPot(b) {
  const T = M('terracottaPot');
  b.cylinder(0.5, 0.5, 0, 0.1, 0.098, 10, T, { rTop: 0.118 });
  b.cylinder(0.5, 0.5, 0.1, 0.24, 0.118, 10, T, { rTop: 0.152 });
  b.cylinder(0.5, 0.5, 0.24, 0.28, 0.166, 10, T, { rTop: 0.17 });
  b.fan([[0.5 - 0.14, 0.5 - 0.14, 0.235], [0.5 + 0.14, 0.5 - 0.14, 0.235], [0.5 + 0.14, 0.5 + 0.14, 0.235], [0.5 - 0.14, 0.5 + 0.14, 0.235]],
    M('soil'), [0, 0, 1], true, { occ: false });
  const FM = [M('flowerRed'), M('flowerYellow'), M('flowerPurple'), M('flowerWhite'), M('flowerRed')];
  for (let i = 0; i < 5; i++) {
    const a = i * 1.257 + 0.3;
    const x = 0.5 + Math.cos(a) * 0.075, y = 0.5 + Math.sin(a) * 0.075;
    const h = 0.16 + 0.07 * (i % 3);
    b.m.quad([x - 0.03, y, 0.24], [x + 0.03, y, 0.24], [x + 0.012, y, 0.24 + h], [x - 0.012, y, 0.24 + h], M('cropLeafDk'), nrm(Math.cos(a) * 0.6, Math.sin(a) * 0.6, 0.9), { detail: 1 });
    b.dome(x, y, 0.24 + h - 0.02, 0.06, 0.05, FM[i], { seg: 7, rings: 2 });
    b.dome(x, y, 0.24 + h + 0.012, 0.026, 0.02, M('flowerYellow'), { seg: 5, rings: 1 });
  }
  for (let i = 0; i < 5; i++) {
    const a = i * 1.1 + 1.4;
    const x = 0.5 + Math.cos(a) * 0.115, y = 0.5 + Math.sin(a) * 0.115;
    b.m.quad([x, y, 0.24], [x + Math.cos(a + 1.4) * 0.055, y + Math.sin(a + 1.4) * 0.055, 0.27],
      [x + Math.cos(a) * 0.11, y + Math.sin(a) * 0.11, 0.33], [x + Math.cos(a - 1.4) * 0.055, y + Math.sin(a - 1.4) * 0.055, 0.27],
      M('cropLeaf'), nrm(Math.cos(a) * 0.6, Math.sin(a) * 0.6, 1), { detail: 1 });
  }
}

function buildWheelbarrow(b) {
  const P = M('woodPlank'), PD = M('woodPlankDk'), I = M('ironBlack'), B = M('woodBlue');
  const x0 = 0.3, x1 = 0.8, y0 = 0.22, y1 = 0.78, t = 0.05, h = 0.28;
  b.box(x0, y0, 0.2, x1 - x0, y1 - y0, 0.045, PD);
  for (let i = 0; i < 3; i++) b.box(x0 + i * ((x1 - x0 - 0.06) / 2), y0, 0.2, 0.06, y1 - y0, 0.05, PD, { occ: false });
  b.box(x1 - t, y0, 0.2, t, y1 - y0, h, P);
  b.box(x0, y0, 0.2, x1 - x0, t, h, B);
  b.box(x0, y1 - t, 0.2, x1 - x0, t, h, B);
  b.box(x0 - 0.025, y0 - 0.025, 0.46, (x1 - x0) + 0.05, 0.035, 0.035, PD, { occ: false });
  b.box(x0 - 0.025, y1 - 0.01, 0.46, (x1 - x0) + 0.05, 0.035, 0.035, PD, { occ: false });
  // load heaped over the rim
  b.fan([[x0, y0 + t, 0.3], [x1 - t, y0 + t, 0.3], [x1 - t, y1 - t, 0.3], [x0, y1 - t, 0.3]], M('soil'), [0, 0, 1], true, { occ: false });
  for (let i = 0; i < 5; i++) {
    const x = x0 + 0.06 + i * 0.09;
    b.box(x, y0 + 0.07, 0.3, 0.07, 0.3 + (i % 2) * 0.1, 0.08, i % 2 ? M('leafDk') : M('soilDk'), { occ: false });
  }
  b.box(x0, y0 + 0.05, 0.47, x1 - x0, 0.18, 0.06, M('leafDk'), { occ: false });
  // handles
  tube(b, [x0 + 0.02, y0 + 0.03, 0.3], [0.98, 0.1, 0.5], 0.03, 0.028, 5, P, { occ: false });
  tube(b, [x0 + 0.02, y1 - 0.03, 0.3], [0.98, 0.9, 0.5], 0.03, 0.028, 5, P, { occ: false });
  // wheel + legs
  tube(b, [0.2, 0.43, 0.19], [0.2, 0.57, 0.19], 0.175, 0.175, 10, PD, { cap: true, cap0: true, capMat: I, occ: false });
  tube(b, [0.182, 0.43, 0.19], [0.218, 0.43, 0.19], 0.052, 0.052, 6, I, { occ: false });
  tube(b, [0.188, 0.43, 0.19], [0.188, 0.57, 0.19], 0.048, 0.048, 6, I, { occ: false });
  b.m.occluders.push({ mn: [0.02, 0.36, 0], mx: [0.38, 0.64, 0.36] });
  b.box(0.76, 0.26, 0, 0.055, 0.055, 0.24, I, { occ: false });
  b.box(0.76, 0.69, 0, 0.055, 0.055, 0.24, I, { occ: false });
}

function buildCampfire(b) {
  const S = M('stone'), SD = M('stoneDk'), SW = M('stoneWarm'), LG = M('log'), LD = M('logDk');
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU + 0.3;
    blob(b, 0.5 + Math.cos(a) * 0.32, 0.5 + Math.sin(a) * 0.32, 0.095 + 0.028 * (i % 2), 0.115 + 0.026 * (i % 3),
      [S, SD, SW][i % 3], { seg: 5, rings: 2, jit: 0.34, occ: i % 3 === 0 });
  }
  for (let i = 0; i < 5; i++) {
    const a = i * 1.257 + 0.2;
    tube(b, [0.5 - Math.cos(a) * 0.21, 0.5 - Math.sin(a) * 0.21, 0.055], [0.5 + Math.cos(a) * 0.21, 0.5 + Math.sin(a) * 0.21, 0.15],
      0.045, 0.036, 5, i % 2 ? LG : LD, { cap: true, capMat: M('woodPlankLt'), occ: false });
  }
  b.m.occluders.push({ mn: [0.24, 0.24, 0], mx: [0.76, 0.76, 0.22] });
  blob(b, 0.5, 0.5, 0.12, 0.22, M('coal'), { seg: 6, rings: 2, jit: 0.3, occ: false });
  blob(b, 0.5, 0.5, 0.15, 0.32, M('fireGlow'), { seg: 7, rings: 3, jit: 0.26, occ: false });
  for (let i = 0; i < 4; i++) {
    const a = i * 1.57 + 0.5;
    b.m.quad([0.5 + Math.cos(a) * 0.07, 0.5 + Math.sin(a) * 0.07, 0.24],
      [0.5 + Math.cos(a + 1.3) * 0.07, 0.5 + Math.sin(a + 1.3) * 0.07, 0.3],
      [0.5 + Math.cos(a + 0.5) * 0.1, 0.5 + Math.sin(a + 0.5) * 0.1, 0.62],
      [0.5 + Math.cos(a - 0.2) * 0.02, 0.5 + Math.sin(a - 0.2) * 0.02, 0.36],
      M('fireGlow'), nrm(Math.cos(a) * 0.45, Math.sin(a) * 0.45, 1), { detail: 1 });
  }
  b.m.quad([0.44, 0.46, 0.3], [0.5, 0.44, 0.34], [0.52, 0.5, 0.7], [0.46, 0.52, 0.34], M('fireGlow'), [0.3, 0.1, 1], { detail: 1 });
}

function buildLogPile(b) {
  const LG = M('log'), LD = M('logDk'), LT = M('woodPlankLt'), W = M('woodWeathered');
  const rows = [[0.34, 0.1], [0.52, 0.1], [0.7, 0.1], [0.43, 0.27], [0.61, 0.27], [0.52, 0.44]];
  for (let i = 0; i < rows.length; i++) {
    const [y, z] = rows[i];
    const x0 = 0.14 + (i % 3) * 0.03, x1 = 0.86 - (i % 2) * 0.03;
    tube(b, [x0, y, z], [x1, y, z], 0.093, 0.086, 7, i % 2 ? LG : LD, { cap: true, cap0: true, capMat: LT, occ: i % 2 === 0 });
  }
  b.box(0.1, 0.5, 0, 0.055, 0.055, 0.42, W, { occ: false });
  b.box(0.85, 0.5, 0, 0.055, 0.055, 0.42, W, { occ: false });
}

function buildCompostBin(b) {
  const W = M('woodWeathered'), WD = M('woodPlankDk');
  b.box(0.16, 0.16, 0, 0.68, 0.68, 0.06, WD);
  for (let s = 0; s < 4; s++) {
    const sgn = s < 2 ? 0 : 1, ax = s % 2;
    for (let k = 0; k < 4; k++) {
      const z = 0.05 + k * 0.1;
      if (ax === 0) b.box(sgn ? 0.79 : 0.14, 0.16, z, 0.045, 0.68, 0.085, W, { occ: false });
      else b.box(0.16, sgn ? 0.79 : 0.14, z, 0.68, 0.045, 0.085, W, { occ: false });
    }
  }
  for (let i = 0; i < 4; i++) {
    const dx = i < 2 ? 0.14 : 0.79, dy = i % 2 ? 0.14 : 0.79;
    b.box(dx, dy, 0, 0.055, 0.055, 0.46, WD, { occ: false });
  }
  b.fan([[0.2, 0.2, 0.34], [0.8, 0.2, 0.34], [0.8, 0.8, 0.34], [0.2, 0.8, 0.34]], M('soilDk'), [0, 0, 1], true, { occ: false });
  const scraps = [[0.36, 0.44, M('cropCarrot')], [0.6, 0.38, M('cropLeafDk')], [0.52, 0.62, M('cropTomato')], [0.34, 0.62, M('leafLt')], [0.66, 0.6, M('cropMelon')]];
  for (let i = 0; i < scraps.length; i++) {
    const [x, y, m] = scraps[i];
    b.dome(x, y, 0.35, 0.075, 0.06, m, { seg: 6, rings: 2, occ: false });
  }
}

function buildBirdhouse(b) {
  const W = M('woodWeathered'), P = M('woodPlankLt'), PD = M('woodPlankDk'), I = M('ironBlack');
  b.box(0.465, 0.465, 0, 0.07, 0.07, 1.3, W);
  b.box(0.42, 0.42, 0.16, 0.16, 0.16, 0.05, PD, { occ: false });
  b.box(0.36, 0.38, 1.3, 0.28, 0.24, 0.3, P);
  b.box(0.35, 0.37, 1.3, 0.3, 0.26, 0.03, PD, { occ: false });
  b.gable(0.33, 0.35, 1.6, 0.34, 0.3, 0.17, M('roofShingleDk'), { axis: 'y', overhang: 0.035, endMat: M('roofShingle') });
  b.box(0.625, 0.44, 1.44, 0.03, 0.1, 0.1, M('black'), { occ: false });
  b.box(0.63, 0.45, 1.46, 0.02, 0.08, 0.06, M('black'), { occ: false });
  tube(b, [0.64, 0.49, 1.4], [0.72, 0.49, 1.38], 0.018, 0.014, 5, I, { occ: false });
  b.box(0.36, 0.38, 1.6, 0.28, 0.24, 0.02, PD, { occ: false });
  b.box(0.44, 0.36, 1.08, 0.12, 0.04, 0.03, PD, { occ: false });
  b.box(0.6, 0.42, 1.55, 0.02, 0.14, 0.05, M('trimRed'), { occ: false });
}

function buildBeehive(b) {
  const H = M('hay'), HD = M('hayDk'), W = M('woodWeathered');
  b.box(0.24, 0.24, 0, 0.52, 0.52, 0.07, W);
  for (let i = 0; i < 4; i++) {
    const dx = i < 2 ? 0.3 : 0.62, dy = i % 2 ? 0.3 : 0.62;
    b.box(dx, dy, 0, 0.08, 0.08, 0.1, M('woodPlankDk'), { occ: false });
  }
  lathe(b, 0.5, 0.5, [[0.07, 0.2], [0.14, 0.245], [0.28, 0.25], [0.42, 0.225], [0.54, 0.17], [0.63, 0.08], [0.66, 0.02]],
    11, (i) => (i % 2 ? H : HD), { topMat: HD, occ: false });
  b.m.occluders.push({ mn: [0.25, 0.25, 0.07], mx: [0.75, 0.75, 0.66] });
  b.box(0.6, 0.42, 0.1, 0.045, 0.16, 0.05, M('black'), { occ: false });
  // bees
  const bees = [[0.78, 0.34, 0.72], [0.24, 0.66, 0.8], [0.66, 0.76, 0.62]];
  for (let i = 0; i < bees.length; i++) {
    const [x, y, z] = bees[i];
    b.box(x - 0.02, y - 0.02, z, 0.045, 0.045, 0.035, M('black'), { occ: false });
    b.box(x - 0.021, y - 0.021, z + 0.012, 0.047, 0.047, 0.014, M('flowerYellow'), { occ: false });
    b.m.quad([x - 0.02, y + 0.005, z + 0.04], [x + 0.03, y + 0.005, z + 0.04], [x + 0.03, y + 0.005, z + 0.075], [x - 0.02, y + 0.005, z + 0.075],
      M('white'), [0, 1, 0.4], { detail: 1 });
  }
}

function buildClothesline(b) {
  const W = M('woodWeathered'), LG = M('woodPlankDk');
  b.box(0.0, 0.42, 0, 0.095, 0.095, 1.0, W);
  b.box(0.9, 0.42, 0, 0.095, 0.095, 1.0, W);
  b.box(0.0, 0.42, 0.95, 0.095, 0.095, 0.06, LG, { occ: false });
  b.box(0.9, 0.42, 0.95, 0.095, 0.095, 0.06, LG, { occ: false });
  b.box(0.03, 0.425, 0.34, 0.04, 0.08, 0.05, LG, { occ: false });
  b.box(0.93, 0.425, 0.34, 0.04, 0.08, 0.05, LG, { occ: false });
  tube(b, [0.07, 0.468, 0.95], [0.5, 0.468, 0.88], 0.018, 0.018, 4, LG, { occ: false });
  tube(b, [0.5, 0.468, 0.88], [0.93, 0.468, 0.95], 0.018, 0.018, 4, LG, { occ: false });
  const cloth = [[0.2, 0.22, 0.3, M('clothBlue')], [0.46, 0.17, 0.36, M('clothCream')], [0.72, 0.18, 0.26, M('clothRed')]];
  for (let i = 0; i < cloth.length; i++) {
    const [x, w, h, m] = cloth[i];
    const zt = 0.95 - Math.abs(x - 0.5) * 0.14;
    b.box(x - w / 2, 0.435, zt - h, w, 0.07, h, m);
    b.box(x - w / 2 - 0.014, 0.43, zt - 0.022, w + 0.028, 0.08, 0.028, M('woodPlankLt'), { occ: false });
    b.box(x - w / 2 + 0.01, 0.43, zt - h - 0.012, w - 0.02, 0.08, 0.016, m, { occ: false });
  }
}

function buildRainBarrel(b) {
  const I = M('ironBlack'), CO = M('copper');
  lathe(b, 0.5, 0.5, [[0, 0.21], [0.07, 0.26], [0.34, 0.28], [0.58, 0.255], [0.66, 0.225]], 12, staveMat,
    { top: false, bottom: false });
  lathe(b, 0.5, 0.5, [[0.1, 0.272], [0.16, 0.272]], 12, I, { top: false, occ: false });
  lathe(b, 0.5, 0.5, [[0.5, 0.283], [0.56, 0.283]], 12, I, { top: false, occ: false });
  b.m.occluders.push({ mn: [0.2, 0.2, 0], mx: [0.8, 0.8, 0.66] });
  b.fan([[0.24, 0.24, 0.55], [0.76, 0.24, 0.55], [0.76, 0.76, 0.55], [0.24, 0.76, 0.55]], M('waterShallow'), [0, 0, 1], true, { occ: false });
  tube(b, [0.72, 0.5, 0.76], [0.9, 0.5, 0.82], 0.03, 0.03, 5, M('woodPlankLt'), { occ: false });
  tube(b, [0.7, 0.5, 0.2], [0.86, 0.5, 0.2], 0.032, 0.026, 6, CO, { cap: true, capMat: CO, occ: false });
  b.box(0.84, 0.47, 0.19, 0.05, 0.06, 0.05, CO, { occ: false });
  b.box(0.6, 0.2, 0.3, 0.32, 0.06, 0.3, M('woodPlankDk'), { occ: false });
  b.m.quad([0.28, 0.66, 0.68], [0.36, 0.62, 0.68], [0.38, 0.7, 0.68], [0.29, 0.72, 0.68], M('leafDk'), [0, 0, 1], { detail: 1 });
}

// ---------------------------------------------------------------------------
// descriptor table
// ---------------------------------------------------------------------------

const TREES = [
  { id: 'tree_oak', name: 'OAK', seed: 1301, fp: [2, 2], cap: 2.73, build: buildOak },
  { id: 'tree_oak_small', name: 'OAK SAPLING', seed: 1307, fp: [1, 1], cap: 1.54, build: buildOakSmall },
  { id: 'tree_birch', name: 'BIRCH', seed: 1319, fp: [1, 1], cap: 2.66, build: buildBirch },
  { id: 'tree_pine', name: 'PINE', seed: 1327, fp: [2, 2], cap: 2.98, build: (b) => buildPine(b, false) },
  { id: 'tree_pine_tall', name: 'PINE TALL', seed: 1361, fp: [2, 2], cap: 3.68, build: (b) => buildPine(b, true) },
  { id: 'tree_cherry', name: 'CHERRY', seed: 1381, fp: [2, 2], cap: 2.37, build: buildCherry },
  { id: 'tree_autumn', name: 'AUTUMN TREE', seed: 1399, fp: [2, 2], cap: 2.57, build: buildAutumn },
  { id: 'tree_dead', name: 'DEAD TREE', seed: 1409, fp: [1, 1], cap: 2.22, build: buildDeadTree },
  { id: 'stump', name: 'STUMP', seed: 1423, fp: [1, 1], cap: 0.48, build: buildStump },
  { id: 'bush', name: 'BUSH', seed: 1429, fp: [1, 1], cap: 0.53, build: (b) => buildBush(b, false) },
  { id: 'bush_flower', name: 'FLOWERING BUSH', seed: 1433, fp: [1, 1], cap: 0.58, build: (b) => buildBush(b, true) },
  { id: 'hedge_section', name: 'HEDGE', seed: 1447, fp: [1, 1], cap: 0.88, build: buildHedge },
  { id: 'rock_large', name: 'ROCK LARGE', seed: 1451, fp: [1, 1], cap: 0.44, build: buildRockLarge },
  { id: 'rock_small', name: 'ROCK SMALL', seed: 1453, fp: [1, 1], cap: 0.24, build: buildRockSmall },
  { id: 'boulder_mossy', name: 'MOSSY BOULDER', seed: 1459, fp: [2, 2], cap: 0.86, build: buildBoulderMossy },
];

const PROPS = [
  { id: 'fence_wood', name: 'FENCE', seed: 2003, cap: 0.63, build: buildFenceWood },
  { id: 'fence_gate', name: 'GATE', seed: 2011, cap: 0.73, build: buildFenceGate },
  { id: 'fence_stone', name: 'STONE WALL', seed: 2017, cap: 0.40, build: buildFenceStone },
  { id: 'lamp_post', name: 'LAMP POST', seed: 2027, cap: 2.10, build: buildLampPost },
  { id: 'lantern_hanging', name: 'HANGING LANTERN', seed: 2029, cap: 1.77, build: buildLanternHanging },
  { id: 'well_stone', name: 'WELL', seed: 2039, fp: [2, 2], cap: 1.90, build: buildWell },
  { id: 'water_trough', name: 'WATER TROUGH', seed: 2053, cap: 0.36, build: buildWaterTrough },
  { id: 'scarecrow', name: 'SCARECROW', seed: 2063, cap: 1.70, build: buildScarecrow },
  { id: 'mailbox', name: 'MAILBOX', seed: 2069, cap: 1.34, build: buildMailbox },
  { id: 'signpost', name: 'SIGNPOST', seed: 2081, cap: 1.22, build: buildSignpost },
  { id: 'barrel', name: 'BARREL', seed: 2083, cap: 0.64, build: buildBarrel },
  { id: 'crate', name: 'CRATE', seed: 2087, cap: 0.52, build: buildCrate },
  { id: 'sack_pile', name: 'SACK PILE', seed: 2089, cap: 0.64, build: buildSackPile },
  { id: 'hay_bale', name: 'HAY BALE', seed: 2099, cap: 0.48, build: buildHayBale },
  { id: 'flower_pot', name: 'FLOWER POT', seed: 2111, cap: 0.59, build: buildFlowerPot },
  { id: 'wheelbarrow', name: 'WHEELBARROW', seed: 2113, cap: 0.55, build: buildWheelbarrow },
  { id: 'campfire', name: 'CAMPFIRE', seed: 2129, cap: 0.72, build: buildCampfire },
  { id: 'log_pile', name: 'LOG PILE', seed: 2131, cap: 0.55, build: buildLogPile },
  { id: 'compost_bin', name: 'COMPOST BIN', seed: 2137, cap: 0.48, build: buildCompostBin },
  { id: 'birdhouse', name: 'BIRDHOUSE', seed: 2141, cap: 1.79, build: buildBirdhouse },
  { id: 'beehive', name: 'BEEHIVE', seed: 2143, cap: 0.90, build: buildBeehive },
  { id: 'clothesline', name: 'CLOTHESLINE', seed: 2147, cap: 1.03, build: buildClothesline },
  { id: 'rain_barrel', name: 'RAIN BARREL', seed: 2153, cap: 0.87, build: buildRainBarrel },
];

export const MODELS = [
  ...TREES.map((t) => ({ id: t.id, name: t.name, cat: 'tree', fp: t.fp || [1, 1], seed: t.seed, cap: t.cap, build: t.build })),
  ...PROPS.map((p) => ({ id: p.id, name: p.name, cat: 'prop', fp: p.fp || [1, 1], seed: p.seed, cap: p.cap, build: p.build })),
];
