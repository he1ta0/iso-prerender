// Interior room kit: floors, walls, openings and a roof, all as 1x1 tile pieces.
//
// WALL CONVENTION (everything in this file obeys it)
//   A wall segment fills the **+y edge** of its tile:  x in [0,1], y in [1-T,1].
//   The offline baker also renders rotations 1..3, which land the same segment on:
//         rot 0 -> +y edge      rot 1 -> -x edge
//         rot 2 -> -y edge      rot 3 -> +x edge
//   The camera looks from +x +y, so the two edges facing it are rot 0 and rot 3.
//   That single fact is the whole cutaway rule: stipple rot 0 and rot 3, keep
//   rot 1 and rot 2, and hide the roof.
//
// VOLUME MARKING
//   Every wall says what it is made of in solid terms via b.solidBox() /
//   b.glassBox(). The runtime builds a 3D transmittance volume straight out of
//   those marks, so sunlight really does pass through the window openings and
//   land on the floor in the shape of the pane — and it cannot drift out of sync
//   with the sprite, because both come from the same lines of code.

import { Builder } from '../lib/geom.mjs';
import { M } from '../lib/materials.mjs';

export const T = 0.14;        // wall thickness
export const H = 2.2;         // wall height
export const CAP = 0.085;     // capping board on top of a wall
export const RAIL = 0.60;     // chair-rail height (top of the wainscot)

// Aperture geometry. These numbers are the single biggest lever on how an
// interior is LIT, because a window is not a decoration here — it is the only
// hole in a sealed box, and the size and height of the hole decide how much
// floor the sunbeam lands on and how far from the wall it reaches:
//
//   throw = sill height / tan(sun elevation)
//
// At noon (58 degrees) even a tall window drops its patch hard against the wall,
// which is simply what a high sun does. At 25 degrees the same window rakes a
// band three units into the room. Widening the opening raises both.
const WIN = { x0: 0.06, x1: 0.94, z0: 0.62, z1: 2.02 };   // window aperture
// The two wall runs that face the camera are the ones that can actually catch
// the sun, so they get the tall opening: a French-window sill almost at the
// floor throws its patch twice as far across the room as a cottage casement,
// and lets in roughly twice the light doing it.
const WIN_TALL = { x0: 0.05, x1: 0.95, z0: 0.28, z1: 2.06 };
// A round-headed opening. The head is built as vertical columns rather than a
// smooth arc: 14 columns over 0.9 of a tile is about 3 px per step at 48 px per
// tile, which reads as a deliberate pixel arch — and, more usefully, the volume
// marks come out of the same loop, so the light that lands on the floor is
// arched too. A window whose SHAPE reaches the floor is a free way to make four
// walls feel like four different walls.
const WIN_ARCH = { x0: 0.08, x1: 0.92, z0: 0.66, z1: 1.98 };
const DOOR = { x0: 0.19, x1: 0.81, z1: 1.58 };            // doorway aperture

/** the shared build for both window sizes */
function buildWindow(b, A, mint) {
  // solid below, solid in the two side strips, solid above; the aperture
  // itself is simply never marked, so the volume leaves it open
  wallSkin(b, { z1: A.z0 });
  wallSkin(b, { x0: 0, x1: A.x0, z0: A.z0, z1: A.z1, trim: false, cap: false });
  wallSkin(b, { x0: A.x1, x1: 1, z0: A.z0, z1: A.z1, trim: false, cap: false });
  wallSkin(b, { z0: A.z1, z1: H });
  b.box(0, 1 - T, H, 1, T, CAP, M('beam'), { occ: false });

  // the glass itself: marked as a transmitting volume with a warm tint, so
  // sunlight arriving through it is both shaped and coloured
  //
  // The mark is deliberately THICKER than one voxel (0.077 against 0.071): the
  // shader charges a pane once, on the voxel where the ray enters it, so entry has
  // to land on a fully covered voxel or the pane's quoted transmittance is not the
  // one that arrives. See the glass note in src/gl/shaders.js.
  const gy = 1 - T * 0.80;
  b.glassBox(A.x0, gy, A.z0, A.x1 - A.x0, T * 0.55, A.z1 - A.z0, M('glass'), { occ: false },
    { trans: 0.90, tint: [1.0, 0.955, 0.86] });
  // muntins: one transom across, plus a centre stile on the tall opening
  b.box(A.x0, gy - 0.012, A.z0 + (A.z1 - A.z0) * 0.55, A.x1 - A.x0, T * 0.24 + 0.024, 0.028, M('trim'), { occ: false });
  if (mint) b.box((A.x0 + A.x1) / 2 - 0.014, gy - 0.012, A.z0, 0.028, T * 0.24 + 0.024, A.z1 - A.z0, M('trim'), { occ: false });
  apertureTrim(b, A, { mat: 'trim', t: T });
  // interior sill
  b.box(A.x0 - 0.07, 1 - T - 0.10, A.z0 - 0.06, (A.x1 - A.x0) + 0.14, 0.11, 0.045, M('stoneTrim'), { occ: false });
}

/**
 * A round-headed window: the head is cut by stacking columns, and every column
 * marks its own solid above and its own glass below, so sprite and light volume
 * come out of one loop.
 */
function buildArchWindow(b, A) {
  const N = 14;
  const r = (A.x1 - A.x0) / 2, cx = (A.x0 + A.x1) / 2;
  const spring = A.z1 - r;                  // where the arc begins
  const gy = 1 - T * 0.80;                  // pane mark: thicker than one voxel
  const head = (xm) => spring + Math.sqrt(Math.max(0, r * r - (xm - cx) * (xm - cx)));

  // sill and jambs up to the springing line
  wallSkin(b, { z1: A.z0 });
  wallSkin(b, { x0: 0, x1: A.x0, z0: A.z0, z1: H, trim: false, cap: false });
  wallSkin(b, { x0: A.x1, x1: 1, z0: A.z0, z1: H, trim: false, cap: false });
  // the arch itself, column by column
  for (let i = 0; i < N; i++) {
    const x0 = A.x0 + (A.x1 - A.x0) * (i / N);
    const x1 = A.x0 + (A.x1 - A.x0) * ((i + 1) / N);
    const h = head((x0 + x1) / 2);
    wallSkin(b, { x0, x1, z0: h, z1: H, trim: false, cap: false });          // spandrel
    b.glassBox(x0, gy, A.z0, x1 - x0, T * 0.55, h - A.z0, M('glass'), { occ: false },
      { trans: 0.90, tint: [1.0, 0.955, 0.86] });                            // the pane
    b.box(x0 - 0.004, gy - 0.014, h - 0.03, x1 - x0 + 0.008, T * 0.24 + 0.028, 0.03, M('trim'), { occ: false });
  }
  b.box(0, 1 - T, H, 1, T, CAP, M('beam'), { occ: false });
  // springing band and side jambs, in trim rather than plaster
  b.box(A.x0 - 0.05, 1 - T - 0.028, spring - 0.03, (A.x1 - A.x0) + 0.10, T + 0.056, 0.045, M('trim'), { occ: false });
  for (const x of [A.x0 - 0.05, A.x1]) {
    b.box(x, 1 - T - 0.028, A.z0, 0.05, T + 0.056, spring - A.z0 + 0.03, M('trim'), { occ: false });
  }
  b.box(A.x0 - 0.07, 1 - T - 0.10, A.z0 - 0.06, (A.x1 - A.x0) + 0.14, 0.11, 0.045, M('stoneTrim'), { occ: false });
}

// ---------------------------------------------------------------- helpers

/**
 * The two-tone body of a wall: painted plaster over a boarded wainscot, with a
 * baseboard, a chair rail and a capping board. `oy` lets a piece sit at any
 * sub-slice of the tile edge.
 */
function wallSkin(b, o = {}) {
  const t = o.t ?? T;
  const y0 = o.y0 ?? 1 - t, y1 = o.y1 ?? 1;
  const x0 = o.x0 ?? 0, x1 = o.x1 ?? 1;
  const z0 = o.z0 ?? 0, z1 = o.z1 ?? H;
  const ext = M(o.ext ?? 'woodPlank');
  const intTop = M(o.intTop ?? 'plaster');
  const intLow = M(o.intLow ?? 'woodPlankDk');
  const rail = z0 + (o.rail ?? RAIL);
  const w = x1 - x0, d = y1 - y0;

  // lower (wainscot) band
  const lowTop = Math.min(z1, Math.max(z0 + 0.02, rail));
  if (lowTop > z0) {
    b.solidBox(x0, y0, z0, w, d, lowTop - z0, ext, { faces: { ny: intLow, py: ext, pz: intLow } });
  }
  // upper (plaster) band
  if (z1 > lowTop) {
    b.solidBox(x0, y0, lowTop, w, d, z1 - lowTop, ext, { faces: { ny: intTop, py: ext, pz: intTop } });
  }
  // baseboard + chair rail, both projecting slightly into the room
  if (o.trim !== false) {
    b.box(x0 - 0.01, y0 - 0.035, z0, w + 0.02, 0.035, 0.10, M('beamDk'), { occ: false });
    if (rail > z0 + 0.15 && rail < z1) b.box(x0 - 0.01, y0 - 0.03, rail - 0.03, w + 0.02, 0.03, 0.05, M('beamDk'), { occ: false });
  }
  // capping board along the top — this is what makes the wall read as finished
  // once the roof has been cut away
  if (o.cap !== false && z1 >= H - 0.01) {
    b.box(x0 - 0.025, y0 - 0.035, z1, w + 0.05, d + 0.06, CAP, M(o.capMat ?? 'beam'), { occ: false });
  }
}

/** timber frame around an aperture, drawn on the interior side */
function apertureTrim(b, a, o = {}) {
  const t = o.t ?? T;
  const y0 = 1 - t, y1 = 1;
  const m = M(o.mat ?? 'beam');
  const pw = o.post ?? 0.055;
  const inset = o.inset ?? 0.028;
  // jambs
  b.box(a.x0 - pw, y0 - inset, a.z0 - pw, pw, t + inset * 2, (a.z1 - a.z0) + pw * 2, m, { occ: false });
  b.box(a.x1, y0 - inset, a.z0 - pw, pw, t + inset * 2, (a.z1 - a.z0) + pw * 2, m, { occ: false });
  // head
  b.box(a.x0 - pw, y0 - inset, a.z1, (a.x1 - a.x0) + pw * 2, t + inset * 2, pw, m, { occ: false });
  if (a.z0 > 0.02) b.box(a.x0 - pw, y0 - inset, a.z0 - pw, (a.x1 - a.x0) + pw * 2, t + inset * 2, pw, m, { occ: false });
}

// ---------------------------------------------------------------- models
export const MODELS = [
  // ---------------------------------------------------------------- walls
  {
    id: 'wall_solid', name: 'WALL', cat: 'wall', fp: [1, 1], seed: 801, cap: H + CAP, rots: 4,
    build(b) {
      wallSkin(b);
      // a subtle pilaster at the +x end gives a long run of wall some rhythm
      b.box(0.94, 1 - T - 0.02, 0, 0.06, T + 0.04, H, M('beam'), { occ: false });
    },
  },
  {
    id: 'wall_window', name: 'WINDOW', cat: 'wall', fp: [1, 1], seed: 802, cap: H + CAP, rots: 4,
    build(b) { buildWindow(b, WIN, false); },
  },
  {
    id: 'wall_window_tall', name: 'FRENCH WINDOW', cat: 'wall', fp: [1, 1], seed: 807, cap: H + CAP, rots: 4,
    build(b) { buildWindow(b, WIN_TALL, true); },
  },
  {
    id: 'wall_window_arch', name: 'ARCHED WINDOW', cat: 'wall', fp: [1, 1], seed: 808, cap: H + CAP, rots: 4,
    build(b) { buildArchWindow(b, WIN_ARCH); },
  },
  {
    id: 'wall_door', name: 'DOORWAY', cat: 'wall', fp: [1, 1], seed: 803, cap: H + CAP, rots: 4,
    build(b) {
      wallSkin(b, { x0: 0, x1: DOOR.x0, trim: false, cap: false });
      wallSkin(b, { x0: DOOR.x1, x1: 1, trim: false, cap: false });
      wallSkin(b, { x0: DOOR.x0, x1: DOOR.x1, z0: DOOR.z1, z1: H, cap: false });
      b.box(0, 1 - T, H, 1, T, CAP, M('beam'), { occ: false });
      // threshold + jambs; nothing is marked inside the aperture, so a doorway
      // behaves exactly like a window without glass
      b.box(DOOR.x0 - 0.05, 1 - T - 0.02, 0, 0.05, T + 0.04, DOOR.z1 + 0.05, M('beam'), { occ: false });
      b.box(DOOR.x1, 1 - T - 0.02, 0, 0.05, T + 0.04, DOOR.z1 + 0.05, M('beam'), { occ: false });
      b.box(DOOR.x0 - 0.05, 1 - T - 0.02, DOOR.z1, (DOOR.x1 - DOOR.x0) + 0.10, T + 0.04, 0.055, M('beam'), { occ: false });
      b.box(DOOR.x0 - 0.02, 1 - T - 0.04, 0, (DOOR.x1 - DOOR.x0) + 0.04, T + 0.08, 0.035, M('stoneTrim'), { occ: false });
    },
  },
  {
    id: 'wall_int', name: 'PARTITION', cat: 'wall', fp: [1, 1], seed: 804, cap: H + CAP, rots: 4,
    build(b) {
      wallSkin(b, { t: 0.10, ext: 'plaster', intTop: 'plaster', intLow: 'woodPlankDk', capMat: 'beamDk', rail: 0.66 });
    },
  },
  {
    // A knee-high run of wall, used on the sides of a room that face the camera.
    // Iso interiors universally leave those open — a full-height wall there hides
    // the very room you are trying to look at. A stub keeps the room's outline
    // crisp without occluding anything, and unlike a dithered "ghost wall" it
    // introduces no noise at all.
    id: 'wall_stub', name: 'LOW WALL', cat: 'wall', fp: [1, 1], seed: 806, cap: 0.46, rots: 4,
    build(b) {
      const t = T, h = 0.36;
      const y0 = 1 - t;
      b.solidBox(0, y0, 0, 1, t, h, M('woodPlank'), { faces: { ny: M('plaster'), py: M('woodPlank'), pz: M('beam') } });
      // baseboard inside, and a wide flat cap so it reads as a finished kerb
      b.box(-0.01, y0 - 0.035, 0, 1.02, 0.035, 0.09, M('beamDk'), { occ: false });
      b.box(-0.03, y0 - 0.05, h, 1.06, t + 0.10, 0.10, M('beam'), { occ: false });
    },
  },
  {
    id: 'wall_int_door', name: 'PARTITION DOOR', cat: 'wall', fp: [1, 1], seed: 805, cap: H + CAP, rots: 4,
    build(b) {
      const t = 0.10, y0 = 1 - t;
      const a = { x0: 0.22, x1: 0.78, z0: 0, z1: 1.62 };
      wallSkin(b, { t, x0: 0, x1: a.x0, ext: 'plaster', intTop: 'plaster', intLow: 'woodPlankDk', trim: false, cap: false, rail: 0.66 });
      wallSkin(b, { t, x0: a.x1, x1: 1, ext: 'plaster', intTop: 'plaster', intLow: 'woodPlankDk', trim: false, cap: false, rail: 0.66 });
      wallSkin(b, { t, x0: a.x0, x1: a.x1, z0: a.z1, z1: H, ext: 'plaster', intTop: 'plaster', intLow: 'woodPlankDk', trim: false, cap: false });
      b.box(0, y0, H, 1, t, CAP, M('beamDk'), { occ: false });
      b.box(a.x0 - 0.045, y0 - 0.02, 0, 0.045, t + 0.04, a.z1 + 0.045, M('beamDk'), { occ: false });
      b.box(a.x1, y0 - 0.02, 0, 0.045, t + 0.04, a.z1 + 0.045, M('beamDk'), { occ: false });
      b.box(a.x0 - 0.045, y0 - 0.02, a.z1, (a.x1 - a.x0) + 0.09, t + 0.04, 0.045, M('beamDk'), { occ: false });
    },
  },

  // ---------------------------------------------------------------- floors
  {
    id: 'floor_wood', name: 'FLOOR', cat: 'floor', fp: [1, 1], seed: 811, cap: 0.06, phase: 0,
    build(b) { floorSlab(b, M('deck')); },
  },
  {
    id: 'floor_wood_b', name: 'FLOOR', cat: 'floor', fp: [1, 1], seed: 812, cap: 0.06, phase: 2,
    build(b) { floorSlab(b, M('deck')); },
  },
  {
    id: 'floor_stone', name: 'STONE FLOOR', cat: 'floor', fp: [1, 1], seed: 813, cap: 0.06, phase: 0,
    build(b) { floorSlab(b, M('flagstone')); },
  },
  {
    id: 'floor_tile', name: 'TILE FLOOR', cat: 'floor', fp: [1, 1], seed: 814, cap: 0.06, phase: 0,
    build(b) {
      // chequerboard laid as four sub-squares — reads instantly as a scullery
      const light = M('ceramic'), dark = M('ceramicBlue');
      const n = 2, s = 1 / n;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const m = (i + j) % 2 ? dark : light;
          // top face only, for the same reason as floorSlab above
          b.box(i * s, j * s, -0.10, s, s, 0.10, m, {
            faces: { pz: m }, occ: false,
            skip: { nx: true, px: true, ny: true, py: true },
          });
        }
      }
      b.m.mark('solid', 0, 0, -0.10, 1, 1, 0.10);
    },
  },
];

/** a floor tile: top surface exactly at z = 0, skirt below to hide seams */
/**
 * One floor tile: THE TOP FACE ONLY.
 *
 * It used to be a 1x1x0.12 box — a slab with four side faces — and that one
 * decision broke the floor. A slab sprite is 55x35 while the tile it stands for
 * is a 48x24 diamond, and the map lays tiles at (24,12) steps, so a tile's
 * sprite sticks out far enough to cover its neighbours' diamonds with its own
 * SIDE. Every pixel therefore ended up under two to four COPLANAR slabs, all
 * with z = -0.117..0, all with cat 'floor' and so all with the same depth bias
 * — nothing in the renderer could decide between them. Which one's texels
 * survived came down to floating-point rounding in gl_FragDepth, so the winner
 * differed per GPU, and whichever won took the WHOLE floor: a single flat
 * colour with hard straight edges running across the room, in the albedo, at
 * every hour of the day. The painter's algorithm had hidden it, because last
 * drawn simply meant on top.
 *
 * A diamond tiles the plane exactly. No overlap, no coplanar pair, no tie to
 * break — the question cannot come up.
 *
 * The volume mark stays where it was: the light march still needs a solid floor
 * at the old thickness, whatever the sprite looks like.
 */
function floorSlab(b, mat) {
  b.box(0, 0, -0.12, 1, 1, 0.12, mat, {
    faces: { pz: mat }, occ: false,
    skip: { nx: true, px: true, ny: true, py: true },
  });
  b.m.mark('solid', 0, 0, -0.12, 1, 1, 0.12);
}

// ---------------------------------------------------------------- roof
/**
 * One roof per house size. A modular strip kit was tempting, but a gable's
 * profile has to close at both ends and the strips would repeat their shingle
 * pattern every tile; a single mesh is both simpler and better looking, and a
 * house is a one-off object anyway.
 *
 * The whole roof is marked solid from the top of the walls upward, which is what
 * makes the interior dark and the window the only way in for the sun.
 */
export function makeRoof(id, w, d, opt = {}) {
  const wallTop = opt.wallTop ?? H;
  const rise = opt.rise ?? Math.max(1.05, d * 0.30);
  const ov = opt.overhang ?? 0.42;
  return {
    id, name: 'ROOF', cat: 'roof', fp: [w, d], seed: opt.seed ?? 850, cap: wallTop + rise + 0.5, rots: 1,
    build(b) {
      b.gable(0, 0, wallTop, w, d, rise, M(opt.mat ?? 'roofTile'), {
        axis: 'x', overhang: ov, endMat: M(opt.endMat ?? opt.mat ?? 'roofTile'),
      });
      // fascia + eaves shadow line
      b.box(-ov, -ov, wallTop - 0.09, w + ov * 2, 0.09, 0.10, M('beam'), { occ: false });
      b.box(-ov, d + ov - 0.09, wallTop - 0.09, w + ov * 2, 0.09, 0.10, M('beam'), { occ: false });
      // ridge cap
      b.box(-ov, d / 2 - 0.07, wallTop + rise - 0.02, w + ov * 2, 0.14, 0.08, M('beamDk'), { occ: false });

      if (opt.chimney !== false) {
        const cx = w * (opt.chimneyAt ?? 0.70), cy = d * 0.24;
        b.box(cx, cy, wallTop - 0.2, 0.40, 0.40, rise + 0.95, M('stone'));
        b.box(cx - 0.04, cy - 0.04, wallTop + rise + 0.75, 0.48, 0.48, 0.09, M('stoneTrim'), { occ: false });
        b.box(cx + 0.10, cy + 0.10, wallTop + rise + 0.84, 0.20, 0.20, 0.02, M('black'), { occ: false });
      }

      // ---- the light-blocking volume: a solid slab across the whole roof.
      // The eaves overhang the walls, so this seals the room completely.
      b.m.mark('solid', -ov, -ov, wallTop, w + ov * 2, d + ov * 2, rise + 0.10);
    },
  };
}

export const MODELS_ROOF = [makeRoof('roof_8x6', 8, 6)];
