// The chapel kit —architecture for the third interior map (src/interior_chapel.js).
//
// WHY A SECOND INTERIOR KIT AT ALL
//
// roomkit.mjs is a COTTAGE kit: two-tone boarded walls, a chair rail, a painted
// lath-and-plaster skin, and windows the size of a casement. A chapel is not a
// cottage with bigger numbers. It has a stone skin with a plinth and a cornice,
// openings twice as tall as the cottage's whole wall (4.2 units against 2.2), a
// floor of two marbles, and —the reason this file exists —STAINED GLASS.
//
// THE ONE PIECE OF NEW ENGINE WORK IN THIS FILE IS COLOUR
//
// `glassBox(..., { trans, tint })` has been in the geometry API since the volume
// was written, and until now every call site in the project passed the same warm
// near-white: `{ trans: 0.90, tint: [1.0, 0.955, 0.86] }`. The tint is not
// decoration; it is a per-voxel colour that the light march multiplies into the
// sunlight every time a ray crosses that voxel (see roomMarch1 in
// src/gl/shaders.js). Five differently tinted panes therefore paint five
// differently coloured patches on the floor, and the same five colours light the
// shafts in the air above them —with no new shader, no new pass, and no new
// uniform. The chapel map is mostly an argument that this was already possible.
//
// A window here is still ONE loop: the sprite and the transmittance marks come
// out of the same iteration, so a pane and the patch of light it throws cannot
// drift apart. That property is inherited from roomkit, not rebuilt.
//
// WALL CONVENTION (identical to roomkit —the runtime knows only one)
//   A wall piece fills the +y edge of its tile: y in [1-CT, 1], x in [0, 1].
//   Baked rotations land it on:  rot 0 -> +y   rot 1 -> -x   rot 2 -> -y   rot 3 -> +x
//   The camera looks from +x +y, so rot 0 and rot 3 face it and are the runs the
//   scene declares `cut`.
//
// EVERY ARCHITECTURE PIECE IN THIS FILE DECLARES `cut: false`, deliberately.
// The manifest's per-category `cut` flag is the renderer's licence to fade a
// piece that happens to sit in front of the focus band, and it is the right
// default for a wall that the SCENE has already spoken for. It is the wrong
// answer for a free-standing pier in the middle of a nave, which would then fade
// in and out as the camera moves. Declaring false here means the cut-away in a
// chapel is decided in exactly one place: the placements in interior_chapel.js.

import { Builder } from '../lib/geom.mjs';
import { M } from '../lib/materials.mjs';

export const CH = 4.2;        // chapel wall height (a cottage wall is 2.2)
export const CT = 0.1424;     // stone wall thickness: EXACTLY 2 voxels (2*1/14.04)
const CAP = 0.13;             // capping board
const PLINTH = 0.66;          // height of the splayed plinth course

// Aperture geometry. As in roomkit these numbers are the biggest single lever on
// how the room is LIT, because the window is the only hole in a sealed box:
//
//   throw = height of the aperture / tan(sun elevation)
//
// The chapel aisles are 5 tiles deep and the near runs are where the sun is all
// day (see sunAzimuth in src/main.js), so a sill at 1.0 and a head at 3.1 rakes a
// band most of the way across an aisle at noon and right across the nave at dusk.
const LANCET = { x0: 0.17, x1: 0.83, z0: 1.00, z1: 2.62 };   // 5-light lancet
const GREAT = { x0: 0.07, x1: 0.93, z0: 0.92, z1: 3.02 };    // 3-light great window
const ROSE = { x0: 0.10, x1: 0.90, zc: 3.34, r: 0.40 };      // the wheel
const DOOR = { x0: 0.20, x1: 0.80, z1: 2.40 };               // west door

/**
 * The five glasses, in the order a glazier would lead them up.
 *
 * `trans` is what the pane passes and `tint` is what it does to what it passes.
 * The two together are why a red pane throws a red patch rather than a grey one.
 *
 * These are now the PHYSICAL numbers, applied once per pane: the shader charges a
 * pane on the voxel where the ray enters it and nothing while the ray is inside
 * it (see the glass note in src/gl/shaders.js). Before that, the cost was charged
 * per voxel crossed, so every value here had to be the square root of what the
 * floor should receive — and even then the answer depended on the angle, which is
 * what turned a window seen at a low sun into a curtain of strips.
 *
 * Real flashed glass transmits roughly half of what hits it; these sit a little
 * above that, because a chapel lit only by its windows is a chapel you cannot see.
 */
export const GLASS = [
  { mat: 'glassViolet', trans: 0.70, tint: [0.64, 0.38, 1.00] },
  { mat: 'glassAzure', trans: 0.74, tint: [0.30, 0.49, 1.00] },
  { mat: 'glassGold', trans: 0.77, tint: [1.00, 0.77, 0.30] },
  { mat: 'glassRose', trans: 0.67, tint: [1.00, 0.30, 0.25] },
  { mat: 'glassVerdant', trans: 0.72, tint: [0.30, 0.90, 0.42] },
];

/**
 * The three lights of the great window, LUMINANCE-MATCHED.
 *
 * A pane's brightness is its transmittance times the luma of its tint, and the
 * three colours above are nowhere near equal: gold comes out at 0.79, rose at
 * 0.45. Side by side in one window they therefore project three bands of very
 * different brightness, and bands of different brightness read as BARS — which is
 * exactly how a three-light window gets mistaken for light leaking through cracks.
 * The eye is happy to read a change of HUE as one patch of coloured light; it
 * reads a change of VALUE as a seam.
 *
 * So the transmittances here are chosen to land all three at the same luma
 * (0.41 = trans x luma(tint)): a glazier does the same thing with flashed glass,
 * for the same reason. The colours stay as saturated as they were; only how much
 * light each one passes is levelled.
 */
export const GREAT_PANES = [
  { ...GLASS[3], trans: 0.92 },    // rose    0.445 x 0.92 = 0.41
  { ...GLASS[2], trans: 0.52 },    // gold    0.785 x 0.52 = 0.41
  { ...GLASS[1], trans: 0.84 },    // azure   0.486 x 0.84 = 0.41
];

// ---------------------------------------------------------------- primitives

/**
 * The body of a stone wall: a marked solid, in two courses.
 *
 * The plinth course is the same stone in the same volume —it is a different
 * FACE material, not a different thickness —so the cube the light marches
 * through stays exactly the tile edge, and the splay you see is a moulding drawn
 * in front of it. Anything else would make the wall thicker than the tile it
 * occupies and eat the floor of the tile next to it.
 */
function wallBody(b, o = {}) {
  const t = o.t ?? CT;
  const x0 = o.x0 ?? 0, x1 = o.x1 ?? 1;
  const y0 = o.y0 ?? 1 - t, y1 = o.y1 ?? 1;
  const z0 = o.z0 ?? 0, z1 = o.z1 ?? CH;
  const w = x1 - x0, d = y1 - y0;
  if (w <= 0.002 || d <= 0.002 || z1 - z0 <= 0.002) return;
  const face = M(o.face ?? 'stonePale');
  const out = M(o.out ?? 'stoneDk');
  const split = Math.min(z1, z0 + PLINTH);
  if (split > z0 + 0.002) {
    b.solidBox(x0, y0, z0, w, d, split - z0, out, { faces: { ny: M(o.plinth ?? 'stoneWarm'), py: out, pz: face } });
  }
  if (z1 > split + 0.002) {
    b.solidBox(x0, y0, split, w, d, z1 - split, out, { faces: { ny: face, py: out, pz: face } });
  }
}

/** base moulding for one slice —unmarked, so it does not fatten the volume */
function baseMould(b, x0, x1, z0 = 0) {
  b.box(x0 - 0.012, 1 - CT - 0.05, z0, (x1 - x0) + 0.024, 0.05, 0.11, M('stoneTrim'), { occ: false });
}

/** cornice + cap across a whole tile. Drawn ONCE per piece, never per slice. */
function capBand(b, o = {}) {
  const x0 = o.x0 ?? 0, x1 = o.x1 ?? 1, z = o.z ?? CH;
  const w = x1 - x0;
  b.box(x0 - 0.015, 1 - CT - 0.07, z - 0.17, w + 0.030, CT + 0.07, 0.17, M('stoneTrim'), { occ: false });
  b.box(x0 - 0.035, 1 - CT - 0.10, z, w + 0.070, CT + 0.10, CAP, M('stoneDk'), { occ: false });
}

/** height of the apex of a two-centre pointed arch of half-width (A.x0..A.x1) */
const apexOf = (A, zs) => zs + 0.866 * (A.x1 - A.x0);

/** height of that arch at x —0 at the jambs, 0.866w at the centre */
function archAt(x, A, zs) {
  const w = A.x1 - A.x0, cx = (A.x0 + A.x1) / 2;
  const from = x < cx ? A.x1 : A.x0;
  const dx = x - from;
  return zs + Math.sqrt(Math.max(0, w * w - dx * dx));
}

/**
 * A stained-glass window, in one loop.
 *
 * `strips` is a list of GLASS entries; the aperture is divided into one column
 * band per strip, and inside a band the pointed head is cut column by column.
 * Every column marks its own stone above the head and its own pane below it, so
 * the arch you see and the arch of light on the floor are the same arch.
 *
 * The lead cames between strips are DRAWN but never marked: a mark would punch a
 * 2 cm hole of unfiltered sunlight through the middle of the patch, and the point
 * of the exercise is that the patch is the colour of the glass.
 */
function stainedWindow(b, A, strips, o = {}) {
  const N = o.cols ?? 24;                      // columns across the aperture
  const zs = A.z1;                             // springing line
  const apex = apexOf(A, zs);
  const gy = 1 - CT * 0.80;
  // The pane mark is THICKER than one voxel (0.094 against 0.071) so that the
  // voxel where a ray enters the glass is always fully covered: the shader charges
  // a pane once, on entry, and a partially covered entry voxel would hand the
  // floor a different transmittance than the table quotes. See the glass note in
  // src/gl/shaders.js.
  const gw = CT * 0.55;

  // ---- the stone around the aperture
  wallBody(b, { z0: 0, z1: A.z0 });                              // sill wall
  wallBody(b, { x0: 0, x1: A.x0 });                              // left jamb
  wallBody(b, { x0: A.x1, x1: 1 });                              // right jamb
  wallBody(b, { z0: apex, z1: CH });                             // above the apex
  baseMould(b, 0, 1);
  capBand(b);

  // ---- glass, strip by strip, column by column
  const n = strips.length;
  const per = Math.max(1, Math.round(N / n));
  for (let s = 0; s < n; s++) {
    const G = strips[s];
    const sx0 = A.x0 + (A.x1 - A.x0) * (s / n);
    const sx1 = A.x0 + (A.x1 - A.x0) * ((s + 1) / n);
    for (let i = 0; i < per; i++) {
      const x0 = sx0 + (sx1 - sx0) * (i / per);
      const x1 = sx0 + (sx1 - sx0) * ((i + 1) / per);
      const h = Math.min(apex, archAt((x0 + x1) / 2, A, zs));
      if (h <= A.z0 + 0.03) { wallBody(b, { x0, x1, z0: A.z0 }); continue; }
      if (h < apex - 0.001) wallBody(b, { x0, x1, z0: h });       // spandrel over the arch
      b.glassBox(x0, gy, A.z0, x1 - x0, gw, h - A.z0, M(G.mat), { occ: false },
        { trans: G.trans, tint: G.tint });
    }
    // a stone mullion between strips: marked, so it splits the patch of light
    // into as many pencils as there are lights in the window
    if (s > 0 && (o.mullion ?? 0) > 0) {
      const mw = o.mullion;
      wallBody(b, { x0: sx0 - mw / 2, x1: sx0 + mw / 2, z0: A.z0 });
    }
  }

  // ---- tracery: a hood mould over the arch, a transom across, and the sill
  const steps = 9;
  for (let i = 0; i < steps; i++) {
    const x0 = A.x0 + (A.x1 - A.x0) * (i / steps);
    const x1 = A.x0 + (A.x1 - A.x0) * ((i + 1) / steps);
    const h = Math.min(apex, archAt((x0 + x1) / 2, A, zs));
    b.box(x0 - 0.008, 1 - CT - 0.045, h - 0.02, (x1 - x0) + 0.016, CT + 0.045, 0.075, M('stoneTrim'), { occ: false });
  }
  b.box(A.x0 - 0.06, 1 - CT - 0.045, A.z0 + (zs - A.z0) * 0.66, (A.x1 - A.x0) + 0.12, CT + 0.045, 0.055, M('stoneTrim'), { occ: false });
  b.box(A.x0 - 0.10, 1 - CT - 0.14, A.z0 - 0.07, (A.x1 - A.x0) + 0.20, CT + 0.14, 0.075, M('stoneTrim'), { occ: false });
  b.box(A.x0 - 0.10, 1 - CT - 0.14, A.z0 - 0.13, (A.x1 - A.x0) + 0.20, CT + 0.14, 0.06, M('stoneDk'), { occ: false });
  // lead cames along the strip boundaries and around every pane
  for (let s = 0; s <= n; s++) {
    const x = A.x0 + (A.x1 - A.x0) * (s / n);
    b.box(x - 0.008, gy - 0.014, A.z0, 0.016, gw + 0.028, apex - A.z0, M('ironBlack'), { occ: false });
  }
  b.box(A.x0 - 0.012, gy - 0.014, A.z0 - 0.02, (A.x1 - A.x0) + 0.024, gw + 0.028, 0.03, M('ironBlack'), { occ: false });
}

// ---------------------------------------------------------------- models
export const MODELS = [
  // ---------------------------------------------------------------- walls
  {
    id: 'wall_stone', name: 'CHAPEL WALL', cat: 'wall', fp: [1, 1], seed: 941, cap: CH + CAP, rots: 4, cut: false,
    build(b) {
      wallBody(b);
      // A blind arch, so a 15-tile run of stone is not 15 identical tiles. It is
      // drawn, not marked: a recess that exists in the volume would let light
      // through a wall, which is the one thing a wall must never do.
      const A = { x0: 0.20, x1: 0.80, z0: 1.15, z1: 2.55 };
      wallBody(b, { x0: A.x0, x1: A.x1, z0: 0, z1: 0.02, face: 'stoneWarm' });
      for (let i = 0; i < 8; i++) {
        const x0 = A.x0 + (A.x1 - A.x0) * (i / 8), x1 = A.x0 + (A.x1 - A.x0) * ((i + 1) / 8);
        b.box(x0, 1 - CT - 0.028, 0.02, (x1 - x0) + 0.004, 0.028, Math.min(apexOf(A, A.z1), archAt((x0 + x1) / 2, A, A.z1)) - 0.02, M('stoneWarm'), { occ: false });
      }
      b.box(A.x0 - 0.045, 1 - CT - 0.032, 0.02, 0.045, 0.032, A.z1 + 0.02, M('stoneTrim'), { occ: false });
      b.box(A.x1, 1 - CT - 0.032, 0.02, 0.045, 0.032, A.z1 + 0.02, M('stoneTrim'), { occ: false });
      baseMould(b, 0, 1);
      capBand(b);
    },
  },
  {
    id: 'wall_stone_lancet', name: 'LANCET', cat: 'wall', fp: [1, 1], seed: 942, cap: CH + CAP, rots: 4, cut: false,
    build(b) { stainedWindow(b, LANCET, GLASS, { cols: 25 }); },
  },
  {
    // The great window: three lights and the widest patch of coloured light in the
    // game. This is the piece the near (ghosted) runs carry, because the near runs
    // are the only ones the sun can reach through.
    //
    // NO MARKED MULLIONS, and that is a statement about the VOLUME, not about the
    // window: the glazing bars are still DRAWN (the cames and the tracery in
    // stainedWindow), what is gone is their mark in the transmittance field. A
    // 7.5 cm bar is about one voxel, so marking it carves a one-voxel slot out of
    // the aperture, and a one-voxel slot at a grazing sun angle projects a ruled
    // dark line 1.7 px wide across the entire patch. Real glazing bars do shadow
    // a window, but a real bar is also lit from every side and the sun is half a
    // degree wide; here the mark can only ever draw a ruled line, and a ruled line
    // lying on a floor reads as a rendering fault rather than as a bar. The
    // aperture is therefore marked as what it looks like from across the room:
    // one opening.
    id: 'wall_stone_great', name: 'GREAT WINDOW', cat: 'wall', fp: [1, 1], seed: 943, cap: CH + CAP, rots: 4, cut: false,
    build(b) { stainedWindow(b, GREAT, GREAT_PANES, { cols: 24 }); },
  },
  {
    // A wheel window. The circle is cut column by column like the arch heads
    // above, so the round patch it throws on the floor is round; the panes are
    // grouped into six fields around a gold hub, which is what makes it read as
    // a rose rather than as a porthole.
    id: 'wall_stone_rose', name: 'ROSE WINDOW', cat: 'wall', fp: [1, 1], seed: 944, cap: CH + CAP, rots: 4, cut: false,
    build(b) {
      const R = ROSE;
      const cx = (R.x0 + R.x1) / 2;
      const N = 22;
      const gy = 1 - CT * 0.80, gw = CT * 0.55;
      const zBot = R.zc - R.r, zTop = R.zc + R.r;
      wallBody(b, { z0: 0, z1: zBot });
      wallBody(b, { z0: zTop, z1: CH });
      const fields = [GLASS[3], GLASS[2], GLASS[1]];       // left, centre, right
      for (let i = 0; i < N; i++) {
        const x0 = R.x0 + (R.x1 - R.x0) * (i / N), x1 = R.x0 + (R.x1 - R.x0) * ((i + 1) / N);
        const xm = (x0 + x1) / 2, dx = Math.abs(xm - cx);
        const chord = dx >= R.r ? 0 : Math.sqrt(R.r * R.r - dx * dx);
        if (chord < 0.02) { wallBody(b, { x0, x1, z0: zBot, z1: zTop }); continue; }
        const zt = R.zc + chord, zb = R.zc - chord;
        if (zt < zTop - 0.001) wallBody(b, { x0, x1, z0: zt, z1: zTop });
        if (zb > zBot + 0.001) wallBody(b, { x0, x1, z0: zBot, z1: zb });
        const G = fields[xm < cx - R.r * 0.3 ? 0 : (xm > cx + R.r * 0.3 ? 2 : 1)];
        const hub = R.r * 0.30;
        const hz = dx >= hub ? 0 : Math.sqrt(hub * hub - dx * dx);
        // upper field, hub, lower field —marked separately so the hub keeps its
        // own colour even where the field above it is violet
        if (zt > R.zc + hz + 0.01) {
          b.glassBox(x0, gy, R.zc + hz, x1 - x0, gw, zt - R.zc - hz, M(G.mat), { occ: false }, { trans: G.trans, tint: G.tint });
        }
        if (hz > 0.01) {
          b.glassBox(x0, gy, R.zc - hz, x1 - x0, gw, hz * 2, M(GLASS[2].mat), { occ: false },
            { trans: GLASS[2].trans, tint: GLASS[2].tint });
        }
        if (zb < R.zc - hz - 0.01) {
          const G2 = fields[xm < cx - R.r * 0.3 ? 2 : (xm > cx + R.r * 0.3 ? 0 : 1)];
          b.glassBox(x0, gy, zb, x1 - x0, gw, R.zc - hz - zb, M(G2.mat), { occ: false }, { trans: G2.trans, tint: G2.tint });
        }
      }
      // rim, hub ring and eight spokes: drawn on top of the glass, never marked
      for (let i = 0; i < N; i++) {
        const x0 = R.x0 + (R.x1 - R.x0) * (i / N), x1 = R.x0 + (R.x1 - R.x0) * ((i + 1) / N);
        const xm = (x0 + x1) / 2, dx = Math.abs(xm - cx);
        const chord = dx >= R.r ? 0 : Math.sqrt(R.r * R.r - dx * dx);
        if (chord < 0.02) continue;
        b.box(x0 - 0.006, 1 - CT - 0.05, R.zc + chord - 0.055, (x1 - x0) + 0.012, CT + 0.05, 0.075, M('stoneTrim'), { occ: false });
        b.box(x0 - 0.006, 1 - CT - 0.05, R.zc - chord, (x1 - x0) + 0.012, CT + 0.05, 0.075, M('stoneTrim'), { occ: false });
      }
      for (const a of [-0.72, -0.36, 0, 0.36, 0.72]) {
        const x = cx + Math.sin(a) * R.r * 0.98;
        const zz = R.zc + Math.cos(a) * R.r * 0.98;
        b.box(x - 0.026, 1 - CT - 0.04, Math.min(zz, R.zc) - 0.02, 0.052, CT + 0.04, Math.abs(zz - R.zc) + 0.04, M('stoneTrim'), { occ: false });
      }
      baseMould(b, 0, 1);
      capBand(b);
    },
  },
  {
    id: 'wall_door_chapel', name: 'WEST DOOR', cat: 'wall', fp: [1, 1], seed: 945, cap: CH + CAP, rots: 4, cut: false,
    build(b) {
      const A = { x0: DOOR.x0, x1: DOOR.x1, z0: 0, z1: DOOR.z1 };
      const apex = apexOf(A, A.z1);
      wallBody(b, { x0: 0, x1: A.x0 });
      wallBody(b, { x0: A.x1, x1: 1 });
      wallBody(b, { z0: apex, z1: CH });
      for (let i = 0; i < 12; i++) {
        const x0 = A.x0 + (A.x1 - A.x0) * (i / 12), x1 = A.x0 + (A.x1 - A.x0) * ((i + 1) / 12);
        const h = Math.min(apex, archAt((x0 + x1) / 2, A, A.z1));
        if (h < apex - 0.001) wallBody(b, { x0, x1, z0: h });
      }
      // two leaves, a hinge stile each, and a ring handle: the door is SHUT, and
      // it is the one aperture in the map that lets no light through at all
      const y0 = 1 - CT + 0.02;
      b.box(A.x0, y0, 0, (A.x1 - A.x0) / 2 - 0.01, 0.09, A.z1 + 0.9, M('woodPlankDk'), { occ: false, faces: { ny: M('woodPlank') } });
      b.box((A.x0 + A.x1) / 2 + 0.01, y0, 0, (A.x1 - A.x0) / 2 - 0.01, 0.09, A.z1 + 0.9, M('woodPlankDk'), { occ: false, faces: { ny: M('woodPlank') } });
      for (const x of [A.x0 + 0.10, A.x1 - 0.16]) {
        b.box(x, y0 - 0.02, 0.18, 0.06, 0.02, A.z1 + 0.55, M('ironBlack'), { occ: false });
      }
      b.cylinder((A.x0 + A.x1) / 2 - 0.13, y0 - 0.03, 1.05, 1.13, 0.055, 10, M('ironBlack'), { rTop: 0.055, top: false, rot: 0.4 });
      b.mark('solid', A.x0, 1 - CT, 0, A.x1 - A.x0, CT, A.z1 + 0.95);
      // hood mould over the arch
      for (let i = 0; i < 9; i++) {
        const x0 = A.x0 + (A.x1 - A.x0) * (i / 9), x1 = A.x0 + (A.x1 - A.x0) * ((i + 1) / 9);
        const h = Math.min(apex, archAt((x0 + x1) / 2, A, A.z1));
        b.box(x0 - 0.012, 1 - CT - 0.05, h - 0.02, (x1 - x0) + 0.024, CT + 0.05, 0.08, M('stoneTrim'), { occ: false });
      }
      baseMould(b, 0, 1);
      capBand(b);
    },
  },
  {
    // A free-standing pier. Its volume mark is a square the width of the shaft,
    // which is the honest shape for a 14-voxel-per-unit grid: a round mark would
    // alias into a plus sign and stripe the light it lets past.
    id: 'wall_column', name: 'PIER', cat: 'wall', fp: [1, 1], seed: 946, cap: CH, rots: 4, cut: false,
    build(b) {
      const st = M('stonePale'), sd = M('stoneDk');
      b.box(0.26, 0.26, 0, 0.48, 0.48, 0.34, sd);                        // plinth block
      b.box(0.31, 0.31, 0.34, 0.38, 0.38, 0.12, M('stoneTrim'), { occ: false });
      b.cylinder(0.5, 0.5, 0.46, CH - 0.30, 0.205, 12, st, { top: false, rTop: 0.195 });
      b.box(0.30, 0.30, CH - 0.32, 0.40, 0.40, 0.11, M('stoneTrim'), { occ: false });
      b.box(0.25, 0.25, CH - 0.21, 0.50, 0.50, 0.21, sd);                // capital
      b.mark('solid', 0.28, 0.28, 0, 0.44, 0.44, CH - 0.20);
    },
  },

  // ---------------------------------------------------------------- floors
  {
    id: 'floor_marble', name: 'MARBLE', cat: 'floor', fp: [1, 1], seed: 951, cap: 0.06, phase: 0,
    build(b) { marbleSlab(b, M('marblePale')); },
  },
  {
    id: 'floor_marble_dk', name: 'DARK MARBLE', cat: 'floor', fp: [1, 1], seed: 952, cap: 0.06, phase: 1,
    build(b) { marbleSlab(b, M('marbleDk')); },
  },
  {
    // The chancel pavement: a gold lozenge in a red border, in ONE plane.
    // Nine sub-squares laid edge to edge, exactly like roomkit's chequerboard —    // the alternative (a decal lying on a slab) is a coplanar pair, and a
    // coplanar pair is the one thing this renderer cannot break a tie on.
    id: 'floor_mosaic', name: 'CHANCEL PAVEMENT', cat: 'floor', fp: [1, 1], seed: 953, cap: 0.06, phase: 0,
    build(b) {
      const n = 3, s = 1 / n;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const mid = i === 1 && j === 1;
          const edge = (i + j) % 2 === 0;
          const m = mid ? M('marblePale') : (edge ? M('carpetRed') : M('marbleDk'));
          b.box(i * s, j * s, -0.12, s, s, 0.12, m, {
            faces: { pz: mid ? M('gold') : m }, occ: false,
            skip: { nx: true, px: true, ny: true, py: true },
          });
        }
      }
      b.m.mark('solid', 0, 0, -0.12, 1, 1, 0.12);
    },
  },

  // ---------------------------------------------------------------- furniture
  {
    id: 'furn_pew', name: 'PEW', cat: 'furn', fp: [2, 1], seed: 961, cap: 1.12, rots: 4,
    build(b) {
      const mm = M('woodPlank'), md = M('woodPlankDk'), tk = M('trim');
      const x0 = 0.06, x1 = 1.94;
      for (const x of [x0, x1 - 0.075]) b.box(x, 0.26, 0, 0.075, 0.66, 0.47, mm, { faces: { ny: md, px: md } });
      b.box(x0, 0.24, 0.47, x1 - x0, 0.58, 0.08, mm, { faces: { pz: mm, ny: md } });       // seat
      b.box(x0, 0.80, 0.47, x1 - x0, 0.10, 0.59, mm, { faces: { ny: md, py: md } });       // back
      b.box(x0 - 0.02, 0.77, 1.00, (x1 - x0) + 0.04, 0.16, 0.07, tk, { occ: false });      // capping rail
      b.box(x0, 0.80, 0.68, x1 - x0, 0.13, 0.045, md, { occ: false });                     // book ledge
      b.box(x0, 0.03, 0, x1 - x0, 0.20, 0.11, md, { occ: false, faces: { pz: md } });      // kneeler
      b.box(x0 - 0.01, 0.20, 0.06, (x1 - x0) + 0.02, 0.05, 0.06, tk, { occ: false });
    },
  },
  {
    id: 'furn_altar', name: 'ALTAR', cat: 'furn', fp: [2, 1], seed: 962, cap: 1.70, rots: 4,
    build(b) {
      const st = M('stonePale'), sd = M('stoneDk'), gt = M('gold');
      b.box(0.16, 0.22, 0, 1.68, 0.60, 0.92, st, { faces: { ny: sd, pz: M('stoneTrim') } });
      b.box(0.07, 0.14, 0.92, 1.86, 0.76, 0.09, M('stoneTrim'), { occ: false });
      // fair linen over the front, with a coloured band —the altar is the one
      // piece of furniture in the map that is dressed rather than built
      b.box(0.18, 0.165, 0.32, 1.64, 0.06, 0.60, M('clothCream'), { occ: false });
      b.box(0.18, 0.158, 0.32, 1.64, 0.07, 0.11, M('carpetRed'), { occ: false });
      b.box(0.30, 0.68, 1.01, 1.40, 0.20, 0.15, sd, { occ: false });                 // gradine
      for (const x of [0.54, 1.40]) {
        b.cylinder(x, 0.78, 1.16, 1.30, 0.075, 10, gt, { rTop: 0.045, top: true });
        b.cylinder(x, 0.78, 1.30, 1.54, 0.030, 8, M('wax'));
        b.box(x - 0.021, 0.759, 1.54, 0.042, 0.042, 0.075, M('fireGlow'), { occ: false });
      }
      b.box(0.94, 0.76, 1.16, 0.12, 0.06, 0.46, gt, { occ: false });                 // cross
      b.box(0.82, 0.76, 1.38, 0.36, 0.06, 0.12, gt, { occ: false });
    },
  },
  {
    id: 'furn_lectern', name: 'LECTERN', cat: 'furn', fp: [1, 1], seed: 963, cap: 1.30, rots: 4,
    build(b) {
      const mm = M('woodPlankDk'), tk = M('trim'), lt = M('woodPlankLt');
      b.box(0.32, 0.32, 0, 0.36, 0.36, 0.10, mm);
      b.box(0.44, 0.44, 0.10, 0.12, 0.12, 0.92, mm);
      b.box(0.31, 0.31, 0.60, 0.38, 0.38, 0.06, tk, { occ: false });
      b.box(0.20, 0.30, 1.02, 0.60, 0.34, 0.055, lt, { occ: false, faces: { pz: lt } });
      b.box(0.20, 0.30, 1.02, 0.60, 0.045, 0.115, tk, { occ: false });          // the lip a book rests on
      b.box(0.20, 0.60, 1.02, 0.60, 0.04, 0.075, tk, { occ: false });
      b.box(0.30, 0.36, 1.075, 0.40, 0.26, 0.045, M('paper'), { occ: false });  // an open book
      b.box(0.485, 0.36, 1.075, 0.03, 0.26, 0.05, M('clothBlue'), { occ: false });
    },
  },
  {
    id: 'furn_font', name: 'FONT', cat: 'furn', fp: [1, 1], seed: 964, cap: 1.05, rots: 4,
    build(b) {
      const st = M('stonePale'), sd = M('stoneDk');
      b.cylinder(0.5, 0.5, 0, 0.14, 0.30, 8, sd);
      b.cylinder(0.5, 0.5, 0.14, 0.62, 0.185, 8, st);
      b.cylinder(0.5, 0.5, 0.62, 0.80, 0.20, 8, M('stoneTrim'), { rTop: 0.30, top: false });
      b.cylinder(0.5, 0.5, 0.80, 0.86, 0.30, 8, st, { top: false });
      b.cylinder(0.5, 0.5, 0.82, 0.845, 0.26, 8, M('water'), { top: true });
    },
  },
  {
    // Tall enough that its flames stand above a pew back, which is the whole
    // reason a chapel needs one: this is the light you see across the room at
    // evensong, and the point light rule for `candelabra` reads its flame height.
    id: 'furn_candelabra', name: 'CANDELABRA', cat: 'furn', fp: [1, 1], seed: 965, cap: 1.95, rots: 4,
    build(b) {
      const ir = M('ironBlack'), gt = M('gold'), wx = M('wax');
      b.cylinder(0.5, 0.5, 0, 0.10, 0.22, 10, ir);
      b.cylinder(0.5, 0.5, 0.10, 1.30, 0.048, 8, ir);
      b.cylinder(0.5, 0.5, 0.52, 0.62, 0.085, 8, gt, { rTop: 0.055, top: true });
      b.box(0.16, 0.455, 1.28, 0.68, 0.09, 0.075, ir, { occ: false });
      b.box(0.455, 0.16, 1.28, 0.09, 0.68, 0.075, ir, { occ: false });
      const cup = [[0.5, 0.5], [0.20, 0.5], [0.80, 0.5], [0.5, 0.20], [0.5, 0.80]];
      for (const [x, y] of cup) {
        b.cylinder(x, y, 1.355, 1.40, 0.055, 8, gt, { rTop: 0.04, top: true });
        b.cylinder(x, y, 1.40, 1.66, 0.030, 8, wx);
        b.box(x - 0.022, y - 0.022, 1.66, 0.044, 0.044, 0.08, M('fireGlow'), { occ: false });
      }
    },
  },
  {
    // A banner on a rod. No volume marks at all: it hangs three units off the
    // floor and a mark at that height would stripe the light for no reason.
    // interior_chapel passes `back` at placement, the way roomkit does for the
    // curtain, so the mount does not depend on marks that are not there.
    id: 'furn_banner', name: 'BANNER', cat: 'furn', fp: [1, 1], seed: 966, cap: 3.10, rots: 4,
    build(b) {
      const rod = M('beamDk'), cl = M('carpetRed'), gt = M('gold');
      b.box(0.03, 0.44, 2.98, 0.94, 0.075, 0.075, rod, { occ: false });
      b.box(0.02, 0.44, 2.90, 0.075, 0.075, 0.12, gt, { occ: false });
      b.box(0.925, 0.44, 2.90, 0.075, 0.075, 0.12, gt, { occ: false });
      b.box(0.14, 0.455, 1.52, 0.72, 0.05, 1.40, cl, { faces: { ny: cl } });
      b.box(0.14, 0.450, 1.52, 0.72, 0.055, 0.12, gt, { occ: false });
      b.box(0.14, 0.448, 2.55, 0.72, 0.06, 0.14, M('clothCream'), { occ: false });
      b.box(0.42, 0.446, 2.02, 0.16, 0.062, 0.38, gt, { occ: false });      // a charge
      b.box(0.34, 0.444, 2.14, 0.32, 0.064, 0.14, gt, { occ: false });
    },
  },
  {
    // A tie-beam truss. It is furniture, not architecture, and that is a
    // decision: it hangs at 3.6 with the ceiling at 4.2 and stamps nothing into
    // the volume, so the beams do not draw shadow bars across the floor —the
    // light in this room belongs to the windows.
    id: 'furn_truss', name: 'TRUSS', cat: 'furn', fp: [4, 1], seed: 967, cap: 4.20, rots: 1,
    build(b) {
      const bm = M('beam'), bd = M('beamDk');
      b.box(0.02, 0.34, 3.50, 3.96, 0.26, 0.24, bm, { faces: { py: bd, ny: bd } });
      b.box(1.86, 0.36, 3.74, 0.28, 0.22, 0.46, bm);                       // king post
      b.box(1.72, 0.36, 4.06, 0.56, 0.22, 0.14, bm, { occ: false });       // head
      for (const [x, dir] of [[0.16, 1], [3.44, -1]]) {
        b.box(x, 0.34, 3.28, 0.30, 0.26, 0.26, bd);                        // corbel
        // the brace: a stack of short blocks stepping up to the king post. At
        // this scale a diagonal IS a staircase, and a staircase is what the
        // pixel artist would have drawn anyway.
        for (let i = 0; i < 7; i++) {
          const t = i / 6;
          const bx = x + dir * (0.22 + (1.58 - 0.22) * t);
          b.box(bx, 0.36, 3.64 + 0.40 * t, 0.16, 0.22, 0.11, bm, { occ: false });
        }
      }
      b.box(0.10, 0.34, 3.30, 0.16, 0.26, 0.22, bd, { occ: false });
      b.box(3.74, 0.34, 3.30, 0.16, 0.26, 0.22, bd, { occ: false });
    },
  },
];

/** a marble floor tile: top face only, exactly like roomkit's floorSlab */
function marbleSlab(b, mat) {
  b.box(0, 0, -0.12, 1, 1, 0.12, mat, {
    faces: { pz: mat }, occ: false,
    skip: { nx: true, px: true, ny: true, py: true },
  });
  b.m.mark('solid', 0, 0, -0.12, 1, 1, 0.12);
}
