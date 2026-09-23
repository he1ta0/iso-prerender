// Interior furniture kit — everything that stands on a farmhouse floor.
//
// READ THIS FIRST. The room kit cuts the roof and the two camera-facing walls
// away, so the interior is a real volume: the sun is ray-marched through the
// window openings and lands on the floor in the shape of the pane. Furniture
// therefore is not just a picture — every bulky piece also *marks* the volume it
// occupies (`b.solidBox` / `b.mark`), so the sun is stopped by a wardrobe the
// same way it is stopped by a wall. Thin or soft parts (flames, cloth, spindles,
// book spines) are deliberately left unmarked: they read as geometry, but they
// should not carve hard black shadows into a room.
//
// Scale reminders (1 tile = 32x16 px, 1 world unit = 16 px across, 1 z-unit =
// 22 px up): wall 2.2, a person 1.25. Table top ~0.85, chair seat ~0.50, bed
// ~0.55, wardrobe ~2.0, counter ~0.95, shelf ~1.6.
//
// Orientation: the camera looks from +x +y, so the front of every piece faces
// +y (or +x) — drawer fronts, doors, seats, fireboxes are all on a face the
// camera can see, and `rots: 4` bakes the other three quarter turns.
//
// Three pieces are wall/ceiling mounted and are meant to be placed off the
// floor by the runtime: `furn_clock` (wall, 1.20-1.99), `furn_herbs` (ceiling,
// tied off at 2.17) and `furn_chandelier` (ceiling, body 1.89-2.33). Everything
// else stands on z = 0.
//
// All randomness is `b.rng()` (seeded per descriptor) — never Math.random().

import { Builder } from '../lib/geom.mjs';
import { M } from '../lib/materials.mjs';

void Builder;   // the harness constructs the Builder and passes it to build(b)

const TAU = Math.PI * 2;
const nrm = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };

// ---------------------------------------------------------------------------
// primitives (angled tapered prism, vertical revolve, cone, disc, tilted box)
// ---------------------------------------------------------------------------

/** Angled tapered prism — stretchers, spindles, pipes, handles, chains. */
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
      // clamped at the floor: a leg that ends at z = 0 gets a flat foot instead
      // of a ring of vertices poking through the floorboards
      out.push([
        p[0] + (u[0] * ca + v[0] * sa) * r,
        p[1] + (u[1] * ca + v[1] * sa) * r,
        Math.max(0, p[2] + (u[2] * ca + v[2] * sa) * r),
      ]);
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
  // only chunky members occlude: a 0.02 twine would just smear AO over everything
  if (o.occ !== false && Math.max(r0, r1) >= 0.028) {
    const r = Math.max(r0, r1);
    b.m.occluders.push({
      mn: [Math.min(p0[0], p1[0]) - r, Math.min(p0[1], p1[1]) - r, Math.min(p0[2], p1[2]) - r],
      mx: [Math.max(p0[0], p1[0]) + r, Math.max(p0[1], p1[1]) + r, Math.max(p0[2], p1[2]) + r],
    });
  }
}

/** Vertical revolve. Barrels, pots, jars, turned legs, bowls. */
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
    if (Math.abs(dr) < 1e-6 && Math.abs(dz) < 1e-6) continue;
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
  if (o.occ || o.vol) b.m.occluders.push({ mn: [cx - mr, cy - mr, bot[0]], mx: [cx + mr, cy + mr, top[0]] });
  if (o.vol) b.mark('solid', cx - mr, cy - mr, bot[0], mr * 2, mr * 2, top[0] - bot[0]);
}

/** Cone with correctly tilted normals (cylinder with rTop:0 shades wrong). */
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
  const m = typeof mat === 'function' ? mat : (i) => mat;
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const am = ((i + 0.5) / sides) * TAU + rot;
    b.m.quad(pts[j], pts[i], apex, apex, m(i), nrm(Math.cos(am) * nr, Math.sin(am) * nr, nz), { gid });
  }
  if (o.bottom) b.fan(pts, m(0), [0, 0, -1], false, { gid: b.m.newGid() });
  if (o.occ) b.m.occluders.push({ mn: [cx - r, cy - r, z0], mx: [cx + r, cy + r, z1] });
}

/** Disc with its axis along y — plates on edge, clock faces, wheels, lids. */
function discY(b, cx, cy, cz, r, t, mat, o = {}) {
  const seg = o.seg || 12;
  const yF = cy + t / 2, yB = cy - t / 2;
  const F = [], Bk = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * TAU;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    F.push([x, yF, z]); Bk.push([x, yB, z]);
  }
  b.fan(F, mat, [0, 1, 0], true, { gid: b.m.newGid() });
  b.fan(Bk, mat, [0, -1, 0], false, { gid: b.m.newGid() });
  const gid = b.m.newGid();
  const rm = o.rimMat !== undefined ? o.rimMat : mat;
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    const am = ((i + 0.5) / seg) * TAU;
    b.m.quad(F[i], F[j], Bk[j], Bk[i], rm, nrm(Math.cos(am), 0, Math.sin(am)), { gid });
  }
}

/** Box tilted about an axis through its centre (leaning frames, book wedges, lids). */
function rotBox(b, cx, cy, cz, w, d, h, axis, ang, mat, o = {}) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const R = (x, y, z) => (axis === 'x' ? [x, y * c - z * s, y * s + z * c]
    : axis === 'y' ? [x * c + z * s, y, -x * s + z * c]
      : [x * c - y * s, x * s + y * c, z]);
  const hw = w / 2, hd = d / 2, hh = h / 2;
  const P = (sx, sy, sz) => { const p = R(sx * hw, sy * hd, sz * hh); return [cx + p[0], cy + p[1], cz + p[2]]; };
  const N = (nx, ny, nz) => R(nx, ny, nz);
  const A = [P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1)];
  const Bq = [P(-1, 1, -1), P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1)];
  const C = [P(1, 1, -1), P(-1, 1, -1), P(-1, 1, 1), P(1, 1, 1)];
  const D = [P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1)];
  const E = [P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)];
  const F = [P(-1, 1, -1), P(1, 1, -1), P(1, -1, -1), P(-1, -1, -1)];
  b.m.quad(A[0], A[1], A[2], A[3], mat, N(1, 0, 0));
  b.m.quad(Bq[0], Bq[1], Bq[2], Bq[3], mat, N(-1, 0, 0));
  b.m.quad(C[0], C[1], C[2], C[3], mat, N(0, 1, 0));
  b.m.quad(D[0], D[1], D[2], D[3], mat, N(0, -1, 0));
  b.m.quad(E[0], E[1], E[2], E[3], mat, N(0, 0, 1));
  b.m.quad(F[0], F[1], F[2], F[3], mat, N(0, 0, -1));
  if (o.occ !== false) {
    const all = [...A, ...Bq, ...C, ...D, ...E, ...F];
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (const p of all) for (let k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; }
    b.m.occluders.push({ mn, mx });
  }
}

/** Turned leg (cove + bead profile) — the thing that stops a chair reading as a box. */
function leg(b, cx, cy, z0, z1, r, mat, o = {}) {
  const S = z1 - z0;
  const prof = [
    [z0, r * 0.70], [z0 + S * 0.025, r], [z0 + S * 0.08, r * 0.84],
    [z0 + S * 0.15, r * 0.58], [z0 + S * 0.22, r * 0.50], [z0 + S * 0.58, r * 0.46],
    [z0 + S * 0.80, r * 0.52], [z0 + S * 0.86, r * 0.76], [z0 + S * 0.92, r * 0.56],
    [z1, r * 0.82],
  ];
  lathe(b, cx, cy, prof, o.sides || 8, mat, { top: false, bottom: false, occ: o.occ !== false });
}

/** Square post. */
function post(b, cx, cy, z0, z1, s, mat, o = {}) { b.box(cx - s / 2, cy - s / 2, z0, s, s, z1 - z0, mat, o); }

/** A slab split into n boards, alternating material — reads as planking. */
function boards(b, x, y, z, w, d, h, n, mats, axis = 'y', o = {}) {
  for (let i = 0; i < n; i++) {
    const m = mats[i % mats.length];
    if (axis === 'y') b.box(x, y + (d * i) / n, z, w, d / n + 0.0015, h, m, o);
    else if (axis === 'x') b.box(x + (w * i) / n, y, z, w / n + 0.0015, d, h, m, o);
    else b.box(x, y, z + (h * i) / n, w, d, h / n + 0.0015, m, o);
  }
}

/** Iron hoop / ring around a lathe body. */
function hoop(b, cx, cy, z, r, t, mat, sides = 12) {
  lathe(b, cx, cy, [[z, r], [z + t, r]], sides, mat, { top: false });
}

/** Tapered flame. Unlit geometry that reads as light because fireGlow is emissive. */
function flame(b, cx, cy, z0, z1, r, mat, o = {}) {
  tube(b, [cx, cy, z0], [cx + (o.dx || 0), cy + (o.dy || 0), z1], r, r * 0.10, o.sides || 5, mat, { occ: false });
}

/**
 * A candle: stick, wick, flame. The flame is deliberately oversized — at 16 px
 * per tile a physically-sized flame is one pixel and vanishes; this one is a
 * 3-4 px warm blob with a pale core pushed toward the camera (so the core is not
 * swallowed by the orange body it sits inside).
 */
function candle(b, cx, cy, z0, h, r, mat) {
  lathe(b, cx, cy, [[z0, r], [z0 + h * 0.86, r * 0.94], [z0 + h, r * 0.8]], 8, mat, { occ: false });
  b.box(cx - 0.006, cy - 0.006, z0 + h, 0.012, 0.012, 0.022, M('black'), { occ: false });
  flame(b, cx, cy, z0 + h + 0.015, z0 + h + 0.155, r * 1.55, M('fireGlow'), { sides: 6 });
  flame(b, cx + 0.014, cy + 0.014, z0 + h + 0.04, z0 + h + 0.135, r * 0.8, M('lampGlass'), { sides: 5 });
}

/** Flat oval braided rug. `bands` outermost first: {f: radius fraction, a, b}. */
function ovalRug(b, cx, cy, rx, ry, bands, seg = 26) {
  const ZT = 0.022;
  const pt = (i, f) => { const a = (i / seg) * TAU; return [cx + Math.cos(a) * rx * f, cy + Math.sin(a) * ry * f]; };
  const gid = b.m.newGid();
  for (let k = 0; k < bands.length; k++) {
    const fo = bands[k].f, fi = bands[k + 1] ? bands[k + 1].f : 0;
    const bd = bands[k];
    if (fi <= 0.0001) {
      const pts = [];
      for (let i = 0; i < seg; i++) { const p = pt(i, fo); pts.push([p[0], p[1], ZT]); }
      b.fan(pts, bd.a, [0, 0, 1], true, { gid });
      break;
    }
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      const A = pt(i, fo), B = pt(j, fo), C = pt(j, fi), D = pt(i, fi);
      b.m.quad([A[0], A[1], ZT], [B[0], B[1], ZT], [C[0], C[1], ZT], [D[0], D[1], ZT],
        (i >> 1) % 2 ? bd.a : bd.b, [0, 0, 1], { gid });
    }
  }
  // rim + underside
  b.mark('solid', cx - rx, cy - ry, 0, rx * 2, ry * 2, 0.02);
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    const A = pt(i, 1), B = pt(j, 1);
    b.m.quad([A[0], A[1], 0], [B[0], B[1], 0], [B[0], B[1], ZT], [A[0], A[1], ZT], bands[0].b, nrm(A[0] - cx, A[1] - cy, 0.25));
  }
  const pts = [];
  for (let i = 0; i < seg; i++) { const p = pt(i, 1); pts.push([p[0], p[1], 0]); }
  b.fan(pts, bands[bands.length - 1].b, [0, 0, -1], false, { gid: b.m.newGid() });
}

/** Flat rectangular braided rug: nested frames, then a fringe at both ends. */
function rectRug(b, x, y, w, d, bands, mat) {
  const ZT = 0.02;
  const gid = b.m.newGid();
  for (let k = 0; k < bands.length; k++) {
    const i = bands[k].i, m = bands[k].m;
    const j = bands[k + 1] ? bands[k + 1].i : 0.92;
    const x0 = x + w * i, x1 = x + w * (1 - i), y0 = y + d * i, y1 = y + d * (1 - i);
    const X0 = x + w * j, X1 = x + w * (1 - j), Y0 = y + d * j, Y1 = y + d * (1 - j);
    const q = (ax, ay, bx, by) => b.m.quad([ax, ay, ZT], [bx, ay, ZT], [bx, by, ZT], [ax, by, ZT], m, [0, 0, 1], { gid });
    q(x0, y0, x1, Y0);              // front band
    q(x0, Y1, x1, y1);              // back band
    q(x0, Y0, X0, Y1);              // left band
    q(X1, Y0, x1, Y1);              // right band
  }
  b.mark('solid', x, y, 0, w, d, 0.018);
  b.box(x - 0.012, y - 0.012, 0, w + 0.024, d + 0.024, 0.015, mat, { occ: false, skip: { pz: true } });
  b.box(x + 0.02, y + 0.02, 0.014, w - 0.04, d - 0.04, 0.008, bands[bands.length - 1].m, { occ: false });
  for (let i = 0; i < 9; i++) {   // fringe
    const fx = x + (w * (i + 0.5)) / 9;
    for (const fy of [y - 0.012, y + d + 0.012]) {
      tube(b, [fx, fy, 0.008], [fx + (i % 2 ? 0.012 : -0.012), fy + (fy < y ? -0.045 : 0.045), 0.005], 0.008, 0.004, 3, M('clothCream'), { occ: false });
    }
  }
}

// ===========================================================================
// SLEEPING
// ===========================================================================

function buildBed(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), WL = M('woodPlankLt');
  const QU = M('clothBlue'), QR = M('clothRed'), CR = M('clothCream'), CP = M('clothPink');
  // ---- frame -------------------------------------------------------------
  for (const [x, y, top] of [[0.09, 0.11, 1.02], [0.91, 0.11, 1.02], [0.09, 1.89, 0.58], [0.91, 1.89, 0.58]]) {
    post(b, x, y, 0, top, 0.075, WK);
    b.box(x - 0.05, y - 0.05, top, 0.1, 0.1, 0.035, WL, { occ: false });
    if (top > 1) { // head-post finial
      lathe(b, x, y, [[top + 0.035, 0.028], [top + 0.06, 0.042], [top + 0.10, 0.03], [top + 0.13, 0.006]], 7, W, { occ: false });
    }
  }
  b.box(0.06, 0.09, 0.30, 0.88, 1.82, 0.14, W);              // side rails / box
  b.mark('solid', 0.06, 0.09, 0.30, 0.88, 1.82, 0.16);
  b.box(0.06, 0.05, 0.44, 0.88, 0.11, 0.50, W);              // headboard panel
  b.box(0.10, 0.16, 0.50, 0.80, 0.02, 0.38, WL, { occ: false });  // raised panel
  b.box(0.05, 0.045, 0.94, 0.90, 0.13, 0.075, WK);           // head rail
  b.box(0.07, 1.86, 0.36, 0.86, 0.09, 0.20, W);              // foot rail
  b.box(0.06, 1.84, 0.56, 0.88, 0.13, 0.045, WL, { occ: false });
  // ---- bedding -----------------------------------------------------------
  b.box(0.10, 0.16, 0.44, 0.80, 1.70, 0.12, CR);             // straw tick / mattress
  b.box(0.05, 0.70, 0.30, 0.90, 1.20, 0.28, QU);             // quilt (drapes over the sides)
  b.box(0.045, 0.70, 0.578, 0.91, 0.26, 0.022, QR, { occ: false });   // stripe 1
  b.box(0.045, 1.28, 0.578, 0.91, 0.26, 0.022, QR, { occ: false });   // stripe 2
  b.box(0.045, 1.80, 0.578, 0.91, 0.10, 0.022, CR, { occ: false });   // quilt hem at the foot
  b.box(0.045, 0.66, 0.578, 0.91, 0.06, 0.026, CR, { occ: false });   // top edge of the turn-down
  b.box(0.05, 0.60, 0.72, 0.90, 0.20, 0.16, CR);             // sheet turn-down
  b.box(0.22, 1.05, 0.582, 0.14, 0.15, 0.012, M('clothYellow'), { occ: false }); // patch
  b.box(0.13, 0.20, 0.56, 0.74, 0.34, 0.10, CR);             // pillow
  b.box(0.17, 0.24, 0.66, 0.66, 0.26, 0.05, M('white'), { occ: false });
  b.box(0.155, 0.545, 0.60, 0.70, 0.03, 0.045, CP, { occ: false }); // pillow piping
}

function buildCot(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), H = M('hay'), CR = M('clothCream'), CB = M('clothGreen');
  for (const [x, y] of [[0.12, 0.14], [0.88, 0.14], [0.12, 1.86], [0.88, 1.86]]) post(b, x, y, 0, 0.34, 0.06, WK);
  b.box(0.09, 0.11, 0.28, 0.06, 1.78, 0.07, W);
  b.box(0.85, 0.11, 0.28, 0.06, 1.78, 0.07, W);
  tube(b, [0.12, 0.16, 0.12], [0.12, 1.84, 0.28], 0.018, 0.018, 4, WK);
  tube(b, [0.12, 1.84, 0.12], [0.12, 0.16, 0.28], 0.018, 0.018, 4, WK);
  tube(b, [0.88, 0.16, 0.12], [0.88, 1.84, 0.28], 0.018, 0.018, 4, WK);
  tube(b, [0.88, 1.84, 0.12], [0.88, 0.16, 0.28], 0.018, 0.018, 4, WK);
  boards(b, 0.10, 0.13, 0.34, 0.80, 1.74, 0.05, 4, [W, WK], 'y');
  b.mark('solid', 0.09, 0.11, 0.28, 0.82, 1.78, 0.12);
  b.box(0.13, 0.17, 0.39, 0.74, 1.66, 0.10, H);              // straw tick
  b.box(0.10, 0.86, 0.40, 0.80, 0.96, 0.15, CB);             // blanket
  b.box(0.075, 0.86, 0.40, 0.03, 0.96, 0.12, CB, { occ: false });
  b.box(0.895, 0.86, 0.40, 0.03, 0.96, 0.12, CB, { occ: false });
  b.box(0.10, 0.90, 0.51, 0.80, 0.16, 0.05, M('clothTeal'), { occ: false });
  b.box(0.19, 0.22, 0.47, 0.62, 0.30, 0.10, CR);             // pillow
  b.box(0.08, 0.05, 0.30, 0.84, 0.09, 0.30, W);              // headboard
  b.box(0.06, 0.03, 0.58, 0.88, 0.13, 0.05, WK, { occ: false });
}

function buildCradle(b) {
  const W = M('woodPlank'), WL = M('woodPlankLt'), WK = M('woodPlankDk'), CP = M('clothPink'), CR = M('clothCream');
  // ---- rockers (chord along y, ends lifted) ------------------------------
  for (const rx of [0.2, 0.8]) {
    let prev = null;
    for (let i = 0; i <= 7; i++) {
      const t = i / 7;
      const p = [rx, 0.09 + 0.82 * t, 0.032 + 0.14 * (2 * t - 1) * (2 * t - 1)];
      if (prev) tube(b, prev, p, 0.028, 0.028, 5, WK);
      prev = p;
    }
  }
  // ---- posts -------------------------------------------------------------
  for (const [x, y, zr] of [[0.24, 0.27, 0.075], [0.76, 0.27, 0.075], [0.24, 0.73, 0.075], [0.76, 0.73, 0.075]]) {
    tube(b, [x, y, zr], [x, y, 0.34], 0.027, 0.024, 5, WK);
  }
  // ---- slatted basket ----------------------------------------------------
  b.box(0.17, 0.19, 0.30, 0.66, 0.62, 0.045, W);
  b.mark('solid', 0.17, 0.19, 0.30, 0.66, 0.62, 0.06);
  const slat = [[0.335, 0.40], [0.415, 0.48], [0.495, 0.565]];
  for (const [z0, z1] of slat) {
    b.box(0.16, 0.18, z0, 0.68, 0.03, z1 - z0, W, { occ: false });
    b.box(0.16, 0.79, z0, 0.68, 0.03, z1 - z0, W, { occ: false });
    b.box(0.16, 0.20, z0, 0.03, 0.60, z1 - z0, WL, { occ: false });
    b.box(0.81, 0.20, z0, 0.03, 0.60, z1 - z0, WL, { occ: false });
  }
  b.box(0.15, 0.17, 0.555, 0.70, 0.05, 0.03, WK, { occ: false });   // rim
  // ---- hood over the head end: a cloth canopy stretched over wire hoops ----
  for (const hx of [0.22, 0.5, 0.78]) {
    let prev = null;
    for (let i = 0; i <= 5; i++) {
      const a = Math.PI - (i / 5) * (Math.PI / 2);
      const p = [hx, 0.44 + Math.cos(a) * 0.30, 0.555 + Math.sin(a) * 0.30];
      if (prev) tube(b, prev, p, 0.019, 0.019, 4, WK);
      prev = p;
    }
  }
  for (const a of [0.86, 0.5, 0.16]) {
    const ang = Math.PI - a * (Math.PI / 2);
    tube(b, [0.20, 0.44 + Math.cos(ang) * 0.30, 0.555 + Math.sin(ang) * 0.30],
      [0.80, 0.44 + Math.cos(ang) * 0.30, 0.555 + Math.sin(ang) * 0.30], 0.016, 0.016, 4, WL);
  }
  for (const [a0, a1] of [[0.86, 0.5], [0.5, 0.16]]) {
    const A0 = Math.PI - a0 * (Math.PI / 2), A1 = Math.PI - a1 * (Math.PI / 2);
    const hy0 = 0.44 + Math.cos(A0) * 0.285, hz0 = 0.555 + Math.sin(A0) * 0.285;
    const hy1 = 0.44 + Math.cos(A1) * 0.285, hz1 = 0.555 + Math.sin(A1) * 0.285;
    b.m.quad([0.22, hy0, hz0], [0.78, hy0, hz0], [0.78, hy1, hz1], [0.22, hy1, hz1],
      CP, nrm(0, hz1 - hz0, -(hy1 - hy0)), { occ: false });
  }
  b.box(0.22, 0.30, 0.335, 0.56, 0.42, 0.075, CP);           // blanket
  b.box(0.20, 0.28, 0.40, 0.60, 0.10, 0.035, CR, { occ: false });
}

function buildNightstand(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), WL = M('woodPlankLt');
  for (const [x, y] of [[0.17, 0.19], [0.83, 0.19], [0.17, 0.81], [0.83, 0.81]]) leg(b, x, y, 0, 0.27, 0.045, WK);
  b.solidBox(0.13, 0.14, 0.24, 0.74, 0.72, 0.42, W);         // carcass
  b.box(0.15, 0.16, 0.28, 0.70, 0.70, 0.04, WK, { occ: false });
  b.box(0.09, 0.10, 0.66, 0.82, 0.80, 0.06, WL);             // top
  b.box(0.10, 0.11, 0.60, 0.80, 0.78, 0.02, WK, { occ: false });
  b.box(0.19, 0.86, 0.33, 0.62, 0.022, 0.23, WK);            // drawer front
  b.box(0.23, 0.882, 0.365, 0.54, 0.012, 0.16, W, { occ: false });
  for (const kx of [0.37, 0.63]) {
    tube(b, [kx, 0.882, 0.445], [kx, 0.912, 0.445], 0.021, 0.014, 6, M('copper'), { cap: true, capMat: M('copper') });
  }
  // a book left on top
  b.box(0.20, 0.24, 0.72, 0.26, 0.34, 0.045, M('clothRed'));
  b.box(0.225, 0.265, 0.765, 0.21, 0.29, 0.012, M('paper'), { occ: false });
}

function buildWardrobe(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), WL = M('woodPlankLt'), BD = M('beamDk'), CO = M('copper');
  b.box(0.07, 0.12, 0, 0.86, 0.66, 0.09, BD);                // plinth
  b.solidBox(0.07, 0.12, 0.09, 0.86, 0.66, 1.89, WK);        // carcass
  b.box(0.10, 0.15, 0.09, 0.80, 0.60, 1.89, M('beam'), { occ: false });   // interior mass
  b.box(0.05, 0.10, 1.98, 0.90, 0.70, 0.06, WL);             // top
  b.band(0.05, 0.10, 2.04, 0.90, 0.70, 0.05, 0.035, WL);     // cornice
  // ---- doors on the +y face ---------------------------------------------
  for (const dx of [0.125, 0.5]) {
    b.box(dx, 0.78, 0.14, 0.375, 0.028, 1.80, W);
    b.box(dx + 0.045, 0.808, 1.16, 0.285, 0.012, 0.66, WL, { occ: false });
    b.box(dx + 0.045, 0.808, 0.30, 0.285, 0.012, 0.72, WL, { occ: false });
  }
  b.box(0.475, 0.80, 0.14, 0.05, 0.024, 1.80, WK, { occ: false });
  b.box(0.10, 0.795, 1.90, 0.80, 0.03, 0.06, WK, { occ: false });
  b.box(0.10, 0.795, 0.12, 0.80, 0.03, 0.07, WK, { occ: false });
  for (const kx of [0.44, 0.56]) tube(b, [kx, 0.806, 1.02], [kx, 0.848, 1.02], 0.026, 0.017, 6, CO, { cap: true, capMat: CO });
}

function buildDresser(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), WL = M('woodPlankLt'), CO = M('copper');
  for (const [x, y] of [[0.17, 0.29], [0.83, 0.29], [0.17, 0.69], [0.83, 0.69]]) {
    lathe(b, x, y, [[0, 0.052], [0.04, 0.062], [0.10, 0.05], [0.14, 0.038]], 8, WK, { top: false });
  }
  b.solidBox(0.10, 0.24, 0.12, 0.80, 0.52, 0.74, W);
  b.box(0.06, 0.20, 0.86, 0.88, 0.60, 0.055, WL);            // top
  b.box(0.07, 0.21, 0.915, 0.86, 0.58, 0.012, WK, { occ: false });
  const rows = [[0.20, 0.17], [0.40, 0.17], [0.60, 0.17]];
  for (const [z0, h] of rows) {
    b.box(0.145, 0.76, z0, 0.71, 0.026, h, WK);
    b.box(0.185, 0.786, z0 + 0.025, 0.63, 0.010, h - 0.05, W, { occ: false });
    for (const kx of [0.36, 0.64]) tube(b, [kx, 0.786, z0 + h / 2], [kx, 0.824, z0 + h / 2], 0.023, 0.015, 6, CO, { cap: true, capMat: CO });
  }
  // bowl + folded cloth on top
  lathe(b, 0.33, 0.46, [[0.915, 0.055], [0.925, 0.10], [0.965, 0.115], [0.995, 0.105]], 12, M('ceramic'), { bottom: true });
  b.box(0.55, 0.30, 0.915, 0.29, 0.34, 0.035, M('clothBlue'));
  b.box(0.55, 0.30, 0.95, 0.29, 0.10, 0.018, M('clothCream'), { occ: false });
}

function buildChest(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), WL = M('woodPlankLt'), IR = M('ironBlack'), CO = M('copper'), BD = M('beamDk');
  for (const [x, y] of [[0.10, 0.16], [0.90, 0.16], [0.10, 0.84], [0.90, 0.84]]) post(b, x, y, 0, 0.58, 0.07, BD);
  // body: three horizontal boards per side, so it reads as a joined chest
  boards(b, 0.135, 0.19, 0.10, 0.73, 0.62, 0.40, 3, [W, WK, W], 'z');
  b.mark('solid', 0.12, 0.18, 0.06, 0.76, 0.64, 0.50);
  b.band(0.14, 0.20, 0.17, 0.72, 0.60, 0.05, 0.016, IR);
  b.band(0.14, 0.20, 0.40, 0.72, 0.60, 0.05, 0.016, IR);
  // domed lid, clearly proud of the body
  b.box(0.05, 0.11, 0.50, 0.90, 0.78, 0.07, WL);
  b.box(0.09, 0.15, 0.57, 0.82, 0.70, 0.045, WL, { occ: false });
  b.box(0.15, 0.21, 0.615, 0.70, 0.58, 0.03, W, { occ: false });
  for (const sy of [0.24, 0.76]) {                            // straps run up over the lid
    b.box(0.05, sy, 0.50, 0.90, 0.06, 0.075, IR, { occ: false });
    b.box(0.09, sy, 0.575, 0.82, 0.06, 0.05, IR, { occ: false });
    b.box(0.16, sy, 0.615, 0.68, 0.06, 0.035, IR, { occ: false });
  }
  b.box(0.42, 0.885, 0.24, 0.16, 0.026, 0.34, IR, { occ: false });    // hasp
  b.box(0.45, 0.912, 0.42, 0.10, 0.024, 0.12, CO, { occ: false });    // lock plate
  tube(b, [0.5, 0.22, 0.665], [0.5, 0.62, 0.665], 0.058, 0.05, 7, M('clothRed'), { cap: true, capMat: M('clothRed') });  // rolled blanket
  for (const sx of [0.10, 0.87]) b.box(sx, 0.44, 0.26, 0.03, 0.16, 0.05, IR, { occ: false });
}

// ===========================================================================
// SEATING
// ===========================================================================

function buildChair(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), WL = M('woodPlankLt');
  for (const [x, y] of [[0.27, 0.72], [0.73, 0.72]]) leg(b, x, y, 0, 0.47, 0.043, WK);
  for (const x of [0.27, 0.73]) tube(b, [x, 0.30, 0.02], [x, 0.235, 0.99], 0.038, 0.028, 6, WK);
  b.solidBox(0.20, 0.20, 0.44, 0.60, 0.58, 0.055, W);        // seat frame
  b.box(0.23, 0.23, 0.495, 0.54, 0.52, 0.025, WL, { occ: false });
  b.box(0.185, 0.185, 0.40, 0.63, 0.63, 0.045, WK, { occ: false });
  // stretchers — a chair without them reads as a floating slab
  tube(b, [0.27, 0.70, 0.19], [0.27, 0.32, 0.19], 0.022, 0.022, 5, WK);
  tube(b, [0.73, 0.70, 0.19], [0.73, 0.32, 0.19], 0.022, 0.022, 5, WK);
  tube(b, [0.27, 0.51, 0.17], [0.73, 0.51, 0.17], 0.02, 0.02, 5, WK);
  // ladder back
  b.box(0.265, 0.245, 0.60, 0.47, 0.028, 0.115, W);
  b.box(0.265, 0.235, 0.77, 0.47, 0.026, 0.10, WK);
  b.box(0.255, 0.225, 0.93, 0.49, 0.032, 0.075, W);
  b.box(0.29, 0.243, 0.63, 0.42, 0.012, 0.055, WL, { occ: false });
}

function buildStool(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), WL = M('woodPlankLt');
  lathe(b, 0.5, 0.5, [[0.44, 0.235], [0.475, 0.245], [0.505, 0.24]], 12, W, { topMat: WL, bottom: true, vol: true });
  b.box(0.24, 0.24, 0.47, 0.52, 0.52, 0.03, WK, { occ: false, skip: { pz: true } });
  const d = 0.16, e = 0.27;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    tube(b, [0.5 + sx * d, 0.5 + sy * d, 0.44], [0.5 + sx * e, 0.5 + sy * e, 0], 0.032, 0.024, 6, WK);
  }
  // octagonal stretcher ring
  const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => [0.5 + sx * 0.215, 0.5 + sy * 0.215]);
  for (let i = 0; i < 4; i++) {
    const p = pts[i], q = pts[(i + 1) % 4];
    tube(b, [p[0], p[1], 0.155], [q[0], q[1], 0.155], 0.018, 0.018, 4, W);
  }
}

function buildBench(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), WL = M('woodPlankLt');
  boards(b, 0.13, 0.20, 0.43, 1.74, 0.60, 0.055, 2, [WL, W], 'y');
  b.box(0.10, 0.19, 0.40, 1.80, 0.62, 0.03, WK, { occ: false });
  b.mark('solid', 0.10, 0.19, 0.40, 1.80, 0.62, 0.09);
  for (const [x, y] of [[0.22, 0.30], [1.78, 0.30], [0.22, 0.70], [1.78, 0.70]]) leg(b, x, y, 0, 0.43, 0.05, WK);
  tube(b, [0.22, 0.30, 0.14], [1.78, 0.30, 0.14], 0.024, 0.024, 5, W);
  tube(b, [0.22, 0.70, 0.14], [1.78, 0.70, 0.14], 0.024, 0.024, 5, W);
  tube(b, [0.22, 0.30, 0.14], [1.78, 0.70, 0.14], 0.016, 0.016, 4, WK);
  tube(b, [0.22, 0.70, 0.14], [1.78, 0.30, 0.14], 0.016, 0.016, 4, WK);
  for (const x of [0.22, 1.78]) tube(b, [x, 0.30, 0.42], [x, 0.245, 0.90], 0.036, 0.03, 6, WK);
  tube(b, [0.22, 0.245, 0.855], [1.78, 0.245, 0.855], 0.038, 0.038, 6, W);
  tube(b, [0.28, 0.262, 0.64], [1.72, 0.262, 0.64], 0.024, 0.024, 5, WK);
  b.box(0.60, 0.226, 0.70, 0.80, 0.03, 0.10, WL, { occ: false });
}

function buildArmchair(b) {
  const CF = M('clothGreen'), CR = M('clothCream'), CY = M('clothYellow'), WK = M('woodPlankDk'), W = M('woodPlank');
  for (const [x, y] of [[0.18, 0.19], [0.82, 0.19], [0.18, 0.81], [0.82, 0.81]]) {
    lathe(b, x, y, [[0, 0.05], [0.06, 0.058], [0.16, 0.048], [0.20, 0.04]], 8, WK, { top: false });
  }
  b.solidBox(0.14, 0.15, 0.18, 0.72, 0.72, 0.26, WK);
  b.box(0.19, 0.20, 0.42, 0.62, 0.60, 0.13, CF);             // seat cushion
  b.box(0.22, 0.23, 0.55, 0.56, 0.54, 0.05, CF, { occ: false });
  b.box(0.20, 0.63, 0.43, 0.60, 0.03, 0.085, CR, { occ: false });   // piping
  b.solidBox(0.16, 0.14, 0.42, 0.68, 0.18, 0.60, CF);        // back
  b.box(0.20, 0.155, 0.60, 0.60, 0.03, 0.30, CF, { occ: false });
  tube(b, [0.17, 0.23, 1.03], [0.83, 0.23, 1.03], 0.075, 0.075, 9, CF);
  tube(b, [0.17, 0.22, 1.02], [0.83, 0.22, 1.05], 0.03, 0.03, 6, CR, { occ: false });   // pale top roll line
  // arms: a wooden frame with a fat roll on top, kept clear of the body so the
  // silhouette reads
  for (const ax of [0.135, 0.865]) {
    b.box(ax - 0.035, 0.18, 0.40, 0.07, 0.56, 0.22, WK);
    tube(b, [ax, 0.17, 0.68], [ax, 0.75, 0.68], 0.075, 0.075, 8, CF);
    tube(b, [ax, 0.16, 0.70], [ax, 0.76, 0.70], 0.026, 0.026, 6, CR, { occ: false });
    lathe(b, ax, 0.75, [[0.62, 0.06], [0.68, 0.078], [0.74, 0.06]], 8, CF, { top: false, occ: false });
  }
  b.box(0.50, 0.28, 0.60, 0.28, 0.30, 0.10, CY);             // throw pillow
  b.box(0.24, 0.30, 0.60, 0.24, 0.26, 0.09, M('clothRed'), { occ: false });
}

function buildRocker(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), WL = M('woodPlankLt');
  for (const rx of [0.21, 0.79]) {
    let prev = null;
    for (let i = 0; i <= 7; i++) {
      const t = i / 7;
      const p = [rx, 0.09 + 0.82 * t, 0.035 + 0.14 * (2 * t - 1) * (2 * t - 1)];
      if (prev) tube(b, prev, p, 0.03, 0.03, 5, WK);
      prev = p;
    }
  }
  for (const [x, y0, y1] of [[0.21, 0.72, 0.70], [0.79, 0.72, 0.70], [0.21, 0.28, 0.34], [0.79, 0.28, 0.34]]) {
    tube(b, [x, y0, 0.075], [x, y1, 0.45], 0.03, 0.027, 5, WK);
  }
  b.solidBox(0.19, 0.22, 0.43, 0.62, 0.54, 0.055, W);
  b.box(0.22, 0.25, 0.485, 0.56, 0.48, 0.022, WL, { occ: false });
  // spindle back, raked
  for (const x of [0.24, 0.76]) tube(b, [x, 0.33, 0.46], [x, 0.255, 1.02], 0.03, 0.026, 6, WK);
  tube(b, [0.24, 0.255, 1.00], [0.76, 0.255, 1.00], 0.036, 0.036, 6, W);
  for (const sx of [0.33, 0.41, 0.5, 0.59, 0.67]) tube(b, [sx, 0.325, 0.47], [sx, 0.262, 0.99], 0.016, 0.014, 5, WL);
  for (const ax of [0.21, 0.79]) {
    tube(b, [ax, 0.70, 0.50], [ax, 0.70, 0.665], 0.024, 0.022, 5, WK);
    tube(b, [ax, 0.70, 0.685], [ax, 0.31, 0.745], 0.024, 0.022, 5, W);
  }
}

// ===========================================================================
// TABLES / SURFACES
// ===========================================================================

function buildTable(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), WL = M('woodPlankLt');
  for (const [x, y] of [[0.26, 0.26], [1.74, 0.26], [0.26, 1.74], [1.74, 1.74]]) leg(b, x, y, 0, 0.80, 0.075, W, { sides: 9 });
  boards(b, 0.10, 0.10, 0.80, 1.80, 1.80, 0.075, 3, [WL, W, WL], 'y', { faces: { pz: WL } });
  b.mark('solid', 0.10, 0.10, 0.80, 1.80, 1.80, 0.09);
  b.box(0.20, 0.22, 0.66, 1.60, 0.05, 0.14, WK, { occ: false });
  b.box(0.20, 1.73, 0.66, 1.60, 0.05, 0.14, WK, { occ: false });
  b.box(0.22, 0.20, 0.66, 0.05, 1.60, 0.14, WK, { occ: false });
  b.box(1.73, 0.20, 0.66, 0.05, 1.60, 0.14, WK, { occ: false });
  tube(b, [0.26, 0.26, 0.26], [1.74, 0.26, 0.26], 0.033, 0.033, 6, W);
  tube(b, [0.26, 1.74, 0.26], [1.74, 1.74, 0.26], 0.033, 0.033, 6, W);
  tube(b, [0.26, 0.26, 0.26], [0.26, 1.74, 0.26], 0.028, 0.028, 5, WK);
  tube(b, [1.74, 0.26, 0.26], [1.74, 1.74, 0.26], 0.028, 0.028, 5, WK);
  tube(b, [1.0, 0.26, 0.26], [1.0, 1.74, 0.26], 0.024, 0.024, 5, WK);
  // a bowl of apples, so the table is not a bare slab
  lathe(b, 0.72, 0.66, [[0.875, 0.075], [0.885, 0.13], [0.935, 0.15], [0.975, 0.135]], 12, M('ceramic'), { bottom: true });
  for (const [ax, ay, az] of [[0.70, 0.64, 0.965], [0.76, 0.68, 0.965], [0.72, 0.70, 0.995]]) {
    b.dome(ax, ay, az - 0.02, 0.05, 0.075, M('cropBerry'), { seg: 8, rings: 3 });
    tube(b, [ax, ay, az + 0.05], [ax + 0.012, ay + 0.01, az + 0.085], 0.008, 0.006, 4, WK);
  }
}

function buildTableSmall(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), WL = M('woodPlankLt');
  lathe(b, 0.5, 0.5, [
    [0.735, 0.35], [0.752, 0.415], [0.775, 0.42], [0.79, 0.412],
  ], 14, W, { topMat: WL, top: true });
  lathe(b, 0.5, 0.5, [
    [0, 0.21], [0.035, 0.215], [0.07, 0.17], [0.10, 0.085], [0.20, 0.062],
    [0.34, 0.055], [0.44, 0.05], [0.52, 0.058], [0.56, 0.075], [0.60, 0.062],
    [0.64, 0.085], [0.70, 0.072], [0.735, 0.10],
  ], 10, W, { top: false, vol: true });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    tube(b, [0.5 + Math.cos(a) * 0.075, 0.5 + Math.sin(a) * 0.075, 0.085],
      [0.5 + Math.cos(a) * 0.235, 0.5 + Math.sin(a) * 0.235, 0.008], 0.03, 0.022, 5, WK);
  }
  lathe(b, 0.5, 0.5, [[0.70, 0.115], [0.735, 0.125]], 12, WK, { top: false });
  // a cup left behind
  lathe(b, 0.62, 0.38, [[0.79, 0.045], [0.805, 0.056], [0.855, 0.058], [0.87, 0.05]], 10, M('ceramic'), { bottom: true });
  tube(b, [0.663, 0.38, 0.80], [0.663, 0.38, 0.845], 0.012, 0.012, 5, M('ceramic'), { occ: false });
  b.m.quad([0.66, 0.393, 0.795], [0.69, 0.393, 0.80], [0.69, 0.393, 0.85], [0.66, 0.393, 0.845], M('ceramic'), [0, 0, 1]);
}

function buildDesk(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), WL = M('woodPlankLt');
  for (const [x, y] of [[0.18, 0.22], [1.82, 0.22], [0.18, 0.78], [1.82, 0.78]]) leg(b, x, y, 0, 0.72, 0.055, WK);
  boards(b, 0.06, 0.10, 0.72, 1.88, 0.78, 0.06, 3, [W, WL, W], 'y', { faces: { pz: WL } });
  b.mark('solid', 0.06, 0.10, 0.72, 1.88, 0.78, 0.07);
  b.box(0.15, 0.72, 0.545, 1.70, 0.06, 0.175, WK, { occ: false });   // front apron
  b.box(0.15, 0.22, 0.545, 0.06, 0.50, 0.175, WK, { occ: false });
  b.box(1.79, 0.22, 0.545, 0.06, 0.50, 0.175, WK, { occ: false });
  b.box(0.44, 0.78, 0.575, 0.94, 0.026, 0.115, W, { occ: false });   // drawer
  b.box(0.50, 0.806, 0.595, 0.82, 0.010, 0.075, WL, { occ: false });
  tube(b, [1.0, 0.808, 0.632], [1.0, 0.845, 0.632], 0.023, 0.015, 6, M('copper'), { cap: true, capMat: M('copper') });
  // desktop clutter: paper, inkwell, quill, books
  b.box(0.62, 0.24, 0.78, 0.56, 0.36, 0.006, M('paper'), { occ: false });
  b.box(0.66, 0.28, 0.786, 0.48, 0.28, 0.004, M('white'), { occ: false });
  lathe(b, 1.28, 0.34, [[0.78, 0.045], [0.80, 0.055], [0.845, 0.055], [0.86, 0.045]], 8, M('ceramicBlue'), { bottom: true });
  tube(b, [1.28, 0.30, 0.83], [1.20, 0.20, 1.02], 0.008, 0.016, 4, M('white'));
  b.m.quad([1.20, 0.20, 0.95], [1.13, 0.30, 0.99], [1.20, 0.24, 1.09], [1.24, 0.20, 1.03], M('white'), [0.2, -0.6, 0.6], { detail: 1 });
  b.box(1.46, 0.22, 0.78, 0.34, 0.44, 0.035, M('clothRed'));
  b.box(1.49, 0.25, 0.815, 0.28, 0.38, 0.028, M('clothBlue'), { occ: false });
  b.box(1.52, 0.28, 0.843, 0.22, 0.32, 0.012, M('paper'), { occ: false });
}

function buildSideTable(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), WL = M('woodPlankLt'), CO = M('copper');
  for (const [x, y] of [[0.20, 0.22], [0.80, 0.22], [0.20, 0.78], [0.80, 0.78]]) leg(b, x, y, 0, 0.60, 0.036, WK, { sides: 7 });
  b.box(0.09, 0.11, 0.60, 0.82, 0.78, 0.05, WL);
  b.box(0.10, 0.12, 0.65, 0.80, 0.76, 0.015, WK, { occ: false });
  b.mark('solid', 0.10, 0.12, 0.58, 0.80, 0.76, 0.08);
  b.box(0.17, 0.70, 0.40, 0.66, 0.09, 0.20, W);              // apron / drawer
  b.box(0.28, 0.79, 0.44, 0.44, 0.026, 0.115, WK, { occ: false });
  tube(b, [0.5, 0.795, 0.498], [0.5, 0.828, 0.498], 0.021, 0.014, 6, CO, { cap: true, capMat: CO });
  b.box(0.16, 0.18, 0.19, 0.68, 0.64, 0.03, W);              // lower shelf
  b.box(0.20, 0.24, 0.22, 0.24, 0.30, 0.05, M('clothGreen'), { occ: false });
  lathe(b, 0.66, 0.40, [[0.22, 0.05], [0.235, 0.058], [0.29, 0.05]], 8, M('ceramic'), { bottom: true, occ: false });
}

// ===========================================================================
// KITCHEN / HEARTH
// ===========================================================================

function buildCounter(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), WL = M('woodPlankLt'), CO = M('copper');
  b.box(0.09, 0.19, 0, 1.82, 0.62, 0.10, M('beamDk'));       // toe kick
  b.solidBox(0.07, 0.17, 0.09, 1.86, 0.66, 0.80, WK);
  // butcher block: end-grain strips, lighter front edge
  for (let i = 0; i < 6; i++) {
    const x = 0.03 + (1.94 * i) / 6;
    b.box(x, 0.11, 0.88, 1.94 / 6 + 0.002, 0.78, 0.13, i % 2 ? WL : W, { faces: { py: WL, pz: i % 2 ? W : WL } });
  }
  b.mark('solid', 0.02, 0.11, 0.86, 1.96, 0.78, 0.15);
  b.box(0.03, 0.105, 0.955, 1.94, 0.79, 0.025, WK, { occ: false });
  for (const dx of [0.13, 1.05]) {
    b.box(dx, 0.82, 0.16, 0.82, 0.03, 0.66, W);
    b.box(dx + 0.075, 0.848, 0.235, 0.67, 0.012, 0.51, WL, { occ: false });
    tube(b, [dx + (dx < 0.5 ? 0.79 : 0.03), 0.85, 0.49], [dx + (dx < 0.5 ? 0.83 : 0.07), 0.888, 0.49], 0.023, 0.015, 6, CO, { cap: true, capMat: CO });
  }
  b.box(0.03, 0.10, 0.16, 0.05, 0.72, 0.66, WK, { occ: false });
  b.box(1.92, 0.10, 0.16, 0.05, 0.72, 0.66, WK, { occ: false });
  // worktop clutter
  lathe(b, 0.42, 0.45, [[1.00, 0.075], [1.01, 0.135], [1.06, 0.155], [1.10, 0.14]], 12, M('ceramic'), { bottom: true });
  b.dome(0.38, 0.42, 1.075, 0.052, 0.075, M('cropTomato'), { seg: 8, rings: 3 });
  b.dome(0.48, 0.47, 1.075, 0.05, 0.07, M('cropTomato'), { seg: 8, rings: 3 });
  b.box(1.20, 0.30, 0.995, 0.42, 0.30, 0.035, WL, { occ: false });   // chopping board
  b.box(1.62, 0.40, 0.995, 0.10, 0.10, 0.03, WL, { occ: false });
  for (let i = 0; i < 3; i++) {
    lathe(b, 1.50 + i * 0.09, 0.62, [[1.00, 0.042], [1.06, 0.05], [1.17, 0.046]], 8, i % 2 ? M('ceramicBlue') : M('ceramic'), { top: false, occ: false });
  }
}

function buildStove(b) {
  const IR = M('ironBlack'), MD = M('metalDark'), MT = M('metal'), CO = M('copper');
  for (const [x, y] of [[0.21, 0.25], [0.79, 0.25], [0.21, 0.75], [0.79, 0.75]]) post(b, x, y, 0, 0.15, 0.05, IR);
  b.solidBox(0.14, 0.18, 0.13, 0.72, 0.64, 0.53, IR);
  b.box(0.11, 0.15, 0.66, 0.78, 0.70, 0.055, IR);
  b.box(0.10, 0.14, 0.715, 0.80, 0.72, 0.02, MT, { occ: false });
  lathe(b, 0.63, 0.66, [[0.735, 0.10], [0.755, 0.108], [0.765, 0.095]], 12, MD, { occ: false });
  tube(b, [0.63, 0.60, 0.79], [0.63, 0.72, 0.79], 0.012, 0.012, 4, MT, { occ: false });
  // firebox door with a glowing window
  b.box(0.29, 0.82, 0.25, 0.42, 0.025, 0.34, MD);
  b.box(0.32, 0.845, 0.275, 0.36, 0.016, 0.27, M('glassLit'), { occ: false });   // hot glass surround
  b.box(0.355, 0.861, 0.325, 0.29, 0.014, 0.17, M('fireGlow'), { occ: false });   // fire behind it
  b.box(0.34, 0.875, 0.345, 0.32, 0.012, 0.016, IR, { occ: false });
  b.box(0.34, 0.875, 0.455, 0.32, 0.012, 0.016, IR, { occ: false });
  tube(b, [0.70, 0.845, 0.42], [0.74, 0.90, 0.42], 0.014, 0.014, 5, CO);
  b.box(0.36, 0.855, 0.33, 0.28, 0.006, 0.16, M('fireGlow'), { occ: false });
  // flue
  lathe(b, 0.62, 0.36, [[0.735, 0.105], [0.79, 0.093]], 12, IR, { top: false, occ: false });
  b.cylinder(0.62, 0.36, 0.78, 1.30, 0.082, 10, MD, { occ: false });
  hoop(b, 0.62, 0.36, 0.98, 0.092, 0.035, IR, 10);
  lathe(b, 0.62, 0.36, [[1.30, 0.085], [1.36, 0.108], [1.40, 0.10]], 10, IR, { top: false, occ: false });
  b.mark('solid', 0.14, 0.18, 0.13, 0.72, 0.64, 1.16);
  // kettle on the front burner
  lathe(b, 0.34, 0.60, [[0.735, 0.085], [0.75, 0.095], [0.83, 0.098], [0.90, 0.06], [0.925, 0.045], [0.94, 0.06]], 12, CO, { bottom: true });
  tube(b, [0.34, 0.62, 0.78], [0.20, 0.60, 0.68], 0.014, 0.022, 5, CO);
  tube(b, [0.34, 0.63, 0.90], [0.34, 0.60, 0.96], 0.012, 0.012, 4, IR);
  tube(b, [0.34, 0.60, 0.96], [0.34, 0.52, 0.90], 0.012, 0.012, 4, IR);
}

function buildFireplace(b) {
  const ST = M('stone'), SD = M('stoneDk'), SW = M('stoneWarm'), FL = M('flagstone');
  const BM = M('beam'), BD = M('beamDk');
  // piers
  for (const px of [0.07, 1.39]) {
    b.solidBox(px, 0.16, 0, 0.54, 0.74, 1.32, ST);
    for (let i = 0; i < 7; i++) {
      const z = 0.14 + i * 0.17;
      const lx = px + 0.06 + ((i * 37) % 11) / 11 * 0.36;
      b.box(lx, 0.155, z, 0.15, 0.02, 0.11, i % 3 === 0 ? SW : SD, { occ: false });
      b.box(px + 0.05 + ((i * 53) % 9) / 9 * 0.38, 0.885, z + 0.04, 0.14, 0.02, 0.10, i % 2 ? SD : ST, { occ: false });
    }
  }
  b.solidBox(0.07, 0.16, 0.92, 1.86, 0.74, 0.40, ST);        // lintel
  b.box(0.62, 0.16, 0, 0.76, 0.26, 0.92, SD);                // firebox back
  b.box(0.16, 0.40, 0, 0.14, 0.50, 0.92, SD, { occ: false });
  b.box(1.70, 0.40, 0, 0.14, 0.50, 0.92, SD, { occ: false });
  b.box(0.58, 0.36, 0, 0.84, 0.56, 0.06, FL, { occ: false });
  b.box(0.52, 0.88, 0, 0.96, 0.12, 0.045, FL, { occ: false });
  for (let i = 0; i < 9; i++) {                              // soot in the firebox
    const sx = 0.66 + ((i * 41) % 13) / 13 * 0.62;
    b.box(sx, 0.42, 0.5 + ((i * 29) % 7) / 7 * 0.36, 0.09, 0.006, 0.09, M('black'), { occ: false });
  }
  // mantel + corbels
  b.box(0.03, 0.13, 1.32, 1.94, 0.80, 0.11, BM, { occ: false });
  b.box(0.02, 0.12, 1.43, 1.96, 0.82, 0.03, BD, { occ: false });
  for (const cx of [0.22, 1.60]) {
    b.box(cx, 0.16, 1.14, 0.18, 0.42, 0.18, BD, { occ: false });
    b.box(cx + 0.02, 0.17, 1.30, 0.14, 0.40, 0.04, BD, { occ: false });
  }
  b.solidBox(0.30, 0.22, 1.46, 1.40, 0.62, 0.32, M('plasterWarm'));   // chimney breast
  b.box(0.27, 0.19, 1.78, 1.46, 0.68, 0.05, M('beam'), { occ: false });
  // fire
  for (const [ly, lz] of [[0.52, 0.11], [0.60, 0.16], [0.56, 0.21]]) {
    tube(b, [0.68, ly, lz], [1.32, ly + 0.02, lz], 0.048, 0.042, 6, M('bark'));
  }
  for (let i = 0; i < 9; i++) {
    const cx2 = 0.68 + ((i * 17) % 9) / 9 * 0.62;
    b.box(cx2, 0.46 + ((i * 23) % 5) / 5 * 0.22, 0.05, 0.07, 0.07, 0.05, M('coal'), { occ: false });
  }
  for (const [fx, fy, fh] of [[0.78, 0.54, 0.38], [0.92, 0.60, 0.46], [1.06, 0.52, 0.40], [1.20, 0.58, 0.30], [0.99, 0.66, 0.26]]) {
    flame(b, fx, fy, 0.12, 0.12 + fh, 0.075, M('fireGlow'), { sides: 5, dx: 0.02 });
  }
  // mantel dressing
  lathe(b, 0.42, 0.42, [[1.43, 0.06], [1.44, 0.10], [1.50, 0.115], [1.56, 0.10], [1.60, 0.055]], 12, M('ceramicBlue'), { bottom: true });
  discY(b, 1.42, 0.42, 1.55, 0.10, 0.02, M('ceramic'), { seg: 12 });
  discY(b, 1.60, 0.40, 1.55, 0.085, 0.02, M('ceramicBlue'), { seg: 12 });
}

function buildCauldron(b) {
  const IR = M('ironBlack'), CO = M('copper');
  const top = 0.78;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    tube(b, [0.5 + sx * 0.26, 0.5 + sy * 0.26, 0], [0.5 + sx * 0.13, 0.5 + sy * 0.13, top], 0.024, 0.018, 5, IR);
  }
  const fr = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => [0.5 + sx * 0.13, 0.5 + sy * 0.13]);
  for (let i = 0; i < 4; i++) {
    const p = fr[i], q = fr[(i + 1) % 4];
    tube(b, [p[0], p[1], top], [q[0], q[1], top], 0.016, 0.016, 4, IR);
  }
  tube(b, [fr[0][0], fr[0][1], top], [fr[2][0], fr[2][1], top], 0.013, 0.013, 4, IR, { occ: false });
  // hook + bail
  tube(b, [0.5, 0.5, top], [0.5, 0.5, 0.70], 0.013, 0.013, 4, IR, { occ: false });
  tube(b, [0.5, 0.5, 0.70], [0.5, 0.545, 0.665], 0.012, 0.012, 4, IR, { occ: false });
  for (const s of [-1, 1]) {
    tube(b, [0.5, 0.545, 0.665], [0.5 + s * 0.17, 0.5 + s * 0.03, 0.63], 0.011, 0.011, 4, IR, { occ: false });
    tube(b, [0.5 + s * 0.17, 0.5 + s * 0.03, 0.63], [0.5 + s * 0.215, 0.5, 0.585], 0.011, 0.011, 4, IR, { occ: false });
  }
  lathe(b, 0.5, 0.5, [
    [0.215, 0.06], [0.225, 0.13], [0.25, 0.185], [0.30, 0.215], [0.40, 0.228], [0.50, 0.222], [0.56, 0.20],
  ], 14, IR, { top: false, vol: true });
  hoop(b, 0.5, 0.5, 0.52, 0.212, 0.035, CO, 14);
  lathe(b, 0.5, 0.5, [[0.56, 0.20], [0.585, 0.215], [0.60, 0.20]], 14, IR, { top: false, occ: false });
  // stew
  lathe(b, 0.5, 0.5, [[0.545, 0.185], [0.555, 0.19]], 12, M('cropCarrot'), { top: true, occ: false });
  // fire beneath
  for (let i = 0; i < 6; i++) {
    const a = i * 1.05;
    b.box(0.5 + Math.cos(a) * 0.12 - 0.03, 0.5 + Math.sin(a) * 0.12 - 0.03, 0.02, 0.07, 0.07, 0.055, M('coal'), { occ: false });
  }
  for (const [fx, fy] of [[0.42, 0.52], [0.5, 0.44], [0.58, 0.54], [0.5, 0.56]]) {
    flame(b, fx, fy, 0.07, 0.24, 0.06, M('fireGlow'), { sides: 5 });
  }
}

function buildChurn(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), WL = M('woodPlankLt'), IR = M('ironBlack');
  lathe(b, 0.5, 0.5, [
    [0.02, 0.17], [0.05, 0.205], [0.14, 0.225], [0.34, 0.235], [0.52, 0.22], [0.60, 0.20],
  ], 14, (i) => (i % 2 ? W : WK), { top: false, bottom: true, vol: true });
  hoop(b, 0.5, 0.5, 0.10, 0.228, 0.03, IR, 14);
  hoop(b, 0.5, 0.5, 0.44, 0.228, 0.03, IR, 14);
  lathe(b, 0.5, 0.5, [[0.60, 0.20], [0.615, 0.215], [0.645, 0.205]], 14, WK, { top: false, occ: false });
  lathe(b, 0.5, 0.5, [[0.645, 0.185], [0.685, 0.19]], 14, WL, { topMat: WL });
  tube(b, [0.5, 0.5, 0.685], [0.5, 0.5, 1.02], 0.021, 0.021, 6, W);
  tube(b, [0.5, 0.42, 1.02], [0.5, 0.58, 1.02], 0.028, 0.028, 6, WK, { cap: true, capMat: WK });
  tube(b, [0.5, 0.5, 0.30], [0.5, 0.5, 0.72], 0.055, 0.05, 6, WL, { occ: false });
  for (const s of [-1, 1]) tube(b, [0.5, 0.5, 0.62], [0.5 + s * 0.07, 0.5, 0.55], 0.018, 0.018, 4, WL, { occ: false });
  b.box(0.30, 0.86, 0.02, 0.40, 0.10, 0.05, WK, { occ: false });   // a paddle resting on the floor
}

function buildShelfJars(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), WL = M('woodPlankLt');
  b.box(0.12, 0.14, 0.06, 0.76, 0.06, 1.30, WK);             // back
  for (const sx of [0.12, 0.80]) b.box(sx, 0.14, 0.06, 0.08, 0.36, 1.30, WK);
  b.mark('solid', 0.12, 0.14, 0.06, 0.76, 0.36, 1.30);
  for (const z of [0.06, 0.48, 0.90]) b.box(0.10, 0.12, z, 0.80, 0.40, 0.055, WL);
  b.box(0.08, 0.10, 1.28, 0.84, 0.44, 0.06, WL);
  b.box(0.06, 0.08, 1.34, 0.88, 0.48, 0.035, W, { occ: false });
  // jars: two shelves of preserves, each with a lid and a paper label
  const jm = [M('ceramic'), M('ceramicBlue'), M('terracottaPot'), M('wax')];
  const fm = [M('cropBerry'), M('cropCarrot'), M('leafDk'), M('cropMelon'), M('cropPumpkin')];
  for (let s = 0; s < 2; s++) {
    const z0 = s ? 0.535 : 0.115;
    let x = 0.16;
    for (let i = 0; i < 4; i++) {
      const r = 0.055 + b.rng() * 0.022;
      const h = 0.15 + b.rng() * 0.075;
      const cx = x + r;
      lathe(b, cx, 0.30, [[z0, r * 0.9], [z0 + 0.01, r], [z0 + h * 0.75, r], [z0 + h, r * 0.92]], 10, jm[(i + s) % jm.length], { top: false, occ: false });
      lathe(b, cx, 0.30, [[z0 + h * 0.55, r * 0.92], [z0 + h * 0.58, r * 0.95]], 10, fm[(i * 2 + s) % fm.length], { top: false, occ: false });
      lathe(b, cx, 0.30, [[z0 + h, r * 0.92], [z0 + h + 0.025, r * 0.98], [z0 + h + 0.04, r * 0.8]], 10, WK, { occ: false });
      b.box(cx - r * 0.55, 0.30 + r + 0.004, z0 + h * 0.34, r * 1.1, 0.008, h * 0.36, M('paper'), { occ: false });
      x = cx + r + 0.02 + b.rng() * 0.03;
    }
  }
  // a stack of bowls + a jug on top
  for (let i = 0; i < 3; i++) lathe(b, 0.30, 0.30, [[1.375 + i * 0.035, 0.085], [1.39 + i * 0.035, 0.095]], 10, M('ceramic'), { top: false, occ: false });
  lathe(b, 0.66, 0.30, [[1.375, 0.055], [1.39, 0.075], [1.46, 0.08], [1.50, 0.05]], 10, M('ceramicBlue'), { occ: false });
}

function buildShelfPlates(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), WL = M('woodPlankLt');
  for (const sx of [0.14, 0.79]) b.box(sx, 0.18, 0, 0.07, 0.30, 1.20, WK);
  b.mark('solid', 0.14, 0.16, 0, 0.72, 0.32, 1.20);
  b.box(0.14, 0.16, 0.02, 0.72, 0.04, 1.16, M('plasterWhite'), { occ: false });
  for (const z of [0.36, 0.74]) b.box(0.12, 0.16, z, 0.76, 0.34, 0.05, WL);
  b.box(0.10, 0.14, 1.12, 0.80, 0.38, 0.06, WL);
  b.box(0.08, 0.12, 1.18, 0.84, 0.42, 0.035, W, { occ: false });
  // plates standing on edge
  for (const [px, pr, pm] of [[0.30, 0.105, M('ceramic')], [0.50, 0.12, M('ceramicBlue')], [0.70, 0.10, M('ceramic')]]) {
    discY(b, px, 0.30, 1.12 + pr + 0.06, pr, 0.022, pm, { seg: 14, rimMat: pm });
    discY(b, px, 0.30, 1.12 + pr + 0.06, pr * 0.55, 0.026, M('ceramicBlue'), { seg: 10, rimMat: M('ceramicBlue') });
  }
  for (const [px, pr] of [[0.34, 0.09], [0.66, 0.085]]) {
    discY(b, px, 0.30, 0.74 + pr + 0.05, pr, 0.02, M('ceramic'), { seg: 12 });
  }
  // mugs hanging from the underside of the middle shelf
  for (const mx of [0.28, 0.46, 0.64]) {
    lathe(b, mx, 0.30, [[0.60, 0.048], [0.615, 0.055], [0.70, 0.058], [0.715, 0.05]], 10, M('ceramicBlue'), { bottom: true, occ: false });
    tube(b, [mx + 0.05, 0.30, 0.63], [mx + 0.05, 0.30, 0.69], 0.011, 0.011, 4, M('ceramicBlue'), { occ: false });
    b.box(mx - 0.012, 0.288, 0.72, 0.024, 0.024, 0.022, M('ironBlack'), { occ: false });
  }
  b.box(0.20, 0.22, 0.42, 0.30, 0.22, 0.05, M('clothYellow'), { occ: false });
  lathe(b, 0.66, 0.30, [[0.42, 0.075], [0.43, 0.10], [0.50, 0.115], [0.545, 0.09], [0.55, 0.055]], 12, M('ceramic'), { occ: false });
  tube(b, [0.55, 0.30, 0.47], [0.44, 0.30, 0.52], 0.014, 0.02, 5, M('ceramic'), { occ: false });
}

function buildVegBasket(b) {
  const H = M('hay'), HD = M('hayDk'), WK = M('woodPlankDk');
  lathe(b, 0.5, 0.5, [
    [0.01, 0.20], [0.03, 0.245], [0.10, 0.27], [0.20, 0.29], [0.28, 0.30],
  ], 16, (i) => (i % 2 ? H : HD), { top: false, bottom: true, vol: true, occ: true });
  lathe(b, 0.5, 0.5, [[0.28, 0.30], [0.315, 0.315], [0.345, 0.30]], 16, WK, { top: false, occ: false });
  for (let i = 0; i < 8; i++) {                              // upright staves
    const a = (i / 8) * TAU + 0.2;
    tube(b, [0.5 + Math.cos(a) * 0.30, 0.5 + Math.sin(a) * 0.30, 0.06],
      [0.5 + Math.cos(a) * 0.30, 0.5 + Math.sin(a) * 0.30, 0.30], 0.016, 0.014, 4, HD, { occ: false });
  }
  for (let i = 0; i <= 2; i++) {                             // bail handle
    const t = i / 2;
    tube(b, [0.30 + 0.28 * t, 0.5, 0.29 + Math.sin(t * Math.PI) * 0.13], [0.30 + 0.28 * (t + 0.5), 0.5, 0.29 + Math.sin((t + 0.5) * Math.PI) * 0.13], 0.014, 0.014, 4, WK, { occ: false });
  }
  // vegetables
  for (const [cx, cy, r, m] of [[0.36, 0.40, 0.085, M('leaf')], [0.58, 0.36, 0.095, M('leafLt')], [0.50, 0.62, 0.09, M('leafDk')]]) {
    b.dome(cx, cy, 0.29, r, r * 1.6, m, { seg: 9, rings: 3 });
    b.dome(cx, cy, 0.33, r * 0.55, r * 0.7, M('cropLeaf'), { seg: 7, rings: 2 });
  }
  for (const [cx, cy, a] of [[0.68, 0.60, 0.5], [0.32, 0.62, -0.4], [0.64, 0.32, 1.2]]) {
    tube(b, [cx - Math.cos(a) * 0.10, cy - Math.sin(a) * 0.10, 0.30], [cx + Math.cos(a) * 0.10, cy + Math.sin(a) * 0.10, 0.42], 0.036, 0.006, 6, M('cropCarrot'));
    b.m.quad([cx + Math.cos(a) * 0.09, cy + Math.sin(a) * 0.09, 0.42], [cx + Math.cos(a) * 0.05, cy + Math.sin(a) * 0.05, 0.42],
      [cx + Math.cos(a) * 0.04, cy + Math.sin(a) * 0.04, 0.49], [cx + Math.cos(a) * 0.08, cy + Math.sin(a) * 0.08, 0.47], M('leaf'), [0, 0, 1], { detail: 1 });
  }
  b.dome(0.40, 0.58, 0.29, 0.10, 0.13, M('cropPumpkin'), { seg: 10, rings: 3 });
  tube(b, [0.40, 0.58, 0.41], [0.42, 0.58, 0.46], 0.018, 0.014, 5, M('cropLeafDk'));
}

// ===========================================================================
// STORAGE / DISPLAY
// ===========================================================================

/** One book: spine toward +y, with a gilt band and a page block. */
function book(b, x, y, z, w, d, h, mat) {
  b.box(x, y, z, w, d, h, mat);
  b.box(x + 0.012, y + 0.004, z + 0.008, w - 0.024, d + 0.012, 0.022, M('copper'), { occ: false });
  b.box(x + 0.012, y + 0.004, z + h - 0.032, w - 0.024, d + 0.012, 0.02, M('copper'), { occ: false });
  b.box(x + w - 0.006, y + 0.02, z + 0.012, 0.012, d - 0.04, h - 0.024, M('paper'), { occ: false });
}

function buildBookshelf(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), WL = M('woodPlankLt');
  b.box(0.10, 0.18, 0.06, 1.80, 0.07, 1.56, WK);             // back
  for (const sx of [0.10, 1.82]) b.box(sx, 0.18, 0.06, 0.08, 0.40, 1.60, WK);
  b.mark('solid', 0.10, 0.18, 0.06, 1.80, 0.40, 1.60);
  b.box(0.06, 0.14, 0.02, 1.88, 0.48, 0.06, W);
  for (const z of [0.06, 0.44, 0.82, 1.20]) b.box(0.10, 0.16, z, 1.80, 0.44, 0.055, WL);
  b.box(0.06, 0.12, 1.62, 1.88, 0.54, 0.07, WL);
  b.box(0.04, 0.10, 1.69, 1.92, 0.58, 0.04, W, { occ: false });
  b.box(0.10, 0.16, 1.58, 1.80, 0.46, 0.045, WK, { occ: false });
  const cols = [M('clothRed'), M('clothBlue'), M('clothGreen'), M('clothYellow'), M('clothTeal'),
    M('clothPurple'), M('clothCream'), M('woodRed'), M('woodBlue'), M('woodSage')];
  // three shelves of books, each row different
  for (let s = 0; s < 3; s++) {
    const z0 = s === 0 ? 0.115 : s === 1 ? 0.495 : 0.875;
    const y0 = 0.20 + (s % 2) * 0.03;
    let x = 0.14;
    let i = s * 3;
    while (x < 1.80) {
      const w = 0.055 + b.rng() * 0.075;
      const h = 0.24 + b.rng() * 0.13 - s * 0.012;
      if (x + w > 1.86) break;
      if (b.rng() < 0.12) { x += 0.05 + b.rng() * 0.06; i++; continue; }   // a gap
      book(b, x, y0, z0, w, 0.20 + b.rng() * 0.04, h, cols[i % cols.length]);
      x += w + 0.006;
      i++;
    }
    if (s === 1) {   // a leaning wedge + a flat stack, so the row is not a fence
      rotBox(b, 1.62, 0.30, z0 + 0.16, 0.09, 0.20, 0.32, 'y', -0.30, cols[(i + 2) % cols.length], { occ: false });
      for (let k = 0; k < 3; k++) book(b, 1.34, 0.22, z0 + 0.055 * k, 0.34, 0.24, 0.05, cols[(k + 4) % cols.length]);
    }
    if (s === 2) {   // a bowl and a candlestick on the top shelf
      lathe(b, 0.34, 0.34, [[z0 + 0.09, 0.08], [z0 + 0.10, 0.115], [z0 + 0.145, 0.125], [z0 + 0.175, 0.11]], 12, M('ceramic'), { bottom: true, occ: false });
      lathe(b, 0.72, 0.32, [[z0, 0.07], [z0 + 0.02, 0.075], [z0 + 0.045, 0.03], [z0 + 0.10, 0.028], [z0 + 0.13, 0.05], [z0 + 0.16, 0.035]], 10, M('copper'), { top: false, occ: false });
      candle(b, 0.72, 0.32, z0 + 0.16, 0.11, 0.026, M('wax'));
    }
  }
}

function buildCoatRack(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), CB = M('clothBlue'), HB = M('clothTeal');
  lathe(b, 0.5, 0.5, [
    [0, 0.06], [0.03, 0.09], [0.10, 0.055], [0.16, 0.048], [0.30, 0.042], [0.42, 0.05],
    [0.46, 0.038], [0.62, 0.036], [0.66, 0.05], [0.72, 0.038], [0.90, 0.034],
    [1.10, 0.032], [1.30, 0.034], [1.52, 0.038], [1.62, 0.055], [1.66, 0.03], [1.74, 0.026],
  ], 10, WK, { top: false, vol: true });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    tube(b, [0.5 + Math.cos(a) * 0.06, 0.5 + Math.sin(a) * 0.06, 0.10],
      [0.5 + Math.cos(a) * 0.30, 0.5 + Math.sin(a) * 0.30, 0.008], 0.03, 0.022, 5, WK);
  }
  lathe(b, 0.5, 0.5, [[1.74, 0.045], [1.78, 0.055], [1.83, 0.03], [1.85, 0.008]], 8, W, { occ: false });
  for (let i = 0; i < 4; i++) {                              // pegs
    const a = (i / 4) * TAU + Math.PI / 4;
    const dx = Math.cos(a), dy = Math.sin(a);
    tube(b, [0.5 + dx * 0.02, 0.5 + dy * 0.02, 1.60], [0.5 + dx * 0.20, 0.5 + dy * 0.20, 1.52], 0.024, 0.016, 5, W);
    lathe(b, 0.5 + dx * 0.21, 0.5 + dy * 0.21, [[1.515, 0.022], [1.545, 0.026], [1.575, 0.012]], 6, W, { occ: false });
  }
  // a coat on the +x+y peg and a hat on the +x-y one, because an empty rack
  // reads as a maypole
  b.box(0.47, 0.50, 0.82, 0.26, 0.20, 0.62, CB);
  b.box(0.45, 0.47, 1.30, 0.30, 0.16, 0.16, CB, { occ: false });
  b.box(0.51, 0.53, 1.40, 0.18, 0.14, 0.12, CB, { occ: false });
  b.box(0.47, 0.505, 1.06, 0.26, 0.02, 0.05, M('clothCream'), { occ: false });
  b.box(0.49, 0.495, 1.24, 0.16, 0.02, 0.09, HB, { occ: false });
  b.box(0.45, 0.62, 0.82, 0.30, 0.02, 0.30, M('clothBlue'), { occ: false });
  lathe(b, 0.648, 0.352, [[1.44, 0.155], [1.47, 0.17], [1.525, 0.155], [1.54, 0.10]], 12, M('hatStraw'), { occ: false });
  b.box(0.60, 0.39, 1.40, 0.10, 0.10, 0.045, M('hatStraw'), { occ: false });
}

function buildBarrel(b) {
  const W = M('woodPlank'), WK = M('woodPlankDk'), WL = M('woodPlankLt'), IR = M('ironBlack');
  lathe(b, 0.5, 0.5, [
    [0.02, 0.235], [0.05, 0.27], [0.12, 0.29], [0.28, 0.30], [0.42, 0.29], [0.52, 0.265], [0.56, 0.245],
  ], 16, (i) => (i % 2 ? W : WK), { top: false, bottom: true, vol: true });
  hoop(b, 0.5, 0.5, 0.075, 0.288, 0.04, IR, 16);
  hoop(b, 0.5, 0.5, 0.26, 0.303, 0.045, IR, 16);
  hoop(b, 0.5, 0.5, 0.475, 0.272, 0.04, IR, 16);
  lathe(b, 0.5, 0.5, [[0.56, 0.245], [0.575, 0.26], [0.60, 0.25]], 16, WK, { top: false, occ: false });
  lathe(b, 0.5, 0.5, [[0.60, 0.24], [0.625, 0.235]], 16, WL, { topMat: WL });
  b.box(0.44, 0.30, 0.625, 0.12, 0.14, 0.02, WK, { occ: false });   // bung
  for (let i = 0; i < 16; i++) {                              // grain on the staves
    const a = (i / 16) * TAU;
    if (i % 3) continue;
    b.m.quad([0.5 + Math.cos(a) * 0.302, 0.5 + Math.sin(a) * 0.302, 0.13],
      [0.5 + Math.cos(a + 0.09) * 0.302, 0.5 + Math.sin(a + 0.09) * 0.302, 0.13],
      [0.5 + Math.cos(a + 0.09) * 0.302, 0.5 + Math.sin(a + 0.09) * 0.302, 0.50],
      [0.5 + Math.cos(a) * 0.302, 0.5 + Math.sin(a) * 0.302, 0.50], W, [Math.cos(a), Math.sin(a), 0], { occ: false });
  }
}

function buildCrate(b) {
  const C = M('plankCrate'), WK = M('woodPlankDk'), WL = M('woodPlankLt'), S = M('sack');
  for (const [x, y] of [[0.10, 0.10], [0.82, 0.10], [0.10, 0.82], [0.82, 0.82]]) post(b, x, y, 0, 0.54, 0.08, WK);
  b.box(0.10, 0.10, 0.02, 0.80, 0.80, 0.05, WK);
  b.mark('solid', 0.10, 0.10, 0, 0.80, 0.80, 0.55);
  for (const [z0, z1] of [[0.08, 0.19], [0.24, 0.35], [0.40, 0.51]]) {
    b.box(0.10, 0.10, z0, 0.80, 0.035, z1 - z0, C, { occ: false });
    b.box(0.10, 0.855, z0, 0.80, 0.035, z1 - z0, C, { occ: false });
    b.box(0.10, 0.12, z0, 0.035, 0.76, z1 - z0, C, { occ: false });
    b.box(0.855, 0.12, z0, 0.035, 0.76, z1 - z0, C, { occ: false });
  }
  b.box(0.08, 0.08, 0.54, 0.84, 0.84, 0.05, WL);
  for (const sy of [0.16, 0.76]) b.box(0.08, sy, 0.585, 0.84, 0.09, 0.03, WK, { occ: false });
  b.m.quad([0.30, 0.30, 0.591], [0.62, 0.30, 0.591], [0.62, 0.44, 0.591], [0.30, 0.44, 0.591], M('white'), [0, 0, 1], { detail: 1 });
  b.m.quad([0.36, 0.33, 0.593], [0.56, 0.33, 0.593], [0.56, 0.41, 0.593], [0.36, 0.41, 0.593], M('plankCrate'), [0, 0, 1], { detail: 1 });
  for (const sx of [0.065, 0.855]) {                          // rope handles
    tube(b, [sx, 0.32, 0.42], [sx - 0.03, 0.40, 0.30], 0.018, 0.018, 4, M('hay'), { occ: false });
    tube(b, [sx - 0.03, 0.40, 0.30], [sx - 0.03, 0.58, 0.30], 0.018, 0.018, 4, M('hay'), { occ: false });
    tube(b, [sx - 0.03, 0.58, 0.30], [sx, 0.66, 0.42], 0.018, 0.018, 4, M('hay'), { occ: false });
  }
  b.dome(0.5, 0.5, 0.59, 0.22, 0.10, S, { seg: 9, rings: 3 });
}

function buildSack(b) {
  const S = M('sack'), SD = M('hayDk'), WH = M('cropWheat');
  lathe(b, 0.48, 0.5, [
    [0, 0.19], [0.02, 0.235], [0.09, 0.265], [0.20, 0.275], [0.30, 0.26], [0.38, 0.20],
    [0.43, 0.115], [0.46, 0.085],
  ], 12, S, { top: false, bottom: true, vol: true });
  lathe(b, 0.48, 0.5, [[0.445, 0.095], [0.465, 0.10], [0.49, 0.088]], 12, SD, { top: false, occ: false });
  for (let i = 0; i <= 3; i++) {
    const a = Math.PI + (i / 3) * Math.PI * 1.6;
    tube(b, [0.48, 0.5, 0.47], [0.48 + Math.cos(a) * 0.16, 0.5 + Math.sin(a) * 0.16, 0.365], 0.055, 0.03, 5, S, { occ: false });
  }
  tube(b, [0.34, 0.42, 0.42], [0.62, 0.58, 0.42], 0.012, 0.012, 4, M('hay'), { occ: false });
  lathe(b, 0.48, 0.50, [[0.40, 0.125], [0.425, 0.135], [0.45, 0.12]], 12, S, { top: false, occ: false });
  // spilled grain
  for (let i = 0; i < 12; i++) {
    const a = i * 0.9, r = 0.30 + ((i * 13) % 7) / 7 * 0.16;
    const gx = 0.48 + Math.cos(a) * r, gy = 0.5 + Math.sin(a) * r * 0.9;
    if (gx < 0.04 || gx > 0.96 || gy < 0.04 || gy > 0.96) continue;
    b.dome(gx, gy, 0.0, 0.03, 0.022, WH, { seg: 6, rings: 2 });
  }
}

// ===========================================================================
// SOFT / DECOR
// ===========================================================================

function buildRugOval(b) {
  const CR = M('clothCream'), CY = M('clothYellow'), RR = M('rugRed'), RB = M('rugBlue');
  ovalRug(b, 1.0, 1.0, 0.96, 0.92, [
    { f: 1.00, a: RR, b: M('woodRed') },
    { f: 0.88, a: CR, b: CY },
    { f: 0.80, a: RR, b: M('woodRed') },
    { f: 0.52, a: CR, b: CY },
    { f: 0.44, a: RR, b: M('woodRed') },
    { f: 0.16, a: RB, b: M('clothBlue') },
  ], 30);
}

function buildRugSmall(b) {
  rectRug(b, 0.12, 0.20, 0.76, 0.60, [
    { i: 0.00, m: M('clothCream') },
    { i: 0.09, m: M('rugBlue') },
    { i: 0.20, m: M('clothCream') },
    { i: 0.28, m: M('rugBlue') },
  ], M('clothCream'));
}

function buildCurtain(b) {
  const CC = M('clothCream'), CP = M('clothPink'), CY = M('clothYellow'), W = M('woodPlankDk'), CO = M('copper');
  tube(b, [0.05, 0.5, 2.0], [0.95, 0.5, 2.0], 0.022, 0.022, 6, W);
  for (const fx of [0.05, 0.95]) lathe(b, fx, 0.5, [[1.965, 0.03], [1.995, 0.045], [2.035, 0.02], [2.05, 0.005]], 7, CO, { occ: false });
  // pleated panels: alternating depth + shade, the only way cloth reads at 1 tile
  for (const [x0, x1, m] of [[0.05, 0.46, CC], [0.54, 0.95, CC]]) {
    const n = 5, w = (x1 - x0) / n;
    for (let i = 0; i < n; i++) {
      const x = x0 + i * w;
      const dy = (i % 2 ? 0.055 : 0.015);
      const zb = 0.03 + (i % 2 ? 0.012 : 0);
      b.box(x, 0.5 - dy, zb, w + 0.004, 0.05 + dy * 2, 1.95 - zb, i % 2 ? m : CP, { occ: i === 0 });
    }
    b.mark('solid', x0, 0.44, 0.03, x1 - x0, 0.12, 1.92);      // cloth does stop the sun
    b.box(x0 - 0.01, 0.475, 1.86, x1 - x0 + 0.02, 0.09, 0.08, M('clothBlue'), { occ: false });  // heading tape
    b.box(x0 + 0.02, 0.455, 0.86, x1 - x0 - 0.04, 0.13, 0.14, CY, { occ: false });               // tie-back
    b.box(x0 + 0.02, 0.52, 0.03, x1 - x0 - 0.04, 0.02, 0.06, m, { occ: false });
  }
  for (let i = 0; i < 4; i++) {                               // rings on the rod
    const rx = 0.10 + i * 0.10;
    lathe(b, rx, 0.5, [[1.975, 0.026], [2.01, 0.026]], 8, CO, { top: false, occ: false });
    if (i < 3) { lathe(b, rx + 0.28, 0.5, [[1.975, 0.026], [2.01, 0.026]], 8, CO, { top: false, occ: false }); }
  }
}

function buildPainting(b) {
  const FR = M('beam'), FD = M('beamDk'), G = M('copper');
  const ang = 0.13;
  const c = Math.cos(ang), s = Math.sin(ang);
  const PZ = 0.418;                                  // the frame stands on the floor and leans back
  const CW = 0.33, CH = 0.36;
  // local canvas frame: u = x, v = height up the leaning board, off = out of it
  // toward the room. `off` is what keeps the flat art layers sorting correctly.
  const at = (u, v, off = 0) => [0.5 + u, 0.752 - v * s + off * c, PZ + v * c + off * s];
  rotBox(b, ...at(0, 0, 0), CW * 2 + 0.02, 0.05, CH * 2 + 0.02, 'x', ang, FD, { occ: false });
  const q = (u0, v0, u1, v1, m, off) => {
    const n = [0, -s, c];
    const U0 = -CW + u0 * CW * 2, U1 = -CW + u1 * CW * 2, V0 = -CH + v0 * CH * 2, V1 = -CH + v1 * CH * 2;
    b.m.quad(at(U0, V0, off), at(U1, V0, off), at(U1, V1, off), at(U0, V1, off), m, n, { detail: 1 });
  };
  q(0, 0, 1, 1, M('plasterBlue'), 0.0270);           // sky
  q(0, 0.44, 1, 0.62, M('ceramicBlue'), 0.0282);     // haze — deliberately NOT
  //   `glassSky`: the night pass treats any PAT.GLASS surface as a window and
  //   would hang a glowing pane in the middle of the picture at 2am
  q(0.66, 0.66, 0.86, 0.86, M('flowerYellow'), 0.0294);   // sun
  q(0, 0.24, 0.60, 0.52, M('leafDk'), 0.0306);       // far hills
  q(0.38, 0.20, 1.0, 0.48, M('conifer'), 0.0318);    // near hills
  q(0, 0, 1, 0.34, M('grassLt'), 0.0330);            // meadow
  q(0, 0, 1, 0.12, M('grassDry'), 0.0342);           // foreground
  q(0.52, 0.06, 0.74, 0.24, M('stoneWarm'), 0.0354); // cottage
  q(0.48, 0.24, 0.78, 0.34, M('roofTile'), 0.0366);
  q(0.10, 0.34, 0.32, 0.52, M('leaf'), 0.0378);      // tree canopy
  q(0.18, 0.06, 0.24, 0.50, M('bark'), 0.0390);      // trunk
  // gilt liner just inside the moulding
  for (const [u, v, w, h] of [[0, -CH + 0.012, CW * 2, 0.024], [0, CH - 0.012, CW * 2, 0.024],
    [-CW + 0.012, 0, 0.024, CH * 2 - 0.05], [CW - 0.012, 0, 0.024, CH * 2 - 0.05]]) {
    const p = at(u, v, 0.0295);
    rotBox(b, p[0], p[1], p[2], w, 0.014, h, 'x', ang, G, { occ: false });
  }
  for (const [u, v, w, h] of [[0, -CH - 0.025, CW * 2 + 0.12, 0.05], [0, CH + 0.025, CW * 2 + 0.12, 0.05],
    [-CW - 0.025, 0, 0.05, CH * 2 + 0.05], [CW + 0.025, 0, 0.05, CH * 2 + 0.05]]) {
    const p = at(u, v, 0.027);
    rotBox(b, p[0], p[1], p[2], w, 0.05, h, 'x', ang, FR);
  }
  b.box(0.22, 0.22, 0, 0.56, 0.36, 0.035, M('woodPlankDk'));   // it leans on a little plinth
  b.mark('solid', 0.14, 0.24, 0, 0.72, 0.34, 0.78);
}

function buildClock(b) {
  const WK = M('woodPlankDk'), W = M('woodPlank'), CO = M('copper'), BK = M('black');
  // wall clock: hangs on a wall, so the case sits between z 1.30 and 1.98
  discY(b, 0.5, 0.62, 1.66, 0.30, 0.11, WK, { seg: 18, rimMat: W });
  discY(b, 0.5, 0.60, 1.66, 0.325, 0.05, W, { seg: 18 });
  discY(b, 0.5, 0.685, 1.66, 0.235, 0.02, M('paper'), { seg: 18 });
  discY(b, 0.5, 0.70, 1.66, 0.255, 0.012, M('white'), { seg: 18 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    const long = i % 3 === 0;
    b.box(0.5 + Math.cos(a) * 0.205 - (long ? 0.012 : 0.007), 0.706, 1.66 + Math.sin(a) * 0.205 - (long ? 0.012 : 0.007),
      long ? 0.024 : 0.014, 0.006, long ? 0.024 : 0.014, BK, { occ: false });
  }
  rotBox(b, 0.5, 0.706, 1.66, 0.02, 0.008, 0.30, 'y', 0.62, BK, { occ: false });
  rotBox(b, 0.5, 0.706, 1.66, 0.016, 0.008, 0.40, 'y', -0.52, BK, { occ: false });
  tube(b, [0.5, 0.70, 1.66], [0.5, 0.725, 1.66], 0.02, 0.012, 6, CO, { cap: true, capMat: CO, occ: false });
  // pendulum box below the dial
  b.box(0.36, 0.60, 1.26, 0.28, 0.07, 0.10, WK);
  discY(b, 0.5, 0.60, 1.24, 0.075, 0.02, CO, { seg: 12 });
  b.mark('solid', 0.36, 0.58, 1.20, 0.28, 0.11, 0.78);
  // bracket + hanger
  b.box(0.44, 0.60, 1.92, 0.12, 0.05, 0.07, W, { occ: false });
  tube(b, [0.5, 0.635, 1.90], [0.5, 0.635, 1.95], 0.012, 0.012, 4, M('ironBlack'), { occ: false });
}

function buildPlant(b) {
  const P = M('terracottaPot'), S = M('soil'), L = M('leaf'), LD = M('leafDk'), LL = M('leafLt');
  lathe(b, 0.5, 0.5, [[0, 0.20], [0.02, 0.225], [0.08, 0.24], [0.20, 0.245], [0.26, 0.25], [0.29, 0.265]], 14, P, { bottom: true, vol: true });
  lathe(b, 0.5, 0.5, [[0.245, 0.27], [0.285, 0.285], [0.30, 0.265]], 14, P, { top: false, occ: false });
  lathe(b, 0.5, 0.5, [[0.28, 0.24], [0.295, 0.245]], 12, S, { top: true, occ: false });
  for (let i = 0; i < 7; i++) {
    const a = i * 0.9 + 0.4;
    const len = 0.34 + b.rng() * 0.30;
    const lean = 0.14 + b.rng() * 0.22;
    const tx = 0.5 + Math.cos(a) * lean, ty = 0.5 + Math.sin(a) * lean;
    tube(b, [0.5, 0.5, 0.28], [tx, ty, 0.28 + len], 0.014, 0.008, 4, M('cropLeafDk'));
    for (let k = 0; k < 3; k++) {
      const t = 0.35 + k * 0.28;
      const lx = 0.5 + (tx - 0.5) * t, ly = 0.5 + (ty - 0.5) * t, lz = 0.28 + len * t;
      const d = a + (k % 2 ? 1.5 : -1.5) + 0.4;
      const r = 0.075 + b.rng() * 0.03;
      b.m.quad(
        [lx, ly, lz],
        [lx + Math.cos(d + 1.3) * r * 0.6, ly + Math.sin(d + 1.3) * r * 0.6, lz + r * 0.28],
        [lx + Math.cos(d) * r * 1.15, ly + Math.sin(d) * r * 1.15, lz + r * 0.55],
        [lx + Math.cos(d - 1.3) * r * 0.6, ly + Math.sin(d - 1.3) * r * 0.6, lz + r * 0.28],
        k % 2 ? L : (b.rng() < 0.5 ? LL : LD), nrm(Math.cos(d) * 0.4, Math.sin(d) * 0.4, 1), { detail: 1 });
    }
    if (i % 3 === 1) {
      for (let f = 0; f < 4; f++) {
        const fa = f * 1.6 + i;
        b.dome(tx + Math.cos(fa) * 0.035, ty + Math.sin(fa) * 0.035, 0.28 + len - 0.02, 0.032, 0.03,
          f % 2 ? M('flowerRed') : M('flowerWhite'), { seg: 6, rings: 2 });
      }
    }
  }
}

function buildHerbs(b) {
  const HD = M('hayDk'), H = M('hay'), LD = M('leafDk'), R = M('cropBerry'), CO = M('copper');
  const HT = 2.17;                       // the joist the twine is tied to
  // hangs from the ceiling: twine loop at the top, dried bundle below
  tube(b, [0.5, 0.5, HT], [0.5, 0.5, HT - 0.18], 0.012, 0.012, 4, H, { occ: false });
  lathe(b, 0.5, 0.5, [[HT - 0.025, 0.035], [HT + 0.005, 0.04]], 8, CO, { top: false, occ: false });
  lathe(b, 0.5, 0.5, [[HT - 0.24, 0.062], [HT - 0.19, 0.075], [HT - 0.15, 0.055]], 10, H, { top: false, occ: false });
  for (let i = 0; i < 11; i++) {
    const a = i * 0.571 + 0.3;
    const lean = 0.05 + (i % 4) * 0.028;
    const len = 0.20 + ((i * 7) % 5) / 5 * 0.20;
    const tx = 0.5 + Math.cos(a) * lean, ty = 0.5 + Math.sin(a) * lean;
    tube(b, [0.5 + Math.cos(a) * 0.03, 0.5 + Math.sin(a) * 0.03, HT - 0.24], [tx, ty, HT - 0.24 - len], 0.016, 0.007, 4,
      i % 3 ? HD : LD, { occ: false });
    if (i % 2) {
      const d = a + 1.2;
      b.m.quad([tx, ty, HT - 0.24 - len + 0.05], [tx + Math.cos(d + 1.4) * 0.035, ty + Math.sin(d + 1.4) * 0.035, HT - 0.24 - len + 0.03],
        [tx + Math.cos(d) * 0.07, ty + Math.sin(d) * 0.07, HT - 0.24 - len + 0.09],
        [tx + Math.cos(d - 1.4) * 0.035, ty + Math.sin(d - 1.4) * 0.035, HT - 0.24 - len + 0.03],
        LD, nrm(Math.cos(d) * 0.5, Math.sin(d) * 0.5, 1), { detail: 1 });
    }
  }
  for (const [rx, ry, rz] of [[0.44, 0.53, HT - 0.38], [0.56, 0.47, HT - 0.43], [0.50, 0.57, HT - 0.35]]) {
    b.dome(rx, ry, rz, 0.026, 0.03, R, { seg: 6, rings: 2 });
  }
  b.mark('solid', 0.40, 0.40, HT - 0.56, 0.20, 0.20, 0.40);
}

function buildCandles(b) {
  const CO = M('copper'), WX = M('wax'), IR = M('ironBlack'), WL = M('woodPlankLt');
  lathe(b, 0.5, 0.5, [[0, 0.135], [0.018, 0.165], [0.05, 0.135], [0.075, 0.075], [0.15, 0.06], [0.24, 0.068]], 12, CO, { top: false, vol: true });
  lathe(b, 0.5, 0.5, [[0.24, 0.042], [0.29, 0.04], [0.315, 0.056]], 10, CO, { top: false, occ: false });
  for (const s of [-1, 1]) {
    tube(b, [0.5, 0.5, 0.27], [0.5 + s * 0.16, 0.5, 0.30], 0.02, 0.017, 5, CO, { occ: false });
    tube(b, [0.5 + s * 0.16, 0.5, 0.30], [0.5 + s * 0.27, 0.5, 0.365], 0.017, 0.015, 5, CO, { occ: false });
    lathe(b, 0.5 + s * 0.27, 0.5, [[0.36, 0.045], [0.38, 0.055], [0.405, 0.045]], 10, CO, { top: false, occ: false });
    candle(b, 0.5 + s * 0.27, 0.5, 0.405, 0.20, 0.034, WX);
  }
  candle(b, 0.5, 0.5, 0.315, 0.235, 0.036, WX);
  b.box(0.68, 0.24, 0, 0.13, 0.15, 0.032, IR, { occ: false });     // box of spills
  b.box(0.70, 0.27, 0.032, 0.09, 0.08, 0.010, WL, { occ: false });
  b.mark('solid', 0.32, 0.36, 0, 0.36, 0.28, 0.06);
}

function buildOilLamp(b) {
  const CO = M('copper'), IR = M('ironBlack'), WX = M('wax'), GL = M('lampGlass'), CE = M('ceramicBlue');
  // A TABLE LAMP, authored at the size one should be.
  //
  // It used to be modelled floor-to-tabletop tall — 0.90 units, in a world where
  // the table top is 0.88 and a wall is 2.2 — and then simply painted over the
  // tabletop by the painter's algorithm. That made it LOOK like a table lamp
  // while its geometry sat inside the table: correct by accident, and the first
  // thing to break the moment occlusion moved into a depth buffer, where "nearer
  // wins" is not negotiable.
  //
  // The scene now says `over(oil_lamp, 4, 4, 0, TABLE_TOP)` — the piece is lifted
  // to the real height of the table it stands on, so its depth is honest. At the
  // old size that lift put a 1.78-unit torch under a 1.93-unit chandelier, which
  // is why the model is scaled to a lamp rather than the lift being fudged.
  const S = 0.60;
  const Z = (v) => v * S, R = (v) => v * S;
  const X = (v) => 0.5 + (v - 0.5) * S;
  const pr = (list) => list.map(([z, r]) => [Z(z), R(r)]);
  lathe(b, 0.5, 0.5, pr([
    [0, 0.145], [0.025, 0.16], [0.06, 0.125], [0.10, 0.065], [0.17, 0.056], [0.21, 0.068],
    [0.235, 0.055], [0.29, 0.09], [0.36, 0.122], [0.43, 0.122], [0.49, 0.09], [0.525, 0.06],
  ]), 12, CO, { top: false, vol: true });
  lathe(b, 0.5, 0.5, pr([[0.48, 0.062], [0.515, 0.074], [0.545, 0.07]]), 10, IR, { top: false, occ: false });
  tube(b, [X(0.57), 0.5, Z(0.41)], [X(0.65), 0.5, Z(0.41)], R(0.026), R(0.02), 6, CO, { cap: true, capMat: CO });   // wick knob
  lathe(b, 0.5, 0.5, pr([[0.525, 0.042], [0.56, 0.034]]), 8, WX, { top: false, occ: false });
  // glass chimney with the flame inside it
  lathe(b, 0.5, 0.5, pr([
    [0.545, 0.046], [0.60, 0.088], [0.72, 0.096], [0.83, 0.088], [0.875, 0.072], [0.90, 0.058],
  ]), 12, GL, { top: false, occ: false });
  flame(b, 0.5, 0.5, Z(0.545), Z(0.71), R(0.038), M('fireGlow'), { sides: 6 });
  flame(b, X(0.514), X(0.514), Z(0.57), Z(0.675), R(0.019), M('lampGlass'), { sides: 5 });
  lathe(b, 0.5, 0.5, pr([[0.17, 0.115], [0.19, 0.132]]), 12, CE, { top: false, occ: false });
}

function buildChandelier(b) {
  const WK = M('woodPlankDk'), CO = M('copper'), WX = M('wax'), IR = M('ironBlack');
  // CEILING MOUNTED. The room's ceiling is the top of the wall (z = 2.2), so the
  // chain is tied off there and the body hangs in the 1.90-2.33 band.
  const CT = 2.32;
  tube(b, [0.5, 0.5, CT], [0.5, 0.5, CT - 0.15], 0.016, 0.016, 5, IR, { occ: false });
  for (let i = 0; i < 4; i++) lathe(b, 0.5, 0.5, [[CT - 0.01 - i * 0.04, 0.032], [CT + 0.01 - i * 0.04, 0.032]], 8, IR, { top: false, occ: false });
  lathe(b, 0.5, 0.5, [[CT - 0.17, 0.035], [CT - 0.15, 0.06], [CT - 0.11, 0.075], [CT - 0.08, 0.05], [CT - 0.06, 0.02]], 10, WK, { occ: false });
  lathe(b, 0.5, 0.5, [[CT - 0.25, 0.10], [CT - 0.21, 0.115], [CT - 0.18, 0.09]], 12, CO, { top: false, occ: false });
  lathe(b, 0.5, 0.5, [[CT - 0.43, 0.05], [CT - 0.39, 0.13], [CT - 0.31, 0.15], [CT - 0.25, 0.12]], 12, M('lampGlass'), { top: false, occ: false });
  flame(b, 0.5, 0.5, CT - 0.39, CT - 0.25, 0.045, M('fireGlow'), { sides: 5 });
  b.mark('solid', 0.36, 0.36, CT - 0.45, 0.28, 0.28, 0.30);
  const N = 6;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU + 0.3;
    const dx = Math.cos(a), dy = Math.sin(a);
    tube(b, [0.5, 0.5, CT - 0.19], [0.5 + dx * 0.18, 0.5 + dy * 0.18, CT - 0.25], 0.016, 0.015, 4, WK, { occ: false });
    tube(b, [0.5 + dx * 0.18, 0.5 + dy * 0.18, CT - 0.25], [0.5 + dx * 0.40, 0.5 + dy * 0.40, CT - 0.31], 0.015, 0.013, 4, WK, { occ: false });
    tube(b, [0.5 + dx * 0.40, 0.5 + dy * 0.40, CT - 0.31], [0.5 + dx * 0.44, 0.5 + dy * 0.44, CT - 0.35], 0.013, 0.012, 4, WK, { occ: false });
    lathe(b, 0.5 + dx * 0.44, 0.5 + dy * 0.44, [[CT - 0.39, 0.042], [CT - 0.372, 0.055], [CT - 0.35, 0.042]], 8, CO, { top: false, occ: false });
    candle(b, 0.5 + dx * 0.44, 0.5 + dy * 0.44, CT - 0.35, 0.15, 0.026, WX);
  }
}

function buildLantern(b) {
  const IR = M('ironBlack'), GL = M('lampGlass'), WX = M('wax'), MT = M('metal');
  lathe(b, 0.5, 0.5, [[0, 0.175], [0.025, 0.19], [0.06, 0.16], [0.085, 0.115], [0.105, 0.11]], 12, IR, { top: false, vol: true });
  lathe(b, 0.5, 0.5, [[0.105, 0.115], [0.135, 0.142], [0.15, 0.138]], 12, MT, { top: false, occ: false });
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    post(b, 0.5 + sx * 0.125, 0.5 + sy * 0.125, 0.14, 0.56, 0.024, IR);
  }
  for (const [px, py, w, d] of [[0.5, 0.63, 0.24, 0.018], [0.5, 0.37, 0.24, 0.018], [0.63, 0.5, 0.018, 0.24], [0.37, 0.5, 0.018, 0.24]]) {
    b.box(px - w / 2, py - d / 2, 0.155, w, d, 0.39, GL, { occ: false });
  }
  lathe(b, 0.5, 0.5, [[0.40, 0.026], [0.43, 0.033], [0.50, 0.03]], 8, WX, { top: false, occ: false });
  flame(b, 0.5, 0.5, 0.43, 0.62, 0.042, M('fireGlow'), { sides: 6 });
  flame(b, 0.514, 0.514, 0.46, 0.60, 0.021, M('lampGlass'), { sides: 5 });
  lathe(b, 0.5, 0.5, [[0.56, 0.135], [0.585, 0.15], [0.61, 0.135]], 12, IR, { top: false, occ: false });
  cone(b, 0.5, 0.5, 0.61, 0.715, 0.14, 10, IR, { bottom: false, occ: false });
  lathe(b, 0.5, 0.5, [[0.715, 0.024], [0.735, 0.022]], 6, IR, { top: false, occ: false });
  tube(b, [0.5, 0.5, 0.735], [0.5, 0.5, 0.785], 0.01, 0.01, 4, IR, { occ: false });
  for (let i = 0; i <= 3; i++) {                              // bail handle over the cap
    const a = Math.PI * (i / 4), a2 = Math.PI * ((i + 1) / 4);
    tube(b, [0.5 - Math.cos(a) * 0.055, 0.5, 0.80 + Math.sin(a) * 0.022],
      [0.5 - Math.cos(a2) * 0.055, 0.5, 0.80 + Math.sin(a2) * 0.022], 0.009, 0.009, 4, IR, { occ: false });
  }
  lathe(b, 0.5, 0.5, [[0.785, 0.052], [0.805, 0.056], [0.825, 0.042]], 10, IR, { top: false, occ: false });
}

// ===========================================================================
// descriptor table
// ===========================================================================

export const MODELS = [
  // ---- sleeping ----------------------------------------------------------
  { id: 'furn_bed', name: 'BED', cat: 'furn', fp: [1, 2], seed: 701, cap: 1.17, rots: 4, build: buildBed },
  { id: 'furn_bed_cot', name: 'COT', cat: 'furn', fp: [1, 2], seed: 703, cap: 0.63, rots: 4, build: buildCot },
  { id: 'furn_cradle', name: 'CRADLE', cat: 'furn', fp: [1, 1], seed: 707, cap: 0.87, rots: 4, build: buildCradle },
  { id: 'furn_nightstand', name: 'NIGHTSTAND', cat: 'furn', fp: [1, 1], seed: 709, cap: 0.78, rots: 4, build: buildNightstand },
  { id: 'furn_wardrobe', name: 'WARDROBE', cat: 'furn', fp: [1, 1], seed: 711, cap: 2.09, rots: 4, build: buildWardrobe },
  { id: 'furn_dresser', name: 'CHEST OF DRAWERS', cat: 'furn', fp: [1, 1], seed: 713, cap: 1.00, rots: 4, build: buildDresser },
  { id: 'furn_chest', name: 'BLANKET CHEST', cat: 'furn', fp: [1, 1], seed: 717, cap: 0.73, rots: 4, build: buildChest },

  // ---- seating -----------------------------------------------------------
  { id: 'furn_chair', name: 'CHAIR', cat: 'furn', fp: [1, 1], seed: 719, cap: 1.01, rots: 4, build: buildChair },
  { id: 'furn_stool', name: 'STOOL', cat: 'furn', fp: [1, 1], seed: 727, cap: 0.51, rots: 1, build: buildStool },
  { id: 'furn_bench', name: 'BENCH', cat: 'furn', fp: [2, 1], seed: 733, cap: 0.90, rots: 4, build: buildBench },
  { id: 'furn_armchair', name: 'ARMCHAIR', cat: 'furn', fp: [1, 1], seed: 739, cap: 1.08, rots: 4, build: buildArmchair },
  { id: 'furn_rocker', name: 'ROCKING CHAIR', cat: 'furn', fp: [1, 1], seed: 743, cap: 1.06, rots: 4, build: buildRocker },

  // ---- tables ------------------------------------------------------------
  { id: 'furn_table', name: 'DINING TABLE', cat: 'furn', fp: [2, 2], seed: 751, cap: 1.07, rots: 4, build: buildTable },
  { id: 'furn_table_small', name: 'ROUND TABLE', cat: 'furn', fp: [1, 1], seed: 757, cap: 0.88, rots: 1, build: buildTableSmall },
  { id: 'furn_desk', name: 'DESK', cat: 'furn', fp: [2, 1], seed: 761, cap: 1.10, rots: 4, build: buildDesk },
  { id: 'furn_side_table', name: 'SIDE TABLE', cat: 'furn', fp: [1, 1], seed: 769, cap: 0.71, rots: 4, build: buildSideTable },

  // ---- kitchen / hearth --------------------------------------------------
  { id: 'furn_counter', name: 'KITCHEN COUNTER', cat: 'furn', fp: [2, 1], seed: 773, cap: 1.11, rots: 4, build: buildCounter },
  { id: 'furn_stove', name: 'WOOD STOVE', cat: 'furn', fp: [1, 1], seed: 787, cap: 1.40, rots: 4, build: buildStove },
  { id: 'furn_fireplace', name: 'FIREPLACE', cat: 'furn', fp: [2, 1], seed: 797, cap: 1.83, rots: 4, build: buildFireplace },
  { id: 'furn_cauldron', name: 'CAULDRON', cat: 'furn', fp: [1, 1], seed: 809, cap: 0.80, rots: 1, build: buildCauldron },
  { id: 'furn_churn', name: 'BUTTER CHURN', cat: 'furn', fp: [1, 1], seed: 811, cap: 1.06, rots: 1, build: buildChurn },
  { id: 'furn_shelf_jars', name: 'PRESERVE SHELF', cat: 'furn', fp: [1, 1], seed: 821, cap: 1.52, rots: 4, build: buildShelfJars },
  { id: 'furn_veg_basket', name: 'VEGETABLE BASKET', cat: 'furn', fp: [1, 1], seed: 823, cap: 0.52, rots: 1, build: buildVegBasket },

  // ---- storage / display -------------------------------------------------
  { id: 'furn_bookshelf', name: 'BOOKSHELF', cat: 'furn', fp: [2, 1], seed: 827, cap: 1.74, rots: 4, build: buildBookshelf },
  { id: 'furn_shelf_plates', name: 'WALL SHELF', cat: 'furn', fp: [1, 1], seed: 829, cap: 1.42, rots: 4, cut: true, build: buildShelfPlates },
  { id: 'furn_coat_rack', name: 'COAT RACK', cat: 'furn', fp: [1, 1], seed: 839, cap: 1.86, rots: 1, build: buildCoatRack },
  { id: 'furn_barrel', name: 'BARREL', cat: 'furn', fp: [1, 1], seed: 853, cap: 0.65, rots: 1, build: buildBarrel },
  { id: 'furn_crate', name: 'CRATE', cat: 'furn', fp: [1, 1], seed: 857, cap: 0.69, rots: 1, build: buildCrate },
  { id: 'furn_sack', name: 'SACK', cat: 'furn', fp: [1, 1], seed: 859, cap: 0.53, rots: 1, build: buildSack },

  // ---- soft / decor ------------------------------------------------------
  // NOTE the `cut: true` on the wall-hung pieces. They are furniture by
  // category, but visually they are part of the WALL they hang on — a curtain
  // that stays at full strength while its wall ghosts into a 24 % film reads as
  // a bright object floating in the middle of the room you are trying to see
  // into. Anything mounted on a wall cuts with that wall.
  { id: 'furn_rug_round', name: 'RUG', cat: 'furn', fp: [2, 2], seed: 863, cap: 0.03, rots: 1, build: buildRugOval },
  { id: 'furn_rug_small', name: 'SMALL RUG', cat: 'furn', fp: [1, 1], seed: 877, cap: 0.03, rots: 1, build: buildRugSmall },
  { id: 'furn_curtain', name: 'CURTAINS', cat: 'furn', fp: [1, 1], seed: 881, cap: 2.06, rots: 4, cut: true, build: buildCurtain },
  { id: 'furn_painting', name: 'PAINTING', cat: 'furn', fp: [1, 1], seed: 883, cap: 0.84, rots: 4, cut: true, build: buildPainting },
  { id: 'furn_clock', name: 'WALL CLOCK', cat: 'furn', fp: [1, 1], seed: 887, cap: 1.99, rots: 4, cut: true, build: buildClock },
  { id: 'furn_plant', name: 'POTTED PLANT', cat: 'furn', fp: [1, 1], seed: 907, cap: 0.89, rots: 1, build: buildPlant },
  { id: 'furn_herbs', name: 'HANGING HERBS', cat: 'furn', fp: [1, 1], seed: 911, cap: 2.18, rots: 1, build: buildHerbs },
  { id: 'furn_candles', name: 'CANDLE STAND', cat: 'furn', fp: [1, 1], seed: 919, cap: 0.77, rots: 1, build: buildCandles },
  { id: 'furn_oil_lamp', name: 'OIL LAMP', cat: 'furn', fp: [1, 1], seed: 929, cap: 0.57, rots: 1, build: buildOilLamp },
  { id: 'furn_chandelier', name: 'CEILING LAMP', cat: 'furn', fp: [1, 1], seed: 937, cap: 2.34, rots: 1, build: buildChandelier },
  { id: 'furn_lantern', name: 'LANTERN', cat: 'furn', fp: [1, 1], seed: 941, cap: 0.84, rots: 1, build: buildLantern },
];
