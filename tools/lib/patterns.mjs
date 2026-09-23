// World-space procedural surface detail.
//
// Every material carries a pattern id. The pattern is evaluated per pixel from
// the *world* position of the surface point, which buys us three things:
//
//   1. texture that flows seamlessly across tiles (grass, soil, water),
//   2. tile variants for free — `setPatternPhase()` shifts the noise domain,
//   3. and the important one for this project: because the pattern is an
//      analytic function of world position, we can take its **gradient** by
//      finite differences and turn it into a detail normal map.
//
// (3) is what makes a pre-rendered pixel sprite survive being lit at runtime.
// Geometry alone gives one constant normal per face, so a wooden wall lit by a
// lantern is a dead flat gradient. Perturbing the normal by the gradient of the
// board/plank/brick pattern gives that wall visible relief at no asset cost.
//
// Conventions, shared by every pattern:
//   n      surface normal (model/world space, unit)
//   top    true when the face points mostly up  -> in-plane coords are (x, y)
//   u      horizontal coordinate running *along* a vertical wall
//   q1,q2  generic in-plane coords (ground: x,y — wall: u,z)
//
// Feature sizes are in world units. With the project's 32x16 tiles one world
// unit is 16 screen px horizontally and ZPX px vertically, so a 0.19-unit plank
// is a ~3 px board.

export const PAT = {
  NONE: 0,
  PLANK: 1,        // vertical boards (siding, crates, fences)
  LOG: 2,          // horizontal stacked logs (log cabin, retaining walls)
  STUCCO: 3,       // fine plaster noise
  BRICK: 4,
  STONE: 5,        // rubble / fieldstone
  COBBLE: 6,
  SHINGLE: 7,      // wood shakes
  TILE_ROOF: 8,    // terracotta barrel tiles
  THATCH: 9,
  SLATE: 10,
  GRASS: 11,
  GRASS_TALL: 12,
  SOIL: 13,
  TILLED: 14,      // ploughed furrows — the money pattern for a farming game
  SAND: 15,
  GRAVEL: 16,
  STONE_PATH: 17,  // flagstones
  WATER: 18,
  DECK: 19,        // horizontal decking
  LEAF: 20,
  HEDGE: 21,
  BARK: 22,
  METAL: 23,
  GLASS: 24,
  FABRIC: 25,      // woven cloth (awnings, sacks, curtains)
  HAY: 26,
  CROP_LEAF: 27,
  NOISE: 28,
  CONCRETE: 29,
};

// ---------------------------------------------------------------- hash noise
function h2(a, b, s = 0) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) ^ 0x27d4eb2f, 0xc2b2ae35);
  h ^= (s * 0x9e3779b1) | 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2545f491); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
const fract = (v) => v - Math.floor(v);
// smooth value noise on a 2-D lattice: cheap, and C1-ish so the gradient is clean
function vnoise(x, y, s = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = h2(xi, yi, s), b = h2(xi + 1, yi, s), c = h2(xi, yi + 1, s), d = h2(xi + 1, yi + 1, s);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm(x, y, oct = 3, s = 0) {
  let sum = 0, amp = 1, norm = 0, fx = x, fy = y;
  for (let i = 0; i < oct; i++) {
    sum += vnoise(fx, fy, s + i * 17) * amp;
    norm += amp;
    amp *= 0.5; fx *= 2.03; fy *= 2.01;
  }
  return sum / norm;
}

// pattern phase: shifts the noise domain so one material can produce several
// tile variants (and animated water frames) without duplicating materials.
let PHASE = 0;
export function setPatternPhase(p) { PHASE = p | 0; }
export const getPatternPhase = () => PHASE;

// ---------------------------------------------------------------- patterns
/**
 * Multiplier applied to the base albedo. Deliberately returns values around 1.0
 * so materials keep their authored colour; anything below 1 reads as a groove,
 * crack or seam and therefore also drives the bump.
 */
export function patternMul(pid, x, y, z, n) {
  if (pid === 0) return 1;
  // Original world coordinates, captured before any phase shift. Large-scale
  // variation must be evaluated on THESE so that it flows continuously across
  // tile boundaries: a per-tile brightness difference reads as a quilt, a
  // world-space field reads as a meadow.
  const ox = x, oy = y;

  // domain shift for tile variants — only affects the noisy ground patterns,
  // masonry keeps its world-space registration so walls stay coherent
  if (PHASE && (pid === PAT.GRASS || pid === PAT.GRASS_TALL || pid === PAT.SOIL ||
    pid === PAT.TILLED || pid === PAT.SAND || pid === PAT.GRAVEL || pid === PAT.WATER ||
    pid === PAT.NOISE || pid === PAT.STONE || pid === PAT.STONE_PATH || pid === PAT.DECK)) {
    x += PHASE * 4.137; y -= PHASE * 2.719;
    if (pid !== PAT.WATER && pid !== PAT.STONE && pid !== PAT.STONE_PATH) z += PHASE * 1.371;
  }

  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const top = az >= ax && az >= ay;
  const u = ax >= ay ? y : x;
  const q1 = top ? x : u, q2 = top ? y : z;

  // broad, seamless field variation shared by every ground pattern: dry patches,
  // lush hollows, worn spots. Feature size is a few tiles, so it survives the
  // 32x16 tiling without ever lining up with it.
  const patch = (s1, s2, amt) => 1 + amt * (fbm(ox * s1, oy * s2, 2, 5) - 0.5) * 2;

  switch (pid) {
    // ---- wood -------------------------------------------------------------
    case PAT.PLANK: {           // vertical boards with a dark seam between them
      const w = 0.19;
      const p = Math.floor(u / w);
      const f = fract(u / w);
      const seam = f > 0.90 ? 0.74 : f < 0.06 ? 0.86 : 1;
      const grain = 0.965 + 0.06 * vnoise(q1 * 26, q2 * 3.2, 3);
      return seam * grain * (0.955 + 0.09 * h2(p, 0, 11));
    }
    case PAT.DECK: {            // horizontal decking, planks run along u
      const w = 0.165;
      const p = Math.floor(z / w);
      const f = fract(z / w);
      const seam = f > 0.88 ? 0.78 : 1;
      return seam * (0.94 + 0.11 * h2(p, 0, 23)) * (0.97 + 0.05 * vnoise(u * 5, z * 30, 5));
    }
    case PAT.LOG: {             // stacked round logs: strong vertical relief
      const w = 0.17;
      const f = fract(z / w);
      const round = Math.sin(f * Math.PI);            // 0 at the seam, 1 mid-log
      const shade = 0.80 + 0.26 * round;
      return shade * (0.95 + 0.10 * vnoise(u * 4.5, z * 22, 7));
    }
    case PAT.BARK: {
      const f = fract(u / 0.085);
      const groove = f > 0.78 ? 0.72 : 0.88 + 0.2 * f;
      return groove * (0.9 + 0.2 * vnoise(u * 30, z * 9, 9));
    }
    case PAT.SHINGLE: {         // wood shakes on a roof pitch
      const rh = 0.135, rw = 0.17;
      const row = Math.floor(q2 / rh);
      const off = (row & 1) * 0.5;
      const col = Math.floor(q1 / rw + off);
      const fz = fract(q2 / rh), fu = fract(q1 / rw + off);
      const edge = (fz > 0.86 || fu > 0.92) ? 0.76 : 1;
      return edge * (0.90 + 0.18 * h2(col, row, 9));
    }
    // ---- masonry ----------------------------------------------------------
    case PAT.BRICK: {
      const rh = 0.115, rw = 0.27;
      const row = Math.floor(z / rh);
      const off = (row & 1) * 0.5;
      const col = Math.floor(u / rw + off);
      const fz = fract(z / rh), fu = fract(u / rw + off);
      const joint = (fz > 0.84 || fu > 0.90) ? 0.74 : 1;
      return joint * (0.93 + 0.13 * h2(col, row, 5));
    }
    case PAT.STONE: {           // irregular fieldstone
      const g = 0.2;
      const ci = Math.floor(q1 / g), cj = Math.floor(q2 / g);
      const jx = h2(ci, cj, 41) * 0.5, jy = h2(ci, cj, 43) * 0.5;
      const fu = fract(q1 / g + jx), fv = fract(q2 / g + jy);
      const edge = (fu > 0.86 || fv > 0.86) ? 0.72 : 1;
      const dome = 1 + 0.12 * Math.sin(Math.min(1, fu) * Math.PI) * Math.sin(Math.min(1, fv) * Math.PI);
      return edge * dome * (0.90 + 0.18 * h2(ci, cj, 47));
    }
    case PAT.COBBLE: {
      const g = 0.145;
      const ci = Math.floor(q1 / g), cj = Math.floor(q2 / g);
      const jx = h2(ci, cj, 51) * 0.4, jy = h2(ci, cj, 53) * 0.4;
      const fu = fract(q1 / g + jx) - 0.5, fv = fract(q2 / g + jy) - 0.5;
      const d = Math.hypot(fu, fv) * 2;
      const edge = d > 0.82 ? 0.70 : 1;
      return edge * (1.06 - 0.24 * d) * (0.92 + 0.16 * h2(ci, cj, 57));
    }
    case PAT.SLATE: {
      const rh = 0.15, rw = 0.2;
      const row = Math.floor(q2 / rh), off = (row & 1) * 0.5;
      const col = Math.floor(q1 / rw + off);
      const fz = fract(q2 / rh), fu = fract(q1 / rw + off);
      const edge = (fz > 0.88 || fu > 0.94) ? 0.80 : 1;
      return edge * (0.95 + 0.10 * h2(col, row, 61));
    }
    case PAT.TILE_ROOF: {       // barrel tiles: ribs along the slope + row breaks
      const rib = 0.135, row = 0.21;
      const fr = fract(q1 / rib);
      const cap = 0.86 + 0.30 * Math.sin(fr * Math.PI);
      const fz = fract(q2 / row);
      const brk = fz > 0.90 ? 0.78 : 1;
      return cap * brk * (0.96 + 0.07 * h2(Math.floor(q1 / rib), Math.floor(q2 / row), 67));
    }
    case PAT.THATCH: {          // straw: horizontal streaks, stitched every so often
      const streak = 0.9 + 0.22 * vnoise(q1 * 7, q2 * 46, 71);
      const course = fract(q2 / 0.19);
      const lip = course > 0.87 ? 0.80 : 1 - 0.10 * course;
      const stitch = fract(q1 / 0.24) > 0.95 ? 0.88 : 1;
      return streak * lip * stitch;
    }
    case PAT.STUCCO: {
      return 0.975 + 0.05 * fbm(q1 * 22, q2 * 22, 2, 73);
    }
    case PAT.CONCRETE: {
      const pu = Math.floor(q1 / 0.33), pz = Math.floor(q2 / 0.5);
      const seam = (fract(q1 / 0.33) > 0.965 || fract(q2 / 0.5) > 0.978) ? 0.86 : 1;
      return seam * (0.965 + 0.05 * h2(pu, pz, 21) + 0.025 * vnoise(q1 * 24, q2 * 24, 4));
    }
    case PAT.METAL: {
      return 0.97 + 0.05 * vnoise(q1 * 14, q2 * 40, 79);
    }
    case PAT.FABRIC: {          // woven: warp + weft
      const wv = 0.045;
      const warp = fract(q1 / wv) > 0.5 ? 1.04 : 0.96;
      const weft = fract(q2 / wv) > 0.5 ? 1.04 : 0.96;
      return warp * weft * (0.97 + 0.05 * fbm(q1 * 18, q2 * 18, 2, 83));
    }
    case PAT.HAY: {
      return (0.9 + 0.24 * vnoise(q1 * 9, q2 * 52, 87)) * (fract(q2 / 0.16) > 0.9 ? 0.84 : 1);
    }
    // ---- ground -----------------------------------------------------------
    // Every ground pattern is multiplied by `patch()`: a broad, world-space
    // field (a few tiles across) that flows straight through tile boundaries.
    // That is what keeps a large meadow from turning into a patchwork quilt
    // when the same tile is stamped a thousand times.
    case PAT.GRASS: {
      const base = 0.93 + 0.15 * fbm(q1 * 11, q2 * 11, 3, 13);
      const blade = 0.97 + 0.09 * vnoise(q1 * 47, q2 * 47, 19);
      const tuft = h2(Math.floor(q1 * 9), Math.floor(q2 * 9), 23) > 0.90 ? 1.10 : 1;
      return base * blade * tuft * patch(1.30, 1.30, 0.085);
    }
    case PAT.GRASS_TALL: {
      const base = 0.90 + 0.17 * fbm(q1 * 8, q2 * 8, 3, 29);
      const blade = 0.94 + 0.14 * vnoise(q1 * 38, q2 * 38, 31);
      const tuft = h2(Math.floor(q1 * 6), Math.floor(q2 * 6), 37) > 0.78 ? 1.14 : 0.97;
      return base * blade * tuft * patch(1.30, 1.30, 0.095);
    }
    case PAT.SOIL: {
      const clod = 0.90 + 0.20 * fbm(q1 * 17, q2 * 17, 3, 41);
      const grit = 0.96 + 0.08 * vnoise(q1 * 62, q2 * 62, 43);
      const stone = h2(Math.floor(q1 * 13), Math.floor(q2 * 13), 47) > 0.93 ? 1.14 : 1;
      return clod * grit * stone * patch(1.6, 1.6, 0.07);
    }
    case PAT.TILLED: {          // ploughed furrows: rounded ridges, dark troughs
      const w = 0.22;
      const f = fract(q1 / w);
      const ridge = Math.sin(f * Math.PI);              // 0 trough, 1 crest
      const shade = 0.78 + 0.34 * ridge;
      const crumb = 0.95 + 0.10 * fbm(q1 * 40, q2 * 40, 2, 53);
      return shade * crumb * patch(1.7, 1.7, 0.05);
    }
    case PAT.SAND: {
      return (0.94 + 0.12 * fbm(q1 * 24, q2 * 24, 3, 59)) *
        (0.98 + 0.04 * Math.sin(q1 * 34 + vnoise(q1 * 6, q2 * 6, 61) * 5)) * patch(1.5, 1.5, 0.06);
    }
    case PAT.GRAVEL: {
      const g = 0.075;
      const ci = Math.floor(q1 / g), cj = Math.floor(q2 / g);
      const fu = fract(q1 / g) - 0.5, fv = fract(q2 / g) - 0.5;
      const d = Math.hypot(fu, fv) * 2;
      return (d > 0.75 ? 0.76 : 1.04 - 0.2 * d) * (0.88 + 0.26 * h2(ci, cj, 67));
    }
    case PAT.STONE_PATH: {      // flagstones with mortar gaps
      const g = 0.33;
      const ci = Math.floor(q1 / g), cj = Math.floor(q2 / g);
      const fu = fract(q1 / g), fv = fract(q2 / g);
      const gap = (fu > 0.90 || fv > 0.90 || fu < 0.06 || fv < 0.06) ? 0.72 : 1;
      const dome = 1 + 0.05 * Math.sin(fu * Math.PI) * Math.sin(fv * Math.PI);
      return gap * dome * (0.94 + 0.11 * h2(ci, cj, 71));
    }
    case PAT.WATER: {
      const rip = Math.sin(q1 * 22 + q2 * 14 + vnoise(q1 * 5, q2 * 5, 73) * 6.5);
      const rip2 = Math.sin(q1 * 9 - q2 * 26 + 1.7);
      return 1 + 0.085 * rip + 0.05 * rip2;
    }
    // ---- foliage ----------------------------------------------------------
    case PAT.LEAF: {
      const clump = 0.80 + 0.44 * fbm(q1 * 13, q2 * 13, 3, 79);
      const detail = 0.94 + 0.14 * vnoise(q1 * 55, q2 * 55, 83);
      return clump * detail;
    }
    case PAT.HEDGE: {
      const clump = 0.86 + 0.26 * fbm(q1 * 30, q2 * 30, 2, 89);
      return clump * (0.94 + 0.14 * vnoise(q1 * 70, q2 * 70, 91));
    }
    case PAT.CROP_LEAF: {
      const clump = 0.88 + 0.24 * fbm(q1 * 22, q2 * 22, 2, 97);
      const vein = 0.96 + 0.08 * Math.sin(q1 * 52);
      return clump * vein;
    }
    case PAT.NOISE: {
      return 0.94 + 0.12 * h2(Math.floor(q1 * 40), Math.floor(q2 * 40), 13) +
        0.06 * h2(Math.floor(q1 * 150), Math.floor(q2 * 150), 19);
    }
    case PAT.GLASS: {           // panes with a sky-reflection gradient
      const cw = 0.16, ch = 0.2;
      const cu = Math.floor(u / cw), cz = Math.floor(z / ch);
      const fu = fract(u / cw), fz = fract(z / ch);
      const frame = (fu < 0.14 || fz < 0.12) ? 0.68 : 1;
      const sky = 0.84 + 0.46 * (1 - Math.abs(n[2]));
      return frame * sky * (0.86 + 0.30 * h2(cu, cz, 31));
    }
    default:
      return 1;
  }
}

/**
 * Height signal used for the detail normal. Defaults to the albedo multiplier
 * (a dark seam is a groove), but patterns whose albedo noise is *colour* rather
 * than *relief* override it so we do not invent bumps that are not there.
 */
export function patternHeight(pid, x, y, z, n, mul) {
  switch (pid) {
    case PAT.GLASS: return 1;                  // flat glass: no relief
    case PAT.WATER: return 1;                  // ripples are colour, not shape
    case PAT.GRASS:
    case PAT.GRASS_TALL:
    case PAT.SAND:
    case PAT.NOISE: {
      // for these the albedo noise IS the shape (tufts, clods, grit), but the
      // low-frequency component dominates; keep only the fine detail
      const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
      const top = az >= ax && az >= ay;
      const u = ax >= ay ? y : x;
      const q1 = top ? x : u, q2 = top ? y : z;
      return 1 + 0.55 * (vnoise(q1 * 47, q2 * 47, 19) - 0.5);
    }
    case PAT.LEAF:
    case PAT.HEDGE:
    case PAT.CROP_LEAF: {
      const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
      const top = az >= ax && az >= ay;
      const u = ax >= ay ? y : x;
      const q1 = top ? x : u, q2 = top ? y : z;
      return 0.72 + 0.56 * fbm(q1 * 13, q2 * 13, 3, 79);
    }
    case PAT.CONCRETE:
    case PAT.STUCCO:
    case PAT.METAL:
      return 1 + 0.5 * (mul - 1);
    default:
      return mul;
  }
}
