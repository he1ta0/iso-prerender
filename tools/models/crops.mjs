// Crop kit — eight field/garden crops, five growth stages each.
//
// Every stage is its own descriptor (`crop_<name>_0` … `crop_<name>_4`) on a
// 1x1 tile footprint, because the runtime swaps sprites by growth stage instead
// of scaling one mesh. Stage 0 is a sprout, stage 4 is "harvest me".
//
// Readability rules that shaped this file (a tile is 32x16 px, 1 z-unit = 22 px,
// 1 world unit = 16 px across) — the camera looks from +x +y, the sun is high
// and also from +x +y:
//
//   * nothing structural is thinner than ~0.05 units (~1 px after resolve).
//     Leaf *plates* can be thin because their silhouette is their width.
//   * leaf plates carry a +z normal bias. A plate lying parallel to the ground
//     catches ndl ~= 0.85 and reads bright green; a truly vertical blade facing
//     away from the sun reads almost black. Biasing the normals up is what makes
//     a 3-pixel sprout legible at all, and it is what makes a clump of grass
//     read as a clump rather than as a smear.
//   * adjacent leaves alternate cropLeaf / cropLeafDk so a bush has internal
//     contrast instead of being one flat blob.
//   * every stage changes HEIGHT *and* SILHOUETTE. Colour alone does not read
//     at this scale, so fruit is always pushed to the outside of the silhouette.
//
// All randomness comes from `b.rng()` seeded by the descriptor's `seed`, so the
// whole kit is byte-for-byte reproducible.

import { Builder } from '../lib/geom.mjs';
import { M } from '../lib/materials.mjs';

// The harness builds the Builder and hands it to `build(b)`; the import above
// documents where the API lives and keeps the module self-describing.
void Builder;

const TAU = Math.PI * 2;
const nrm = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };

// ---------------------------------------------------------------------------
// primitives shared by every crop
// ---------------------------------------------------------------------------

/** Flat ribbon along a centreline. `w` is measured horizontally, ⟂ to travel. */
function strip(b, p0, p1, w0, w1, mat, n, o = {}) {
  let dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  let l = Math.hypot(dx, dy);
  if (l < 1e-6) { dx = 1; dy = 0; l = 1; }
  const px = -dy / l, py = dx / l;
  b.m.quad(
    [p0[0] + px * w0 * 0.5, p0[1] + py * w0 * 0.5, p0[2]],
    [p0[0] - px * w0 * 0.5, p0[1] - py * w0 * 0.5, p0[2]],
    [p1[0] - px * w1 * 0.5, p1[1] - py * w1 * 0.5, p1[2]],
    [p1[0] + px * w1 * 0.5, p1[1] + py * w1 * 0.5, p1[2]],
    mat, n, { detail: o.detail === undefined ? 1 : o.detail, gid: o.gid },
  );
}

/** Upright tapering blade: grass, wheat stalk, carrot top. */
function blade(b, x, y, z, ang, h, w, mat, o = {}) {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const bend = o.bend === undefined ? h * 0.26 : o.bend;
  const n = nrm(ca * (o.nOut === undefined ? 0.42 : o.nOut), sa * (o.nOut === undefined ? 0.42 : o.nOut), o.nUp === undefined ? 1 : o.nUp);
  strip(b, [x, y, z], [x + ca * bend, y + sa * bend, z + h], w, w * (o.tipW === undefined ? 0.14 : o.tipW), mat, n, o);
}

/** Two-segment arcing leaf that rises to a peak and then droops (corn, vines). */
function arcLeaf(b, x, y, z, ang, len, peak, tipZ, w, mat, o = {}) {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const n = nrm(ca * (o.nOut === undefined ? 0.5 : o.nOut), sa * (o.nOut === undefined ? 0.5 : o.nOut), o.nUp === undefined ? 0.9 : o.nUp);
  const mid = [x + ca * len * 0.5, y + sa * len * 0.5, z + peak];
  const tip = [x + ca * len, y + sa * len, z + tipZ];
  strip(b, [x, y, z], mid, w, w * 0.85, mat, n, o);
  strip(b, mid, tip, w * 0.85, w * 0.16, mat, n, o);
}

/** One leaf plate: base at (x,y,z), pointing along `ang`, rising `rise` units. */
function leaf(b, x, y, z, ang, len, wid, rise, mat, o = {}) {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const mx = x + ca * len * 0.42, my = y + sa * len * 0.42, mz = z + rise * 0.42;
  const sx = -sa * wid * 0.5, sy = ca * wid * 0.5;
  const n = nrm(ca * (o.nOut === undefined ? 0.3 : o.nOut), sa * (o.nOut === undefined ? 0.3 : o.nOut), 1);
  b.m.quad([x, y, z], [mx + sx, my + sy, mz], [x + ca * len, y + sa * len, z + rise], [mx - sx, my - sy, mz], mat, n, { detail: 1 });
}

/** `n` leaves radiating from one point, jittered deterministically. */
function rosette(b, x, y, z, n, len, wid, rise, mats, o = {}) {
  for (let i = 0; i < n; i++) {
    const a = (o.a0 || 0) + (i / n) * TAU + (b.rng() - 0.5) * (o.jitter === undefined ? 0.3 : o.jitter);
    const k = 1 + (b.rng() - 0.5) * (o.sizeJit === undefined ? 0.2 : o.sizeJit);
    leaf(b, x + (b.rng() - 0.5) * 0.04, y + (b.rng() - 0.5) * 0.04, z + (b.rng() - 0.5) * 0.02,
      a, len * k, wid * k, rise * (2 - k), mats[i % mats.length], { nOut: o.nOut });
  }
}

/** Soil mound, so a seedling reads as planted rather than dropped on the tile. */
function mound(b, r = 0.2, h = 0.022, mat = 'soilDk') {
  b.cylinder(0.5, 0.5, 0, h, r, 8, M(mat), { rTop: r * 0.68, occ: false });
}

/** Root-crop bulb: a squashed hemisphere with an optional coloured crown. */
function bulb(b, cx, cy, r, h, matBot, matTop) {
  const seg = 9;
  b.dome(cx, cy, 0.004, r, h * 0.68, matBot, { seg, rings: 2 });
  if (matTop !== null && matTop !== undefined) b.dome(cx, cy, h * 0.4, r * 0.95, h * 0.64, matTop, { seg, rings: 2 });
}

/** Angled tapered prism between two points (stakes, cobs, stems, tendrils). */
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
  if (o.cap) b.fan(B, mat, d, true, { gid: b.m.newGid() });
  if (o.occ !== false) {
    const mn = [Math.min(p0[0], p1[0]) - r0, Math.min(p0[1], p1[1]) - r0, Math.min(p0[2], p1[2]) - r0];
    const mx = [Math.max(p0[0], p1[0]) + r0, Math.max(p0[1], p1[1]) + r0, Math.max(p0[2], p1[2]) + r0];
    b.m.occluders.push({ mn, mx });
  }
}

/** Two twine ties around a stake. */
function tie(b, x, y, z, w, mat) {
  b.box(x - w * 0.5, y - w * 0.5, z, w, w, 0.018, mat, { occ: false });
}

// ---------------------------------------------------------------------------
// turnip — big leaf rosette, bulb swells out of the soil at stage 3
// ---------------------------------------------------------------------------
function buildTurnip(b, s) {
  const CL = M('cropLeaf'), CD = M('cropLeafDk');
  const mix = [CL, CD, CL, CL, CD, CL, CD, CL, CD];
  const cx = 0.5, cy = 0.5;
  mound(b, s < 2 ? 0.14 : 0.2, 0.024);

  if (s === 0) {
    rosette(b, cx, cy, 0.02, 3, 0.085, 0.07, 0.105, [CL, CD, CL], { jitter: 0.5, sizeJit: 0.22, nOut: 0.55, a0: 0.4 });
    return;
  }
  if (s === 1) {
    rosette(b, cx, cy, 0.025, 5, 0.15, 0.105, 0.23, [CL, CD, CL, CD, CL], { nOut: 0.4, a0: 0.2 });
    leaf(b, cx, cy, 0.03, 1.4, 0.11, 0.08, 0.31, CL, { nOut: 0.2 });
    return;
  }
  if (s === 2) {
    rosette(b, cx, cy, 0.03, 7, 0.21, 0.135, 0.29, mix, { nOut: 0.3 });
    for (let i = 0; i < 5; i++) leaf(b, cx, cy, 0.04, i * 1.257 + 0.6, 0.14, 0.10, 0.47, i % 2 ? CL : CD, { nOut: 0.2 });
    return;
  }
  const ripe = s === 4;
  const r = ripe ? 0.175 : 0.11, h = ripe ? 0.135 : 0.08;
  bulb(b, cx, cy, r, h, ripe ? M('white') : M('cropMelon'), ripe ? M('cropEggplant') : null);
  const lz = h * 0.78;
  const n = ripe ? 8 : 7;
  const len = ripe ? 0.235 : 0.215, wid = ripe ? 0.15 : 0.13, rise = ripe ? 0.36 : 0.29;
  rosette(b, cx, cy, lz, n, len, wid, rise, mix, { nOut: 0.3 });
  for (let i = 0; i < (ripe ? 5 : 4); i++) {
    leaf(b, cx, cy, lz, i * 1.5 + 0.45, len * 0.62, wid * 0.7, ripe ? 0.6 : 0.46, i % 2 ? CL : CD, { nOut: 0.18 });
  }
}

// ---------------------------------------------------------------------------
// potato — soft bushy plant; white flowers and exposed tubers say "ripe"
// ---------------------------------------------------------------------------
function buildPotato(b, s) {
  const CL = M('cropLeaf'), CD = M('cropLeafDk');
  const mix = [CL, CD, CD, CL, CL, CD, CL, CD, CL, CD];
  const cx = 0.5, cy = 0.5;
  mound(b, s < 2 ? 0.15 : 0.21, 0.026);

  if (s === 0) {
    rosette(b, cx, cy, 0.02, 3, 0.09, 0.075, 0.11, [CD, CL, CD], { jitter: 0.45, sizeJit: 0.2, nOut: 0.5, a0: 0.9 });
    return;
  }
  if (s === 1) {
    rosette(b, cx, cy, 0.025, 6, 0.15, 0.10, 0.23, mix, { nOut: 0.35 });
    blade(b, cx, cy, 0.03, 0.8, 0.26, 0.055, CD, { nUp: 0.95, nOut: 0.3, tipW: 0.3 });
    blade(b, cx, cy, 0.03, 3.6, 0.22, 0.055, CD, { nUp: 0.95, nOut: 0.3, tipW: 0.3 });
    return;
  }
  if (s === 2) {
    rosette(b, cx, cy, 0.03, 7, 0.20, 0.135, 0.28, mix, { nOut: 0.3 });
    rosette(b, cx, cy, 0.16, 6, 0.16, 0.115, 0.26, [CL, CD, CL, CD, CL, CD], { nOut: 0.28, a0: 0.5 });
    for (let i = 0; i < 3; i++) blade(b, cx + Math.cos(i * 2.1) * 0.07, cy + Math.sin(i * 2.1) * 0.07, 0.03, i * 2.1, 0.42, 0.06, CD, { nUp: 0.95, nOut: 0.28, tipW: 0.25 });
    return;
  }
  // stage 3 / 4: full bush, then buds -> flowers + tubers
  const ripe = s === 4;
  rosette(b, cx, cy, 0.03, 8, 0.215, 0.145, 0.30, mix, { nOut: 0.3 });
  rosette(b, cx, cy, 0.17, 8, 0.175, 0.125, 0.28, [CD, CL, CD, CL, CD, CL, CD, CL], { nOut: 0.28, a0: 0.35 });
  const tops = [];
  for (let i = 0; i < 4; i++) {
    const a = i * 1.57 + 0.4;
    const x = cx + Math.cos(a) * 0.13, y = cy + Math.sin(a) * 0.13;
    blade(b, x, y, 0.04, a, ripe ? 0.46 : 0.40, 0.06, CD, { nUp: 0.95, nOut: 0.26, tipW: 0.22 });
    tops.push([x + Math.cos(a) * 0.09, y + Math.sin(a) * 0.09, ripe ? 0.47 : 0.41]);
  }
  if (ripe) {
    for (let i = 0; i < tops.length; i++) {
      const [x, y, z] = tops[i];
      b.dome(x, y, z, 0.052, 0.038, M('white'), { seg: 6, rings: 2 });
      b.dome(x, y, z + 0.012, 0.022, 0.018, M('flowerYellow'), { seg: 5, rings: 1 });
    }
    // tubers pushed out of the soil around the base — the real "dig me" cue
    const tub = [[0.5, 0.24, 0.5, 0.085], [0.27, 0.62, 0.5, 0.075], [0.72, 0.6, 0.5, 0.07], [0.5, 0.79, 0.5, 0.065]];
    for (let i = 0; i < tub.length; i++) {
      const [x, y] = tub[i];
      b.dome(x, y, 0.004, tub[i][3], tub[i][3] * 0.78, i % 2 ? M('sack') : M('cropWheat'), { seg: 7, rings: 2 });
    }
  } else {
    for (let i = 0; i < tops.length; i++) {
      const [x, y, z] = tops[i];
      b.dome(x, y, z - 0.01, 0.042, 0.045, M('cropMelon'), { seg: 6, rings: 2 });
    }
  }
}

// ---------------------------------------------------------------------------
// tomato — needs a stake, so the stake is in the silhouette from stage 2 up
// ---------------------------------------------------------------------------
function buildTomato(b, s) {
  const CL = M('cropLeaf'), CD = M('cropLeafDk');
  const mix = [CL, CD, CL, CL, CD, CL, CD, CL];
  const cx = 0.5, cy = 0.5;
  mound(b, s < 2 ? 0.16 : 0.22, 0.028);

  if (s <= 1) {
    if (s === 0) {
      rosette(b, cx, cy, 0.02, 3, 0.10, 0.08, 0.12, [CL, CD, CL], { jitter: 0.4, sizeJit: 0.2, nOut: 0.5, a0: 0.7 });
      leaf(b, cx, cy, 0.02, 2.4, 0.08, 0.06, 0.14, CD, { nOut: 0.3 });
      return;
    }
    blade(b, cx, cy, 0.02, 0.9, 0.24, 0.06, CD, { nUp: 0.9, nOut: 0.3, tipW: 0.3 });
    rosette(b, cx, cy, 0.03, 5, 0.16, 0.11, 0.24, mix, { nOut: 0.35, a0: 0.2 });
    leaf(b, cx, cy, 0.13, 1.2, 0.14, 0.10, 0.20, CL, { nOut: 0.25 });
    return;
  }
  // stake
  b.cylinder(cx, cy, 0, 0.98, 0.052, 5, M('woodWeathered'), { rTop: 0.042 });
  b.box(cx - 0.032, cy - 0.032, 0.96, 0.064, 0.064, 0.035, M('woodPlankDk'), { occ: false });
  const ripe = s === 4;
  // main stem climbing the stake + side branches
  blade(b, cx, cy, 0.03, 0.6, ripe ? 0.86 : 0.62, 0.07, CD, { nUp: 0.86, nOut: 0.34, tipW: 0.5, bend: 0.06 });
  rosette(b, cx, cy, 0.05, 6, 0.20, 0.135, 0.26, mix, { nOut: 0.3, a0: 0.4 });
  rosette(b, cx, cy, 0.30, 6, 0.19, 0.13, 0.26, [CD, CL, CD, CL, CD, CL], { nOut: 0.3, a0: 0.1 });
  if (ripe) rosette(b, cx, cy, 0.56, 5, 0.16, 0.12, 0.24, [CL, CD, CL, CD, CL], { nOut: 0.28 });
  tie(b, cx, cy, 0.28, 0.13, M('hayDk'));
  tie(b, cx, cy, 0.58, 0.12, M('hayDk'));

  // stage 2 is a bare bush; fruit only from stage 3 up
  if (s < 3) {
    leaf(b, cx, cy, 0.46, 2.2, 0.15, 0.11, 0.22, CL, { nOut: 0.25 });
    leaf(b, cx, cy, 0.2, 4.4, 0.16, 0.12, 0.24, CD, { nOut: 0.25 });
    return;
  }

  // trusses of fruit, hung on the outside of the bush so they break the silhouette
  const F = ripe ? M('cropTomato') : M('cropMelon');
  const truss = (tx, ty, tz, n, r) => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + 0.5;
      const x = tx + Math.cos(a) * r * 1.05, y = ty + Math.sin(a) * r * 1.05;
      const z = tz - (i % 2) * 0.05;
      blade(b, tx, ty, tz + 0.05, a, Math.max(0.04, tz + 0.05 - z), 0.03, CD, { nUp: 0.9, nOut: 0.3, tipW: 0.6, bend: 0 });
      b.dome(x, y, z, ripe ? 0.072 : 0.058, ripe ? 0.075 : 0.058, F, { seg: 7, rings: 2 });
      if (ripe) b.box(x - 0.012, y - 0.012, z + 0.072, 0.024, 0.024, 0.02, CD, { occ: false });
    }
  };
  if (ripe) {
    truss(cx + 0.24, cy + 0.20, 0.20, 4, 0.10);
    truss(cx - 0.22, cy + 0.10, 0.42, 3, 0.09);
    truss(cx + 0.06, cy - 0.24, 0.62, 3, 0.09);
    for (let i = 0; i < 3; i++) {
      const a = i * 2.1 + 0.3;
      b.dome(cx + Math.cos(a) * 0.16, cy + Math.sin(a) * 0.16, 0.76, 0.04, 0.03, M('flowerYellow'), { seg: 6, rings: 1 });
    }
  } else {
    truss(cx + 0.22, cy + 0.18, 0.22, 3, 0.085);
    truss(cx - 0.20, cy + 0.06, 0.44, 2, 0.075);
    for (let i = 0; i < 4; i++) {
      const a = i * 1.57 + 0.9;
      b.dome(cx + Math.cos(a) * 0.15, cy + Math.sin(a) * 0.15, 0.72, 0.042, 0.032, M('flowerYellow'), { seg: 6, rings: 1 });
    }
  }
}

// ---------------------------------------------------------------------------
// corn — the tall one; long arcing blades, a tassel, cobs half-way up
// ---------------------------------------------------------------------------
function stalk(b, x, y, h, ripe) {
  const CL = M('cropLeaf'), CD = M('cropLeafDk');
  b.cylinder(x, y, 0, h, 0.056, 6, CD, { rTop: 0.032 });
  const n = Math.max(4, Math.round(h / 0.19));
  for (let i = 0; i < n; i++) {
    const a = i * 2.399963 + 0.7;
    const z = 0.1 + (i / n) * (h - 0.28);
    const len = 0.26 + 0.16 * (1 - Math.abs((i / n) - 0.45) * 1.4);
    arcLeaf(b, x, y, z, a, len, len * 0.42, len * 0.12, 0.085, i % 2 ? CL : CD, { nUp: 0.72, nOut: 0.5 });
  }
  // tassel — green until the plant is ripe, so it never reads as harvest-ready early
  const t = ripe ? M('flowerYellow') : CL;
  const t2 = ripe ? M('cropWheat') : CD;
  for (let i = 0; i < 5; i++) {
    const a = i * 1.257 + 0.3;
    blade(b, x, y, h - 0.03, a, 0.2, 0.028, i % 2 ? t : t2, { nUp: 0.8, nOut: 0.7, tipW: 0.3, bend: 0.1 });
  }
  if (ripe) {
    for (let i = 0; i < 2; i++) {
      const a = i * 3.1 + 1.1;
      const bx = x + Math.cos(a) * 0.05, by = y + Math.sin(a) * 0.05;
      const z = h * 0.44 + i * 0.14;
      tube(b, [bx, by, z], [bx + Math.cos(a) * 0.16, by + Math.sin(a) * 0.16, z - 0.13], 0.035, 0.05, 5, M('cropCorn'), { cap: true, occ: false });
      for (let k = 0; k < 3; k++) {
        const aa = a + (k - 1) * 0.5;
        blade(b, bx, by, z + 0.05, aa, 0.19, 0.05, CL, { nUp: 0.7, nOut: 0.5, tipW: 0.35, bend: 0.07 });
      }
    }
  }
}

function buildCorn(b, s) {
  const CL = M('cropLeaf'), CD = M('cropLeafDk');
  const cx = 0.5, cy = 0.5;
  mound(b, s < 2 ? 0.17 : 0.24, 0.03);
  if (s === 0) {
    for (let i = 0; i < 4; i++) {
      const a = i * 1.6 + 0.4;
      blade(b, cx, cy, 0.02, a, 0.15, 0.075, i % 2 ? CL : CD, { nUp: 0.75, nOut: 0.6, tipW: 0.2, bend: 0.05 });
    }
    return;
  }
  if (s === 1) {
    for (let i = 0; i < 6; i++) {
      const a = i * 1.05 + 0.2;
      arcLeaf(b, cx, cy, 0.02, a, 0.2, 0.38, 0.26, 0.08, i % 2 ? CL : CD, { nUp: 0.75, nOut: 0.55 });
    }
    return;
  }
  if (s === 2) {
    stalk(b, cx + 0.14, cy + 0.1, 0.82, false);
    for (let i = 0; i < 5; i++) {
      const a = i * 1.3 + 0.5;
      arcLeaf(b, cx - 0.1, cy - 0.06, 0.02, a, 0.26, 0.3, 0.2, 0.085, i % 2 ? CL : CD, { nUp: 0.75, nOut: 0.55 });
    }
    return;
  }
  if (s === 3) {
    stalk(b, cx + 0.13, cy + 0.11, 1.02, false);
    stalk(b, cx + 0.04, cy - 0.12, 1.24, false);
    stalk(b, cx - 0.14, cy + 0.02, 0.9, false);
    return;
  }
  stalk(b, cx + 0.15, cy + 0.12, 1.35, true);
  stalk(b, cx + 0.05, cy - 0.13, 1.72, true);
  stalk(b, cx - 0.15, cy + 0.03, 1.16, true);
  // a couple of ground-level suckers to thicken the base
  for (let i = 0; i < 4; i++) {
    const a = i * 1.6 + 2.2;
    arcLeaf(b, cx, cy, 0.02, a, 0.3, 0.28, 0.14, 0.09, i % 2 ? CL : CD, { nUp: 0.72, nOut: 0.6 });
  }
}

// ---------------------------------------------------------------------------
// wheat — a clump of straight stalks; ripe = golden heads that triple the width
// ---------------------------------------------------------------------------
function wheatClump(b, cx, cy, spread, n, h, ripe, s3) {
  const CL = M('cropLeaf'), CD = M('cropLeafDk');
  const head = ripe ? M('cropWheat') : (s3 ? CD : null);
  for (let i = 0; i < n; i++) {
    const a = i * 2.399963 + 0.9;
    const rr = spread * (0.3 + 0.7 * ((i * 7) % 5) / 4);
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
    const hh = h * (0.72 + 0.32 * (((i * 3) % 7) / 6));
    // stalks lean AWAY from the clump centre so the sheaf fans instead of
    // collapsing into a single vertical column
    const dir = Math.atan2(y - cy, x - cx) + (b.rng() - 0.5) * 0.6;
    const mat = i % 3 === 0 ? CD : CL;
    const lean = 0.14 + 0.1 * (((i * 5) % 3) / 2);
    blade(b, x, y, 0.012, dir, hh, 0.048, mat, { nUp: 0.9, nOut: 0.3, tipW: 0.55, bend: hh * lean });
    if (head !== null) {
      const tx = x + Math.cos(dir) * hh * lean, ty = y + Math.sin(dir) * hh * lean;
      const hm = ripe && i % 4 === 0 ? M('hay') : head;
      const hz = 0.012 + hh * 0.74;
      const hh2 = hh * 0.26;
      const nd = nrm(Math.cos(dir) * 0.35, Math.sin(dir) * 0.35, 1);
      // grain head: a bulging 2-segment ear, wide enough to survive the resolve
      strip(b, [tx, ty, hz], [tx + Math.cos(dir) * 0.012, ty + Math.sin(dir) * 0.012, hz + hh2 * 0.55], 0.05, 0.085, hm, nd, {});
      strip(b, [tx + Math.cos(dir) * 0.012, ty + Math.sin(dir) * 0.012, hz + hh2 * 0.55], [tx + Math.cos(dir) * 0.02, ty + Math.sin(dir) * 0.02, hz + hh2], 0.085, 0.028, hm, nd, {});
      for (let k = 0; k < 4; k++) {
        const aa = dir + (k - 1.5) * 0.6;
        blade(b, tx, ty, hz + hh2 * 0.5, aa, hh2 * 0.85, 0.022, hm, { nUp: 0.7, nOut: 0.6, tipW: 0.2, bend: 0.035 });
      }
    }
  }
}

function buildWheat(b, s) {
  const cx = 0.5, cy = 0.5;
  mound(b, s < 2 ? 0.15 : 0.24, 0.022, 'soil');
  if (s === 0) { wheatClump(b, cx, cy, 0.08, 6, 0.15, false, false); return; }
  if (s === 1) { wheatClump(b, cx, cy, 0.15, 10, 0.34, false, false); return; }
  if (s === 2) { wheatClump(b, cx, cy, 0.21, 13, 0.53, false, false); return; }
  if (s === 3) { wheatClump(b, cx, cy, 0.25, 15, 0.74, false, true); return; }
  wheatClump(b, cx, cy, 0.28, 18, 0.92, true, false);
}

// ---------------------------------------------------------------------------
// pumpkin — a ground vine; the fruit is the whole silhouette change
// ---------------------------------------------------------------------------
function buildPumpkin(b, s) {
  const CL = M('cropLeaf'), CD = M('cropLeafDk');
  const cx = 0.5, cy = 0.5;
  mound(b, s < 2 ? 0.16 : 0.26, 0.026);
  if (s === 0) {
    blade(b, cx, cy, 0.02, 0.6, 0.075, 0.045, CD, { nUp: 0.85, nOut: 0.4, tipW: 0.5 });
    leaf(b, cx, cy, 0.075, 0.6, 0.085, 0.095, 0.06, CL, { nOut: 0.4 });
    leaf(b, cx, cy, 0.075, 3.7, 0.085, 0.095, 0.06, CD, { nOut: 0.4 });
    return;
  }
  if (s === 1) {
    arcLeaf(b, cx, cy, 0.015, 0.5, 0.26, 0.1, 0.04, 0.06, CD, { nUp: 0.6, nOut: 0.6 });
    arcLeaf(b, cx, cy, 0.015, 3.6, 0.2, 0.09, 0.04, 0.055, CD, { nUp: 0.6, nOut: 0.6 });
    leaf(b, cx + 0.1, cy + 0.06, 0.05, 0.5, 0.15, 0.15, 0.15, CL, { nOut: 0.45 });
    leaf(b, cx - 0.06, cy - 0.08, 0.05, 3.7, 0.14, 0.14, 0.16, CD, { nOut: 0.45 });
    leaf(b, cx + 0.02, cy - 0.02, 0.06, 1.9, 0.12, 0.12, 0.19, CL, { nOut: 0.4 });
    return;
  }
  const vines = s === 2 ? 3 : 4;
  for (let i = 0; i < vines; i++) {
    const a = i * 1.57 + 0.5;
    arcLeaf(b, cx, cy, 0.015, a, 0.32 + 0.04 * (i % 2), 0.1, 0.03, 0.062, i % 2 ? CD : CL, { nUp: 0.62, nOut: 0.6 });
  }
  const rise = s === 2 ? 0.27 : (s === 3 ? 0.31 : 0.36);
  const LN = s === 2 ? 6 : 7;
  for (let i = 0; i < LN; i++) {
    const a = i * 1.05 + 0.9;
    const rr = 0.13 + 0.12 * ((i * 5) % 4) / 3;
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
    const z = 0.045 + 0.03 * ((i * 3) % 3) / 2;
    const M1 = i % 2 ? CL : CD;
    leaf(b, x, y, z, a, 0.15 + 0.03 * (i % 3), 0.17 + 0.03 * (i % 2), rise, M1, { nOut: 0.45 });
    leaf(b, x, y, z + 0.01, a + 0.7, 0.11, 0.13, rise * 0.8, i % 2 ? CD : CL, { nOut: 0.45 });
  }
  if (s === 2) return;
  if (s === 3) {
    // buds + one green fruit
    for (let i = 0; i < 3; i++) {
      const a = i * 2.1 + 0.4;
      const x = cx + Math.cos(a) * 0.24, y = cy + Math.sin(a) * 0.24;
      blade(b, x, y, 0.05, a, 0.14, 0.035, CD, { nUp: 0.9, nOut: 0.35, tipW: 0.4 });
      b.dome(x + Math.cos(a) * 0.06, y + Math.sin(a) * 0.06, 0.17, 0.055, 0.05, M('flowerYellow'), { seg: 6, rings: 2 });
    }
    b.dome(0.68, 0.64, 0.004, 0.13, 0.145, M('cropMelon'), { seg: 8, rings: 3 });
    tube(b, [0.68, 0.64, 0.14], [0.64, 0.70, 0.2], 0.028, 0.02, 5, CD, { occ: false });
    return;
  }
  // ripe: a big ribbed fruit plus a small one, leaves arching over them
  for (let i = 0; i < 3; i++) {
    const a = i * 2.1 + 0.4;
    const x = cx + Math.cos(a) * 0.24, y = cy + Math.sin(a) * 0.24;
    blade(b, x, y, 0.05, a, 0.15, 0.035, CD, { nUp: 0.9, nOut: 0.35, tipW: 0.4 });
    b.dome(x + Math.cos(a) * 0.06, y + Math.sin(a) * 0.06, 0.18, 0.055, 0.05, M('flowerYellow'), { seg: 6, rings: 2 });
  }
  pumpkinFruit(b, 0.64, 0.63, 0.215, 0.245, M('cropPumpkin'), 9);
  pumpkinFruit(b, 0.24, 0.74, 0.115, 0.13, M('cropPumpkin'), 8);
  tube(b, [0.64, 0.63, 0.22], [0.61, 0.71, 0.31], 0.038, 0.03, 6, M('coniferDk'), { occ: false });
  leaf(b, 0.62, 0.6, 0.25, 2.4, 0.18, 0.19, 0.15, CL, { nOut: 0.4 });
  leaf(b, 0.78, 0.5, 0.22, 4.1, 0.16, 0.17, 0.17, CD, { nOut: 0.4 });
  leaf(b, 0.28, 0.72, 0.12, 0.8, 0.14, 0.15, 0.13, CD, { nOut: 0.4 });
}

/** A ribbed squash: rings modulated per column so the ribs survive the outline pass. */
function pumpkinFruit(b, cx, cy, r, h, mat, ribs) {
  const rings = 4, cols = ribs * 2;
  const P = [];
  for (let j = 0; j <= rings; j++) {
    const t = j / rings;
    const rr = r * Math.cos((t * Math.PI) / 2);
    const zz = 0.004 + h * Math.sin((t * Math.PI) / 2);
    const row = [];
    for (let i = 0; i < cols; i++) {
      const a = (i / cols) * TAU;
      const k = 1 + 0.06 * Math.cos(a * ribs);
      row.push([cx + Math.cos(a) * rr * k, cy + Math.sin(a) * rr * k, zz]);
    }
    P.push(row);
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < cols; i++) {
      const i2 = (i + 1) % cols;
      const a = P[j][i], bb = P[j][i2], c = P[j + 1][i2], d = P[j + 1][i];
      const mx = (a[0] + c[0]) * 0.5 - cx, my = (a[1] + c[1]) * 0.5 - cy, mz = (a[2] + c[2]) * 0.5 - h * 0.4;
      b.m.quad(bb, a, d, c, mat, nrm(mx, my, mz));
    }
  }
  b.m.occluders.push({ mn: [cx - r, cy - r, 0], mx: [cx + r, cy + r, h] });
}

// ---------------------------------------------------------------------------
// strawberry — low trifoliate bush; berries hang under the leaves
// ---------------------------------------------------------------------------
function buildStrawberry(b, s) {
  const CL = M('cropLeaf'), CD = M('cropLeafDk');
  const cx = 0.5, cy = 0.5;
  mound(b, s < 2 ? 0.13 : 0.2, 0.024);
  const node = (x, y, z, ang, len, wid, rise, i) => {
    const a1 = i % 2 ? CL : CD, a2 = i % 2 ? CD : CL;
    leaf(b, x, y, z, ang, len, wid, rise, a1, { nOut: 0.36 });
    leaf(b, x, y, z, ang + 0.85, len * 0.86, wid * 0.92, rise * 0.86, a2, { nOut: 0.36 });
    leaf(b, x, y, z, ang - 0.85, len * 0.86, wid * 0.92, rise * 0.86, a2, { nOut: 0.36 });
  };
  if (s === 0) {
    node(cx, cy, 0.015, 0.5, 0.075, 0.07, 0.085, 0);
    node(cx, cy, 0.015, 3.6, 0.07, 0.065, 0.08, 1);
    return;
  }
  if (s === 1) {
    node(cx, cy, 0.02, 0.4, 0.12, 0.10, 0.17, 0);
    node(cx, cy, 0.02, 2.3, 0.115, 0.095, 0.17, 1);
    node(cx, cy, 0.02, 4.2, 0.11, 0.09, 0.16, 2);
    return;
  }
  const K = s === 2 ? 4 : 5;
  for (let i = 0; i < K; i++) {
    const a = (i / K) * TAU + 0.35;
    const rr = 0.09 + 0.03 * (i % 2);
    node(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 0.03 + 0.02 * (i % 3), a, s === 2 ? 0.145 : 0.16, s === 2 ? 0.115 : 0.13, s === 2 ? 0.20 : 0.235, i);
  }
  if (s === 2) return;
  if (s === 3) {
    for (let i = 0; i < 5; i++) {
      const a = i * 1.257 + 0.2;
      const x = cx + Math.cos(a) * 0.19, y = cy + Math.sin(a) * 0.19;
      b.dome(x, y, 0.14 + 0.02 * (i % 2), 0.05, 0.032, M('white'), { seg: 6, rings: 2 });
      b.dome(x, y, 0.158 + 0.02 * (i % 2), 0.024, 0.018, M('flowerYellow'), { seg: 5, rings: 1 });
    }
    return;
  }
  // ripe: berries slung outside the leaf mass, red calyx-capped
  for (let i = 0; i < 6; i++) {
    const a = i * 1.05 + 0.25;
    const x = cx + Math.cos(a) * 0.205, y = cy + Math.sin(a) * 0.205;
    const z = 0.055 + 0.02 * (i % 2);
    blade(b, cx, cy, z + 0.1, a, 0.13, 0.026, CD, { nUp: 0.85, nOut: 0.4, tipW: 0.7, bend: 0 });
    b.dome(x, y, z, 0.058, 0.075, M('cropBerry'), { seg: 7, rings: 2 });
    leaf(b, x, y, z + 0.062, a + 1.6, 0.05, 0.05, 0.012, CL, { nOut: 0.7 });
    leaf(b, x, y, z + 0.062, a - 1.6, 0.05, 0.05, 0.012, CL, { nOut: 0.7 });
  }
  for (let i = 0; i < 3; i++) {
    const a = i * 2.1 + 1.2;
    b.dome(cx + Math.cos(a) * 0.15, cy + Math.sin(a) * 0.15, 0.17, 0.045, 0.03, M('white'), { seg: 6, rings: 2 });
  }
  for (let i = 0; i < 4; i++) {
    const a = i * 1.57 + 2.6;
    node(cx + Math.cos(a) * 0.1, cy + Math.sin(a) * 0.1, 0.16, a, 0.13, 0.11, 0.2, i);
  }
}

// ---------------------------------------------------------------------------
// carrot — feathery top; the orange shoulder is the ripeness cue
// ---------------------------------------------------------------------------
function feather(b, cx, cy, z0, n, len, spread, mats) {
  for (let i = 0; i < n; i++) {
    const a = i * 2.399963 + 0.4;
    const rr = spread * (0.25 + 0.75 * (((i * 5) % 7) / 6));
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
    const dir = a + (b.rng() - 0.5) * 0.5;
    const hh = len * (0.72 + 0.34 * (((i * 3) % 5) / 4));
    blade(b, x, y, z0, dir, hh, 0.035, mats[i % mats.length], { nUp: 0.72, nOut: 0.5, tipW: 0.12, bend: hh * 0.34 });
  }
}

function buildCarrot(b, s) {
  const CL = M('cropLeaf'), CD = M('cropLeafDk');
  const mats = [CL, CD, CL, CD, CL, CL, CD];
  const cx = 0.5, cy = 0.5;
  mound(b, s < 2 ? 0.13 : 0.19, 0.022, 'soil');
  if (s === 0) { feather(b, cx, cy, 0.02, 5, 0.12, 0.05, mats); return; }
  if (s === 1) { feather(b, cx, cy, 0.03, 10, 0.27, 0.09, mats); return; }
  if (s === 2) {
    feather(b, cx, cy, 0.03, 16, 0.39, 0.12, mats);
    b.dome(cx, cy, 0.004, 0.06, 0.05, M('cropLeafDk'), { seg: 7, rings: 2 });
    return;
  }
  const ripe = s === 4;
  const r = ripe ? 0.13 : 0.085, h = ripe ? 0.115 : 0.07;
  b.dome(cx, cy, 0.004, r, h, M('cropCarrot'), { seg: 8, rings: 2 });
  if (ripe) {
    // a soil lip around the shoulder sells "pulling it up"
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU + 0.2;
      b.box(cx + Math.cos(a) * (r + 0.015) - 0.045, cy + Math.sin(a) * (r + 0.015) - 0.045, 0, 0.09, 0.09, 0.028, M('soilDk'), { occ: false });
    }
  }
  feather(b, cx, cy, h * 0.8, ripe ? 22 : 18, ripe ? 0.42 : 0.36, ripe ? 0.13 : 0.115, mats);
}

// ---------------------------------------------------------------------------
// descriptor table
// ---------------------------------------------------------------------------
const STAGE = ['sprout', 'seedling', 'bush', 'unripe', 'RIPE'];

const CROPS = [
  { id: 'turnip', label: 'TURNIP', seed: 101, cap: [0.14, 0.35, 0.53, 0.54, 0.73], build: buildTurnip },
  { id: 'potato', label: 'POTATO', seed: 211, cap: [0.15, 0.31, 0.47, 0.49, 0.53], build: buildPotato },
  { id: 'tomato', label: 'TOMATO', seed: 307, cap: [0.17, 0.35, 1.01, 1.01, 1.01], build: buildTomato },
  { id: 'corn', label: 'CORN', seed: 401, cap: [0.18, 0.42, 1.01, 1.43, 1.91], build: buildCorn },
  { id: 'wheat', label: 'WHEAT', seed: 503, cap: [0.18, 0.39, 0.58, 0.87, 1.08], build: buildWheat },
  { id: 'pumpkin', label: 'PUMPKIN', seed: 601, cap: [0.15, 0.27, 0.34, 0.37, 0.42], build: buildPumpkin },
  { id: 'strawberry', label: 'STRAWBERRY', seed: 709, cap: [0.12, 0.21, 0.29, 0.32, 0.38], build: buildStrawberry },
  { id: 'carrot', label: 'CARROT', seed: 809, cap: [0.17, 0.34, 0.46, 0.46, 0.56], build: buildCarrot },
];

export const MODELS = [];
for (const c of CROPS) {
  for (let s = 0; s < 5; s++) {
    MODELS.push({
      id: `crop_${c.id}_${s}`,
      name: `${c.label} ${STAGE[s]}`,
      cat: 'crop',
      fp: [1, 1],
      seed: c.seed + s * 17,
      cap: c.cap[s],
      build: (b) => c.build(b, s),
    });
  }
}
