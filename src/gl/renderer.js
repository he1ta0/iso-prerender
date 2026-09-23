// WebGL2 runtime renderer.
//
//   focus depth -> sprites (depth-tested, 3x RGBA8 MRT) -> lighting -> bloom -> post
//
// The sprite pass is one instanced draw call for the whole world: every placed
// object contributes one quad, already positioned in isometric screen space on
// the CPU, and carries its own view depth as a fragment value. The lighting pass
// is a single full-screen pass that rebuilds the world position analytically
// from (screen, height) 鈥?orthographic isometric projection makes that exact, so
// no world-position buffer is needed.
//
// ---- what the depth buffer replaced -----------------------------------------
// Occlusion used to be a CPU painter's sort: one number per sprite, one total
// order, and a scene layout that had to be authored around it. It is replaced by
// a real depth buffer (see SPRITE_FS for where the depth comes from 鈥?it is
// derived, not stored), which fixes the two things a total order cannot:
//
//   * a sprite that is nearer than another at one pixel and further away at
//     another now resolves per pixel, so interleaved geometry stops being a
//     special case;
//   * the cutaway becomes exact. A focus depth image is rasterised first, and a
//     sprite pixel ghosts only where it is genuinely in front of what you are
//     looking at 鈥?instead of the whole piece fading because two bounding
//     rectangles overlapped.
//
// The CPU sort still runs. It is now only a back-to-front ordering for the
// blended cut-away layer, where order is a compositing choice rather than a
// correctness requirement.

import {
  SPRITE_VS, SPRITE_FS, FOCUS_VS, FOCUS_FS,
  LIGHT_VS, LIGHT_FS, SHAFT_FS, SHAFTBLUR_FS, POST_VS, POST_FS, BLUR_FS, HEIGHTMAX_FS,
} from './shaders.js';

export const FLAG_WATER = 1;
export const FLAG_FOLIAGE = 2;
export const FLAG_GLASS = 4;

const MAX_LIGHTS = 64;
const MAX_INSTANCES = 12000;
const MAX_FOCUS = 96;
const INST_FLOATS = 13;
const INST_BYTES = INST_FLOATS * 4;

/**
 * Forward depth margin per sprite category, in depth units (1 unit = 1 tile of
 * x+y), before BIAS_SCALE.
 *
 * A depth buffer is exact where a sort was merely opinionated, and "exact" for
 * coplanar geometry means a coin toss: the feet of a villager standing on the
 * ground are at the same depth as the ground. The draw order already breaks
 * that tie the right way (the ground goes first), so this is a belt-and-braces
 * margin rather than the mechanism 鈥?and it is FORWARD ONLY. A category given a
 * negative margin here would start losing to the surface it stands on, which is
 * the one way this table can do harm.
 */
const DEPTH_BIAS = {
  ground: 0.0,
  water: 0.02,
  floor: 0.0,
  wall: 0.0,
  roof: 0.0,
  build: 0.0,
  furn: 0.0,
  prop: 0.0,
  crop: 0.04,
  tree: 0.04,
  char: 0.03,
};
const DEFAULT_BIAS = 0.02;
const BIAS_SCALE = 0.12;      // depth units per bias step

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n');
    throw new Error(`shader compile failed:\n${log}\n${numbered}`);
  }
  return s;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link failed: ${gl.getProgramInfoLog(p)}`);
  const u = new Proxy({}, {
    get(cache, name) {
      if (!(name in cache)) cache[name] = gl.getUniformLocation(p, name);
      return cache[name];
    },
  });
  return { p, u };
}

function texFromImage(gl, img, nearest = true) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
  const f = nearest ? gl.NEAREST : gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/**
 * 36 vertices of a unit cube, as corner coordinates in 0..1. The focus pass
 * needs a real box, not a quad: a focus volume is a solid the camera wants to
 * see through, and its NEAREST surface is what a sprite has to beat to count as
 * being in the way. A single tilted quad cannot express that.
 */
function cubeVerts() {
  const F = [
    [[0, 0, 1], [1, 0, 1], [1, 1, 1]], [[0, 0, 1], [1, 1, 1], [0, 1, 1]],   // +z
    [[0, 0, 0], [0, 1, 0], [1, 1, 0]], [[0, 0, 0], [1, 1, 0], [1, 0, 0]],   // -z
    [[0, 1, 0], [0, 1, 1], [1, 1, 1]], [[0, 1, 0], [1, 1, 1], [1, 1, 0]],   // +y
    [[0, 0, 0], [1, 0, 0], [1, 0, 1]], [[0, 0, 0], [1, 0, 1], [0, 0, 1]],   // -y
    [[1, 0, 0], [1, 1, 0], [1, 1, 1]], [[1, 0, 0], [1, 1, 1], [1, 0, 1]],   // +x
    [[0, 0, 0], [0, 0, 1], [0, 1, 1]], [[0, 0, 0], [0, 1, 1], [0, 1, 0]],   // -x
  ];
  const out = new Float32Array(36 * 3);
  let i = 0;
  for (const f of F) for (const v of f) { out[i++] = v[0]; out[i++] = v[1]; out[i++] = v[2]; }
  return out;
}

export class Renderer {
  constructor(gl, opts = {}) {
    this.gl = gl;
    this.zScale = opts.zScale ?? 8;
    this.res = [opts.width ?? 640, opts.height ?? 360];

    this.pSprite = program(gl, SPRITE_VS, SPRITE_FS);
    this.pFocus = program(gl, FOCUS_VS, FOCUS_FS);
    this.pLight = program(gl, LIGHT_VS, LIGHT_FS);
    this.pShaft = program(gl, LIGHT_VS, SHAFT_FS);
  this.pShaftBlur = program(gl, POST_VS, SHAFTBLUR_FS);
    this.pPost = program(gl, POST_VS, POST_FS);
    this.pBlur = program(gl, POST_VS, BLUR_FS);

    // ---- static unit quad (triangle strip) --------------------------------
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

    // ---- full-screen triangle pair in pixel coords ------------------------
    this.fsQuad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fsQuad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

    // ---- instance buffers -------------------------------------------------
    // One buffer PER LAYER, because the two layers are drawn with different
    // depth state (see render()). Each instance is 13 floats:
    // org(2) size(2) uv(2) uvSize(2) z(2) flags+alpha(2) bias(1).
    this.inst = gl.createBuffer();
    this.instData = new Float32Array(MAX_INSTANCES * INST_FLOATS);
    this.instCount = 0;
    this.ghostInst = gl.createBuffer();
    this.ghostData = new Float32Array(MAX_INSTANCES * INST_FLOATS);
    this.ghostCount = 0;

    const attr = (loc, size, off) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, INST_BYTES, off);
      gl.vertexAttribDivisor(loc, 1);
    };
    const bindInst = (buf) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      attr(1, 2, 0);     // org
      attr(2, 2, 8);     // size
      attr(3, 2, 16);    // uv
      attr(4, 2, 24);    // uvSize
      attr(5, 2, 32);    // z0,z1
      attr(6, 2, 40);    // flags, alpha
      attr(7, 1, 48);    // depth bias
    };

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    bindInst(this.inst);
    gl.bindVertexArray(null);

    this.ghostVao = gl.createVertexArray();
    gl.bindVertexArray(this.ghostVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    bindInst(this.ghostInst);
    gl.bindVertexArray(null);

    // ---- focus depth instances --------------------------------------------
    // A world-space box per focus volume: min xyz + max xyz = 6 floats. Drawn as
    // an instanced unit cube so the depth test can find the nearest surface of
    // the box, rather than a single quad pretending to be one.
    this.focusInst = gl.createBuffer();
    this.focusData = new Float32Array(MAX_FOCUS * 6);
    this.focusCount = 0;
    this.cube = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cube);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cubeVerts()), gl.STATIC_DRAW);
    this.focusVao = gl.createVertexArray();
    gl.bindVertexArray(this.focusVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cube);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.focusInst);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 24, 12);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);

    // ---- full-screen VAO --------------------------------------------------
    this.fsVao = gl.createVertexArray();
    gl.bindVertexArray(this.fsVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fsQuad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.heightTex = null;
    this.heightInfo = { origin: [0, 0], size: [1, 1] };
    /**
     * QA switch: draw the world with NO depth test at all.
     *
     * With this on, the sprite layers fall back to exactly what the renderer did
     * before the depth buffer existed 鈥?one instanced draw per layer, painter
     * order, last write wins. That makes "the depth buffer cut something it
     * should not have" a measurable claim: render the same frame both ways and
     * diff them. Whatever changes is what the depth test decided, and every
     * changed pixel is either a fix or a bug, with nothing hidden in between.
     */
    this.depthOff = false;
    /**
     * QA switch: the outdoor shadow march. `true` (default) walks the max
     * pyramid and cannot miss a caster; `false` is the legacy geometric-step
     * march that turns a low sun into scattered dots. One flag, one shader
     * branch, and the two are directly diffable 锟斤拷 see game.shadowMarch.
     */
    this.maxMipOn = true;
    /**
     * Bookkeeping for the loudest failure this renderer can have.
     *
     * `setFocus` is the one call the scene has to make for the per-pixel cutaway
     * to work. If it is never called 鈥?which is what a stale or half-updated
     * module graph looks like from in here 鈥?the old code simply produced an
     * empty image and every cut-able wall went quietly solid, taking the room's
     * furniture with it and printing nothing. The shader now fails safe on its
     * own; this is so the cause gets said out loud as well.
     */
    this.focusEver = false;
    this.framesSinceFocus = 0;
    this.fbos = null;
    this.setSize(this.res[0], this.res[1]);
  }

  // ---------------------------------------------------------------- targets
  setSize(w, h) {
    const gl = this.gl;
    this.res = [w, h];
    if (this.fbos) {
      const f = this.fbos;
      gl.deleteFramebuffer(f.gbuf); gl.deleteFramebuffer(f.scene); gl.deleteFramebuffer(f.bloomA); gl.deleteFramebuffer(f.bloomB);
      gl.deleteFramebuffer(f.ghost); gl.deleteFramebuffer(f.focus);
      for (const t of f.tex) gl.deleteTexture(t);
      for (const r of f.rbo) gl.deleteRenderbuffer(r);
    }
    const mkTex = (iw, ih, internal = gl.RGBA8) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, internal, iw, ih);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const bw = Math.max(1, w >> 2), bh = Math.max(1, h >> 2);
    const gA = mkTex(w, h), gN = mkTex(w, h), gM = mkTex(w, h);
    const hA = mkTex(w, h), hN = mkTex(w, h), hM = mkTex(w, h);
    const scene = mkTex(w, h);
    const bA = mkTex(bw, bh, gl.RGBA8), bB = mkTex(bw, bh, gl.RGBA8);

    // ---- the depth buffer -------------------------------------------------
    // A 24-bit renderbuffer shared by BOTH sprite layers. The opaque layer
    // writes into it, so it holds the world's own front-most surface; the ghost
    // layer then tests against exactly that, which is what turns "is this wall
    // in the way" into a per-pixel question with a correct answer.
    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);

    const gbuf = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, gbuf);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, gA, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, gN, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, gM, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('G-buffer incomplete');

    // the ghost layer: same three channels, written by the sprites that have to
    // get out of the camera's way without leaving the lighting. It shares the
    // depth buffer (no DEPTH_ATTACHMENT of its own) so it cannot disagree with
    // the opaque layer about what is in front.
    const ghost = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, ghost);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, hA, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, hN, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, hM, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('ghost G-buffer incomplete');

    // ---- focus depth ------------------------------------------------------
    // RG = a 16-bit depth of the nearest thing the camera must be able to see,
    // 0 = nothing. Half resolution and LINEAR-filtered: this is a broad "is it
    // in the way" test whose boundary wants to be soft, and a full-resolution
    // target would be a megabyte of buffer for a decision that is already
    // smooth. The crisp edge comes from the depth buffer itself, not from here.
    const fw = Math.max(1, w >> 1), fh = Math.max(1, h >> 1);
    const focusTex = mkTex(fw, fh, gl.RGBA8);
    gl.bindTexture(gl.TEXTURE_2D, focusTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const focusDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, focusDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, fw, fh);
    const focus = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, focus);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, focusTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, focusDepth);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('focus FBO incomplete');

    const mkFbo = (tex) => {
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO incomplete');
      return f;
    };
    const sceneFbo = mkFbo(scene);
    const bloomA = mkFbo(bA);
    const bloomB = mkFbo(bB);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    this.fbos = {
      gbuf, ghost, focus, scene: sceneFbo, bloomA, bloomB,
      tex: [gA, gN, gM, hA, hN, hM, scene, bA, bB, focusTex],
      rbo: [depth, focusDepth],
      gA, gN, gM, hA, hN, hM,
      depth,
      focusTex, fw, fh,
      sceneTex: scene,
      bloomTexA: bA, bloomTexB: bB,
      bw, bh,
    };
  }

  // ---------------------------------------------------------------- textures
  setAtlases({ albedo, nrm, mat }) {
    const gl = this.gl;
    this.texAlbedo = texFromImage(gl, albedo);
    this.texNrm = texFromImage(gl, nrm);
    this.texMat = texFromImage(gl, mat);
    this.atlasSize = [albedo.width, albedo.height];
  }

  /**
   * Stamp every placed object's top-down height image into the world height
   * field. Done once per map change, not per frame.
   *
   * NOTE the two different coordinate pairs in here, because confusing them is
   * what made every outdoor shadow disappear:
   *   sp.s  = [ax0, ay0, w, h]  鈥?where the stamp lives IN THE ATLAS
   *   sp.sx / sp.sy             鈥?where the stamp's origin sits in WORLD units
   *                               relative to the sprite anchor
   * The read used to index the atlas with the sprite-local x/y only, i.e. it
   * sampled the top-left corner of the whole stamp atlas for every object on the
   * map. The field came out empty and nothing outdoors ever cast a shadow.
   *
   * @param place list of { sprite, gx, gy } with `sprite` carrying s/sx/sy/ppc/zs
   * @param opts  { install } 鈥?false builds the field WITHOUT making it active,
   *              which is what the interior needs: its field is created while the
   *              world's is still live, and replacing it here used to delete the
   *              world's texture out from under the running scene.
   */
  buildHeightmap(mapW, mapH, place, ppc = 16, opts = {}) {
    const gl = this.gl;
    const W = Math.max(1, Math.round(mapW * ppc));
    const H = Math.max(1, Math.round(mapH * ppc));
    const h = new Float32Array(W * H);      // world height
    const cov = new Uint8Array(W * H);
    const atlasW = this.stampSize ? this.stampSize[0] : 0;
    const src = this.stampData;
    for (const it of place) {
      const sp = it.sprite;
      if (!sp || !sp.s || !src) continue;
      const [ax0, ay0, sw, sh] = sp.s;
      const fp = sp.fp;
      const ax = it.gx + fp[0] / 2, ay = it.gy + fp[1] / 2;
      const ox = Math.round((ax + sp.sx) * ppc);
      const oy = Math.round((ay + sp.sy) * ppc);
      const scale = sp.zs;                  // stamp R is height / zs
      for (let y = 0; y < sh; y++) {
        const dy = oy + y;
        if (dy < 0 || dy >= H) continue;
        const srow = (ay0 + y) * atlasW;
        for (let x = 0; x < sw; x++) {
          const dx = ox + x;
          if (dx < 0 || dx >= W) continue;
          const si = (srow + ax0 + x) * 4;
          if (src[si + 1] < 8) continue;    // G = coverage
          const di = dy * W + dx;
          const hh = (src[si] / 255) * scale;
          if (hh > h[di]) h[di] = hh;
          cov[di] = 255;
        }
      }
    }
    const buf = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      buf[i * 4] = Math.max(0, Math.min(255, Math.round((h[i] / this.zScale) * 255)));
      buf[i * 4 + 1] = cov[i];
      buf[i * 4 + 2] = 0; buf[i * 4 + 3] = 255;
    }
    // keep a pristine copy of the static layer so per-frame stamps can be undone
    const base = buf.slice();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const rec = {
      W, H, texels: W * H, tex, ppc,
      info: { origin: [0, 0], size: [mapW, mapH] }, base, buf, dirty: null,
    };
    if (opts.install !== false) {
      if (this.heightTex) gl.deleteTexture(this.heightTex);
      this.heightTex = tex;
      this.heightInfo = rec.info;
      this.hmBase = base;
      this.hmBuf = buf;
      this.hmW = W; this.hmH = H; this.hmPPC = ppc;
      this.hmDirty = null;
      this.buildMaxMip();
    }
    return rec;
  }

  /**
   * Make a height field built earlier the active one. The world and every
   * interior have their own (interiors get a flat one), so this is what swaps
   * between scenes.
   */
  activateHeight(h) {
    if (!h) { this.flatHeight(); return; }
    this.heightTex = h.tex;
    this.heightInfo = h.info;
    this.hmBase = h.base;
    this.hmBuf = h.buf;
    this.hmW = h.W; this.hmH = h.H; this.hmPPC = h.ppc;
    this.hmDirty = null;
    this.buildMaxMip();
  }

  /**
   * A 1x1 zero height field. Interiors are lit by their occupancy volume, not by
   * an outdoor height field, so their shadow march has nothing to do in phase 2;
   * a zero field makes it a no-op without needing a shader branch.
   */
  flatHeight() {
    const gl = this.gl;
    if (!this.flatTex) {
      this.flatTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.flatTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    this.heightTex = this.flatTex;
    this.heightInfo = { origin: [0, 0], size: [0.001, 0.001] };
    this.hmBase = null; this.hmBuf = null;
    this.hmW = 1; this.hmH = 1; this.hmPPC = 1;
    this.buildMaxMip();
    this.hmDirty = null;
  }

  /**
   * Per-frame dynamic height stamps (characters, animals, carts...). They have
   * to live in the same field the sun ray-march reads, otherwise a character
   * walks around without ever casting a shadow or touching the ground.
   *
   * Cheap because it is done on the CPU over a tiny dirty rect: restore the
   * static layer there, paint the new blobs, upload just that sub-rectangle.
   *
   * @param blobs [{ x, y, r, h }] in world tiles
   */
  stampDynamic(blobs) {
    const gl = this.gl;
    if (!this.hmBuf) return;
    const W = this.hmW, H = this.hmH, ppc = this.hmPPC;
    const pad = 2;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    const boxes = [];
    for (const b of blobs) {
      const px0 = Math.max(0, Math.floor((b.x - b.r) * ppc) - pad);
      const py0 = Math.max(0, Math.floor((b.y - b.r) * ppc) - pad);
      const px1 = Math.min(W, Math.ceil((b.x + b.r) * ppc) + pad);
      const py1 = Math.min(H, Math.ceil((b.y + b.r) * ppc) + pad);
      if (px1 <= px0 || py1 <= py0) continue;
      boxes.push([px0, py0, px1, py1, b]);
      if (px0 < x0) x0 = px0; if (py0 < y0) y0 = py0;
      if (px1 > x1) x1 = px1; if (py1 > y1) y1 = py1;
    }
    if (!boxes.length) {
      if (!this.hmDirty) return;
      [x0, y0, x1, y1] = this.hmDirty;                       // erase previous frame
      for (let y = y0; y < y1; y++) {
        const row = y * W;
        for (let x = x0; x < x1; x++) this.hmBuf[(row + x) * 4] = this.hmBase[(row + x) * 4];
      }
      this.hmDirty = null;
      this.uploadHeight(x0, y0, x1, y1);
      return;
    }
    // restore the whole dirty region from the static layer (previous + new)
    if (this.hmDirty) {
      x0 = Math.min(x0, this.hmDirty[0]); y0 = Math.min(y0, this.hmDirty[1]);
      x1 = Math.max(x1, this.hmDirty[2]); y1 = Math.max(y1, this.hmDirty[3]);
    }
    for (let y = y0; y < y1; y++) {
      const row = y * W;
      for (let x = x0; x < x1; x++) this.hmBuf[(row + x) * 4] = this.hmBase[(row + x) * 4];
    }
    // paint the blobs with a smooth dome so the shadow catches a soft penumbra
    const k = 255 / this.zScale;
    for (const [px0, py0, px1, py1, b] of boxes) {
      for (let y = py0; y < py1; y++) {
        const dy = (y + 0.5) / ppc - b.y;
        for (let x = px0; x < px1; x++) {
          const dx = (x + 0.5) / ppc - b.x;
          const d = Math.hypot(dx, dy) / b.r;
          if (d >= 1) continue;
          const hh = b.h * Math.sqrt(Math.max(0, 1 - d * d));
          const i = (y * W + x) * 4;
          const v = Math.min(255, Math.round(hh * k));
          if (v > this.hmBuf[i]) this.hmBuf[i] = v;
        }
      }
    }
    this.hmDirty = [x0, y0, x1, y1];
    this.uploadHeight(x0, y0, x1, y1);
  }

  uploadHeight(x0, y0, x1, y1) {
    const gl = this.gl;
    const W = this.hmW;
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return;
    const sub = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const src = ((y0 + y) * W + x0) * 4;
      sub.set(this.hmBuf.subarray(src, src + w * 4), y * w * 4);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, sub);
    this.updateMaxMip(x0, y0, x1, y1);
  }

  // ------------------------------------------------------- the max pyramid
  /**
   * Build the max pyramid over the ACTIVE height field.
   *
   * Level L holds the largest height in each 2^L x 2^L block of level 0, which is
   * what lets the sun march PROVE it clears a block instead of hoping a sample
   * landed inside a caster (see HEIGHTMAX_FS, and README 搂7). It is one texture
   * with a real mip chain so `textureLod` can pick a level, filled by hand 鈥?   * `generateMipmap` averages, and an average is exactly the wrong operator here.
   */
  buildMaxMip() {
    const gl = this.gl;
    const W = this.hmW, H = this.hmH;
    if (this.maxTex) gl.deleteTexture(this.maxTex);
    this.maxW = W; this.maxH = H;
    this.maxLevels = Math.floor(Math.log2(Math.max(W, H))) + 1;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, this.maxLevels, gl.R8, W, H);
    // NEAREST_MIPMAP_NEAREST: textureLod(t, uv, L) must return the max of the
    // block that CONTAINS uv, not a blend of four of them.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.maxTex = t;
    // The framebuffer is created ONCE and then reused for ever. Deleting and
    // re-creating it here is what made the first version of this silently render
    // nothing: `deleteFramebuffer(this.maxFbo)` leaves the JS field holding a
    // name that is no longer an object, so the `if (!this.maxFbo)` below never
    // fired, every attach went to a dead framebuffer, and the pyramid stayed
    // empty 鈥?a scene with no shadows and not one error in the console.
    if (!this.maxFbo) this.maxFbo = gl.createFramebuffer();
    // scratch: one level, used to break the read-while-attached feedback loop
    if (this.maxScratch) gl.deleteTexture(this.maxScratch);
    const s = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, s);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, Math.max(1, W >> 1), Math.max(1, H >> 1));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.maxScratch = s;
    if (!this.pHeightMax) this.pHeightMax = program(gl, LIGHT_VS, HEIGHTMAX_FS);
    this.updateMaxMip(0, 0, W, H);
    return { levels: this.maxLevels, w: W, h: H };
  }

  /**
   * Refresh the pyramid for one rectangle of level 0.
   *
   * Split out because the height field is not static: `stampDynamic` repaints a
   * small rect every frame for the moving villagers, and rebuilding 2.2 M texels
   * because one of them moved would be absurd. Each level's rect is the previous
   * level's halved, so a 16-texel stamp costs a few small draws in total.
   */
  updateMaxMip(x0, y0, x1, y1) {
    const gl = this.gl;
    if (!this.maxTex || !this.heightTex) return;
    const p = this.pHeightMax;
    gl.useProgram(p.p);
    gl.bindVertexArray(this.fsVao);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.maxFbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(p.u.u_src, 0);
    let ax = Math.max(0, x0), ay = Math.max(0, y0);
    let bx = x1, by = y1;
    const draw = (srcTex, dstTex, level, copy, srcLod, rx0, ry0, rx1, ry1) => {
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(p.u.u_copy, copy ? 1 : 0);
      gl.uniform1i(p.u.u_srcLod, srcLod);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dstTex, level);
      gl.viewport(rx0, ry0, rx1 - rx0, ry1 - ry0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    // level 0: the live height field, 1:1
    {
      const rx1 = Math.min(this.maxW, bx), ry1 = Math.min(this.maxH, by);
      if (rx1 > ax && ry1 > ay) draw(this.heightTex, this.maxTex, 0, true, 0, ax, ay, rx1, ry1);
    }
    // levels 1..n: 2x2 max of the level below.
    //
    // The reduction goes through a SCRATCH texture rather than reading the
    // destination's own level L-1. A texture may not be sampled while it is
    // attached to the bound framebuffer 鈥?not even a different level of it 鈥?    // and the first version of this did exactly that. WebGL does not raise an
    // error for it; it returns zeros, so the pyramid was empty, every march
    // "proved" it was clear, and the outdoor scene rendered with no shadows at
    // all. Two passes per level: reduce into scratch, then copy scratch into the
    // level. Both are conflict-free.
    for (let l = 1; l < this.maxLevels; l++) {
      const lw = Math.max(1, this.maxW >> l), lh = Math.max(1, this.maxH >> l);
      ax = Math.floor(ax / 2); ay = Math.floor(ay / 2);
      bx = Math.ceil(bx / 2); by = Math.ceil(by / 2);
      const rx0 = Math.max(0, ax), ry0 = Math.max(0, ay);
      const rx1 = Math.min(lw, bx), ry1 = Math.min(lh, by);
      if (rx1 <= rx0 || ry1 <= ry0) break;
      draw(this.maxTex, this.maxScratch, 0, false, l - 1, rx0, ry0, rx1, ry1);
      draw(this.maxScratch, this.maxTex, l, true, 0, rx0, ry0, rx1, ry1);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** raw RGBA of the stamp atlas, needed by buildHeightmap */
  setStampImage(img) {
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    cv.getContext('2d').drawImage(img, 0, 0);
    this.stampData = cv.getContext('2d').getImageData(0, 0, img.width, img.height).data;
    this.stampSize = [img.width, img.height];
  }

  /**
   * Build the 3D transmittance volume for one interior.
   *
   * The existing shadow system is a height field: it has no concept of a hole,
   * so it can never let sunlight through a window. This volume fixes that. Each
   * voxel stores
   *     R   = transmittance   (0 = solid, 255 = open air, in between = glass)
   *     GBA = colour the light picks up while passing through
   * so a sun ray marched through it is both *shaped* by the aperture and
   * *coloured* by the pane. Stained glass, skylights and open doorways all fall
   * out of the same code for free.
   *
   * @param bounds { min:[x,y,z], max:[x,y,z] } world-space AABB
   * @param marks  [{ kind, x0,y0,z0, x1,y1,z1, trans?, tint? }] world-space boxes
   */
  /**
   * Build a volume and make it current.
   *
   * Returns the whole record, not just its summary, because a scene has to be
   * able to come back to it: `enter()` re-binds a storey's own volume on the way
   * in, and a summary without the textures behind it is exactly the bug that
   * leaves a room lit as if it had no roof. The summary (dims, voxel counts,
   * bounds) lives at `.summary` for the boot log and for worldAt's inside test.
   */
  buildVolume(bounds, marks, opts = {}) {
    const vol = this.makeVolume(bounds, marks, opts);
    this.useVolume(vol);
    return vol;
  }

  /**
   * Build ONE interior's transmittance volume and hand it back WITHOUT making it
   * current.
   *
   * There is one of these per interior SCENE, not one per game: the textures are
   * the expensive part (a 170x142x38 RGBA8 volume is 3.7 MB) and every storey of
   * a house has its own architecture, so each keeps its own. The alternative 鈥?   * one shared slot, rebuilt on the way through a door 鈥?deletes the volume the
   * other floor is standing on, which is a spectacular way to break the floor you
   * were not even looking at.
   *
   * @returns {{roomTex, roomInfo, shaftTex, shaftInfo, shaftFbo, marks, summary}}
   */
  makeVolume(bounds, marks, opts = {}) {
    const gl = this.gl;
    const ppu = opts.voxelsPerUnit ?? 14;      // horizontal resolution
    const ppz = opts.voxelsPerUnitZ ?? 11;     // vertical resolution
    const min = bounds.min, max = bounds.max;
    const sx = Math.max(0.5, max[0] - min[0]);
    const sy = Math.max(0.5, max[1] - min[1]);
    const sz = Math.max(0.5, max[2] - min[2]);
    const dx = Math.max(2, Math.ceil(sx * ppu));
    const dy = Math.max(2, Math.ceil(sy * ppu));
    const dz = Math.max(2, Math.ceil(sz * ppz));
    const data = new Uint8Array(dx * dy * dz * 4);
    // default: open air
    for (let i = 0; i < dx * dy * dz; i++) {
      data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255; data[i * 4 + 3] = 255;
    }

    const kx = dx / sx, ky = dy / sy, kz = dz / sz;
    // ---- voxel COVERAGE, not voxel membership --------------------------------
    //
    // A mark used to be rasterised by bounding box: every voxel it touched became
    // 100% solid (or 100% glass) and every voxel it missed stayed 100% air. The
    // field the light marches through was therefore binary, and a binary field
    // quantises every shadow edge and every pane of glass to the voxel grid 鈥?    // 1/14 of a world unit, 1.7 px on screen along the light's cross direction.
    //
    // What that looks like on a floor is not a soft edge and not a hard edge: it
    // is a STAIRCASE of flat plateaus, because the visibility is averaged over a
    // few discrete rays, so each quantised step comes out at a discrete level.
    // In a room with tall windows raking light across a pale floor the treads are
    // 5-10 px wide and read as "rows of light bars" stuck to the lit surface. Two
    // earlier attempts to remove them (a penumbra, and a normal offset at the
    // shading point) both missed, because neither touches the thing that is
    // quantised: the field itself.
    //
    // So each voxel now stores the FRACTION of it the mark actually covers, and
    // the field composes multiplicatively:
    //
    //   solid  T *= 1 - coverage
    //   glass  T *= 1 - coverage * (1 - trans),  tint <- lerp(tint, glassTint, coverage)
    //
    // A wall 0.17 thick still has a fully covered voxel in the middle, so it is
    // still opaque; only a ray clipping its silhouette gets a fractional value,
    // which is exactly the anti-aliasing it should have had. And because the
    // composition is a product, the result no longer depends on the ORDER of the
    // marks 鈥?the whole class of "which mark won" bugs goes with it.
    const cov = (lo, hi, size, a, b) => {
      const s = Math.min(b, hi) - Math.max(a, lo);
      return s > 0 ? s / size : 0;
    };
    const vx = 1 / kx, vy = 1 / ky, vz = 1 / kz;
    // ---- coverage is ACCUMULATED per kind, then composed once ----------------
    //
    // Marks that describe one surface routinely overlap in the voxel grid: a
    // window aperture is built one column at a time so that its head can follow
    // an arch, and each column's box — 0.036 world units wide against a 0.071
    // voxel — is rounded outward onto a whole voxel. Neighbouring columns then
    // share a voxel, and composing the pane voxel by voxel charged that shared
    // voxel TWICE, so the glass alternated between one and two thicknesses along
    // the aperture. Light through the window came out as five or six parallel
    // pencils with hard edges: the "curtain" that survives penumbra, normal
    // offsets and a finer grid, because none of those touch how many times a
    // voxel was charged.
    //
    // Two accumulators (solid coverage, glass coverage) and one pass at the end
    // fix it: coverage ADDS within a kind, and each kind is applied once. It is
    // also simply the more honest reading of a mark — a mark describes a surface,
    // not a filter stacked in front of another.
    const n3 = dx * dy * dz;
    const covS = new Float32Array(n3);
    const covG = new Float32Array(n3);
    const tAcc = new Float32Array(n3 * 3);
    const trAcc = new Float32Array(n3);
    let solidVox = 0, glassVox = 0;
    for (const mk of marks) {
      const i0 = Math.max(0, Math.floor((mk.x0 - min[0]) * kx));
      const i1 = Math.min(dx - 1, Math.ceil((mk.x1 - min[0]) * kx) - 1);
      const j0 = Math.max(0, Math.floor((mk.y0 - min[1]) * ky));
      const j1 = Math.min(dy - 1, Math.ceil((mk.y1 - min[1]) * ky) - 1);
      const k0 = Math.max(0, Math.floor((mk.z0 - min[2]) * kz));
      const k1 = Math.min(dz - 1, Math.ceil((mk.z1 - min[2]) * kz) - 1);
      if (i1 < i0 || j1 < j0 || k1 < k0) continue;
      const glass = mk.kind === 'glass';
      const tr = mk.trans ?? 0.9;
      const tint = mk.tint ?? [1, 1, 1];
      for (let k = k0; k <= k1; k++) {
        const fz = cov(min[2] + k / kz, min[2] + (k + 1) / kz, vz, mk.z0, mk.z1);
        if (fz <= 0) continue;
        for (let j = j0; j <= j1; j++) {
          const fy = cov(min[1] + j / ky, min[1] + (j + 1) / ky, vy, mk.y0, mk.y1);
          if (fy <= 0) continue;
          let idx = (k * dy + j) * dx + i0;
          for (let i = i0; i <= i1; i++, idx++) {
            const fx = cov(min[0] + i / kx, min[0] + (i + 1) / kx, vx, mk.x0, mk.x1);
            if (fx <= 0) continue;
            const c = fx * fy * fz;
            if (c <= 0.002) continue;
            if (glass) {
              covG[idx] += c;
              trAcc[idx] += tr * c;
              tAcc[idx * 3] += tint[0] * c;
              tAcc[idx * 3 + 1] += tint[1] * c;
              tAcc[idx * 3 + 2] += tint[2] * c;
            } else {
              covS[idx] += c;
            }
          }
        }
      }
    }
    for (let idx = 0; idx < n3; idx++) {
      const cs = Math.min(1, covS[idx]);
      const cg = Math.min(1, covG[idx]);
      const o = idx * 4;
      const t = cg > 0 ? 1 - cg * (1 - trAcc[idx] / covG[idx]) : 1;
      data[o] = Math.round(Math.max(0, Math.min(1, (1 - cs) * t)) * 255);
      if (cg > 0) {
        data[o + 1] = Math.round(Math.max(0, Math.min(1, tAcc[idx * 3] / covG[idx])) * 255);
        data[o + 2] = Math.round(Math.max(0, Math.min(1, tAcc[idx * 3 + 1] / covG[idx])) * 255);
        data[o + 3] = Math.round(Math.max(0, Math.min(1, tAcc[idx * 3 + 2] / covG[idx])) * 255);
      }
    }
    for (let i = 0; i < dx * dy * dz; i++) {
      if (data[i * 4] === 0) solidVox++;
      else if (data[i * 4] < 250) glassVox++;
    }

    const roomTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, roomTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, dx, dy, dz, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

    // the shader walks this volume with a 3D-DDA, so what it needs is the voxel
    // grid itself (dimensions + how many voxels there are per world unit), not a
    // step size 鈥?a step size is exactly the thing that used to leak at dawn.
    const roomInfo = {
      min, size: [sx, sy, sz], dim: [dx, dy, dz], top: max[2],
      kos: [kx, ky, kz], vox: [dx, dy, dz],
    };
    const shaft = this.makeShaftVolume(bounds, marks);
    return {
      roomTex, roomInfo,
      shaftTex: shaft.tex, shaftTexB: shaft.tex2, shaftInfo: shaft.info, shaftFbo: shaft.fbo,
      marks,
      summary: { dim: [dx, dy, dz], voxels: dx * dy * dz, solidVox, glassVox, bounds: { min, max } },
    };
  }

  /**
   * Make one volume the one the lighting pass reads.
   *
   * `roomTex`/`roomInfo`/`shaftTex`/`shaftInfo`/`shaftFbo` are kept as aliases of
   * the current volume's, so the render pass and the shaft refill go on reading
   * `this.roomInfo` exactly as before 鈥?switching storeys is this one call and
   * nothing in the hot path changes.
   *
   * Pass null outdoors: the room lights by its height field there.
   */
  useVolume(vol) {
    this.volume = vol || null;
    this.roomTex = vol ? vol.roomTex : null;
    this.roomInfo = vol ? vol.roomInfo : null;
    this.shaftTex = vol ? vol.shaftTex : null;
    this.shaftTexB = vol ? (vol.shaftTexB || null) : null;
    this.shaftBlurTex = this.shaftTex;
    if (this.fogBlurPasses === undefined) this.fogBlurPasses = 1;
    this.shaftInfo = vol ? vol.shaftInfo : null;
    this.shaftFbo = vol ? vol.shaftFbo : null;
  }

  /** release a volume's GPU resources (only for a volume being discarded) */
  disposeVolume(vol) {
    const gl = this.gl;
    if (!vol) return;
    if (this.volume === vol) this.useVolume(null);
    if (vol.roomTex) gl.deleteTexture(vol.roomTex);
    if (vol.shaftTex) gl.deleteTexture(vol.shaftTex);
    if (vol.shaftFbo) gl.deleteFramebuffer(vol.shaftFbo);
  }

  /**
   * Allocate the coarse sun-visibility volume used for volumetric shafts.
   *
   * Same bounds as the room, roughly a quarter of the resolution on each axis.
   * The beams want to be soft, so the coarseness is a feature rather than a
   * compromise, and the pass that fills it runs one small draw per z slice 鈥?a
   * few thousand fragments in total, versus the million a full-resolution build
   * would touch.
   */
  buildShaftVolume(bounds, marks) {
    const shaft = this.makeShaftVolume(bounds, marks);
    this.shaftTex = shaft.tex;
    this.shaftInfo = shaft.info;
    this.shaftFbo = shaft.fbo;
    return shaft;
  }

  /** allocate one interior's coarse sun-visibility volume (see buildShaftVolume) */
  makeShaftVolume(bounds, marks) {
    const gl = this.gl;
    const min = bounds.min, max = bounds.max;
    // ---- what the AIR volume is allowed to cover -----------------------------
    //
    // The room volume's bounds carry a 0.55 margin around the building (walls
    // drawn at the plan's edge overhang it slightly). The SHAFT volume must not
    // inherit that margin: out there the sun march starts outside the voxel grid
    // and reports open sky, so the margin is full sun at every hour, in every
    // direction. The lighting pass walks the SIGHT LINE up and out through it 鈥?    // the camera stands outside a cut-away room, so that is exactly the segment
    // it traverses 鈥?and adds all of that outdoor sky to a floor the sun never
    // reaches. The result is a hard-edged, uniformly bright band hugging the two
    // walls the camera cuts away, and it does not move when the sun does, which
    // is the tell that it is geometry and not light.
    //
    // So the air volume covers the ARCHITECTURE and nothing else: the bounding
    // box of the wall / floor / roof / glass marks. Outside it, in-scatter is
    // zero, which is both what a room's air deserves and a smooth function of
    // position 鈥?unlike testing each sight line against the wall voxels, which
    // punches window-shaped ribbons through a room whose walls are not drawn.
    let mn = min, mx = max;
    if (marks && marks.length) {
      const b0 = [Infinity, Infinity], b1 = [-Infinity, -Infinity];
      for (const mk of marks) {
        if (mk.x0 < b0[0]) b0[0] = mk.x0; if (mk.x1 > b1[0]) b1[0] = mk.x1;
        if (mk.y0 < b0[1]) b0[1] = mk.y0; if (mk.y1 > b1[1]) b1[1] = mk.y1;
      }
      if (b1[0] > b0[0] && b1[1] > b0[1]) {
        mn = [Math.max(min[0], b0[0]), Math.max(min[1], b0[1]), min[2]];
        mx = [Math.min(max[0], b1[0]), Math.min(max[1], b1[1]), max[2]];
      }
    }
    const sx = mx[0] - mn[0], sy = mx[1] - mn[1], sz = mx[2] - mn[2];
    // ---- how big the air volume's cells are ----------------------------------
    //
    // This was a fixed 56x46x32, which is a constant CELL COUNT over a per-room
    // WORLD SIZE 鈥?i.e. the cell size grew with the room. In the cottage it comes
    // out at 0.21 world units (4.85 cells per unit); in the chapel, which is 40%
    // wider and twice as tall, it came out at 0.29 lateral and 0.11 vertical. The
    // shaft pass then integrates that field along the sight line with a per-pixel
    // white-noise jitter, because a fixed march through a coarse grid lands on the
    // same phase of it every step and bands. A 40% coarser field is 40% more
    // banding for the same jitter to hide, and hiding it is what the noise IS 鈥?    // on a bright shaft seen edge-on that noise reads as a curtain of light
    // strips, and the taller the room the worse it gets.
    //
    // So the count is derived from the size at the density the cottage already
    // had: the two older interiors keep the same grid (56x46x32) and a bigger room
    // simply gets more cells instead of coarser ones.
    const SH_PPU = 4.87, SH_PPZ = 9.28;
    const nx = Math.max(8, Math.round(sx * SH_PPU));
    const ny = Math.max(8, Math.round(sy * SH_PPU));
    const nz = Math.max(8, Math.round(sz * SH_PPZ));
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, nx, ny, nz, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    // a second volume of the same size: the blur pass reads one and writes the
    // other, so the source is never bound while it is being written
    const tex2 = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex2);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, nx, ny, nz, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    const info = {
      min: [mn[0], mn[1], mn[2]],
      size: [sx, sy, sz],
      invSize: [1 / sx, 1 / sy, 1 / sz],
      dim: [nx, ny, nz],
      sun: null,                        // which sun direction it was built for
    };
    return { tex, tex2, info, fbo };
  }

  /**
   * Refill the shaft volume. Cheap enough to run whenever the sun moves; the
   * caller decides when that is (see main.js), because a still sun means still
   * beams and there is no reason to pay for them twice.
   */
  updateShaftVolume(light) {
    const gl = this.gl;
    const info = this.shaftInfo;
    const room = light.room ? this.roomInfo : null;
    if (!info || !room) return false;
    const p = this.pShaft;
    gl.useProgram(p.p);
    gl.bindVertexArray(this.fsVao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shaftFbo);
    gl.viewport(0, 0, info.dim[0], info.dim[1]);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, this.roomTex);
    gl.uniform1i(p.u.u_roomVol, 0);
    gl.uniform1i(p.u.u_hasRoom, 1);
    gl.uniform3f(p.u.u_roomMin, room.min[0], room.min[1], room.min[2]);
    gl.uniform3f(p.u.u_roomKos, room.kos[0], room.kos[1], room.kos[2]);
    gl.uniform3f(p.u.u_roomVox, room.vox[0], room.vox[1], room.vox[2]);
    gl.uniform1f(p.u.u_roomTop, room.top);
    gl.uniform3f(p.u.u_sunDir, light.sunDir[0], light.sunDir[1], light.sunDir[2]);
    gl.uniform3f(p.u.u_shaftMin, info.min[0], info.min[1], info.min[2]);
    gl.uniform3f(p.u.u_shaftSize, info.size[0], info.size[1], info.size[2]);
    gl.uniform3f(p.u.u_shaftDim, info.dim[0], info.dim[1], info.dim[2]);
    for (let k = 0; k < info.dim[2]; k++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.shaftTex, 0, k);
      gl.uniform1f(p.u.u_slice, k);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    // ---- blur the field it just wrote ---------------------------------------
    //
    // The visibility it stores is a STEP function of position — a cell is in the
    // sun or it is not — and the shaft grid is 5-10x coarser than the room grid,
    // so one cell's worth of that step is 0.2-0.3 world units of hard edge. The
    // light pass then integrates the field along the sight line and the edges come
    // out as slabs: a sunbeam standing in the air reads as a CURTAIN of parallel
    // strips rather than as a beam. That is the artefact, and it is a property of
    // the fog field, not of the glass and not of the penumbra.
    //
    // A 3x3x3 box blur over the volume is the whole fix: 190k fragments, once per
    // sun move, and the step becomes a ramp two cells wide — which is what fog
    // does to a shadow edge in the first place.
    const blurPasses = Math.max(0, Math.min(4, (light.fogBlur ?? this.fogBlurPasses ?? 1) | 0));
    if (this.shaftTexB && this.pShaftBlur && blurPasses > 0) {
      const q = this.pShaftBlur;
      gl.useProgram(q.p);
      gl.uniform3f(q.u.u_shaftDim, info.dim[0], info.dim[1], info.dim[2]);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, this.shaftTex);
      gl.uniform1i(q.u.u_src, 1);
      let src = this.shaftTex, dst = this.shaftTexB;
      for (let pass = 0; pass < blurPasses; pass++) {
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, src);
        for (let k = 0; k < info.dim[2]; k++) {
          gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, dst, 0, k);
          gl.uniform1f(q.u.u_slice, k);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
        const swap = src; src = dst; dst = swap;
      }
      this.shaftBlurTex = src;
    } else {
      this.shaftBlurTex = this.shaftTex;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    info.sun = [light.sunDir[0], light.sunDir[1], light.sunDir[2]];
    return true;
  }
  clearVolume() {
    this.useVolume(null);
  }

  // ---------------------------------------------------------------- sprites
  /**
   * @param list  prepared draw items:
   *              {org, size, uv, uvSize, z, flags, alpha, bias}
   * @param ghost true for the transparent layer (camera-facing occluders)
   */
  setInstances(list, ghost = false) {
    const n = Math.min(list.length, MAX_INSTANCES);
    const d = ghost ? this.ghostData : this.instData;
    for (let i = 0; i < n; i++) {
      const it = list[i];
      const o = i * INST_FLOATS;
      d[o] = it.org[0]; d[o + 1] = it.org[1];
      d[o + 2] = it.size[0]; d[o + 3] = it.size[1];
      d[o + 4] = it.uv[0]; d[o + 5] = it.uv[1];
      d[o + 6] = it.uvSize[0]; d[o + 7] = it.uvSize[1];
      d[o + 8] = it.z[0]; d[o + 9] = it.z[1];
      d[o + 10] = it.flags || 0;
      d[o + 11] = it.alpha ?? 1;
      d[o + 12] = it.bias || 0;
    }
    const gl = this.gl;
    const buf = ghost ? this.ghostInst : this.inst;
    if (ghost) this.ghostCount = n; else this.instCount = n;
    if (!n) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, n * INST_FLOATS), gl.DYNAMIC_DRAW);
  }

  /**
   * The volumes the camera must be able to see through, as world-space boxes.
   * Rasterised into a half-resolution depth image before the world is drawn;
   * SPRITE_FS reads it back to decide, per pixel, whether it is in the way.
   *
   * @param boxes [{x0,y0,x1,y1,z0,z1}] in world tiles / world units
   */
  setFocus(boxes) {
    const gl = this.gl;
    const n = Math.min(boxes.length, MAX_FOCUS);
    for (let i = 0; i < n; i++) {
      const b = boxes[i], o = i * 6;
      this.focusData[o] = b.x0; this.focusData[o + 1] = b.y0; this.focusData[o + 2] = b.z0;
      this.focusData[o + 3] = b.x1; this.focusData[o + 4] = b.y1; this.focusData[o + 5] = b.z1;
    }
    this.focusCount = n;
    this.focusEver = true;
    this.framesSinceFocus = 0;
    if (!n) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.focusInst);
    gl.bufferData(gl.ARRAY_BUFFER, this.focusData.subarray(0, n * 6), gl.DYNAMIC_DRAW);
  }

  /**
   * Is a focus image available to the cut-away this frame?
   *
   * The sprite shader only refines the fade per pixel when this is true. When it
   * is false the whole declared piece fades, which is the safe direction: a wall
   * that was told to get out of the way gets out of the way whether or not the
   * renderer managed to build an image saying where it was in the way.
   */
  get focusReady() { return this.focusCount > 0; }

  /** depth margin, in depth units, for a sprite category */
  categoryBias(cat) {
    return (DEPTH_BIAS[cat] ?? DEFAULT_BIAS) * BIAS_SCALE;
  }

  clearInstances() {
    this.instCount = 0;
    this.ghostCount = 0;
    this.focusCount = 0;
  }

  // ---------------------------------------------------------------- frame
  render(light, post) {
    const gl = this.gl;
    const [w, h] = this.res;
    const F = this.fbos;
    const depthK = (2 * light.iso[1]) / light.iso[2];
    const depthRange = light.depthRange || 512;
    const depthOrigin = light.depthOrigin || 0;

    // ---- (0) focus depth --------------------------------------------------
    // What the camera must be able to see, ranked by depth. Everything after
    // this reads it, so it is filled before anything else touches the buffers.
    //
    // Cleared to the FAR end of the depth range, not to zero: the image is
    // sampled with LINEAR filtering so the ghost boundary is soft, and blending
    // toward a cleared zero would make the band around the focus box keener to
    // ghost than the box itself. Cleared far, the blend is always conservative.
    gl.bindFramebuffer(gl.FRAMEBUFFER, F.focus);
    gl.viewport(0, 0, F.fw, F.fh);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.GEQUAL);
    gl.depthMask(true);
    gl.clearColor(1, 1, 0, 1);
    gl.clearDepth(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (this.focusCount > 0) {
      const p = this.pFocus;
      gl.useProgram(p.p);
      gl.bindVertexArray(this.focusVao);
      gl.uniform2f(p.u.u_res, F.fw, F.fh);
      gl.uniform2f(p.u.u_cam, light.camPx[0] * 0.5, light.camPx[1] * 0.5);
      gl.uniform3f(p.u.u_iso, light.iso[0] * 0.5, light.iso[1] * 0.5, light.iso[2] * 0.5);
      gl.uniform1f(p.u.u_depthRange, depthRange);
      gl.uniform1f(p.u.u_depthOrigin, depthOrigin);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, this.focusCount);
    }

    this.framesSinceFocus++;
    if (!this.focusEver && !this.warnedFocusMissing && this.framesSinceFocus > 90) {
      this.warnedFocusMissing = true;
      console.warn('[renderer] no cut-away focus has ever been published. The scene is '
        + 'probably running against a stale copy of src/main.js 鈥?the cut-away will fall '
        + 'back to whole-piece fades. Hard-reload (Ctrl-Shift-R) to pick up the current code.');
    }

    // ---- (1) G-buffer ----------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, F.gbuf);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    if (this.depthOff) gl.disable(gl.DEPTH_TEST); else gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.GEQUAL);
    gl.depthMask(true);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const useSprite = (layer) => {
      const p = this.pSprite;
      gl.useProgram(p.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texAlbedo);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.texNrm);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.texMat);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, F.focusTex);
      gl.uniform1i(p.u.u_albedo, 0);
      gl.uniform1i(p.u.u_nrm, 1);
      gl.uniform1i(p.u.u_mat, 2);
      gl.uniform1i(p.u.u_focus, 3);
      gl.uniform1f(p.u.u_zScale, this.zScale);
      gl.uniform2f(p.u.u_res, w, h);
      gl.uniform2f(p.u.u_cam, light.camPx[0], light.camPx[1]);
      gl.uniform3f(p.u.u_iso, light.iso[0], light.iso[1], light.iso[2]);
      gl.uniform1f(p.u.u_depthK, depthK);
      gl.uniform1f(p.u.u_depthRange, depthRange);
      gl.uniform1f(p.u.u_depthOrigin, depthOrigin);
      gl.uniform1i(p.u.u_layer, layer);
      gl.uniform1i(p.u.u_focusOn, this.focusCount > 0 ? 1 : 0);
    };

    if (this.instCount > 0) {
      useSprite(0);
      gl.bindVertexArray(this.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.instCount);
    }

    // ---- (1b) ghost layer -------------------------------------------------
    // The same sprites, the same atlas, the same projection 鈥?written into a
    // second transparent G-buffer, TESTED AGAINST THE DEPTH THE OPAQUE WORLD
    // JUST WROTE. A ghosted wall therefore still loses to anything genuinely in
    // front of it, which is what stops a cutaway from punching through the
    // villager standing in the doorway.
    //
    // The clear happens EVERY frame, not only on frames that have ghosts: the
    // light pass always samples this layer, so leaving a frame's worth of stale
    // ghosts in it composites the previous camera position over the new one.
    gl.bindFramebuffer(gl.FRAMEBUFFER, F.ghost);
    gl.viewport(0, 0, w, h);
    if (this.depthOff) gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.ghostCount > 0) {
      useSprite(1);
      gl.bindVertexArray(this.ghostVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.ghostCount);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(true);

    // ---- (2) lighting ----------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, F.scene);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.pLight.p);
    gl.bindVertexArray(this.fsVao);
    const u = this.pLight.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, F.gA);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, F.gN);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, F.gM);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_3D, this.roomTex || null);
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, F.hA);
    gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, F.hN);
    gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, F.hM);
    gl.activeTexture(gl.TEXTURE9); gl.bindTexture(gl.TEXTURE_2D, F.focusTex);
    // texture unit 8 is the shaft volume (a 3D texture), so the pyramid takes 10
    gl.activeTexture(gl.TEXTURE10); gl.bindTexture(gl.TEXTURE_2D, this.maxTex || null);
    gl.uniform1i(u.u_maxMip, 10);
    gl.uniform1f(u.u_maxMipTexel, 1 / Math.max(1, this.hmPPC || 1));
    gl.uniform1f(u.u_sunRadius, 0.00465);          // tan of the sun's 0.266 deg radius
    gl.uniform1i(u.u_maxMipOn, (this.maxMipOn && this.maxTex && this.hmPPC > 1) ? 1 : 0);
    gl.uniform1i(u.u_albedo, 0); gl.uniform1i(u.u_normal, 1);
    gl.uniform1i(u.u_mat, 2); gl.uniform1i(u.u_height, 3);
    gl.uniform1i(u.u_roomVol, 4);
    gl.uniform1i(u.u_albedoB, 5); gl.uniform1i(u.u_normalB, 6);
    gl.uniform1i(u.u_matB, 7);
    gl.uniform1i(u.u_focus, 9);
    const room = light.room ? this.roomInfo : null;
    gl.uniform1i(u.u_hasRoom, room ? 1 : 0);
    if (room) {
      gl.uniform3f(u.u_roomMin, room.min[0], room.min[1], room.min[2]);
      gl.uniform3f(u.u_roomKos, room.kos[0], room.kos[1], room.kos[2]);
      gl.uniform3f(u.u_roomVox, room.vox[0], room.vox[1], room.vox[2]);
      gl.uniform1f(u.u_roomTop, room.top);
    } else {
      gl.uniform3f(u.u_roomMin, 0, 0, 0);
      gl.uniform3f(u.u_roomKos, 1, 1, 1);
      gl.uniform3f(u.u_roomVox, 1, 1, 1);
      gl.uniform1f(u.u_roomTop, 0);
    }

    // ---- volumetric shafts (interiors only) -------------------------------
    const shaft = (room && this.shaftInfo && light.shaftAmount > 0.001) ? this.shaftInfo : null;
    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_3D, shaft ? (this.shaftBlurTex || this.shaftTex) : null);
    gl.uniform1i(u.u_shaft, 8);
    gl.uniform1f(u.u_shaftAmount, shaft ? light.shaftAmount : 0);
    gl.uniform1f(u.u_shaftJitter, light.shaftJitter ?? 0.55);
    gl.uniform1f(u.u_shaftSteps, light.shaftSteps ?? 16);
    if (shaft) {
      gl.uniform3f(u.u_shaftMin, shaft.min[0], shaft.min[1], shaft.min[2]);
      gl.uniform3f(u.u_shaftInvSize, shaft.invSize[0], shaft.invSize[1], shaft.invSize[2]);
    } else {
      gl.uniform3f(u.u_shaftMin, 0, 0, 0);
      gl.uniform3f(u.u_shaftInvSize, 1, 1, 1);
    }
    gl.uniform2f(u.u_res, w, h);
    gl.uniform2f(u.u_cam, light.camPx[0], light.camPx[1]);
    gl.uniform2f(u.u_camWorld, light.camWorld[0], light.camWorld[1]);
    gl.uniform3f(u.u_iso, light.iso[0], light.iso[1], light.iso[2]);
    gl.uniform3f(u.u_sunDir, light.sunDir[0], light.sunDir[1], light.sunDir[2]);
    gl.uniform3f(u.u_sunColor, light.sunColor[0], light.sunColor[1], light.sunColor[2]);
    gl.uniform3f(u.u_skyColor, light.skyColor[0], light.skyColor[1], light.skyColor[2]);
    gl.uniform3f(u.u_groundColor, light.groundColor[0], light.groundColor[1], light.groundColor[2]);
    gl.uniform1f(u.u_sunGain, light.sunGain);
    gl.uniform1f(u.u_ambGain, light.ambGain);
    gl.uniform2f(u.u_mapOrigin, this.heightInfo.origin[0], this.heightInfo.origin[1]);
    gl.uniform2f(u.u_mapSize, this.heightInfo.size[0], this.heightInfo.size[1]);
    gl.uniform1f(u.u_zScale, this.zScale);
    gl.uniform1f(u.u_shadowStep, light.shadowStep);
    gl.uniform1f(u.u_shadowSoft, light.shadowSoft);
    gl.uniform1f(u.u_ambShadow, light.ambShadow);
    gl.uniform1f(u.u_sunSoftIndoor, light.sunSoftIndoor ?? 0.12);
    gl.uniform1i(u.u_shadowTaps, light.shadowTaps ?? 3);
    gl.uniform3f(u.u_fogColor, light.fogColor[0], light.fogColor[1], light.fogColor[2]);
    gl.uniform1f(u.u_fogNear, light.fogNear);
    gl.uniform1f(u.u_fogFar, light.fogFar);
    gl.uniform1f(u.u_fogAmount, light.fogAmount);
    gl.uniform1f(u.u_mistHeight, light.mistHeight);
    gl.uniform1f(u.u_mistAmount, light.mistAmount);
    gl.uniform3f(u.u_eyeDir, light.eye[0], light.eye[1], light.eye[2]);
    gl.uniform1f(u.u_exposure, light.exposure);
    gl.uniform1f(u.u_sat, light.saturation);
    gl.uniform1f(u.u_indoorAmbient, light.indoorAmbient ?? 0.34);
    const ib = light.indoorBounce || [0.052, 0.034, 0.019];
    gl.uniform3f(u.u_indoorBounce, ib[0], ib[1], ib[2]);
    gl.uniform1f(u.u_indoorSun, light.indoorSun ?? 1.35);
    gl.uniform1f(u.u_ghostVeil, light.ghostVeil ?? 0.62);
    gl.uniform1f(u.u_depthRange, depthRange);
    gl.uniform1i(u.u_lightDebug, light.debug | 0);

    const L = light.lights || [];
    const n = Math.min(L.length, MAX_LIGHTS);
    const pos = new Float32Array(MAX_LIGHTS * 4), col = new Float32Array(MAX_LIGHTS * 4);
    for (let i = 0; i < n; i++) {
      const l = L[i];
      pos[i * 4] = l.x; pos[i * 4 + 1] = l.y; pos[i * 4 + 2] = l.z; pos[i * 4 + 3] = l.radius;
      col[i * 4] = l.r * l.intensity; col[i * 4 + 1] = l.g * l.intensity; col[i * 4 + 2] = l.b * l.intensity; col[i * 4 + 3] = 0;
    }
    gl.uniform4fv(u.u_lightPos, pos);
    gl.uniform4fv(u.u_lightCol, col);
    gl.uniform1i(u.u_lightCount, n);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // ---- (3) bloom -------------------------------------------------------
    let bloomReady = false;
    if (post.bloom > 0.001) {
      gl.useProgram(this.pBlur.p);
      gl.bindVertexArray(this.fsVao);
      gl.uniform2f(this.pBlur.u.u_texel, 1 / F.bw, 1 / F.bh);
      gl.uniform1i(this.pBlur.u.u_src, 0);

      // horizontal bright-pass into bloomA
      gl.bindFramebuffer(gl.FRAMEBUFFER, F.bloomA);
      gl.viewport(0, 0, F.bw, F.bh);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, F.sceneTex);
      gl.uniform1i(this.pBlur.u.u_first, 1);
      gl.uniform1f(this.pBlur.u.u_threshold, post.bloomThreshold);
      gl.uniform2f(this.pBlur.u.u_dir, 1, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // vertical blur into bloomB
      gl.bindFramebuffer(gl.FRAMEBUFFER, F.bloomB);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, F.bloomTexA);
      gl.uniform1i(this.pBlur.u.u_first, 0);
      gl.uniform2f(this.pBlur.u.u_dir, 0, 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      bloomReady = true;
    }

    // ---- (4) post -> canvas ---------------------------------------------
    // debug views: 1 = albedo, 2 = shading normal, 3 = material (AO/spec/emis),
    // 4 = world height field. Invaluable when the lighting pass misbehaves.
    const dbg = this.debug | 0;
    const srcTex = dbg === 1 ? F.gA : dbg === 2 ? F.gN : dbg === 3 ? F.gM
      : dbg === 4 ? this.heightTex : F.sceneTex;
    const useBloom = dbg === 0 && bloomReady;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.pPost.p);
    gl.bindVertexArray(this.fsVao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, useBloom ? F.bloomTexB : F.sceneTex);
    gl.uniform1i(this.pPost.u.u_scene, 0);
    gl.uniform1i(this.pPost.u.u_bloom, 1);
    gl.uniform1f(this.pPost.u.u_bloomAmount, useBloom ? post.bloom : 0);
    gl.uniform1f(this.pPost.u.u_vignette, dbg ? 0 : (post.vignette ?? 0));
    gl.uniform1f(this.pPost.u.u_grain, dbg ? 0 : (post.grain ?? 0));
    gl.uniform1f(this.pPost.u.u_time, post.time ?? 0);
    gl.uniform1i(this.pPost.u.u_dither, post.dither ?? 0);
    gl.uniform1i(this.pPost.u.u_posterize, post.posterize ?? 0);
    gl.uniform1f(this.pPost.u.u_scanline, post.scanline ?? 0);
    const lift = post.lift || [0, 0, 0], gain = post.gain || [1, 1, 1];
    gl.uniform3f(this.pPost.u.u_lift, lift[0], lift[1], lift[2]);
    gl.uniform3f(this.pPost.u.u_gain, gain[0], gain[1], gain[2]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}
