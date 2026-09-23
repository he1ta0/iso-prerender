// Ground tiles.
//
// Every terrain tile is a thin slab whose **top face sits exactly at z = 0**, so
// tiles butt together on the walking plane with no seam and no z-fighting. The
// skirt below z=0 is what hides the hairline gap that antialiased diamond edges
// would otherwise leave between neighbours.
//
// The procedural patterns are evaluated in world space, so a tile's `phase`
// shifts the noise domain to produce visually distinct variants that still read
// as one continuous field of grass.

import { Builder } from '../lib/geom.mjs';
import { M } from '../lib/materials.mjs';

const SKIRT = 0.09;      // how far a tile reaches below the walking plane

/** flat diamond with a skirt; `top` is the visible surface material */
function ground(b, top, opt = {}) {
  const skirt = opt.skirt ?? SKIRT;
  const side = opt.side ?? top;
  b.box(0, 0, -skirt, 1, 1, skirt, side, {
    faces: { pz: top },
    occ: opt.occ !== false,
    bottom: false,
  });
  // a couple of decorative bits on top
  if (opt.tufts) {
    const r = b.rng;
    for (let i = 0; i < opt.tufts; i++) {
      const x = 0.08 + r() * 0.84, y = 0.08 + r() * 0.84;
      const h = 0.035 + r() * 0.05;
      b.box(x, y, 0, 0.022, 0.022, h, opt.tuftMat ?? top, { occ: false });
    }
  }
  if (opt.pebbles) {
    const r = b.rng;
    for (let i = 0; i < opt.pebbles; i++) {
      const x = 0.1 + r() * 0.8, y = 0.1 + r() * 0.8;
      const s = 0.03 + r() * 0.035;
      b.box(x, y, 0, s, s, s * 0.7, opt.pebbleMat ?? M('stone'), { occ: false });
    }
  }
}

/** small flat scatter patch (flowers, leaf litter) — no skirt */
function scatter(b, mat, n, size, h) {
  const r = b.rng;
  for (let i = 0; i < n; i++) {
    const x = 0.06 + r() * 0.88, y = 0.06 + r() * 0.88;
    const s = size * (0.7 + r() * 0.6);
    b.box(x, y, 0, s, s, h * (0.7 + r() * 0.6), mat, { occ: false });
  }
}

export const MODELS = [
  // ---- grass ---------------------------------------------------------------
  {
    id: 'g_grass', name: 'GRASS', cat: 'ground', fp: [1, 1], seed: 11, cap: 0.1, phase: 0,
    build(b) { ground(b, M('grass'), { tufts: 5 }); },
  },
  {
    id: 'g_grass_b', name: 'GRASS', cat: 'ground', fp: [1, 1], seed: 12, cap: 0.1, phase: 1,
    build(b) { ground(b, M('grass'), { tufts: 4 }); },
  },
  {
    id: 'g_grass_c', name: 'GRASS', cat: 'ground', fp: [1, 1], seed: 13, cap: 0.1, phase: 2,
    build(b) { ground(b, M('grass'), { tufts: 7, tuftMat: M('grassDk') }); },
  },
  {
    id: 'g_grass_d', name: 'GRASS', cat: 'ground', fp: [1, 1], seed: 14, cap: 0.1, phase: 3,
    build(b) { ground(b, M('grass'), { tufts: 6, tuftMat: M('grassLt') }); },
  },
  {
    id: 'g_grass_flower', name: 'MEADOW', cat: 'ground', fp: [1, 1], seed: 15, cap: 0.14, phase: 4,
    build(b) {
      ground(b, M('grass'), { tufts: 3 });
      scatter(b, M('flowerWhite'), 3, 0.026, 0.05);
      scatter(b, M('flowerYellow'), 2, 0.026, 0.05);
      scatter(b, M('flowerRed'), 2, 0.024, 0.048);
    },
  },
  {
    id: 'g_grass_tall', name: 'TALL GRASS', cat: 'ground', fp: [1, 1], seed: 16, cap: 0.22, phase: 5,
    build(b) { ground(b, M('grassTall'), { tufts: 16, tuftMat: M('grassDk') }); },
  },
  {
    id: 'g_grass_dry', name: 'DRY GRASS', cat: 'ground', fp: [1, 1], seed: 17, cap: 0.1, phase: 6,
    build(b) { ground(b, M('grassDry'), { tufts: 5, tuftMat: M('hay') }); },
  },

  // ---- soil / farm ---------------------------------------------------------
  {
    id: 'g_dirt', name: 'DIRT', cat: 'ground', fp: [1, 1], seed: 21, cap: 0.1, phase: 0,
    build(b) { ground(b, M('soil'), { pebbles: 2 }); },
  },
  {
    id: 'g_dirt_b', name: 'DIRT', cat: 'ground', fp: [1, 1], seed: 22, cap: 0.1, phase: 2,
    build(b) { ground(b, M('soilDk'), { pebbles: 3, pebbleMat: M('stoneDk') }); },
  },
  {
    id: 'g_tilled', name: 'TILLED', cat: 'ground', fp: [1, 1], seed: 23, cap: 0.1, phase: 0,
    build(b) { ground(b, M('tilled'), { occ: false }); },
  },
  {
    id: 'g_tilled_b', name: 'TILLED', cat: 'ground', fp: [1, 1], seed: 24, cap: 0.1, phase: 3,
    build(b) { ground(b, M('tilled'), { occ: false }); },
  },
  {
    id: 'g_tilled_wet', name: 'WET SOIL', cat: 'ground', fp: [1, 1], seed: 25, cap: 0.1, phase: 0,
    build(b) { ground(b, M('tilledWet'), { occ: false }); },
  },
  {
    id: 'g_tilled_wet_b', name: 'WET SOIL', cat: 'ground', fp: [1, 1], seed: 26, cap: 0.1, phase: 3,
    build(b) { ground(b, M('tilledWet'), { occ: false }); },
  },
  {
    id: 'g_mud', name: 'MUD', cat: 'ground', fp: [1, 1], seed: 27, cap: 0.1, phase: 1,
    build(b) { ground(b, M('mud'), { pebbles: 2 }); },
  },

  // ---- paths ---------------------------------------------------------------
  {
    id: 'g_path_sand', name: 'PATH', cat: 'ground', fp: [1, 1], seed: 31, cap: 0.1, phase: 0,
    build(b) { ground(b, M('sandPath'), { pebbles: 2, pebbleMat: M('gravel') }); },
  },
  {
    id: 'g_path_sand_b', name: 'PATH', cat: 'ground', fp: [1, 1], seed: 32, cap: 0.1, phase: 2,
    build(b) { ground(b, M('sandPath'), { pebbles: 3, pebbleMat: M('stone') }); },
  },
  {
    id: 'g_gravel', name: 'GRAVEL', cat: 'ground', fp: [1, 1], seed: 33, cap: 0.1, phase: 1,
    build(b) { ground(b, M('gravel'), { pebbles: 5, pebbleMat: M('stone') }); },
  },
  {
    id: 'g_flagstone', name: 'FLAGSTONE', cat: 'ground', fp: [1, 1], seed: 34, cap: 0.1, phase: 0,
    build(b) { ground(b, M('flagstone'), { occ: false }); },
  },
  {
    id: 'g_flagstone_b', name: 'FLAGSTONE', cat: 'ground', fp: [1, 1], seed: 35, cap: 0.1, phase: 1,
    build(b) { ground(b, M('flagstoneDk'), { occ: false }); },
  },
  {
    id: 'g_sand', name: 'SAND', cat: 'ground', fp: [1, 1], seed: 36, cap: 0.1, phase: 4,
    build(b) { ground(b, M('sand'), { pebbles: 2, pebbleMat: M('stoneWarm') }); },
  },

  // ---- water ---------------------------------------------------------------
  // Rendered as a pit: the surface sits slightly below the walking plane so a
  // shoreline tile can lip over it and the runtime can put a rim of light on it.
  { id: 'g_water', name: 'WATER', cat: 'water', fp: [1, 1], seed: 41, cap: 0.1, phase: 0, occ: false,
    build(b) { water(b); } },
  { id: 'g_water_b', name: 'WATER', cat: 'water', fp: [1, 1], seed: 42, cap: 0.1, phase: 1, occ: false,
    build(b) { water(b); } },
  { id: 'g_water_c', name: 'WATER', cat: 'water', fp: [1, 1], seed: 43, cap: 0.1, phase: 2, occ: false,
    build(b) { water(b); } },

  // ---- shore ---------------------------------------------------------------
  { id: 'g_shore_n', name: 'SHORE', cat: 'water', fp: [1, 1], seed: 44, cap: 0.12, phase: 0,
    build(b) { shore(b, 'n'); } },
  { id: 'g_shore_s', name: 'SHORE', cat: 'water', fp: [1, 1], seed: 45, cap: 0.12, phase: 1,
    build(b) { shore(b, 's'); } },
  { id: 'g_shore_e', name: 'SHORE', cat: 'water', fp: [1, 1], seed: 46, cap: 0.12, phase: 2,
    build(b) { shore(b, 'e'); } },
  { id: 'g_shore_w', name: 'SHORE', cat: 'water', fp: [1, 1], seed: 47, cap: 0.12, phase: 3,
    build(b) { shore(b, 'w'); } },
];

function water(b) {
  // sunken water body: surface at -0.10, walls down to -0.35
  b.box(0, 0, -0.35, 1, 1, 0.25, M('waterDeep'), { faces: { pz: M('water') }, occ: false });
}

/**
 * A grass tile with one edge cut away to reveal water beneath. `side` names the
 * edge that becomes shoreline, in grid terms (n = -y, s = +y, w = -x, e = +x).
 */
function shore(b, side) {
  const g = M('grass');
  const lip = M('sand');
  const wl = M('waterShallow');
  const H = 1 / 3;
  // water underneath the whole tile
  b.box(0, 0, -0.35, 1, 1, 0.22, M('waterDeep'), { faces: { pz: wl }, occ: false });
  // the land part: a quadrant-ish slab that stops short of the shore edge
  let x = 0, y = 0, w = 1, d = 1;
  if (side === 'n') { y = H; d = 1 - H; }
  else if (side === 's') { d = 1 - H; }
  else if (side === 'w') { x = H; w = 1 - H; }
  else { w = 1 - H; }
  b.box(x, y, -SKIRT, w, d, SKIRT, g, { faces: { pz: g }, occ: false });
  // a sand lip on the exposed face
  const t = 0.055;
  if (side === 'n') b.box(0, H - t, -SKIRT * 1.4, 1, t, SKIRT * 1.4, lip, { occ: false });
  else if (side === 's') b.box(0, 1 - H, -SKIRT * 1.4, 1, t, SKIRT * 1.4, lip, { occ: false });
  else if (side === 'w') b.box(H - t, 0, -SKIRT * 1.4, t, 1, SKIRT * 1.4, lip, { occ: false });
  else b.box(1 - H, 0, -SKIRT * 1.4, t, 1, SKIRT * 1.4, lip, { occ: false });
}
