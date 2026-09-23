// Procedural farm-hand character for the offline pre-renderer.
//
// Everything below is authored in "body space" and converted to tile space only
// when geometry is emitted:
//
//      F = forward   the direction the character faces
//      R = the character's right
//      U = up        (identical to world z)
//
//      tile.x = 0.5 + (F + R) * SQRT1_2
//      tile.y = 0.5 + (F - R) * SQRT1_2
//      tile.z = U
//
// so the model keeps the documented 1x1 footprint, the (0.5, 0.5, 0) anchor and
// the "front faces +x+y" convention of the renderer.
//
// DIRECTION BAKING
//   `o.dir` is baked into the mesh: every vertex *and* every normal is yawed
//   about the anchor by dir * 90 degrees, which is byte-for-byte the transform
//   render.mjs's rotMesh() applies for `rotation: dir`. Bake the atlas with
//   `renderSprite(mesh, { rotation: 0, anchor: [0.5, 0.5, 0] })` and use `dir`
//   as the atlas rotation slot. (Do *not* also pass rotation: dir — that would
//   rotate twice.) Handedness matches the renderer exactly, so a 4-way bake is
//   consistent with every other model in the kit.
//
// SCALE
//   1 world unit = 16 px across, ZPX = 22 px per z-unit, so the ~1.20 z-unit
//   figure reads ~26 px tall and ~8-9 px wide at the shoulders: chunky pixel
//   proportions, head about 1/3.5 of the total height.
//
// DETERMINISM
//   Pure maths only — no Math.random(), no b.rng() — so the same
//   (action, frame, outfit, dir) always produces an identical mesh, and every
//   pose is a continuous function of the cycle phase (frame / frames * 2*PI).

import { M } from '../lib/materials.mjs';

const INV2 = Math.SQRT1_2;
const TAU = Math.PI * 2;
const ZERO = [0, 0, 0];
const EMPTY = {};

// ---------------------------------------------------------------------------
// 3x3 rotation helpers (row major, orthonormal, applied as M * v)
// ---------------------------------------------------------------------------
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function mul3(a, b) {
  const o = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return o;
}
function rotv(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}
/** yaw about U: + turns the body toward its own right */
const yawM = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; };
/** positive pitch tips the +U axis toward +F ("nose down" for the body) */
const pitchM = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
/** positive roll tips the +U axis toward -R (a lean to the character's left) */
const rollM = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, s, 0, -s, c]; };

const clamp0 = (v) => (v > 0 ? v : 0);

// ---------------------------------------------------------------------------
// skeleton
//
// Joints whose local -U is the limb axis are flagged `down`; for those the pose
// values are given in the intuitive sense:
//      p > 0  the far end of the limb swings FORWARD (+F)
//      r > 0  the far end of the limb swings toward the character's RIGHT (+R)
// For body joints (+U) p > 0 leans the top forward and r > 0 leans it left.
// Either way the *world* forward-swing of a chain is just the sum of its p's.
// ---------------------------------------------------------------------------
const HIP_Z = 0.42;        // pelvis joint height
const WAIST = 0.07;        // hips  -> torso pivot (z 0.49)
const NECK_UP = 0.33;      // torso -> neck joint  (z 0.82)
const HEAD_UP = 0.04;      // neck  -> head joint  (z 0.86)
const SHO_R = 0.138;       // shoulder offset from the torso pivot
const SHO_UP = 0.27;       //   (z 0.76)
const UARM = 0.125;        // shoulder -> elbow
const FARM = 0.125;        // elbow -> wrist
const THIGH = 0.185;       // hip joint (z 0.40) -> knee
const SHIN = 0.175;        // knee -> ankle (z 0.04)
const LEG = THIGH + SHIN;
const HIP_R = 0.055;       // half distance between the legs

const RIG = [
  ['root', null, ZERO, false],
  ['hips', 'root', [0, 0, HIP_Z], false],
  ['torso', 'hips', [0, 0, WAIST], false],
  ['neck', 'torso', [0, 0, NECK_UP], false],
  ['head', 'neck', [0, 0, HEAD_UP], false],
  ['armR', 'torso', [0, SHO_R, SHO_UP], true],
  ['foreR', 'armR', [0, 0, -UARM], true],
  ['handR', 'foreR', [0, 0, -FARM], true],
  ['toolR', 'handR', [0, 0, -0.035], true],   // hoe / watering-can grip
  ['armL', 'torso', [0, -SHO_R, SHO_UP], true],
  ['foreL', 'armL', [0, 0, -UARM], true],
  ['handL', 'foreL', [0, 0, -FARM], true],
  ['toolL', 'handL', [0, 0, -0.035], true],   // basket grip
  ['thighR', 'hips', [0, HIP_R, -0.02], true],
  ['shinR', 'thighR', [0, 0, -THIGH], true],
  ['footR', 'shinR', [0, 0, -SHIN], true],
  ['thighL', 'hips', [0, -HIP_R, -0.02], true],
  ['shinL', 'thighL', [0, 0, -THIGH], true],
  ['footL', 'shinL', [0, 0, -SHIN], true],
];

/** Walk the hierarchy once and return { name: { p:[F,R,U], M:3x3 } }. */
function solve(pose) {
  const out = Object.create(null);
  for (let i = 0; i < RIG.length; i++) {
    const name = RIG[i][0], parent = RIG[i][1], at = RIG[i][2], down = RIG[i][3];
    const par = parent ? out[parent] : null;
    const pM = par ? par.M : I3;
    const pP = par ? par.p : ZERO;
    const a = pose[name] || EMPTY;
    const sg = down ? -1 : 1;
    const L = mul3(yawM(a.y || 0), mul3(rollM(sg * (a.r || 0)), pitchM(sg * (a.p || 0))));
    const t = a.t || ZERO;
    const lx = at[0] + t[0], ly = at[1] + t[1], lz = at[2] + t[2];
    out[name] = {
      p: [
        pP[0] + pM[0] * lx + pM[1] * ly + pM[2] * lz,
        pP[1] + pM[3] * lx + pM[4] * ly + pM[5] * lz,
        pP[2] + pM[6] * lx + pM[7] * ly + pM[8] * lz,
      ],
      M: mul3(pM, L),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// geometry emission: an oriented box in a joint's frame, converted to tile
// space and (optionally) yawed into the requested view direction.
// ---------------------------------------------------------------------------
const YAW = [[1, 0], [0, 1], [-1, 0], [0, -1]];   // cos, sin of dir * 90deg

function toTile(v, d) {
  const x = (v[0] + v[1]) * INV2, y = (v[0] - v[1]) * INV2;
  const c = YAW[d][0], s = YAW[d][1];
  return [0.5 + x * c - y * s, 0.5 + x * s + y * c, v[2]];
}
function toTileN(n, d) {
  const c = YAW[d][0], s = YAW[d][1];
  return [n[0] * c - n[1] * s, n[0] * s + n[1] * c, n[2]];
}

// corner index bits: 1 = F high, 2 = R high, 4 = U high
const BOX_FACES = [
  [[1, 0, 0], [1, 3, 7, 5]],
  [[-1, 0, 0], [0, 4, 6, 2]],
  [[0, 1, 0], [2, 6, 7, 3]],
  [[0, -1, 0], [0, 1, 5, 4]],
  [[0, 0, 1], [4, 5, 7, 6]],
  [[0, 0, -1], [0, 2, 3, 1]],
];

/** Emit one oriented box. `lo`/`hi` are [F,R,U] in the joint's local frame. */
function part(b, T, lo, hi, mat, dir, o) {
  const m = T.M, p = T.p;
  const gid = b.m.newGid();
  const P = new Array(8);
  let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
  for (let i = 0; i < 8; i++) {
    const f = (i & 1) ? hi[0] : lo[0];
    const r = (i & 2) ? hi[1] : lo[1];
    const u = (i & 4) ? hi[2] : lo[2];
    const w = [
      p[0] + m[0] * f + m[1] * r + m[2] * u,
      p[1] + m[3] * f + m[4] * r + m[5] * u,
      p[2] + m[6] * f + m[7] * r + m[8] * u,
    ];
    const q = toTile(w, dir);
    P[i] = q;
    if (q[0] < x0) x0 = q[0];
    if (q[1] < y0) y0 = q[1];
    if (q[2] < z0) z0 = q[2];
    if (q[0] > x1) x1 = q[0];
    if (q[1] > y1) y1 = q[1];
    if (q[2] > z1) z1 = q[2];
  }
  const det = o && o.detail ? 1 : 0;
  for (let i = 0; i < 6; i++) {
    const idx = BOX_FACES[i][1];
    const wn = toTileN(rotv(m, BOX_FACES[i][0]), dir);
    b.m.quad(P[idx[0]], P[idx[1]], P[idx[2]], P[idx[3]], mat, wn, { gid, detail: det });
  }
  // one occluder per box drives the offline AO bake (and the runtime shadow map)
  if (!o || o.occ !== false) {
    b.m.occluders.push({
      mn: [x0 - 0.008, y0 - 0.008, z0 - 0.008],
      mx: [x1 + 0.008, y1 + 0.008, z1 + 0.008],
    });
  }
}

/** mirror a [lo,hi] pair onto the character's left when s < 0 (R is index 1) */
function side(lo, hi, s) {
  return s > 0 ? [lo, hi] : [[lo[0], -hi[1], lo[2]], [hi[0], -lo[1], hi[2]]];
}

// ---------------------------------------------------------------------------
// analytic two-bone arm IK
//
// Used so the second hand always lands on the tool handle no matter where the
// swing takes it. Everything is solved in the torso's frame, so the arm keeps
// following the body. `hint` is where the elbow should point; the hinge axis is
// the axis perpendicular to both the shoulder->target line and that hint, which
// keeps the solution in a single bend plane (exactly what a hinge elbow does).
// The shoulder yaw is the third degree of freedom that lets the upper arm point
// anywhere while its local R axis still lines up with the chosen hinge.
// ---------------------------------------------------------------------------
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function armIK(rig, armName, target, hint) {
  const S = rig[armName].p;
  const Mt = rig.torso.M;                                    // torso frame -> body
  const dx = target[0] - S[0], dy = target[1] - S[1], dz = target[2] - S[2];
  // body -> torso-local (Mt is orthonormal, so the transpose is the inverse)
  const L = [
    Mt[0] * dx + Mt[3] * dy + Mt[6] * dz,
    Mt[1] * dx + Mt[4] * dy + Mt[7] * dz,
    Mt[2] * dx + Mt[5] * dy + Mt[8] * dz,
  ];
  const L1 = UARM, L2 = FARM;
  const reach = (L1 + L2) * 0.998;
  let d = Math.hypot(L[0], L[1], L[2]);
  if (d < 1e-5) return null;
  if (d > reach) { const k = reach / d; L[0] *= k; L[1] *= k; L[2] *= k; d = reach; }
  const e1 = [L[0] / d, L[1] / d, L[2] / d];
  let h = cross3(hint, e1);                                  // hinge axis
  let hl = Math.hypot(h[0], h[1], h[2]);
  if (hl < 1e-5) { h = cross3([0, 0, -1], e1); hl = Math.hypot(h[0], h[1], h[2]) || 1; }
  h = [h[0] / hl, h[1] / hl, h[2] / hl];
  const e2 = cross3(h, e1);
  const ca = clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
  const al = Math.acos(ca);
  const s = dot3(e2, hint) >= 0 ? 1 : -1;
  const sa = Math.sin(al) * s;
  const u1 = [e1[0] * ca + e2[0] * sa, e1[1] * ca + e2[1] * sa, e1[2] * ca + e2[2] * sa];
  const u2 = [(L[0] - L1 * u1[0]) / L2, (L[1] - L1 * u1[1]) / L2, (L[2] - L1 * u1[2]) / L2];
  // hinge axis -> (roll, yaw); then pitch of the upper arm and of the forearm
  const r = Math.asin(clamp(h[2], -1, 1));
  const y = Math.atan2(-h[0], h[1]);
  const inv = (u) => {
    const a = yawM(-y), b = rollM(r);
    const v = rotv(a, u);
    return rotv(b, v);
  };
  const v1 = inv(u1), v2 = inv(u2);
  return {
    arm: { p: Math.atan2(v1[0], -v1[2]), r, y },
    fore: { p: Math.atan2(v2[0], -v2[2]) },
  };
}

/**
 * Nearest point on the tool handle that the named hand can actually reach.
 * `abs` is the tool's authored world forward-swing, so the handle's axis in
 * body space is ax = (-sin a, 0, cos a) and a point at local U = t sits at
 * `origin + ax * t`. Clamping t to the shaft's real extent keeps the grip on
 * the wood; the IK then clamps the reach if the point is still too far.
 */
function handleGrip(rig, armName, abs, uMin, uMax) {
  const o = rig.toolR.p;
  const ax = [-Math.sin(abs), 0, Math.cos(abs)];
  const S = rig[armName].p;
  const t = clamp((S[0] - o[0]) * ax[0] + (S[1] - o[1]) * ax[1] + (S[2] - o[2]) * ax[2], uMin, uMax);
  return [o[0] + ax[0] * t, o[1] + ax[1] * t, o[2] + ax[2] * t];
}

/**
 * Plant the hips so the lower sole sits exactly on z = 0. The ankle sits at
 * `hip - (THIGH*cos(a1) + SHIN*cos(a2))`, so the highest ankle (the support
 * leg) decides the hip height; a bent knee therefore raises the hips instead of
 * sinking the foot through the floor. Pure yaw on the hips is fine (it does not
 * change any height), pitch/roll on the hips is not.
 */
function plantFeet(P) {
  const ankle = (th, kn) => THIGH * Math.cos(th) + SHIN * Math.cos(th + kn);
  const h = Math.max(ankle(P.thighR.p, P.shinR.p), ankle(P.thighL.p, P.shinL.p));
  const t = P.root ? P.root.t : ZERO;
  P.root = { t: [t[0], t[1], h - LEG] };
  return h - LEG;
}

/** symmetric squat, used by every pose that keeps both feet on the ground */
function standLegs(P, c) {
  const t = 0.62 * c;
  const knee = -2 * t;
  const foot = -(t + knee);
  P.thighR = { p: t };
  P.shinR = { p: knee };
  P.footR = { p: foot };
  P.thighL = { p: t };
  P.shinL = { p: knee };
  P.footL = { p: foot };
  P.root = { t: ZERO };
  return { t, knee, drop: plantFeet(P) };
}

// ---------------------------------------------------------------------------
// poses — all parametric in the cycle phase ph (0 .. 2*PI), all continuous
// ---------------------------------------------------------------------------
const POSES = {
  /** quiet breathing, weight drifting from foot to foot */
  idle(ph) {
    const s = Math.sin(ph);
    const br = 0.5 - 0.5 * Math.cos(ph);          // 0 -> 1 -> 0
    const P = {};
    standLegs(P, 0.11 + 0.03 * br);               // soles stay at z = 0 exactly
    P.hips = { y: 0.03 * s };                     // (no hip roll: it would lift a sole)
    P.torso = { p: 0.04 + 0.03 * br, r: -0.025 * s, y: -0.025 * s };
    P.neck = { p: -0.02 };
    P.head = { p: -0.04 - 0.025 * br, r: 0.02 * s, y: 0.05 * s };
    P.armR = { p: 0.06 + 0.035 * br, r: 0.13 + 0.02 * s };
    P.foreR = { p: 0.16 + 0.03 * br };
    P.armL = { p: 0.06 + 0.035 * br, r: -0.13 + 0.02 * s };
    P.foreL = { p: 0.16 + 0.03 * br };
    return P;
  },

  /** alternating stride, counter-swinging arms, hip/shoulder counter-rotation */
  walk(ph) {
    const S = Math.sin(ph);
    const sw = 0.40;                               // stride amplitude (rad)
    const kneeAmp = 1.00;
    const P = {};
    const bs = standLegs(P, 0.10);
    const lift = (a) => kneeAmp * clamp0(Math.cos(a + 0.6));   // knee peak just after toe-off
    // thighs alternate; the body height then falls out of plantFeet(), which is
    // what produces the bob: lowest at the double support, ~0.03 in total
    const thR = sw * S, thL = -sw * S;
    const knR = bs.knee - lift(ph), knL = bs.knee - lift(ph + Math.PI);
    P.thighR = { p: bs.t + thR };
    P.shinR = { p: knR };
    P.footR = { p: -(P.thighR.p + knR) };
    P.thighL = { p: bs.t + thL };
    P.shinL = { p: knL };
    P.footL = { p: -(P.thighL.p + knL) };
    plantFeet(P);
    P.root.t[1] = 0.008 * S;                       // slight lateral sway
    P.hips = { y: 0.10 * S };                      // hips may only yaw (see plantFeet)
    P.torso = { p: 0.11 + 0.02 * Math.cos(2 * ph), y: -0.11 * S, r: -0.05 * S };
    P.neck = { p: -0.03 };
    P.head = { p: -0.10, y: 0.06 * S, r: 0.02 * S };
    const aR = -0.55 * S, aL = 0.55 * S;
    P.armR = { p: 0.05 + aR, r: 0.15 };
    P.foreR = { p: 0.40 + 0.22 * clamp0(-S) };
    P.armL = { p: 0.05 + aL, r: -0.15 };
    P.foreL = { p: 0.40 + 0.22 * clamp0(S) };
    return P;
  },

  /** wind the hoe up over the shoulder, then drive it down in front */
  hoe(ph) {
    // phase warp: dwell at the top of the swing, whip through the strike
    const u = -Math.cos(ph - 0.5 * Math.sin(ph));  // -1 wound up .. +1 struck
    const e = 0.5 + 0.5 * u;                       // 0 .. 1
    const P = {};
    standLegs(P, 0.30 + 0.62 * e);
    P.root.t[0] = 0.02 * e;                        // weight follows the swing
    P.torso = { p: 0.03 + 0.60 * e, y: -0.10 };
    P.neck = { p: 0.05 };
    P.head = { p: -0.10 - 0.30 * e, y: 0.06 };
    // right hand carries the tool: up over the shoulder, then down in front
    P.armR = { p: -0.90 + 0.62 * e, r: -0.22 - 0.34 * e };
    P.foreR = { p: 1.45 - 1.15 * e };
    // the tool's aim is authored in world terms (absolute, not inherited from
    // the wrist). The angle runs NEGATIVE so the blade travels the long way
    // round: up behind the shoulder, over the head, then down in front.
    //   -2.80 = blade up behind   -4.71 = blade forward level   -5.84 = in the soil
    P.toolR = { abs: -2.80 - 3.04 * e };
    return P;
  },

  /** tip a watering can forward, free arm out for balance */
  water(ph) {
    const e = 0.5 - 0.5 * Math.cos(ph);            // 0 level .. 1 pouring
    const P = {};
    standLegs(P, 0.16 + 0.12 * e);
    P.root.t[0] = 0.015 * e;
    P.torso = { p: 0.10 + 0.26 * e, y: -0.07 };
    P.neck = { p: 0.02 };
    P.head = { p: -0.06 - 0.30 * e, y: -0.05 };
    P.armR = { p: 0.55 + 0.35 * e, r: -0.12 };
    P.foreR = { p: 0.30 + 0.25 * e };
    P.toolR = { p: -0.32 + 1.40 * e };             // the can rolls over the spout
    P.armL = { p: -0.10 - 0.22 * e, r: -0.50 - 0.20 * e };
    P.foreL = { p: 0.22 + 0.10 * e };
    return P;
  },

  /** crouch down to pick something up, then rise again */
  harvest(ph) {
    const e = 0.5 - 0.5 * Math.cos(ph);            // 0 up .. 1 down in the crop
    const P = {};
    standLegs(P, 0.25 + 1.05 * e);
    P.root.t[0] = 0.03 * e;
    P.torso = { p: 0.08 + 0.62 * e, y: 0.10 };
    P.neck = { p: 0.06 };
    P.head = { p: -0.10 - 0.34 * e, y: -0.10 };
    P.armR = { p: 0.10 + 0.28 * e, r: -0.20 - 0.10 * e };   // reaching hand
    P.foreR = { p: 0.25 + 0.12 * e };
    P.armL = { p: 0.35 + 0.10 * e, r: -0.30 };     // basket hand stays at the hip
    P.foreL = { p: 0.95 };
    P.toolL = { p: 0.25 };
    return P;
  },
};

// ---------------------------------------------------------------------------
// hoe grip: two-pass solve. The tool's aim is absolute (P.toolR.abs), so the
// blade's arc is authored rather than inherited from the wrist, and the left
// hand is then solved onto the shaft with the IK above — which is what keeps
// both hands on the handle through the whole swing.
// ---------------------------------------------------------------------------
const ARM_L_HINT = [-0.35, -0.80, -0.45];          // left elbow: back, out, down

function holdHoe(pose, rig) {
  const aim = (r) => { r.toolR = { p: r.toolR.p, M: pitchM(-pose.toolR.abs) }; return r; };
  aim(rig);
  const T = handleGrip(rig, 'armL', pose.toolR.abs, -0.400, 0.085);
  const ik = armIK(rig, 'armL', T, ARM_L_HINT);
  if (ik) { pose.armL = ik.arm; pose.foreL = ik.fore; }
  return aim(solve(pose));                       // second pass, aim re-applied
}

// ---------------------------------------------------------------------------
// body
// ---------------------------------------------------------------------------
function buildBody(b, R, dir, outfit, action) {
  // materials come from the shared table; M() throws loudly on a typo
  const SKIN = M('skin');
  const HAIR = M(outfit.hair);
  const SHIRT = M(outfit.shirt);
  const PANTS = M(outfit.pants);
  const BOOT = M('boots');
  const EYE = M('hairBlack');
  const HAS_HAT = !!outfit.hat;
  const HAS_APRON = !!outfit.apron;
  const HAT = HAS_HAT ? M(outfit.hat) : -1;
  const APRON = HAS_APRON ? M(outfit.apron) : -1;
  const WOOD = M('woodPlank');
  const METAL = M('metal');
  const IRON = M('ironBlack');
  const STRAW = M('hatStraw');

  const P = (T, lo, hi, m, o) => part(b, T, lo, hi, m, dir, o);

  // ---- torso --------------------------------------------------------------
  P(R.hips, [-0.088, -0.100, -0.045], [0.092, 0.100, 0.080], PANTS);
  P(R.torso, [-0.082, -0.098, -0.030], [0.092, 0.098, 0.125], SHIRT);
  P(R.torso, [-0.090, -0.112, 0.115], [0.098, 0.112, 0.300], SHIRT);
  P(R.torso, [-0.080, 0.070, 0.250], [0.085, 0.150, 0.312], SHIRT);       // shoulder R
  P(R.torso, [-0.080, -0.150, 0.250], [0.085, -0.070, 0.312], SHIRT);     // shoulder L
  if (HAS_APRON) {                                                       // bib + skirt
    P(R.torso, [0.096, -0.054, 0.040], [0.110, 0.054, 0.190], APRON);
    P(R.torso, [0.094, -0.086, -0.145], [0.108, 0.086, 0.052], APRON);
  }

  // ---- legs ---------------------------------------------------------------
  for (const s of [1, -1]) {
    const th = s > 0 ? R.thighR : R.thighL;
    const sh = s > 0 ? R.shinR : R.shinL;
    const ft = s > 0 ? R.footR : R.footL;
    const [tlo, thi] = side([-0.052, -0.055, -0.190], [0.058, 0.055, 0.030], s);
    P(th, tlo, thi, PANTS);
    const [slo, shi] = side([-0.046, -0.048, -0.178], [0.050, 0.048, 0.020], s);
    P(sh, slo, shi, PANTS);
    const [flo, fhi] = side([-0.050, -0.052, -0.040], [0.080, 0.052, 0.028], s);
    P(ft, flo, fhi, BOOT);
  }

  // ---- head ---------------------------------------------------------------
  P(R.neck, [-0.044, -0.046, -0.055], [0.042, 0.046, 0.030], SKIN);
  P(R.head, [-0.118, -0.132, -0.030], [0.118, 0.132, 0.300], SKIN, { detail: 1 });
  for (const s of [1, -1]) {                                              // eyes
    const [elo, ehi] = side([0.104, 0.020, 0.092], [0.130, 0.082, 0.152], s);
    P(R.head, elo, ehi, EYE, { occ: false });
  }
  // hair: back mass + sideburns always, fringe and crown unless a hat covers it
  P(R.head, [-0.132, -0.136, 0.010], [-0.084, 0.136, 0.285], HAIR);
  for (const s of [1, -1]) {
    const [hlo, hhi] = side([-0.125, 0.126, 0.030], [0.100, 0.140, 0.240], s);
    P(R.head, hlo, hhi, HAIR);
  }
  if (HAS_HAT) {
    P(R.head, [0.100, -0.130, 0.166], [0.136, 0.130, 0.238], HAIR);       // fringe
    P(R.head, [-0.158, -0.166, 0.232], [0.158, 0.166, 0.264], HAT);       // brim
    P(R.head, [-0.086, -0.090, 0.258], [0.086, 0.090, 0.350], HAT);       // crown
    P(R.head, [-0.068, -0.072, 0.342], [0.068, 0.072, 0.386], HAT);       // crown top
  } else {
    P(R.head, [0.100, -0.130, 0.166], [0.136, 0.130, 0.272], HAIR);       // fringe
    P(R.head, [-0.128, -0.136, 0.242], [0.128, 0.136, 0.334], HAIR);      // crown
  }

  // ---- arms ---------------------------------------------------------------
  for (const s of [1, -1]) {
    const ua = s > 0 ? R.armR : R.armL;
    const fa = s > 0 ? R.foreR : R.foreL;
    const hd = s > 0 ? R.handR : R.handL;
    const [ulo, uhi] = side([-0.048, -0.048, -0.090], [0.048, 0.048, 0.012], s);
    P(ua, ulo, uhi, SHIRT);                                               // rolled sleeve
    const [blo, bhi] = side([-0.038, -0.038, -0.122], [0.040, 0.038, -0.078], s);
    P(ua, blo, bhi, SKIN, { detail: 1 });                                 // bare upper arm
    const [flo, fhi] = side([-0.036, -0.038, -0.120], [0.040, 0.038, 0.010], s);
    P(fa, flo, fhi, SKIN, { detail: 1 });
    const [hlo, hhi] = side([-0.044, -0.046, -0.062], [0.048, 0.046, 0.010], s);
    P(hd, hlo, hhi, SKIN, { detail: 1 });
  }

  // ---- tools --------------------------------------------------------------
  if (action === 'hoe') {
    const T = R.toolR;                                                    // local U = up the shaft
    P(T, [-0.028, -0.028, -0.440], [0.028, 0.028, 0.100], WOOD);          // shaft
    P(T, [-0.026, -0.032, -0.512], [0.026, 0.104, -0.432], METAL);        // blade
    P(T, [-0.032, -0.034, -0.448], [0.032, 0.034, -0.404], IRON);         // ferrule
  } else if (action === 'water') {
    const T = R.toolR;
    P(T, [-0.058, -0.056, -0.162], [0.058, 0.056, -0.014], METAL);        // can body
    P(T, [-0.062, -0.060, -0.104], [0.062, 0.060, -0.088], IRON);         // band
    P(T, [-0.020, -0.078, -0.020], [0.020, 0.078, 0.008], IRON);          // top handle
    P(T, [0.052, -0.016, -0.130], [0.190, 0.016, -0.080], METAL);         // spout
  } else if (action === 'harvest') {
    const T = R.toolL;
    P(T, [-0.070, -0.072, -0.098], [0.070, 0.072, 0.000], STRAW);         // basket
    P(T, [-0.078, -0.080, -0.020], [0.078, 0.080, 0.010], STRAW);         // rim
  }
}

// ---------------------------------------------------------------------------
// public contract
// ---------------------------------------------------------------------------
export const CHAR = {
  dirs: 4,
  actions: {
    idle:    { frames: 4, fps: 5  },
    walk:    { frames: 8, fps: 10 },
    hoe:     { frames: 6, fps: 8  },
    water:   { frames: 6, fps: 8  },
    harvest: { frames: 5, fps: 8  },
  },
  // `hat` / `apron` are material names or null; `apron` is an optional extra
  // field (the five documented keys are always present).
  palette: [
    { name: 'farmhand',  shirt: 'shirtRed',   pants: 'pantsBlue',  hair: 'hairBrown',  hat: 'hatStraw', apron: 'apron' },
    { name: 'gardener',  shirt: 'shirtCream', pants: 'pantsBrown', hair: 'hairBlond',  hat: null,       apron: 'apron' },
    { name: 'rancher',   shirt: 'shirtBlue',  pants: 'pantsDark',  hair: 'hairBlack',  hat: null,       apron: null },
    { name: 'herbalist', shirt: 'shirtGreen', pants: 'pantsBrown', hair: 'hairAuburn', hat: 'hatStraw', apron: null },
  ],
};

/**
 * Populate `b` with the character in the requested pose.
 * @param {Builder} b  a Builder(1, 1, seed) — model in [0,1]x[0,1], anchor (0.5,0.5,0)
 * @param {object} o   { action:'walk', frame:0..frames-1, outfit:0..palette.length-1, dir:0..3 }
 * @returns {Mesh} the mesh that was filled in (same object as `b.m`)
 */
export function buildCharacter(b, o = {}) {
  const actName = CHAR.actions[o.action] ? o.action : 'idle';
  const spec = CHAR.actions[actName];
  const n = spec.frames;
  const frame = (((o.frame | 0) % n) + n) % n;          // frame === n loops to 0 exactly
  const outfit = CHAR.palette[(((o.outfit | 0) % CHAR.palette.length) + CHAR.palette.length) % CHAR.palette.length];
  const dir = (((o.dir | 0) % CHAR.dirs) + CHAR.dirs) % CHAR.dirs;
  const phase = (frame / n) * TAU;
  const pose = POSES[actName](phase);
  let rig = solve(pose);
  if (actName === 'hoe') rig = holdHoe(pose, rig);
  buildBody(b, rig, dir, outfit, actName);
  return b.m;
}
