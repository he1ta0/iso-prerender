// GLSL ES 3.00 shaders for the runtime.
//
// Pipeline
//   (0) FOCUS    a handful of world-space boxes (what you are looking at) into a
//                half-resolution depth image — the reference the cutaway tests
//                a sprite against
//   (1) SPRITE   instanced quads -> 3 MRT G-buffer targets, WITH A REAL DEPTH
//                BUFFER written from the geometry itself
//   (2) LIGHT    full-screen; reconstructs world position from the isometric
//                projection + stored surface height, then shades
//   (3) POST     tonemap / grade / vignette / optional dither
//
// G-buffer layout (RGBA8 x3 = 12 bytes/px)
//   RT0  rgb = albedo (display space; squared to linear in the light pass)
//        a   = coverage * cut-away alpha
//   RT1  rgb = world shading normal, encoded *0.5+0.5
//        a   = surface flags (bit0 water, bit1 foliage, bit2 emissive-bearing)
//   RT2  r   = ambient occlusion
//        g   = specular strength
//        b   = emissive strength
//        a   = surface height, normalised into the sprite's [z0,z1] range
//
// The world position is *not* stored: because the projection is orthographic
// and isometric, (screen, height) determines (x, y) exactly. That saves a whole
// render target and is more precise than an 8-bit world XY would have been.
//
// ---- depth, and why it is computed rather than stored ------------------------
// Sprites used to be ordered on the CPU by a painter's key and blended in that
// order. That is a total order imposed on a partial one: it cannot be right for
// two pieces that overlap on screen and interleave in depth, and every layout
// change was a chance to get it wrong again.
//
// The fix is not to store a depth map in the atlas — it is to notice that the
// depth map is already implied by data we ship. `nrm.a` holds, per texel, the
// world height of the surface that texel depicts, and the projection is
// orthographic and invertible, so (screen pixel, height) recovers the world
// point exactly. Depth along the view axis is then a closed form:
//
//     dep = (x + y) + (2*HH/ZPX) * z
//
// and `x + y` drops straight out of the projection without solving for x and y
// separately. So SPRITE_FS writes gl_FragDepth, and the hardware resolves
// occlusion per pixel, against the real geometry, for every sprite in the game.
// The CPU sort survives only as a cheap back-to-front ordering for the blended
// cut-away layer; it is no longer what decides who covers whom.

export const SPRITE_VS = `#version 300 es
precision highp float;

layout(location=0) in vec2 a_corner;    // unit quad 0..1
layout(location=1) in vec2 i_org;       // sprite top-left, iso pixels, y-down, world origin
layout(location=2) in vec2 i_size;      // sprite size in pixels
layout(location=3) in vec2 i_uv;        // atlas uv of the sprite's top-left
layout(location=4) in vec2 i_uvSize;    // atlas uv size
layout(location=5) in vec2 i_z;         // world height range [z0, z1]
layout(location=6) in vec2 i_extra;     // x: flags, y: alpha (1 = opaque)
layout(location=7) in float i_bias;     // depth nudge for this placement, in depth units

uniform vec2 u_res;                     // internal resolution in pixels
uniform vec2 u_cam;                     // camera translation in iso pixels
uniform vec3 u_iso;                     // HW, HH, ZPX

out vec2  v_uv;
out vec2  v_z;
out vec2  v_extra;
out float v_bias;

void main() {
  vec2 P = i_org + a_corner * i_size;   // iso space, y down, relative to world origin
  vec2 p = P + u_cam;
  // flip y: iso space grows downward, GL clip space grows upward
  vec2 gl = vec2(p.x, u_res.y - p.y);
  gl_Position = vec4((gl / u_res) * 2.0 - 1.0, 0.0, 1.0);
  v_uv = i_uv + a_corner * i_uvSize;
  v_z = i_z;
  v_extra = i_extra;
  v_bias = i_bias;
}`;

export const SPRITE_FS = `#version 300 es
precision highp float;

in vec2  v_uv;
in vec2  v_z;
in vec2  v_extra;            // x = flags, y = alpha (1 = opaque, < 1 = ghost)
in float v_bias;

uniform sampler2D u_albedo;
uniform sampler2D u_nrm;
uniform sampler2D u_mat;
uniform sampler2D u_focus;   // RG = 16-bit depth of the nearest focus surface
uniform float u_zScale;      // global world-height normalisation (see LIGHT_FS)
uniform float u_depthK;      // 2*HH/ZPX — world z -> depth units
uniform float u_depthRange;  // depth units covered by the 0..1 depth range
uniform float u_depthOrigin; // depth units added before encoding (see FOCUS_FS)
uniform vec2  u_res;
uniform vec2  u_cam;         // camera translation in iso pixels
uniform vec3  u_iso;         // HW, HH, ZPX
uniform int   u_layer;       // 0 = opaque world, 1 = cut-away layer
uniform int   u_focusOn;     // 1 = a focus image was published this frame

layout(location=0) out vec4 o_albedo;
layout(location=1) out vec4 o_normal;
layout(location=2) out vec4 o_mat;

// ---- the cut-away, and why it is an alpha and not a discard -----------------
// A wall that stands between the camera and the thing you are looking at has to
// get out of the way — that part never changes. What changed is HOW.
//
// Screen-door stipple was the first attempt and it is the wrong tool: at 640x360
// a 50 % dither over a room-sized area is noise, and because the pattern is
// anchored to the framebuffer it crawls whenever the camera moves. Discarding a
// pixel (what the stipple did) also throws away the wall's surface at exactly
// the moment the lighting pass needs to know about it.
//
// So the ghost wall keeps its pixels and gets an ALPHA instead. The sprite is
// written into a second, transparent G-buffer layer, the light pass shades it
// like any other surface — at the wall's own world position, with the wall's
// own normal — and then composites it over the room behind. The wall is still
// there; you simply see through it.
//
// WHICH pixels fade used to be "the whole piece, if its screen rectangle
// overlapped the focus rectangle". A rectangle is a blunt instrument: a villager
// walking past the front of a barn has a rectangle that overlaps the barn's, and
// the barn is nearer, so the barn faded although it covered nobody. No amount of
// tuning fixes that, because the rectangles really do overlap.
//
// Now it is a depth comparison against the focus image, per pixel:
//
//     ghost this texel  <=>  it is NEARER than the nearest thing the camera
//                            is trying to look at, at this exact pixel
//
// A wall whose near half stands in front of the room and whose far half stands
// behind it therefore ghosts exactly the half that is in the way, along a crisp
// geometric line. And a building nobody is behind does not fade at all, because
// there is no focus depth there to be in front of.
void main() {
  vec4 a = texture(u_albedo, v_uv);
  if (a.a <= 0.004) discard;

  vec4 n = texture(u_nrm, v_uv);
  vec4 m = texture(u_mat, v_uv);

  // world height: n.a is normalised inside the sprite's own [z0,z1] span, so
  // expand it back and store it against a *global* scale — that way the light
  // pass can decode it without needing per-sprite state.
  float worldZ = mix(v_z.x, v_z.y, n.a);

  // ---- depth ---------------------------------------------------------------
  // The exact view depth of THIS texel, assembled from the two halves that are
  // both already there: the screen position of the fragment, and the surface
  // height the offline bake stored for this texel. The projection is
  //   screen.y = (x + y) * HH - z * ZPX
  // so (x + y) falls straight out of it, and depth along the view axis is
  //   dep = (x + y) + (2*HH/ZPX) * z
  // — which is why no depth map has to be shipped: the one we have is implied.
  vec2 rel = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y) - u_cam;
  float xpy = (rel.y + worldZ * u_iso.z) / u_iso.y;
  float dep = xpy + u_depthK * worldZ + v_bias;
  gl_FragDepth = clamp((dep + u_depthOrigin) / u_depthRange, 0.0, 1.0);

  float alpha = v_extra.y;
  if (alpha < 0.999) {
    // Keep a HAIRLINE of the silhouette rather than a solid cap. Boosting the
    // whole top half-unit made the ghost wall's sunlit cap and its curtain read
    // as bright objects in their own right — the very thing the ghost exists to
    // get out of the way. A two-pixel edge still tells you where the wall is.
    float top = smoothstep(v_z.y - 0.10, v_z.y - 0.015, worldZ);
    float ghostA = mix(v_extra.y, min(1.0, v_extra.y * 3.2), top);

    if (u_layer == 1 && u_focusOn == 1) {
      // ---- is THIS texel in the way? ---------------------------------------
      // The focus image holds the depth of the nearest surface the camera must
      // be able to see. Its empty pixels are cleared to the FAR end of the
      // range, not to zero: with the image filtered linearly — which is what
      // softens the ghost boundary over a couple of pixels — a zero would blend
      // downward and make the band around the focus box MORE eager to ghost,
      // exactly backwards. Cleared far, the blend can only ever be conservative.
      //
      // Decoding is exact (16 bits across two channels). The comparison carries
      // a small epsilon so geometry merely TOUCHING the focus — a wall meeting
      // the floor it stands on — is not mistaken for geometry in front of it.
      vec2 fq = texture(u_focus, gl_FragCoord.xy / u_res).rg;
      float fdep = (fq.r * 255.0 * 256.0 + fq.g * 255.0) / 65535.0 * u_depthRange - u_depthOrigin;
      float inTheWay = dep > fdep + 0.06 ? 1.0 : 0.0;
      // Everywhere it is NOT in the way, the piece is simply world: fully
      // opaque, shaded at full strength.
      alpha = mix(1.0, ghostA, inTheWay);
    } else {
      // ---- no focus published: fade the WHOLE piece ------------------------
      // This is the fail-safe, and it is the important branch. u_focusOn is 0
      // whenever the renderer has no focus image to consult — indoors, where the
      // cut-away is a declared property of the room and needs no image at all,
      // and outdoors on any frame where the focus pass did not run.
      //
      // Refining per pixel is a luxury; fading at all is the requirement. If the
      // image is missing and the shader fell through to "not in the way", every
      // wall in the room would silently go solid — which is exactly the failure
      // this branch exists to make impossible. A piece that has been declared
      // cut-able is cut-able; the depth image only decides WHICH of its pixels.
      alpha = ghostA;
    }
  }

  o_albedo = vec4(a.rgb, a.a * alpha);
  // nrm was dilated into transparent neighbours, so it is safe to sample here
  vec3 nn = normalize(n.rgb * 2.0 - 1.0);
  // bit 3 of the flag byte tells the light pass this pixel is being ghosted, so
  // it knows to pull the ghost veil over it — and, just as importantly, when NOT
  // to, because an opaque piece living in the cut-away layer must read as
  // ordinary world rather than as a film over it.
  o_normal = vec4(nn * 0.5 + 0.5, v_extra.x + (alpha < 0.999 ? 8.0 : 0.0));
  o_mat = vec4(m.r, m.g, m.b, worldZ / u_zScale);
}`;

// ---------------------------------------------------------------- focus depth
// What the camera must be able to see, rasterised as world-space boxes into a
// small depth image.
//
// The cutaway used to be "does this sprite's screen RECTANGLE overlap the focus
// rectangle, and is the sprite nearer". A rectangle is a blunt instrument: a
// villager walking past the front of a barn has a rectangle that overlaps the
// barn's, and the barn is nearer, so the barn ghosted although it was nowhere
// near covering anybody. No amount of tuning the rectangle fixes that, because
// the rectangles genuinely do overlap.
//
// So instead of comparing rectangles, ask the question the depth buffer already
// answers: rasterise the focus volumes with a depth test and keep the NEAREST
// focus surface per pixel. A sprite occludes the focus at a pixel if and only if
// it is nearer than that surface — exact, per pixel, and one small draw.
//
// Empty pixels keep depth 0, meaning "nothing to protect here". A focus box that
// is off screen or degenerate leaves its pixels empty, which fails safe: nothing
// gets ghosted on its behalf.
export const FOCUS_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_cube;      // unit cube corner, 0..1 on each axis
layout(location=1) in vec3 i_min;       // world-space box minimum
layout(location=2) in vec3 i_max;

uniform vec2 u_res;
uniform vec2 u_cam;                     // camera translation in iso pixels
uniform vec3 u_iso;                     // HW, HH, ZPX

out float v_dep;

void main() {
  vec3 w = mix(i_min, i_max, a_cube);
  vec2 p = vec2((w.x - w.y) * u_iso.x, (w.x + w.y) * u_iso.y - w.z * u_iso.z) + u_cam;
  vec2 gl = vec2(p.x, u_res.y - p.y);
  gl_Position = vec4((gl / u_res) * 2.0 - 1.0, 0.0, 1.0);
  // the same depth the sprite shader computes, so the two are directly comparable
  v_dep = (w.x + w.y) + (2.0 * u_iso.y / u_iso.z) * w.z;
}`;

// 16 bits of depth across two channels, because 8 is not enough: over a 160-unit
// outdoor scene one byte is 0.6 units, which is most of a tile — coarse enough
// that a wall standing exactly on the edge of a focus box would flicker between
// ghosted and solid. Two bytes give 0.002 units, and the decode in SPRITE_FS is
// exact, so the ghost boundary is a decision the depth makes rather than a
// rounding artefact.
//
// DEPTH IS OFFSET BEFORE ENCODING. Raw depth is x + y + K*z, which is NEGATIVE
// behind the map's near corner — and a focus box is allowed to hang off the map
// (the room's focus box does). Encoding that without an origin puts negative
// depths through a clamp at zero, which reads back as "no focus here": the far
// half of a room silently stops protecting itself and its back walls go solid
// over the middle of the floor. The origin removes the clamp entirely, and the
// clear value is the FAR end of the range rather than zero, so a linearly
// filtered edge can only ever be conservative.
export const FOCUS_FS = `#version 300 es
precision highp float;
in float v_dep;
uniform float u_depthRange;
uniform float u_depthOrigin;
layout(location=0) out vec4 o_depth;
void main() {
  float q = clamp((v_dep + u_depthOrigin) / u_depthRange, 0.0, 1.0);
  float q16 = floor(q * 65535.0 + 0.5);
  o_depth = vec4(floor(q16 / 256.0) / 255.0, mod(q16, 256.0) / 255.0, 0.0, 1.0);
}`;

// ---------------------------------------------------------------- lighting
// Full-screen passes take the shared unit quad (0..1); the pixel-space
// resolution is only needed inside the light fragment shader, where it is used
// to turn gl_FragCoord back into isometric screen space.
export const LIGHT_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;      // unit quad, 0..1
void main() {
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * One level of the MAX pyramid over the world height field: every texel is the
 * largest height in the 2x2 block below it, so a coarse level answers "can
 * ANYTHING in this cell block the sun" without looking at the fine level at all.
 *
 * This is what turns the outdoor shadow march from a guess into a proof. The old
 * loop advanced by a heuristic step and sampled the ground at the resulting
 * points, which is a *test*: a caster thinner than the step is simply missed, and
 * at a low sun the step reaches ~20 tiles, so a fence post's shadow survived only
 * where a sample happened to land on it — a scatter of small discs instead of a
 * shadow (see the outdoor phase of sunOcclusion, and README §7).
 *
 * Levels are filled by rendering with the viewport set to the region that
 * changed, so gl_FragCoord IS the destination texel. `u_copy` fills level 0 from
 * the live height texture 1:1; every other level takes the max of the 2x2 below.
 */
export const HEIGHTMAX_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_src;
uniform int u_copy;                    // 1 = 1:1 copy (level 0), 0 = 2x2 max
uniform int u_srcLod;                  // which level of u_src the 2x2 max reads
layout(location=0) out vec4 o_out;
void main() {
  ivec2 d = ivec2(gl_FragCoord.xy);
  if (u_copy == 1) { o_out = vec4(texelFetch(u_src, d, u_srcLod).r, 0.0, 0.0, 1.0); return; }
  float m = 0.0;
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      m = max(m, texelFetch(u_src, 2 * d + ivec2(i, j), u_srcLod).r);
    }
  }
  o_out = vec4(m, 0.0, 0.0, 1.0);
}`;

// The interior transmittance volume and the ray that walks it. Shared verbatim
// by the lighting pass and the shaft-volume pass so the beams you SEE and the
// beams that LIGHT the room can never disagree about where the sun gets in.
const ROOM_MARCH = `
uniform sampler3D u_roomVol;
uniform int   u_shadowTaps;      // EXPERIMENT: 3 (default) or 5 taps across the sun disc
uniform int   u_hasRoom;
uniform vec3  u_roomMin;
uniform vec3  u_roomKos;        // voxels per world unit, per axis
uniform vec3  u_roomVox;        // voxel dimensions
uniform float u_roomTop;
uniform vec3  u_sunDir;         // world space, unit, points *toward* the sun

/** world position -> normalised volume coordinate (0..1 on each axis) */
vec3 roomUVW(vec3 p) { return (p - u_roomMin) * u_roomKos / max(u_roomVox, vec3(1.0)); }
bool insideRoom(vec3 p) {
  vec3 u = roomUVW(p);
  return all(greaterThanEqual(u, vec3(0.0))) && all(lessThanEqual(u, vec3(1.0)));
}

/**
 * March the sun ray through the interior transmittance volume.
 *
 * This used to be a fixed step in z with a trilinear fetch, and it had one flaw
 * that mattered: the horizontal distance covered per step is |dir| = tan(zenith)
 * per unit of z, and at a low sun |dir| reaches ~15. A step fine enough at noon
 * therefore jumps TWELVE VOXELS sideways at dawn — and a wall is two voxels
 * thick. The wall was simply stepped over, and the whole room lit up as if the
 * walls were not there. That is a visible, obvious bug: dawn and dusk leaked.
 *
 * So: a proper 3D-DDA (Amanatides & Woo). It visits exactly the voxels the ray
 * passes through — a handful, not hundreds — and it cannot skip one no matter
 * how oblique the ray is. Wall thickness stops being something the step size
 * has to be tuned around.
 */
float roomMarch1(vec3 p, vec2 dir, out vec3 tint, out float tOut) {
  tint = vec3(1.0);
  tOut = 0.0;
  vec3 d = vec3(dir, 1.0) * u_roomKos;              // voxel units per unit of t
  vec3 g = (p - u_roomMin) * u_roomKos;             // entry point, in voxel coords
  ivec3 vi = ivec3(floor(g));
  ivec3 dim = ivec3(u_roomVox);
  vec3 ad = max(abs(d), vec3(1e-5));
  vec3 stp = vec3(d.x < 0.0 ? -1.0 : 1.0, d.y < 0.0 ? -1.0 : 1.0, 1.0);
  vec3 td = 1.0 / ad;
  vec3 tm = mix((vec3(vi) + 1.0 - g) / ad, (g - vec3(vi)) / ad, lessThan(d, vec3(0.0)));
  float trans = 1.0;
  // The step bound has to be the volume's own diagonal, not a number that felt
  // generous. A DDA advances one voxel per iteration, and a ray at a GRAZING
  // angle crosses the whole grid: dim.x + dim.y + dim.z is the exact worst case.
  // 220 was fine for a cottage with the sun overhead and quietly wrong at dawn,
  // when the rays are long and oblique — a ray that ran off the end of the loop
  // returned whatever transmittance it had accumulated, which for a ray that had
  // not met anything yet is 1.0, i.e. FULL SUN through a sealed wall. The chapel
  // (226x170x60) is what made it obvious: 22 floor tiles in its far aisle were
  // lit by light that had passed through nothing at all.
  int maxSteps = dim.x + dim.y + dim.z;
  // ---- glass is a SURFACE, not a medium -------------------------------------
  //
  // The pane used to be charged once per VOXEL crossed: trans and tint were both
  // multiplied on every step inside the glass. A 5 cm pane is about one voxel thick,
  // so a ray that meets it square on pays once — but a ray that grazes it at a
  // low sun angle travels ALONG the pane and pays three, four, five times. The
  // path length through the glass is quantised to whole voxels, and it changes by
  // a step whenever the ray shifts by one, so a window seen at a grazing angle
  // projects a COMB: parallel strips of light whose brightness is the crossing
  // count. That is the "curtain" — bright bands with hard edges standing in the
  // air against a wall — and it is why a stained window's colours refused to blend
  // however soft the penumbra got.
  //
  // At this scale the honest model is a thin optical surface: entering the glass
  // costs its transmittance and its colour, staying inside it costs nothing, and
  // leaving is free. The cost of a pane is then the same from every angle, which
  // is both what a 5 cm pane deserves and what removes the comb. The marks are
  // made slightly thicker than one voxel (see the note in tools/models/chapel.mjs)
  // so that "entering" always begins on a fully covered voxel and the pane's
  // quoted transmittance is the one that arrives.
  bool inGlass = false;
  for (int s = 0; s < maxSteps; s++) {
    if (any(lessThan(vi, ivec3(0))) || any(greaterThanEqual(vi, dim))) break;
    vec4 v = texelFetch(u_roomVol, vi, 0);         // normalised: air = 1, solid = 0
    if (v.r < 0.03) { tOut = min(min(tm.x, tm.y), tm.z); return 0.0; }   // solid
    bool glass = v.r < 0.995;
    if (glass && !inGlass) {
      trans *= v.r;                                   // through the pane, once...
      tint *= v.gba;                                  // ...in its own colour
      if (trans < 0.02) return 0.0;
    }
    inGlass = glass;
    if (tm.x <= tm.y && tm.x <= tm.z)      { tOut = tm.x; vi.x += int(stp.x); tm.x += td.x; }
    else if (tm.y <= tm.z)                 { tOut = tm.y; vi.y += int(stp.y); tm.y += td.y; }
    else                                   { tOut = tm.z; vi.z += 1;         tm.z += td.z; }
  }
  return trans;
}

/**
 * The room march with a penumbra.
 *
 * roomMarch1 above is a knife edge, and it is the only one left in this
 * renderer: the volume is binary — a voxel is air or it is solid — so a single
 * DDA decides a whole pixel and every shadow the room casts comes out with a
 * stair-stepped outline that follows the voxel grid. Outdoors the height-field
 * march has carried u_shadowSoft since the beginning; indoors there was
 * nothing.
 *
 * On a flat interior floor that hard edge is not read as a shadow at all. A
 * patch of sunlight two stops brighter than the boards around it, ending in a
 * ruled line, reads as a lit SURFACE lying on the floor — a pane, a mat, a
 * sheet of paper. It is invisible while the near wall is solid, because the
 * wall and its window explain both the brightness and the edge; hide the wall
 * and the patch is left with no visible cause, which is exactly when it gets
 * reported as a bug.
 *
 * Two extra rays across the sun's disc, weighted so that a fully lit or fully
 * shadowed point is bit-for-bit unchanged, soften the outline over roughly a
 * voxel and a half. Nothing about where the light lands moves; only the edge
 * gets a width, which is the difference between "there is a lit plate here" and
 * "the sun is coming through that window".
 */
float roomMarch(vec3 p, vec2 dir, out vec3 tint, out float tOut, float spread) {
  if (spread <= 0.0001) return roomMarch1(p, dir, tint, tOut);
  vec2 side = vec2(-dir.y, dir.x);
  float sl = length(side);
  side = sl > 1e-5 ? side / sl : vec2(1.0, 0.0);
  // ---- EXPERIMENT: five taps instead of three --------------------------------
  //
  // Three taps give four levels across the sun's disc (0.25 / 0.5 / 0.75 / 1.0),
  // and the last slivers of stray light indoors are about ONE VOXEL wide — so all
  // three taps land in the same state and the sliver keeps its ruled edge. Five
  // taps at 0, +-0.5 and +-1.0 spread give six levels over the same footprint, at
  // 5 marches per pixel instead of 3. Weights 2/2/2/1/1 out of 8, so a fully lit
  // or fully shadowed point is still bit-for-bit unchanged.
  if (u_shadowTaps >= 9) {
    // ---- EXPERIMENT: a box filter at the VOXEL scale -------------------------
    //
    // With the spread set to one voxel and nine taps spanning +-4 of them, this is a
    // plain 9-wide box filter of the visibility, and the smallest feature the room
    // volume can express (one voxel, 1.7 px) is averaged with its neighbours
    // instead of being sampled whole. That is the difference between "soften the
    // edges" and "blur the light": the slivers stop being slivers. Nine marches per
    // pixel instead of three, so it is an experiment and not the default.
    vec3 tsum = vec3(0.0);
    float vsum = 0.0, ob = 0.0;
    for (int i = -4; i <= 4; i++) {
      vec3 ti;
      float oi = 0.0;
      float v = roomMarch1(p + vec3(side * (spread * float(i)), 0.0), dir, ti, oi);
      if (i == 0) ob = oi;
      tsum += ti;
      vsum += v;
    }
    tint = tsum / 9.0;
    tOut = ob;
    return vsum / 9.0;
  }
  if (u_shadowTaps >= 5) {
    vec3 t1, t2, t3, t4, t5;
    float o1 = 0.0, o2 = 0.0, o3 = 0.0, o4 = 0.0, o5 = 0.0;
    float a = roomMarch1(p, dir, t1, o1);
    float b = roomMarch1(p + vec3(side * spread, 0.0), dir, t2, o2);
    float c = roomMarch1(p - vec3(side * spread, 0.0), dir, t3, o3);
    float d = roomMarch1(p + vec3(side * spread * 0.5, 0.0), dir, t4, o4);
    float e = roomMarch1(p - vec3(side * spread * 0.5, 0.0), dir, t5, o5);
    tint = (t1 * 2.0 + t4 * 2.0 + t5 * 2.0 + t2 + t3) / 8.0;
    tOut = o1;
    return (a * 2.0 + d * 2.0 + e * 2.0 + b + c) / 8.0;
  }
  vec3 t1, t2, t3;
  float o1 = 0.0, o2 = 0.0, o3 = 0.0;
  float a = roomMarch1(p, dir, t1, o1);
  float b = roomMarch1(p + vec3(side * spread, 0.0), dir, t2, o2);
  float c = roomMarch1(p - vec3(side * spread, 0.0), dir, t3, o3);
  tint = t1 * 0.5 + t2 * 0.25 + t3 * 0.25;
  tOut = o1;
  return a * 0.5 + b * 0.25 + c * 0.25;
}

/** sun visibility at a point, and the colour the light picked up getting there */
float roomVis(vec3 p, out vec3 tint) {
  tint = vec3(1.0);
  if (u_hasRoom != 1) return 1.0;
  float dz = u_sunDir.z;
  if (dz <= 0.03) return 1.0;
  float tOut;
  // no penumbra while BUILDING the volume: a penumbra there would be baked into
  // the field and then integrated again along the view ray
  return roomMarch(p, u_sunDir.xy / dz, tint, tOut, 0.0);
}
`;

/**
 * The sun-visibility volume: a coarse 3D texture holding, for every point of
 * the room, how much sun reaches it and what colour that light is.
 *
 * Rendering it once per sun direction turns "volumetric light shafts" into a
 * lookup: the region where this value is above zero IS the beam, exactly, for
 * free — because the same march that decides whether the floor is lit decides
 * whether the AIR is lit. The lighting pass then walks the view ray through it.
 *
 * It is deliberately coarse (48 x 40 x 20): the beams want to be soft, the
 * texture filter does the softening, and a full-resolution build every frame
 * would cost more than everything else in the renderer put together.
 */
export const SHAFT_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
${ROOM_MARCH}
uniform vec3  u_shaftMin;
uniform vec3  u_shaftSize;
uniform vec3  u_shaftDim;
uniform float u_slice;          // which z layer this draw is filling
layout(location=0) out vec4 o_shaft;
void main() {
  vec2 uv = gl_FragCoord.xy / u_shaftDim.xy;
  vec3 p = u_shaftMin + vec3(uv, (u_slice + 0.5) / u_shaftDim.z) * u_shaftSize;
  vec3 tint;
  float vis = roomVis(p, tint);
  // RGB = the colour the light carries, A = how much of it is here. The light
  // pass multiplies them, so a shaft through coloured glass is coloured.
  o_shaft = vec4(tint, vis);
}`;

/**
 * One 3x3x3 box blur over the shaft volume, in place of a pass per axis.
 *
 * The visibility it stores is a STEP in space (a cell is in the sun or it is
 * not) sampled onto a grid 5-10x coarser than the room, so every shadow edge in
 * the air is 0.2-0.3 world units of hard edge. Marched along the sight line, those
 * edges come out as parallel slabs — a beam standing in a room reads as a curtain
 * of strips. Blurring the FIELD is the fix that matches what fog does to a shadow
 * edge; blurring the picture afterwards would take the art with it.
 *
 * Runs into a second texture so the source is never bound while it is written.
 */
export const SHAFTBLUR_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D u_src;
uniform vec3  u_shaftDim;
uniform float u_slice;
layout(location=0) out vec4 o_shaft;
void main() {
  vec3 texel = 1.0 / u_shaftDim;
  vec3 c = vec3(gl_FragCoord.xy / u_shaftDim.xy, (u_slice + 0.5) / u_shaftDim.z);
  vec4 sum = vec4(0.0);
  for (int k = -1; k <= 1; k++) {
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec3 o = vec3(float(i), float(j), float(k)) * texel;
        vec3 uvw = c + o;
        // clamp at the volume's own faces: outside is "no fog", and padding it
        // with zeros would draw a bright rim around every beam
        sum += texture(u_src, clamp(uvw, vec3(0.0), vec3(1.0)));
      }
    }
  }
  o_shaft = sum / 27.0;
}`;

export const LIGHT_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler3D;

layout(location=0) out vec4 o_color;

// ---- two G-buffer layers ----------------------------------------------------
// A = the opaque world. B = the GHOST layer: sprites that stand between the
// camera and what you are looking at (see SPRITE_FS). They are shaded
// separately — each at its own world position, with its own normal — and then
// composited. That is what keeps "get out of the camera's way" and "still block
// the sun" from being the same decision, which is the bug this whole pass was
// rewritten to kill.
uniform sampler2D u_albedo;
uniform sampler2D u_normal;
uniform sampler2D u_mat;
uniform sampler2D u_albedoB;
uniform sampler2D u_normalB;
uniform sampler2D u_matB;
uniform sampler2D u_height;     // R = world height / zScale, G = coverage
uniform sampler2D u_focus;      // RG = 16-bit focus depth (lightDebug 9)

uniform vec2  u_res;
uniform vec2  u_cam;            // camera translation in iso pixels
uniform vec2  u_camWorld;       // world xy at the centre of the screen
uniform vec3  u_iso;            // HW, HH, ZPX

uniform vec3  u_sunColor;
uniform vec3  u_skyColor;       // ambient from above
uniform vec3  u_groundColor;    // ambient bounce from below
uniform float u_sunGain;
uniform float u_ambGain;

uniform vec2  u_mapOrigin;      // world xy of heightmap pixel (0,0)
uniform vec2  u_mapSize;        // world size covered by the heightmap
uniform float u_zScale;         // heightmap: world height = R * zScale
uniform float u_shadowStep;     // world units per ray-march step (loop bound is fixed)
uniform float u_shadowSoft;     // world units of penumbra
uniform float u_ambShadow;      // how much ambient survives full shadow
// ---- the max pyramid over the height field (see HEIGHTMAX_FS) ---------------
uniform sampler2D u_maxMip;     // level L = max height over each 2^L x 2^L block
uniform float u_maxMipTexel;    // world units per level-0 texel (1 / ppc)
uniform float u_sunRadius;      // tan of the sun's angular radius, for the footprint
uniform int   u_maxMipOn;       // 0 = the legacy geometric-step march
uniform float u_sunSoftIndoor;  // penumbra width of the room march, world units
// How far off a surface the room march starts, in VOXELS along the surface
// normal. Two voxels clears the wall slabs (they are 0.14 units = 2 voxels
// thick) without moving where the light lands by more than a third of a tile.
#define SURF_OFFSET_VOXELS 2.0

uniform vec3  u_fogColor;
uniform float u_fogNear;
uniform float u_fogFar;
uniform float u_fogAmount;
uniform float u_mistHeight;     // world z below which low mist pools
uniform float u_mistAmount;

uniform int   u_lightCount;
uniform vec4  u_lightPos[64];   // xyz world, w radius
uniform vec4  u_lightCol[64];   // rgb colour * intensity, a unused

uniform vec3  u_eyeDir;         // unit direction from surface toward the camera
uniform float u_exposure;
uniform float u_sat;

float sampleGround(vec2 w) {
  vec2 uv = (w - u_mapOrigin) / u_mapSize;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  return texture(u_height, uv).r * u_zScale;
}

// 0 = shade normally
// 1 = sun occlusion only (this is what "casts a shadow" means here)
// 2 = indoor mask
// 3 = the colour the sun picked up passing through glass
// 4 = point lights only
uniform int   u_lightDebug;

// ---- interior light transport ---------------------------------------------
// The 3D volume below can let sun through a window where a height field cannot:
// R is transmittance, GBA the colour picked up on the way through. Only enabled
// while the camera is actually inside. The march itself is shared with the
// shaft-volume pass — see ROOM_MARCH.
${ROOM_MARCH}

uniform float u_indoorAmbient;  // fraction of sky light that survives a roof
uniform vec3  u_indoorBounce;   // flat warm fill so the room is never grey mud
uniform float u_indoorSun;      // how hard the sun lands once it is through a pane

// A ghosted wall is a stand-in for a wall that is physically still there, so it
// is shaded like one — and a sunlit outer face at 25 % alpha is still a bright
// pale sheet across the room you are trying to look at. The veil pulls the ghost
// layer's own colour down so it reads as a film over the room rather than as a
// competing surface. It is an art control, not a physical one, and it is the only
// thing in this shader that is.
uniform float u_ghostVeil;

// ---- volumetric sunlight ----------------------------------------------------
// u_shaft is the sun-visibility volume the SHAFT pass just filled: the set of
// points in the room the sun can actually reach. Marching the VIEW ray through
// it and adding what we collect is the in-scattered light along that ray —
// which is, physically, what a sunbeam IS. No blur, no screen-space fake: the
// beams are the same beams the floor is lit by, seen from the side.
uniform sampler3D u_shaft;
uniform vec3  u_shaftMin;
uniform vec3  u_shaftInvSize;
uniform float u_shaftAmount;    // scattering coefficient / art control
uniform float u_shaftJitter;    // 0 = no de-banding, 1 = a full step of white noise    // 0 = no de-banding, 1 = a full step of white noise
uniform float u_shaftSteps;

// depth-key range, for the debug view only (see lightDebug 8)
uniform float u_depthRange;

/**
 * How much sun reaches this surface, and what colour it turned on the way.
 *
 * Two phases in one march. Inside the room volume the ray is shaped by walls,
 * window apertures and glass; the moment it leaves the volume it hands over to
 * the outdoor height field, so light that came through a window and is then
 * blocked by a tree outside is still handled correctly.
 *
 * ---- the normal offset, and why the walls needed one -----------------------
 *
 * A fragment that sits ON a wall is a fragment whose own voxel is SOLID, so the
 * march starts inside the thing it is standing on. That is fine on its own — the
 * first voxel returns 0 and the surface shadows itself, which is correct for a
 * surface facing away from the sun. It stops being fine because the room march
 * is a PENUMBRA: it fires three rays, two of them displaced sideways by
 * u_sunSoftIndoor. That displacement is 0.12 world units, the wall slab is 0.14
 * thick, and the volume's voxels are 1/14 unit — so the side taps land in the
 * air OUTSIDE the wall for roughly half of the pixels and in the wall for the
 * other half. The three-ray average then comes out 0.25 / 0.5 / 0.75 in a
 * voxel-periodic pattern: a lit wall was covered in a fine lattice of
 * full-sunlight pixels, each of them multiplied by u_indoorSun (3.0), which is
 * what read as a "halo" and as a broken, faceted surface. It is the indoor
 * equivalent of shadow acne, and it has the same fix.
 *
 * So: step OFF the surface along its own normal before marching, by a couple of
 * voxels. Every ray then starts in the air the wall is standing in, the taps
 * agree with each other, and the surface is lit or shadowed as a whole. The cost
 * is the usual one — the shadow a surface casts on itself shrinks by ~2 voxels
 * (0.14 units), which is a third of a tile's shadow at the sill of a window, and
 * invisible everywhere else.
 */
float sunOcclusion(vec2 w, float z, vec3 N, out vec3 tint) {
  tint = vec3(1.0);
  float dz = u_sunDir.z;
  if (dz <= 0.03) return 1.0;
  vec2 dir = u_sunDir.xy / dz;         // march one unit up per step
  float trans = 1.0;
  float t = 0.0;

  if (u_hasRoom == 1) {
    float tOut = 0.0;
    vec3 p0 = vec3(w, z) + N * (SURF_OFFSET_VOXELS / max(u_roomKos, vec3(1e-3)));
    trans = roomMarch(p0, dir, tint, tOut, u_sunSoftIndoor);
    if (trans <= 0.001) return 0.0;
    t = tOut;
  }
  // phase 2: outdoors, in the height field, continuing from where we left off.
  //
  // ---- why this is a MAX PYRAMID and not a step size -------------------------
  //
  // The obvious march samples the ground every st along the ray and asks "is
  // the ground higher than the ray here". That is a TEST, not a proof: anything
  // thinner than the step is invisible to it, and everything the loop missed
  // comes back as a shadow that is not there. Worse, the step had to grow — a
  // uniform step fine enough for the near field cannot reach the far field — and
  // at a low sun the parameterisation (one unit of HEIGHT per step, so the ground
  // distance per step is |sunDir.xy / sunDir.z|) turns a modest step into ~20
  // tiles. A fence post two texels wide was then sampled once every 400 texels:
  // its shadow appeared only where a sample happened to land inside it, and the
  // 5-tap cross that made the penumbra inflated each of those rare hits into a
  // disc. That is the whole "shadows turn into scattered dots at dawn" bug, and
  // no amount of tuning shadowSoft could fix it, because a miss is boolean.
  //
  // A max pyramid removes the guess. Level L holds the largest height in each
  // 2^L x 2^L block, so 'h > hm' at level L PROVES the ray clears everything in
  // that block, and the ray may advance to where it would touch hm. When it
  // cannot clear the block, drop a level; when it cannot clear a single texel,
  // something real is in the way. No step size is involved, a two-texel caster
  // cannot be jumped over by construction, and the count of iterations goes DOWN
  // because coarse levels cover ground fast.
  if (u_maxMipOn == 1) {
    float pen = 0.0;
    float tt = t;
    float texel = u_maxMipTexel;              // world units per level-0 texel
    float dirLen = max(length(dir), 1e-3);
    float lod = 0.0;
    for (int s = 0; s < 64; s++) {
      float h = z + tt;
      if (h > u_zScale) break;
      vec2 p = w + dir * tt;
      vec2 uv = (p - u_mapOrigin) / u_mapSize;
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
      float cell = texel * exp2(lod);
      float hm = textureLod(u_maxMip, uv, lod).r * u_zScale;
      if (h > hm + texel * 0.05) {
        // Clear at this level: rise to the blocker's height, but never skip more
        // than one cell of the level that proved it clear — then try a COARSER
        // level, so the ray covers the far field in a handful of steps.
        //
        // Descending-only was the second version of this and it walked the whole
        // march at texel-sized steps, ran out of iterations a few tiles from the
        // start, and reported almost no shadow at all. A hi-Z traversal has to
        // coarsen as well as refine.
        tt += max(texel * 0.5, min(h - hm, cell / dirLen));
        lod = min(lod + 1.0, 12.0);
      } else if (lod > 0.5) {
        lod -= 1.0;                           // blocked here: look finer, stay put
      } else {
        // A single texel blocks. Read the footprint the sun's own disc covers at
        // this distance, so the edge of the shadow is as wide as the light source
        // — the same idea as PCSS, one fetch instead of a tap star.
        //
        // Then walk a few texels further and keep the DEEPEST penetration. The
        // first version stopped at the first touch, which makes every grazing hit
        // a penetration of about zero; with a penumbra 1.5 units wide at a low
        // sun, smoothstep() then washed the whole shadow down to a third of its
        // strength. Touching the corner of a barn is not the same event as being
        // behind it.
        float r = max(u_shadowSoft * 0.35, tt * u_sunRadius);
        float lodS = clamp(log2(max(r, texel) / texel), 0.0, 12.0);
        pen = max(pen, textureLod(u_maxMip, uv, lodS).r * u_zScale - h);
        for (int k = 1; k <= 8; k++) {
          float tk = tt + float(k) * texel * 2.0 / dirLen;
          float hk = z + tk;
          if (hk > u_zScale) break;
          vec2 pk = w + dir * tk;
          vec2 uvk = (pk - u_mapOrigin) / u_mapSize;
          if (uvk.x < 0.0 || uvk.y < 0.0 || uvk.x > 1.0 || uvk.y > 1.0) break;
          pen = max(pen, textureLod(u_maxMip, uvk, lodS).r * u_zScale - hk);
        }
        break;                                // the first blocker decides
      }
    }
    return trans * (1.0 - smoothstep(0.0, u_shadowSoft, pen));
  }

  // ---- the legacy heuristic march (kept for A/B; see game.shadowMarch) -------
  //
  // Steps start fine and grow geometrically. A uniform step coarse enough to
  // reach across the map cannot resolve the NEAR field — and the near field is
  // where a shadow's shape, its contact with the ground and every small object's
  // silhouette actually live. A uniform march is what made thin things (chair
  // legs, window frames, a walking figure) scatter into speckle instead of
  // casting a readable shadow.
  float pen = 0.0;
  float tt = t;
  float st = u_shadowStep * 0.38;
  for (int s = 1; s <= 40; s++) {
    tt += st;
    st = min(st * 1.135, u_shadowStep * 5.0);
    float h = z + tt;
    if (h > u_zScale) break;
    vec2 p = w + dir * tt;
    float e = u_shadowSoft * 0.45;
    float th = sampleGround(p);
    th = max(th, sampleGround(p + vec2(e, 0.0)));
    th = max(th, sampleGround(p + vec2(-e, 0.0)));
    th = max(th, sampleGround(p + vec2(0.0, e)));
    th = max(th, sampleGround(p + vec2(0.0, -e)));
    pen = max(pen, th - h);
  }
  return trans * (1.0 - smoothstep(0.0, u_shadowSoft, pen));
}

// ---- one surface, shaded ----------------------------------------------------
struct Surf {
  vec3  alb;      // linear albedo
  vec3  N;
  float flags;
  float ao;
  float specK;
  float emisK;
  float z;
  vec2  W;
  float roomK;    // 1 if this fragment is inside the interior volume
};

Surf fetchSurf(sampler2D tAlb, sampler2D tNrm, sampler2D tMat, ivec2 px, vec4 alb) {
  vec4 nrm = texelFetch(tNrm, px, 0);
  vec4 mat = texelFetch(tMat, px, 0);
  Surf s;
  s.alb = alb.rgb * alb.rgb;                       // display space -> linear
  s.N = normalize(nrm.rgb * 2.0 - 1.0);
  s.flags = nrm.a;
  s.ao = mat.r; s.specK = mat.g; s.emisK = mat.b;
  s.z = mat.a * u_zScale;

  // rebuild world position (orthographic isometric inverse)
  vec2 sp = vec2(px) + 0.5;
  sp.y = u_res.y - sp.y;             // back to iso space (y down)
  vec2 rel = sp - u_cam;
  float xmy = rel.x / u_iso.x;
  float xpy = (rel.y + s.z * u_iso.z) / u_iso.y;
  s.W = vec2((xmy + xpy) * 0.5, (xpy - xmy) * 0.5);
  s.roomK = (u_hasRoom == 1 && insideRoom(vec3(s.W, s.z))) ? 1.0 : 0.0;
  return s;
}

/**
 * In-scattered sunlight along the view ray, ending at the visible surface.
 *
 * The projection is orthographic and isometric, so a fixed screen pixel maps to
 * a straight line in world space — and that line is trivial to walk: raising z
 * by one unit slides the reconstructed world xy by u_iso.z / (2*u_iso.y) in BOTH
 * axes. So the "ray" is a one-line loop, and the only thing it needs from the
 * scene is the shaft volume the SHAFT pass already built.
 *
 * Stopping the march at the surface's own z is what keeps the glow in front of
 * things rather than behind them: everything above that height along this pixel
 * is between the camera and the surface, everything below is inside the wall.
 */
vec3 sunShaft(vec2 W, float zSurf, float roomK) {
  if (u_shaftAmount <= 0.001 || roomK < 0.5) return vec3(0.0);
  float k = u_iso.z / (2.0 * u_iso.y);
  float zTop = u_roomTop;
  float span = zTop - zSurf;
  if (span <= 0.02) return vec3(0.0);
  float step = span / u_shaftSteps;
  // Dither the start of the march by a fraction of a step. The shaft volume is
  // coarse on purpose, and a fixed march through a coarse grid lands on the same
  // phase of it in every step — which shows up as horizontal stripes across the
  // room. A per-pixel offset turns that banding into noise, which is what a
  // photograph of a sunbeam actually looks like.
  //
  // The amount is a uniform because "how much noise is better than how much
  // banding" is a judgement about the picture, not a constant: at 1.0 the noise
  // is white and a bright beam seen edge-on reads as a curtain of strips; the
  // grid is now sized per room (see makeShaftVolume) so there is less banding for
  // it to hide, and the default sits below a full step.
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * u_shaftJitter;
  vec2 base = W - vec2(k, k) * (zSurf + step * jitter);   // world xy at z = 0
  vec3 sum = vec3(0.0);
  for (int i = 1; i <= 24; i++) {
    if (float(i) > u_shaftSteps) break;
    float z = zSurf + step * (float(i) + jitter);
    vec2 p = base + vec2(k, k) * z;
    vec3 uvw = (vec3(p, z) - u_shaftMin) * u_shaftInvSize;
    if (all(greaterThanEqual(uvw, vec3(0.0))) && all(lessThanEqual(uvw, vec3(1.0)))) {
      vec4 s = texture(u_shaft, uvw);
      // dust is denser low down, and the beam thins as it climbs
      sum += s.rgb * s.a * mix(1.0, 0.45, clamp(z / max(u_roomTop, 0.001), 0.0, 1.0));
    }
  }
  return sum * step * u_shaftAmount;
}

vec3 shade(Surf s) {
  float ndl = max(0.0, dot(s.N, u_sunDir));
  vec3 sunTint;
  float shadow = sunOcclusion(s.W, s.z, s.N, sunTint);
  float skyVis = mix(u_ambShadow, 1.0, shadow);

  float indoor = 0.0;
  if (u_hasRoom == 1 && insideRoom(vec3(s.W, s.z))) indoor = 1.0;

  // ---- hemispheric sky ambient, occluded by baked AO ----------------------
  float upness = s.N.z * 0.5 + 0.5;
  vec3 ambient = mix(u_groundColor, u_skyColor, upness);
  // a roof keeps most of the sky out; what is left reads as warm bounce off the
  // boards and plaster, which is exactly what stops an interior going flat and
  // grey. The window portals supply the directional part on top of this.
  if (indoor > 0.5) ambient = ambient * u_indoorAmbient + u_indoorBounce;
  vec3 indirect = ambient * u_ambGain * mix(0.30, 1.0, s.ao) * mix(1.0, skyVis, 0.72);

  // ---- point lights -------------------------------------------------------
  vec3 pointSum = vec3(0.0);
  for (int i = 0; i < 64; i++) {
    if (i >= u_lightCount) break;
    vec3 lp = u_lightPos[i].xyz;
    float radius = u_lightPos[i].w;
    vec3 d = lp - vec3(s.W, s.z);
    float dist2 = dot(d, d);
    if (dist2 > radius * radius) continue;
    float dist = sqrt(dist2);
    vec3 L = d / max(dist, 1e-4);
    // windowed inverse-square: reaches exactly zero at the radius
    float att = pow(1.0 - dist / radius, 2.0) / (1.0 + 0.55 * dist2);
    float nl = max(0.0, dot(s.N, L));
    nl = mix(nl, nl * 0.55 + 0.45, 0.35);   // wrap term: no pitch-black grazing
    pointSum += u_lightCol[i].rgb * att * nl * mix(0.45, 1.0, s.ao);
  }

  // ---- specular -----------------------------------------------------------
  vec3 V = normalize(u_eyeDir);
  vec3 Hv = normalize(V + u_sunDir);
  float spec = 0.0;
  if (s.specK > 0.001) {
    spec = s.specK * pow(max(0.0, dot(s.N, Hv)), 42.0) * shadow * ndl;
    if (s.flags > 0.5 && s.flags < 1.5) {          // water: broad sky sheen
      vec3 H2 = normalize(V + vec3(0.0, 0.0, 1.0));
      spec += s.specK * 0.30 * pow(max(0.0, dot(s.N, H2)), 6.0);
    }
  }

  // ---- emissive -----------------------------------------------------------
  vec3 emissive = vec3(0.0);
  if (s.emisK > 0.004) emissive = s.alb * s.emisK * 2.8;

  vec3 lit = s.alb * (u_sunColor * sunTint * u_sunGain * ndl * shadow * mix(1.0, u_indoorSun, indoor)
    + indirect + pointSum);
  lit += emissive + u_sunColor * sunTint * spec * u_sunGain;
  // ...and the light scattered by the air between the camera and this surface.
  // Not a post effect: it is the same sun, in the same room, along this exact ray.
  lit += u_sunColor * u_sunGain * sunShaft(s.W, s.z, s.roomK);

  // ---- term isolation (QA) ---------------------------------------------------
  // ONE term of this surface's shading, on its own. "The floor by the cut-away
  // looks like a different room" is a claim about a sum of six terms; these make
  // it a claim about one of them. 12 indirect, 13 direct sun, 14 baked AO,
  // 15 the shadow term, 16 raw hemispheric ambient, 17 point lights,
  // 18 (indoor flag, roomK) so a volume-boundary question answers itself.
  if (u_lightDebug == 12) return clamp(indirect, 0.0, 1.0);
  if (u_lightDebug == 13) {
    return clamp(s.alb * u_sunColor * sunTint * u_sunGain * ndl * shadow
      * mix(1.0, u_indoorSun, indoor), 0.0, 1.0);
  }
  if (u_lightDebug == 14) return vec3(s.ao);
  if (u_lightDebug == 15) return vec3(shadow);
  if (u_lightDebug == 16) return clamp(ambient * u_ambGain, 0.0, 1.0);
  if (u_lightDebug == 17) return clamp(pointSum, 0.0, 1.0);
  if (u_lightDebug == 18) return vec3(indoor, s.roomK, 0.0);
  // 19/20 answer "is the volume wrong, or is the POSITION I am sampling it at
  // wrong": 19 encodes the world position rebuilt from the G-buffer, 20 the
  // uniforms that rebuild does with. Two builds that disagree here disagree
  // about where the room is, not about what is in it.
  if (u_lightDebug == 19) return vec3(s.W.x / 16.0, s.W.y / 16.0, s.z / 4.0);
  if (u_lightDebug == 20) return vec3(u_cam.x / 1024.0, u_cam.y / 1024.0, u_zScale / 16.0);
  if (u_lightDebug == 21) return vec3(u_iso.x / 64.0, u_iso.y / 32.0, u_iso.z / 64.0);
  return lit;}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 albA = texelFetch(u_albedo, px, 0);
  vec4 albB = texelFetch(u_albedoB, px, 0);
  bool hasA = albA.a > 0.004;
  bool hasB = albB.a > 0.004;
  if (!hasA && !hasB) { o_color = vec4(0.0, 0.0, 0.0, 1.0); return; }

  // debug views describe the opaque world; a ghosted wall is not what you want
  // to be looking at while debugging the room behind it
  if (u_lightDebug > 0 && u_lightDebug < 5) {
    Surf d;
    if (hasA) d = fetchSurf(u_albedo, u_normal, u_mat, px, albA);
    else d = fetchSurf(u_albedoB, u_normalB, u_matB, px, albB);
    if (u_lightDebug == 1) {
      vec3 tint; float sh = sunOcclusion(d.W, d.z, d.N, tint);
      o_color = vec4(vec3(sh), 1.0); return;
    }
    if (u_lightDebug == 2) {
      float ind = (u_hasRoom == 1 && insideRoom(vec3(d.W, d.z))) ? 1.0 : 0.0;
      o_color = vec4(vec3(ind), 1.0); return;
    }
    if (u_lightDebug == 3) {
      vec3 tint; sunOcclusion(d.W, d.z, d.N, tint);
      o_color = vec4(tint, 1.0); return;
    }
  }

  Surf sA, sB;
  vec3 lit = vec3(0.0);
  float indoor = 0.0;
  if (u_lightDebug == 5) { o_color = vec4(albB.rgb, 1.0); return; }        // ghost albedo
  if (u_lightDebug == 6) { o_color = vec4(vec3(albB.a), 1.0); return; }    // ghost alpha
  // 22/23/24 split a surface into its INPUTS: what the artist baked (albedo,
  // normal, material), with no sun, no ambient and no tonemap of its own. A
  // pattern that survives here is in the asset; one that appears only in the lit
  // frame comes from the shading.
  if (u_lightDebug == 22 || u_lightDebug == 23 || u_lightDebug == 24) {
    Surf d;
    if (hasA) d = fetchSurf(u_albedo, u_normal, u_mat, px, albA);
    else d = fetchSurf(u_albedoB, u_normalB, u_matB, px, albB);
    if (u_lightDebug == 22) { o_color = vec4(albA.a > 0.004 ? albA.rgb : albB.rgb, 1.0); return; }
    if (u_lightDebug == 23) { o_color = vec4(d.N * 0.5 + 0.5, 1.0); return; }
    o_color = vec4(d.ao, d.specK, d.emisK, 1.0); return;   // material: AO / spec / emissive
  }
  if (u_lightDebug == 9) {                                                 // focus depth image
    // The image the cutaway is decided against: what the camera must be able to
    // see, ranked by depth. Blue is the focus volume, GREEN is "nothing to
    // protect here" — and green is why a building nobody stands behind stays
    // solid instead of fading on a rectangle overlap. This is the view to open
    // when a wall fades for no visible reason.
    float fq = texture(u_focus, gl_FragCoord.xy / u_res).r;
    o_color = vec4(0.0, fq, 1.0 - fq, 1.0);
    return;
  }
  if (u_lightDebug == 8) {                                                 // depth-key ordering
    // Every pixel that was actually drawn, painted with the depth the geometry
    // said it had. Banding here means the depth buffer is resolving occlusion
    // and the CPU order no longer decides anything; a smooth gradient across a
    // silhouette means the two agree. This is the view that answers "why is
    // that thing in front of that other thing" without guessing.
    Surf d8;
    if (hasA) d8 = fetchSurf(u_albedo, u_normal, u_mat, px, albA);
    else d8 = fetchSurf(u_albedoB, u_normalB, u_matB, px, albB);
    float dep = (d8.W.x + d8.W.y) + (2.0 * u_iso.y / u_iso.z) * d8.z;
    float t = clamp(dep / max(u_depthRange, 1.0), 0.0, 1.0);
    o_color = vec4(fract(t * 12.0), t, 1.0 - t, 1.0);
    return;
  }
  if (u_lightDebug == 7) {                                                 // volumetric shafts only
    Surf d7;
    if (hasA) d7 = fetchSurf(u_albedo, u_normal, u_mat, px, albA);
    else d7 = fetchSurf(u_albedoB, u_normalB, u_matB, px, albB);
    o_color = vec4(clamp(sunShaft(d7.W, d7.z, d7.roomK) * 6.0, 0.0, 1.0), 1.0);
    return;
  }
  if (u_lightDebug == 10) {                                                // the AIR volume itself
    // The raw value the shaft pass wrote at this surface point — how sunlit the
    // air here is — with no sight-line integral on top. When a patch of floor is
    // bright for no reason, this is the view that says whether the volume is
    // wrong or whether the march through it is.
    Surf d10;
    if (hasA) d10 = fetchSurf(u_albedo, u_normal, u_mat, px, albA);
    else d10 = fetchSurf(u_albedoB, u_normalB, u_matB, px, albB);
    vec3 uvw = (vec3(d10.W, d10.z) - u_shaftMin) * u_shaftInvSize;
    float a = 0.0;
    if (all(greaterThanEqual(uvw, vec3(0.0))) && all(lessThanEqual(uvw, vec3(1.0)))) {
      a = texture(u_shaft, uvw).a;
    }
    o_color = vec4(vec3(a), 1.0);
    return;
  }
  if (u_lightDebug == 11) {                                                // the ROOM volume: air or solid
    // 1 = air, 0 = solid, sampled at this surface point. Debug 10 bright where
    // this is 0 means the air volume is reporting sun inside a wall.
    Surf d11;
    if (hasA) d11 = fetchSurf(u_albedo, u_normal, u_mat, px, albA);
    else d11 = fetchSurf(u_albedoB, u_normalB, u_matB, px, albB);
    ivec3 vi = ivec3(floor((vec3(d11.W, d11.z) - u_roomMin) * u_roomKos));
    float air = 0.0;
    if (all(greaterThanEqual(vi, ivec3(0))) && all(lessThan(vi, ivec3(u_roomVox)))) {
      air = texelFetch(u_roomVol, vi, 0).r;
    }
    o_color = vec4(vec3(air), 1.0);
    return;
  }  if (hasA) {
    sA = fetchSurf(u_albedo, u_normal, u_mat, px, albA);
    lit = shade(sA);
    indoor = (u_hasRoom == 1 && insideRoom(vec3(sA.W, sA.z))) ? 1.0 : 0.0;
  }
  if (hasB) {
    sB = fetchSurf(u_albedoB, u_normalB, u_matB, px, albB);
    // A pixel that ended up fully opaque inside the cut-away layer is not being
    // ghosted at all — it is simply a piece of world that happens to live in
    // that layer, and it must be shaded at full strength rather than veiled.
    // SPRITE_FS marks those by setting bit 3 of the flag byte.
    bool ghosted = mod(floor(sB.flags / 8.0), 2.0) > 0.5;
    vec3 g = shade(sB) * (ghosted ? u_ghostVeil : 1.0);
    lit = hasA ? mix(lit, g, clamp(albB.a, 0.0, 1.0)) : g;
    indoor = max(indoor, (u_hasRoom == 1 && insideRoom(vec3(sB.W, sB.z))) ? 1.0 : 0.0);
  }

  if (u_lightDebug == 4) {
    // point lights alone, straight from the topmost shaded layer
    Surf d = sA;
    if (hasB) d = sB;
    vec3 sum = vec3(0.0);
    for (int i = 0; i < 64; i++) {
      if (i >= u_lightCount) break;
      vec3 lp = u_lightPos[i].xyz;
      float radius = u_lightPos[i].w;
      vec3 dv = lp - vec3(d.W, d.z);
      float dist2 = dot(dv, dv);
      if (dist2 > radius * radius) continue;
      float dist = sqrt(dist2);
      vec3 L = dv / max(dist, 1e-4);
      float att = pow(1.0 - dist / radius, 2.0) / (1.0 + 0.55 * dist2);
      float nl = max(0.0, dot(d.N, L));
      nl = mix(nl, nl * 0.55 + 0.45, 0.35);
      sum += u_lightCol[i].rgb * att * nl * mix(0.45, 1.0, d.ao);
    }
    o_color = vec4(clamp(sum, 0.0, 1.0), 1.0); return;
  }

  float ao = hasA ? sA.ao : sB.ao;
  float z = hasA ? sA.z : sB.z;
  vec2 W = hasA ? sA.W : sB.W;

  // ---- low mist pooling near the ground -----------------------------------
  // Weighted by distance as well as height: a ground plane at z = 0 would
  // otherwise be uniformly veiled, which reads as a washed-out photo rather
  // than as mist sitting in the hollows. Skipped entirely indoors — ground fog
  // is an outdoor phenomenon and it turns a room into grey soup.
  if (u_mistAmount > 0.001 && indoor < 0.5) {
    float m = 1.0 - smoothstep(0.0, max(u_mistHeight, 0.001), z);
    float radial = length(W - u_camWorld);
    m *= smoothstep(5.0, 26.0, radial) * 0.75 + 0.25;
    lit = mix(lit, u_fogColor * (0.5 + 0.5 * ao), m * u_mistAmount);
  }

  // ---- distance fog -------------------------------------------------------
  if (u_fogAmount > 0.001 && indoor < 0.5) {
    float radial = length(W - u_camWorld);
    float f = smoothstep(u_fogNear, u_fogFar, radial);
    lit = mix(lit, u_fogColor, f * u_fogAmount);
  }

  // ---- tonemap + grade ----------------------------------------------------
  lit *= u_exposure;
  lit = lit / (1.0 + lit * 0.72);
  vec3 col = sqrt(max(lit, vec3(0.0)));
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l), col, u_sat);

  o_color = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// ---------------------------------------------------------------- post
export const POST_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;      // unit quad, 0..1
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}`;

export const POST_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
layout(location=0) out vec4 o_color;

uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform vec2  u_res;
uniform float u_bloomAmount;
uniform float u_vignette;
uniform float u_grain;        // animated grain amount
uniform float u_time;
uniform int   u_dither;       // 0 = off, >0 = ordered-dither quantisation levels
uniform int   u_posterize;    // 0 = off, else number of levels per channel
uniform float u_scanline;     // subtle scanline darkening, 0 = off
uniform vec3  u_lift;
uniform vec3  u_gain;

// 8x8 ordered Bayer, the same matrix the offline pipeline used
float bayer8(ivec2 p) {
  const int m[64] = int[64](
     0,32, 8,40, 2,34,10,42,
    48,16,56,24,50,18,58,26,
    12,44, 4,36,14,46, 6,38,
    60,28,52,20,62,30,54,22,
     3,35,11,43, 1,33, 9,41,
    51,19,59,27,49,17,57,25,
    15,47, 7,39,13,45, 5,37,
    63,31,55,23,61,29,53,21);
  int x = p.x & 7, y = p.y & 7;
  return (float(m[y * 8 + x]) + 0.5) / 64.0 - 0.5;
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec3 c = texture(u_scene, v_uv).rgb;
  if (u_bloomAmount > 0.001) c += texture(u_bloom, v_uv).rgb * u_bloomAmount;

  c = c * u_gain + u_lift;

  if (u_scanline > 0.001) {
    float s = mod(floor(gl_FragCoord.y), 2.0) < 0.5 ? 1.0 - u_scanline : 1.0;
    c *= s;
  }

  ivec2 ip = ivec2(gl_FragCoord.xy);
  if (u_dither > 0) {
    float d = bayer8(ip) / float(u_dither);
    c = floor(c * float(u_dither) + 0.5 + d) / float(u_dither);
  }
  if (u_posterize > 1) {
    float n = float(u_posterize);
    c = floor(c * n + 0.5) / n;
  }

  if (u_vignette > 0.001) {
    vec2 d = v_uv - 0.5;
    float v = 1.0 - dot(d, d) * u_vignette;
    c *= clamp(v, 0.0, 1.0);
  }
  if (u_grain > 0.001) {
    float g = hash(vec2(ip) + vec2(u_time * 37.0, u_time * 17.0)) - 0.5;
    c += g * u_grain;
  }

  o_color = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

export const BLUR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
layout(location=0) out vec4 o_color;
uniform sampler2D u_src;
uniform vec2 u_texel;      // 1/size
uniform vec2 u_dir;        // (1,0) or (0,1)
uniform float u_threshold; // bright-pass threshold (only used on the first tap)
uniform int u_first;
void main() {
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = -4; i <= 4; i++) {
    float w = exp(-float(i * i) / 8.0);
    vec2 uv = v_uv + u_dir * u_texel * float(i) * 1.35;
    vec3 c = texture(u_src, uv).rgb;
    if (u_first == 1) {
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c *= max(0.0, l - u_threshold) / max(l, 1e-4);
    }
    sum += c * w;
    wsum += w;
  }
  o_color = vec4(sum / wsum, 1.0);
}`;
