// Procedural mesh builder for the offline pre-renderer.
// Local model space: x,y in tile units on the ground plane (footprint [0,w]x[0,d]),
// z is height in world units (1 z-unit = ZPX pixels on screen, see render.mjs).
// Every model is expected to keep its anchor at (w/2, d/2, 0).

import { PAT, MAT_LIST, MATS } from './materials.mjs';

const V = (x, y, z) => [x, y, z];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export class Mesh {
  constructor() {
    this.pos = [];
    this.ao = [];
    this.tint = [];
    this.faces = [];
    this.occluders = [];
    this.warn = [];
    // Occupancy boxes for the runtime interior volume. A model declares what it
    // is made of in *solid* terms as it builds, so the 3D transmittance volume
    // the sun ray-marches through is generated from the very same code that
    // generates the sprite — they cannot drift apart.
    this.vol = [];
    this.gidCounter = 1;
  }
  /**
   * Record an occupancy box.
   * @param kind 'solid' blocks sunlight, 'glass' lets a tinted fraction through
   * @param o    { trans, tint:[r,g,b] } — defaults suit clear window glass
   */
  mark(kind, x, y, z, w, d, h, o = {}) {
    this.vol.push({
      kind, x0: x, y0: y, z0: z, x1: x + w, y1: y + d, z1: z + h,
      trans: o.trans, tint: o.tint,
    });
    return this;
  }
  newGid() { return this.gidCounter++; }
  vert(x, y, z) {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.ao.push(1);
    this.tint.push(1);
    return i;
  }
  face(vs, m, n, o = {}) {
    let nn = n;
    if (!nn) {
      const p0 = this.pt(vs[0]), p1 = this.pt(vs[1]), p2 = this.pt(vs[vs.length - 1]);
      nn = norm(cross(sub(p1, p0), sub(p2, p0)));
    }
    this.faces.push({ v: vs, n: nn, m, gid: o.gid !== undefined ? o.gid : this.gidCounter++, detail: o.detail ? 1 : 0 });
    return this.faces.length - 1;
  }
  pt(i) { return [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]]; }
  quad(p0, p1, p2, p3, m, n, o) {
    const a = this.vert(...p0), b = this.vert(...p1), c = this.vert(...p2), d = this.vert(...p3);
    return this.face([a, b, c, d], m, n, o);
  }
  tri(p0, p1, p2, m, n, o) {
    const a = this.vert(...p0), b = this.vert(...p1), c = this.vert(...p2);
    return this.face([a, b, c], m, n, o);
  }
  bbox() {
    let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let i = 0; i < this.pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = this.pos[i + k];
        if (v < mn[k]) mn[k] = v;
        if (v > mx[k]) mx[k] = v;
      }
    }
    return { mn, mx };
  }
  /** cheap sanity check against the declared footprint */
  validate(fp) {
    const { mn, mx } = this.bbox();
    const tol = 0.75;
    if (fp && (mn[0] < -tol || mn[1] < -tol || mx[0] > fp[0] + tol || mx[1] > fp[1] + tol)) {
      this.warn.push(`mesh outside footprint [${fp}] -> x[${mn[0].toFixed(2)},${mx[0].toFixed(2)}] y[${mn[1].toFixed(2)},${mx[1].toFixed(2)}]`);
    }
    if (mn[2] < -0.02) this.warn.push(`mesh below ground: z=${mn[2].toFixed(3)}`);
    return this.warn;
  }
}

// --- deterministic hash / rng -------------------------------------------------
export function hash3(x, y, z, s = 0) {
  let h = Math.imul(Math.round(x * 4096) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ Math.round(y * 4096), 0xc2b2ae35);
  h = Math.imul(h ^ Math.round(z * 4096), 0x27d4eb2f);
  h = Math.imul(h ^ (s * 2654435761), 0x165667b1);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
export function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export class Builder {
  constructor(w = 1, d = 1, seed = 1) {
    this.m = new Mesh();
    this.w = w; this.d = d;
    this.rng = makeRng(seed);
    this.cx = w / 2; this.cy = d / 2;
  }
  get mesh() { return this.m; }

  // ---- raw primitives -------------------------------------------------------
  box(x, y, z, w, d, h, m, o = {}) {
    const m2 = this.m;
    const f = o.faces || {};
    const skip = o.skip || {};
    const x1 = x + w, y1 = y + d, z1 = z + h;
    const M = (k, def) => (f[k] !== undefined ? f[k] : def);
    if (!skip.nx) m2.quad(V(x, y1, z), V(x, y, z), V(x, y, z1), V(x, y1, z1), M('nx', m), [-1, 0, 0]);
    if (!skip.px) m2.quad(V(x1, y, z), V(x1, y1, z), V(x1, y1, z1), V(x1, y, z1), M('px', m), [1, 0, 0]);
    if (!skip.ny) m2.quad(V(x1, y, z), V(x, y, z), V(x, y, z1), V(x1, y, z1), M('ny', m), [0, -1, 0]);
    if (!skip.py) m2.quad(V(x, y1, z), V(x1, y1, z), V(x1, y1, z1), V(x, y1, z1), M('py', m), [0, 1, 0]);
    if (!skip.pz) m2.quad(V(x, y, z1), V(x1, y, z1), V(x1, y1, z1), V(x, y1, z1), M('pz', m), [0, 0, 1]);
    if (o.bottom || skip.bottom === false) m2.quad(V(x, y, z), V(x1, y, z), V(x1, y1, z), V(x, y1, z), M('nz', m), [0, 0, -1]);
    if (o.occ !== false) m2.occluders.push({ mn: [x - 0.01, y - 0.01, z - 0.01], mx: [x1 + 0.01, y1 + 0.01, z1 + 0.01] });
    return { x, y, z, w, d, h, x1, y1, z1 };
  }
  /** horizontal slab (a "floor plate"), no bottom face */
  slab(x, y, z, w, d, t, m, o = {}) { return this.box(x, y, z, w, d, t, m, o); }

  /** record an occupancy box in model space (see Mesh.mark) */
  mark(kind, x, y, z, w, d, h, o) { this.m.mark(kind, x, y, z, w, d, h, o); return this; }

  /** build a box and mark it solid in one call — the common case for walls */
  solidBox(x, y, z, w, d, h, m, o = {}) {
    const r = this.box(x, y, z, w, d, h, m, o);
    this.m.mark('solid', x, y, z, w, d, h);
    return r;
  }

  /** build a box and mark it as light-transmitting glass */
  glassBox(x, y, z, w, d, h, m, o = {}, vol = {}) {
    const r = this.box(x, y, z, w, d, h, m, o);
    this.m.mark('glass', x, y, z, w, d, h, vol);
    return r;
  }
  quad(p0, p1, p2, p3, m, n) { return this.m.quad(p0, p1, p2, p3, m, n); }

  cylinder(cx, cy, z0, z1, r, sides, m, o = {}) {
    const rTop = o.rTop !== undefined ? o.rTop : r;
    const seg = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 + (o.rot || 0);
      seg.push([Math.cos(a), Math.sin(a)]);
    }
    const sideGid = this.m.newGid();
    for (let i = 0; i < sides; i++) {
      const a = seg[i], b = seg[(i + 1) % sides];
      const n = norm([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0]);
      const p0 = [cx + a[0] * r, cy + a[1] * r, z0], p1 = [cx + b[0] * r, cy + b[1] * r, z0];
      const p2 = [cx + b[0] * rTop, cy + b[1] * rTop, z1], p3 = [cx + a[0] * rTop, cy + a[1] * rTop, z1];
      this.m.quad(p1, p0, p3, p2, m, n, { gid: sideGid });
    }
    if (o.top !== false && rTop > 1e-4) {
      const top = o.topMat !== undefined ? o.topMat : m;
      const pts = seg.map((s) => [cx + s[0] * rTop, cy + s[1] * rTop, z1]);
      this.fan(pts, top, [0, 0, 1], true, { gid: this.m.newGid() });
    }
    if (o.bottom && r > 1e-4) {
      const pts = seg.map((s) => [cx + s[0] * r, cy + s[1] * r, z0]);
      this.fan(pts, m, [0, 0, -1], false, { gid: this.m.newGid() });
    }
    if (o.occ !== false) this.m.occluders.push({ mn: [cx - r - 0.01, cy - r - 0.01, z0 - 0.01], mx: [cx + r + 0.01, cy + r + 0.01, z1 + 0.01] });
  }
  /** triangle fan cap; pts ordered around the rim */
  fan(pts, m, n, ccw, o) {
    const list = ccw ? pts : pts.slice().reverse();
    for (let i = 1; i < list.length - 1; i++) this.m.tri(list[0], list[i], list[i + 1], m, n, o);
  }
  dome(cx, cy, z, r, h, m, o = {}) {
    const rings = o.rings || 4, seg = o.seg || 12;
    const gid = this.m.newGid();
    const P = [];
    for (let j = 0; j <= rings; j++) {
      const t = j / rings;
      const rr = r * Math.cos((t * Math.PI) / 2);
      const zz = z + h * Math.sin((t * Math.PI) / 2);
      const row = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        row.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, zz]);
      }
      P.push(row);
    }
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < seg; i++) {
        const i2 = (i + 1) % seg;
        const a = P[j][i], b = P[j][i2], c = P[j + 1][i2], d = P[j + 1][i];
        const mid = [(a[0] + c[0]) / 2 - cx, (a[1] + c[1]) / 2 - cy, (a[2] + c[2]) / 2 - z - h * 0.35];
        this.m.quad(b, a, d, c, m, norm(mid), { gid });
      }
    }
    this.m.occluders.push({ mn: [cx - r, cy - r, z - 0.01], mx: [cx + r, cy + r, z + h] });
  }
  /** triangular prism roof, ridge along `axis` */
  gable(x, y, z, w, d, h, m, o = {}) {
    const axis = o.axis || 'x';
    const ov = o.overhang || 0;
    const x0 = x - ov, y0 = y - ov, x1 = x + w + ov, y1 = y + d + ov;
    const endMat = o.endMat !== undefined ? o.endMat : m;
    if (axis === 'x') {
      const ym = (y0 + y1) / 2;
      const nA = norm([0, -h, d / 2 + ov]), nB = norm([0, h, d / 2 + ov]);
      this.m.quad(V(x0, ym, z + h), V(x0, y0, z), V(x1, y0, z), V(x1, ym, z + h), m, nA);
      this.m.quad(V(x0, y1, z), V(x0, ym, z + h), V(x1, ym, z + h), V(x1, y1, z), m, nB);
      this.m.tri(V(x0, y0, z), V(x0, ym, z + h), V(x0, y1, z), endMat, [-1, 0, 0]);
      this.m.tri(V(x1, y1, z), V(x1, ym, z + h), V(x1, y0, z), endMat, [1, 0, 0]);
      if (o.occ !== false) this.m.occluders.push({ mn: [x0, y0, z], mx: [x1, y1, z + h] });
    } else {
      const xm = (x0 + x1) / 2;
      const nA = norm([-h, 0, w / 2 + ov]), nB = norm([h, 0, w / 2 + ov]);
      this.m.quad(V(x0, y0, z), V(xm, y0, z + h), V(xm, y1, z + h), V(x0, y1, z), m, nA);
      this.m.quad(V(xm, y0, z + h), V(x1, y0, z), V(x1, y1, z), V(xm, y1, z + h), m, nB);
      this.m.tri(V(x0, y0, z), V(x1, y0, z), V(xm, y0, z + h), endMat, [0, -1, 0]);
      this.m.tri(V(x1, y1, z), V(x0, y1, z), V(xm, y1, z + h), endMat, [0, 1, 0]);
      if (o.occ !== false) this.m.occluders.push({ mn: [x0, y0, z], mx: [x1, y1, z + h] });
    }
  }
  hip(x, y, z, w, d, h, m, o = {}) {
    const ov = o.overhang || 0;
    const rf = o.ridgeFrac !== undefined ? o.ridgeFrac : 0.3;
    const x0 = x - ov, y0 = y - ov, x1 = x + w + ov, y1 = y + d + ov;
    const W = x1 - x0, D = y1 - y0;
    const cxm = (x0 + x1) / 2, cym = (y0 + y1) / 2;
    let r0, r1;
    if (W >= D) { const rl = W * rf; r0 = [cxm - rl / 2, cym]; r1 = [cxm + rl / 2, cym]; }
    else { const rl = D * rf; r0 = [cxm, cym - rl / 2]; r1 = [cxm, cym + rl / 2]; }
    const R0 = V(r0[0], r0[1], z + h), R1 = V(r1[0], r1[1], z + h);
    const A = V(x0, y0, z), B = V(x1, y0, z), C = V(x1, y1, z), Dv = V(x0, y1, z);
    const hw = (W + D) / 2;
    if (W >= D) {
      this.m.quad(R0, R1, B, A, m, norm([0, -h, D / 2]));
      this.m.quad(R1, R0, Dv, C, m, norm([0, h, D / 2]));
    } else {
      this.m.quad(R0, A, B, R1, m, norm([0, -h, D / 2]));
      this.m.quad(R1, C, Dv, R0, m, norm([0, h, D / 2]));
    }
    this.m.tri(R0, A, Dv, m, norm([-h, 0, hw / 2]));
    this.m.tri(R1, C, B, m, norm([h, 0, hw / 2]));
    if (o.occ !== false) this.m.occluders.push({ mn: [x0, y0, z], mx: [x1, y1, z + h] });
  }
  pyramid(x, y, z, w, d, h, m, o = {}) {
    const ov = o.overhang || 0;
    const x0 = x - ov, y0 = y - ov, x1 = x + w + ov, y1 = y + d + ov;
    const A = V(x0, y0, z), B = V(x1, y0, z), C = V(x1, y1, z), D = V(x0, y1, z);
    const T = V((x0 + x1) / 2, (y0 + y1) / 2, z + h);
    this.m.tri(A, B, T, m, norm([0, -1, 1]));
    this.m.tri(B, C, T, m, norm([1, 0, 1]));
    this.m.tri(C, D, T, m, norm([0, 1, 1]));
    this.m.tri(D, A, T, m, norm([-1, 0, 1]));
    if (o.occ !== false) this.m.occluders.push({ mn: [x0, y0, z], mx: [x1, y1, z + h] });
  }
  shed(x, y, z, w, d, h, m, o = {}) {
    const dir = o.dir || '+y';
    const x0 = x, y0 = y, x1 = x + w, y1 = y + d;
    if (dir === '+y' || dir === '-y') {
      const [ylo, yhi, nrm] = dir === '+y' ? [y0, y1, 1] : [y1, y0, -1];
      const A = V(x0, ylo, z + h), B = V(x1, ylo, z + h), C = V(x1, yhi, z), D = V(x0, yhi, z);
      this.m.quad(A, B, C, D, m, norm([0, nrm * h, d]));
      this.m.tri(V(x0, ylo, z), V(x0, ylo, z + h), V(x0, yhi, z), m, [-1, 0, 0]);
      this.m.tri(V(x1, yhi, z), V(x1, ylo, z + h), V(x1, ylo, z), m, [1, 0, 0]);
    } else {
      const [xlo, xhi, nrm] = dir === '+x' ? [x1, x0, 1] : [x0, x1, -1];
      const A = V(xlo, y0, z + h), B = V(xlo, y1, z + h), C = V(xhi, y1, z), D = V(xhi, y0, z);
      this.m.quad(A, B, C, D, m, norm([nrm * h, 0, w]));
    }
    if (o.occ !== false) this.m.occluders.push({ mn: [x0, y0, z], mx: [x1, y1, z + h] });
  }
  /** window grid on a wall plane */
  facade(o) {
    const plane = o.plane || 'x+';
    const u0 = o.u0, u1 = o.u1, z0 = o.z0, z1 = o.z1;
    const cols = Math.max(1, Math.round(o.cols || 1));
    const rows = Math.max(1, Math.round(o.rows || 1));
    const pw = (u1 - u0) / cols, ph = (z1 - z0) / rows;
    const mw = o.mw !== undefined ? o.mw : 0.6, mh = o.mh !== undefined ? o.mh : 0.58;
    const ww = pw * mw, wh = ph * mh;
    const inset = o.inset !== undefined ? o.inset : 0.008;
    const lit = o.litChance !== undefined ? o.litChance : 0;
    const seed = o.seed || 17;
    const frame = o.frameMat;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const u = u0 + pw * (i + 0.5), zc = z0 + ph * (j + 0.5);
        let mat = o.mat;
        if (lit > 0 && o.litMat !== undefined && hash3(i + (o.hashSalt || 0), j, seed, 3) < lit) {
          mat = (hash3(i, j, seed, 7) < 0.25 && o.litMat2 !== undefined) ? o.litMat2 : o.litMat;
        }
        if (o.skipFn && o.skipFn(i, j)) continue;
        if (frame !== undefined) this.pane(plane, o.at, u, zc, ww * 1.32, wh * 1.35, frame, inset * 0.5);
        this.pane(plane, o.at, u, zc, ww, wh, mat, inset);
      }
    }
  }
  pane(plane, at, u, zc, wu, wv, m, off) {
    const h1 = wu / 2, h2 = wv / 2;
    const o = { detail: 1 };
    if (plane === 'x+') this.m.quad(V(at + off, u - h1, zc - h2), V(at + off, u + h1, zc - h2), V(at + off, u + h1, zc + h2), V(at + off, u - h1, zc + h2), m, [1, 0, 0], o);
    else if (plane === 'x-') this.m.quad(V(at - off, u + h1, zc - h2), V(at - off, u - h1, zc - h2), V(at - off, u - h1, zc + h2), V(at - off, u + h1, zc + h2), m, [-1, 0, 0], o);
    else if (plane === 'y+') this.m.quad(V(u + h1, at + off, zc - h2), V(u - h1, at + off, zc - h2), V(u - h1, at + off, zc + h2), V(u + h1, at + off, zc + h2), m, [0, 1, 0], o);
    else this.m.quad(V(u - h1, at - off, zc - h2), V(u + h1, at - off, zc - h2), V(u + h1, at - off, zc + h2), V(u - h1, at - off, zc + h2), m, [0, -1, 0], o);
  }
  /** horizontal band around a box (cornice, belt course) */
  band(x, y, z, w, d, t, out, m) {
    this.box(x - out, y - out, z, w + out * 2, d + out * 2, t, m, { occ: false });
  }
  /** rows of stairs */
  stairs(x, y, z, w, d, h, steps, m, o = {}) {
    const dir = o.dir || '+y';
    for (let i = 0; i < steps; i++) {
      const t = (i + 1) / steps;
      const sh = h / steps;
      if (dir === '+y') this.box(x, y + d * (i / steps), z + sh * i, w, d / steps + 0.001, sh, m, { occ: false });
      else this.box(x + w * (i / steps), y, z + sh * i, w / steps + 0.001, d, sh, m, { occ: false });
    }
    this.m.occluders.push({ mn: [x, y, z], mx: [x + w, y + d, z + h] });
  }
  fence(x, y, z, len, axis, h, m, o = {}) {
    const step = o.step || 0.28;
    const n = Math.max(2, Math.round(len / step));
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * len;
      const px = axis === 'x' ? x + t : x, py = axis === 'x' ? y : y + t;
      this.box(px - 0.012, py - 0.012, z, 0.024, 0.024, h, m, { occ: false });
    }
    if (axis === 'x') { this.box(x, y - 0.01, z + h * 0.55, len, 0.02, 0.03, m, { occ: false }); this.box(x, y - 0.01, z + h * 0.9, len, 0.02, 0.03, m, { occ: false }); }
    else { this.box(x - 0.01, y, z + h * 0.55, 0.02, len, 0.03, m, { occ: false }); this.box(x - 0.01, y, z + h * 0.9, 0.02, len, 0.03, m, { occ: false }); }
  }
  /** thin vertical mast */
  mast(x, y, z, h, r, m, o = {}) {
    this.cylinder(x, y, z, z + h, r, o.sides || 5, m, { rTop: r * (o.taper || 1), occ: false });
  }
  /** louvered / ribbed roof unit */
  acUnit(x, y, z, w, d, h) {
    this.box(x, y, z, w, d, h, MATS.roofAC);
  }
}

export { V, sub, cross, norm, MAT_LIST, PAT };
