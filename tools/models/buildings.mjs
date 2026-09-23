// Buildings for the vertical slice: a timber cottage, a farmhouse, a barn, a
// shed, a greenhouse and a coop.
//
// Scale reference (see tools/lib/render.mjs): a tile is 32x16 px and one world
// unit of height is 22 px. The character is 1.23 units tall (~27 px), so a
// cottage wall at 2.0 units reads as roughly 1.6x a person and the ridge lands
// at 3.0 — real cottage proportions without going monumental.
//
// Every building is assembled from the same handful of helpers so the village
// shares one construction grammar: stone plinth, exposed timber frame, boarded
// walls, framed openings, oversailing roof.

import { Builder } from '../lib/geom.mjs';
import { M } from '../lib/materials.mjs';

const WALL_INSET = 0.075;   // walls sit this far inside the footprint

// ---------------------------------------------------------------- helpers

/** stone plinth under the whole footprint */
function plinth(b, w, d, h = 0.20, mat = 'stone') {
  b.box(0, 0, 0, w, d, h, M(mat), { bottom: false });
}

/** horizontal beam ring at height z (top plate, belt course) */
function beamRing(b, w, d, z, t, out, mat) {
  b.box(-out, -out, z, w + out * 2, d + out * 2, t, M(mat), { occ: false });
}

/**
 * A framed opening cut into a vertical wall.
 * @param plane 'x+'|'x-'|'y+'|'y-'
 * @param at    the world coordinate of the wall *face* on that axis
 * @param u     position along the wall (the other horizontal axis)
 * @param zc    centre height
 */
function opening(b, plane, at, u, zc, w, h, opt = {}) {
  const glass = opt.glass ?? 'glass';
  const frame = opt.frame ?? 'trim';
  const t = opt.t ?? 0.06;
  const xPlus = plane === 'x+', yPlus = plane === 'y+';
  const xs = plane === 'x+' ? 1 : -1;      // outward direction on x
  const ys = plane === 'y+' ? 1 : -1;
  // recessed dark reveal so the opening reads as a hole rather than a sticker
  b.pane(plane, at, u, zc, w + t * 0.6, h + t * 0.6, M('trimDark'), 0.004);
  b.pane(plane, at, u, zc, w, h, M(glass), 0.022);
  if (opt.solid !== true) {
    b.pane(plane, at, u - w / 2 - t / 2, zc, t, h + t * 2, M(frame), 0.034);
    b.pane(plane, at, u + w / 2 + t / 2, zc, t, h + t * 2, M(frame), 0.034);
  }
  b.pane(plane, at, u, zc + h / 2 + t / 2, w + t * 2, t, M(frame), 0.034);
  b.pane(plane, at, u, zc - h / 2 - t / 2, w + t * 2, t, M(frame), 0.034);
  if (opt.mullion !== false) {
    b.pane(plane, at, u, zc, 0.03, h, M(frame), 0.028);
    if (h > 0.5) b.pane(plane, at, u, zc, w, 0.03, M(frame), 0.028);
  }
  if (opt.sill !== false) {
    const sm = M(opt.sillMat ?? 'stoneTrim');
    const sy = zc - h / 2 - t - 0.035;
    const sw = w + t * 2, sd = 0.09;
    if (xPlus) b.box(at, u - sw / 2, sy, sd, sw, 0.035, sm, { occ: false });
    else if (plane === 'x-') b.box(at - sd, u - sw / 2, sy, sd, sw, 0.035, sm, { occ: false });
    else if (yPlus) b.box(u - sw / 2, at, sy, sw, sd, 0.035, sm, { occ: false });
    else b.box(u - sw / 2, at - sd, sy, sw, sd, 0.035, sm, { occ: false });
  }
}

/** exposed corner posts + a mid-rail around a box of size (w,d) at (ox,oy) */
function framePosts(b, w, d, z0, z1, mat = 'beam', t = 0.15, ox = 0, oy = 0) {
  const m = M(mat);
  const h = z1 - z0;
  for (const [x, y] of [[ox, oy], [ox + w - t, oy], [ox, oy + d - t], [ox + w - t, oy + d - t]]) {
    b.box(x, y, z0, t, t, h, m, { occ: false });
  }
  const zr = z0 + h * 0.62;
  b.box(ox, oy + d - t * 0.85, zr, w, t * 0.85, 0.085, m, { occ: false });
  b.box(ox + w - t * 0.85, oy, zr, t * 0.85, d, 0.085, m, { occ: false });
}

/** gable roof, ridge along x, with eaves fascia. Returns the ridge height. */
function gableRoof(b, w, d, z, h, opt = {}) {
  const ov = opt.overhang ?? 0.30;
  const mat = opt.mat ?? 'roofShingle';
  b.gable(0, 0, z, w, d, h, M(mat), { axis: 'x', overhang: ov, endMat: M(opt.endMat ?? mat) });
  const fm = M(opt.fascia ?? 'beam');
  b.box(-ov, -ov, z - 0.10, w + ov * 2, 0.085, 0.11, fm, { occ: false });
  b.box(-ov, d + ov - 0.085, z - 0.10, w + ov * 2, 0.085, 0.11, fm, { occ: false });
  return z + h;
}

/** stone chimney rising through a roof */
function chimney(b, x, y, z0, z1, opt = {}) {
  const s = opt.size ?? 0.34;
  b.box(x, y, z0, s, s, z1 - z0, M(opt.mat ?? 'stone'));
  b.box(x - 0.035, y - 0.035, z1, s + 0.07, s + 0.07, 0.075, M(opt.capMat ?? 'stoneTrim'), { occ: false });
  b.box(x + 0.08, y + 0.08, z1 + 0.075, s - 0.16, s - 0.16, 0.015, M('black'), { occ: false });
}

/** flower box under a window — cheap, and it makes a cottage feel lived in */
function flowerBox(b, plane, at, u, z) {
  const w = 0.44, dep = 0.16, h = 0.13;
  const xPlus = plane === 'x+';
  const box = (a, bb, c, d, e, f, m) => b.box(a, bb, c, d, e, f, m, { occ: false });
  const cols = ['flowerRed', 'flowerYellow', 'flowerPurple', 'flowerWhite'];
  if (xPlus) {
    box(at + 0.055, u - w / 2, z, dep, w, h, M('woodPlankDk'));
    box(at + 0.07, u - w / 2 + 0.03, z + h, dep - 0.03, w - 0.06, 0.055, M('leafDk'));
    for (let i = 0; i < 4; i++) box(at + 0.085, u - w / 2 + 0.055 + i * 0.095, z + h + 0.045, 0.055, 0.055, 0.06, M(cols[i % 4]));
  } else {
    box(u - w / 2, at + 0.055, z, w, dep, h, M('woodPlankDk'));
    box(u - w / 2 + 0.03, at + 0.07, z + h, w - 0.06, dep - 0.03, 0.055, M('leafDk'));
    for (let i = 0; i < 4; i++) box(u - w / 2 + 0.055 + i * 0.095, at + 0.085, z + h + 0.045, 0.055, 0.055, 0.06, M(cols[i % 4]));
  }
}

/** small pitched canopy over a door, standing on two posts */
function porch(b, plane, at, u, z, span = 0.9) {
  const depth = 0.44, postH = z - 0.10;
  const off = 0.10;                        // gap between wall face and roof back edge
  if (plane === 'x+') {
    // slopes down away from the wall: high edge (x0) at the wall -> dir '-x'
    b.shed(at + off, u - span / 2, z - 0.14, depth, span, 0.14, M('roofShingle'), { dir: '-x' });
    b.box(at + off + depth - 0.10, u - span / 2 + 0.02, 0, 0.09, 0.09, postH, M('beam'), { occ: false });
    b.box(at + off + depth - 0.10, u + span / 2 - 0.11, 0, 0.09, 0.09, postH, M('beam'), { occ: false });
    b.box(at, u - span / 2 - 0.12, 0, off + depth, span + 0.24, 0.075, M('deck'), { occ: false });
    b.box(at + off + depth - 0.16, u - span / 2 - 0.06, 0, 0.16, span + 0.12, 0.045, M('deck'), { occ: false });
  } else if (plane === 'y+') {
    b.shed(u - span / 2, at + off, z - 0.14, span, depth, 0.14, M('roofShingle'), { dir: '-y' });
    b.box(u - span / 2 + 0.02, at + off + depth - 0.10, 0, 0.09, 0.09, postH, M('beam'), { occ: false });
    b.box(u + span / 2 - 0.11, at + off + depth - 0.10, 0, 0.09, 0.09, postH, M('beam'), { occ: false });
    b.box(u - span / 2 - 0.12, at, 0, span + 0.24, off + depth, 0.075, M('deck'), { occ: false });
    b.box(u - span / 2 - 0.06, at + off + depth - 0.16, 0, span + 0.12, 0.16, 0.045, M('deck'), { occ: false });
  }
}

/**
 * Shared body of a boarded cottage: plinth, walls, exposed frame, top plate.
 * Returns the coordinates of the two camera-facing wall faces so openings can
 * be placed exactly on the surface instead of guessed at.
 */
function cottageBody(b, w, d, wallH, opt = {}) {
  const inset = opt.inset ?? WALL_INSET;
  plinth(b, w, d, opt.plinthH ?? 0.20, opt.plinthMat ?? 'stone');
  const bw = w - inset * 2, bd = d - inset * 2;
  b.box(inset, inset, 0.20, bw, bd, wallH - 0.20, M(opt.wall ?? 'woodPlank'), { bottom: false });
  framePosts(b, w, d, 0.20, wallH + 0.02, opt.frame ?? 'beam', opt.postT ?? 0.15);
  beamRing(b, w, d, wallH - 0.02, 0.14, 0.035, opt.frame ?? 'beam');
  return { inset, bw, bd, xf: inset + bw, yf: inset + bd };
}

// ---------------------------------------------------------------- models

export const MODELS = [
  // ---------------------------------------------------------------- cottage
  {
    id: 'bld_cottage', name: 'COTTAGE', cat: 'build', fp: [3, 3], seed: 301, cap: 4.0,
    build(b) {
      const w = 3, d = 3, wallH = 2.0;
      const f = cottageBody(b, w, d, wallH, { wall: 'woodPlank', frame: 'beam' });
      // door on the camera-facing +x wall
      opening(b, 'x+', f.xf, d * 0.5, 0.82, 0.60, 1.12, { glass: 'woodPlankDk', solid: true, mullion: false, frame: 'trimRed' });
      b.pane('x+', f.xf, d * 0.5, 1.08, 0.30, 0.26, M('glassLit'), 0.026);
      b.box(f.xf + 0.02, d * 0.5 - 0.085, 0.88, 0.05, 0.17, 0.045, M('metal'), { occ: false });
      porch(b, 'x+', f.xf, d * 0.5, 1.60, 0.88);
      opening(b, 'x+', f.xf, d * 0.5 - 1.0, 1.26, 0.58, 0.56, { glass: 'glass' });
      opening(b, 'y+', f.yf, w * 0.5, 1.26, 0.58, 0.56, { glass: 'glass' });
      opening(b, 'y+', f.yf, w * 0.5 + 1.0, 1.26, 0.50, 0.56, { glass: 'glass' });
      flowerBox(b, 'x+', f.xf, d * 0.5 - 1.0, 0.88);
      const ridge = gableRoof(b, w, d, wallH, 0.98, { mat: 'roofTile', overhang: 0.32 });
      chimney(b, w * 0.68, d * 0.22, 1.30, ridge + 0.44, { mat: 'stone' });
    },
  },
  {
    id: 'bld_cottage_b', name: 'COTTAGE', cat: 'build', fp: [3, 3], seed: 302, cap: 4.0,
    build(b) {
      const w = 3, d = 3, wallH = 2.0;
      const f = cottageBody(b, w, d, wallH, { wall: 'plasterWarm', frame: 'beamDk' });
      opening(b, 'y+', f.yf, w * 0.5, 0.82, 0.60, 1.12, { glass: 'woodRed', solid: true, mullion: false, frame: 'trim' });
      porch(b, 'y+', f.yf, w * 0.5, 1.60, 0.88);
      opening(b, 'y+', f.yf, w * 0.5 - 1.0, 1.26, 0.50, 0.56, { glass: 'glass' });
      opening(b, 'x+', f.xf, d * 0.5, 1.26, 0.58, 0.56, { glass: 'glass' });
      opening(b, 'x+', f.xf, d * 0.5 + 1.0, 1.26, 0.58, 0.56, { glass: 'glass' });
      flowerBox(b, 'y+', f.yf, w * 0.5 - 1.0, 0.88);
      const ridge = gableRoof(b, w, d, wallH, 1.02, { mat: 'roofThatch', overhang: 0.36, endMat: 'roofThatchDk', fascia: 'beamDk' });
      chimney(b, w * 0.28, d * 0.74, 1.30, ridge + 0.38, { mat: 'brick' });
    },
  },

  // ---------------------------------------------------------------- farmhouse
  {
    id: 'bld_farmhouse', name: 'FARMHOUSE', cat: 'build', fp: [4, 4], seed: 303, cap: 5.8,
    build(b) {
      const w = 4, d = 4, f1 = 2.0, f2 = 3.75;
      const g = cottageBody(b, w, d, f1, { wall: 'woodPlankLt', frame: 'beam' });
      // ---- upper storey, narrower, sitting on a belt course
      const up = 0.17;
      beamRing(b, w, d, f1, 0.16, 0.09, 'beam');
      b.box(up, up, f1 + 0.16, w - up * 2, d - up * 2, f2 - f1 - 0.16, M('plaster'), { bottom: false });
      framePosts(b, w - up * 2, d - up * 2, f1 + 0.16, f2 + 0.02, 'beam', 0.14, up, up);
      beamRing(b, w - up * 0.4, d - up * 0.4, f2 - 0.02, 0.14, 0.03, 'beam');
      const uxf = w - up, uyf = d - up;
      // ---- ground floor openings
      opening(b, 'x+', g.xf, d * 0.5, 0.88, 0.66, 1.20, { glass: 'woodPlankDk', solid: true, mullion: false, frame: 'trim' });
      b.pane('x+', g.xf, d * 0.5, 1.24, 0.30, 0.28, M('glassLit'), 0.026);
      porch(b, 'x+', g.xf, d * 0.5, 1.66, 1.02);
      opening(b, 'x+', g.xf, d * 0.5 - 1.20, 1.30, 0.58, 0.56, { glass: 'glass' });
      opening(b, 'y+', g.yf, w * 0.5 - 0.62, 1.30, 0.58, 0.56, { glass: 'glass' });
      opening(b, 'y+', g.yf, w * 0.5 + 0.62, 1.30, 0.58, 0.56, { glass: 'glass' });
      // ---- first floor openings
      opening(b, 'x+', uxf, d * 0.5 - 0.72, 2.92, 0.54, 0.62, { glass: 'glass' });
      opening(b, 'x+', uxf, d * 0.5 + 0.72, 2.92, 0.54, 0.62, { glass: 'glass' });
      opening(b, 'y+', uyf, w * 0.5, 2.92, 0.54, 0.62, { glass: 'glass' });
      flowerBox(b, 'y+', g.yf, w * 0.5 - 0.62, 0.90);
      const ridge = gableRoof(b, w, d, f2, 1.12, { mat: 'roofSlateBlue', overhang: 0.34, fascia: 'beam' });
      chimney(b, w * 0.24, d * 0.30, 2.50, ridge + 0.62, { mat: 'brick' });
      chimney(b, w * 0.76, d * 0.72, 2.50, ridge + 0.46, { mat: 'brick' });
    },
  },

  // ---------------------------------------------------------------- barn
  {
    id: 'bld_barn', name: 'BARN', cat: 'build', fp: [4, 4], seed: 304, cap: 5.6,
    build(b) {
      const w = 4, d = 4, wallH = 2.4, inset = 0.06;
      plinth(b, w, d, 0.16, 'stone');
      b.box(inset, inset, 0.16, w - inset * 2, d - inset * 2, wallH - 0.16, M('woodRed'), { bottom: false });
      framePosts(b, w, d, 0.16, wallH + 0.02, 'beamDk', 0.17);
      beamRing(b, w, d, wallH - 0.04, 0.18, 0.05, 'beamDk');
      const xf = w - inset, yf = d - inset;
      // big sliding doors on the +x gable end
      opening(b, 'x+', xf, d * 0.5, 1.10, 1.30, 1.76, { glass: 'woodPlankDk', solid: true, mullion: false, frame: 'beamDk', sill: false });
      b.pane('x+', xf, d * 0.5, 1.10, 0.035, 1.70, M('beamDk'), 0.036);
      b.box(xf + 0.02, d * 0.5 - 0.72, 2.00, 0.09, 1.44, 0.09, M('metal'), { occ: false });
      // hay loft opening up high
      opening(b, 'x+', xf, d * 0.5, 2.14, 0.50, 0.42, { glass: 'black', solid: true, mullion: false, frame: 'beamDk' });
      opening(b, 'y+', yf, w * 0.5 - 0.95, 1.58, 0.40, 0.40, { glass: 'glass' });
      opening(b, 'y+', yf, w * 0.5 + 0.95, 1.58, 0.40, 0.40, { glass: 'glass' });
      const ridge = gableRoof(b, w, d, wallH, 1.32, { mat: 'roofRust', overhang: 0.34, endMat: 'roofRust', fascia: 'beamDk' });
      // cupola
      b.box(w * 0.5 - 0.24, d * 0.5 - 0.24, ridge - 0.06, 0.48, 0.48, 0.44, M('woodRed'), { occ: false });
      b.pyramid(w * 0.5 - 0.30, d * 0.5 - 0.30, ridge + 0.38, 0.60, 0.60, 0.34, M('roofRust'), { overhang: 0.06 });
      b.box(w * 0.5 - 0.05, d * 0.5 - 0.05, ridge + 0.72, 0.10, 0.10, 0.34, M('metal'), { occ: false });
    },
  },

  // ---------------------------------------------------------------- shed
  {
    id: 'bld_shed', name: 'SHED', cat: 'build', fp: [2, 2], seed: 305, cap: 3.0,
    build(b) {
      const w = 2, d = 2, wallH = 1.5;
      const f = cottageBody(b, w, d, wallH, { wall: 'woodWeathered', frame: 'beamDk', postT: 0.12 });
      opening(b, 'x+', f.xf, d * 0.5, 0.68, 0.50, 0.94, { glass: 'woodWeathered', solid: true, mullion: false, frame: 'beamDk' });
      opening(b, 'y+', f.yf, w * 0.5, 1.06, 0.40, 0.38, { glass: 'glass' });
      gableRoof(b, w, d, wallH, 0.62, { mat: 'roofShingleDk', overhang: 0.22, fascia: 'beamDk' });
      // tools leaning against the wall
      b.box(w + 0.03, 0.30, 0, 0.05, 0.05, 1.08, M('woodPlankDk'), { occ: false });
      b.box(w + 0.05, 1.42, 0, 0.05, 0.05, 1.22, M('woodPlankDk'), { occ: false });
    },
  },

  // ---------------------------------------------------------------- coop
  {
    id: 'bld_coop', name: 'COOP', cat: 'build', fp: [3, 2], seed: 306, cap: 2.4,
    build(b) {
      const w = 2, d = 2, wallH = 1.05, inset = 0.07;
      plinth(b, w, d, 0.26, 'stone');
      b.box(inset, inset, 0.26, w - inset * 2, d - inset * 2, wallH - 0.26, M('woodWhite'), { bottom: false });
      framePosts(b, w, d, 0.26, wallH + 0.02, 'beam', 0.12);
      beamRing(b, w, d, wallH - 0.02, 0.12, 0.04, 'beam');
      const xf = w - inset;
      opening(b, 'x+', xf, d * 0.5, 0.74, 0.40, 0.40, { glass: 'black', solid: true, mullion: false, frame: 'beam', sill: false });
      // ramp down from the pop hole
      b.box(xf, d * 0.5 - 0.20, 0, 0.50, 0.40, 0.05, M('deck'), { occ: false });
      // wire run
      for (let i = 0; i < 3; i++) b.box(w + 0.06 + i * 0.26, 0.06, 0, 0.045, 0.045, 0.60, M('woodWeathered'), { occ: false });
      b.box(w + 0.06, 0.06, 0.58, 0.84, 0.045, 0.045, M('woodWeathered'), { occ: false });
      b.box(w + 0.06, 1.92, 0.58, 0.84, 0.045, 0.045, M('woodWeathered'), { occ: false });
      b.box(w + 0.06, 1.92, 0, 0.045, 0.045, 0.60, M('woodWeathered'), { occ: false });
      gableRoof(b, w, d, wallH, 0.55, { mat: 'roofGreen', overhang: 0.24, endMat: 'roofGreen' });
    },
  },

  // ---------------------------------------------------------------- greenhouse
  {
    id: 'bld_greenhouse', name: 'GREENHOUSE', cat: 'build', fp: [3, 4], seed: 307, cap: 3.8,
    build(b) {
      const w = 3, d = 4, wallH = 1.9, inset = 0.06;
      plinth(b, w, d, 0.22, 'stone');
      b.box(inset, inset, 0.22, w - inset * 2, d - inset * 2, wallH - 0.22, M('glassSky'), { bottom: false, occ: false });
      const t = 0.10;
      const posts = [[0, 0], [w - t, 0], [0, d - t], [w - t, d - t],
        [(w - t) / 2, 0], [(w - t) / 2, d - t], [0, (d - t) / 2], [w - t, (d - t) / 2]];
      for (const [x, y] of posts) b.box(x, y, 0.22, t, t, wallH - 0.20, M('woodWhite'), { occ: false });
      for (let i = 1; i < 6; i++) {
        const z = 0.22 + (i * (wallH - 0.22)) / 6;
        b.box(0, inset, z, w, 0.05, 0.045, M('woodWhite'), { occ: false });
        b.box(inset, 0, z, 0.05, d, 0.045, M('woodWhite'), { occ: false });
      }
      beamRing(b, w, d, wallH - 0.02, 0.14, 0.05, 'woodWhite');
      opening(b, 'x+', w - inset, d * 0.5, 0.92, 0.58, 1.26, { glass: 'glassSky', frame: 'woodWhite' });
      gableRoof(b, w, d, wallH, 1.10, { mat: 'glassSky', overhang: 0.20, endMat: 'glassSky', fascia: 'woodWhite' });
      b.box(-0.20, d * 0.5 - 0.07, wallH + 1.02, w + 0.40, 0.14, 0.09, M('woodWhite'), { occ: false });
      // planting benches glimpsed through the glass
      b.box(0.30, 0.40, 0.52, 0.60, 3.20, 0.06, M('woodPlankDk'), { occ: false });
      b.box(w - 0.90, 0.40, 0.52, 0.60, 3.20, 0.06, M('woodPlankDk'), { occ: false });
      for (let i = 0; i < 7; i++) {
        b.box(0.36, 0.62 + i * 0.43, 0.58, 0.22, 0.22, 0.20, M('cropLeaf'), { occ: false });
        b.box(w - 0.84, 0.62 + i * 0.43, 0.58, 0.22, 0.22, 0.20, M('cropLeafDk'), { occ: false });
      }
      // a warm grow-lamp slung from the ridge — reads beautifully at night
      b.box(w * 0.5 - 0.32, d * 0.5 - 0.07, wallH + 0.24, 0.64, 0.14, 0.10, M('lampGlass'), { occ: false });
    },
  },
];
