// End-to-end smoke test: boots the game, verifies it renders, animates, responds
// to input, and reports frame cost. Fails loudly instead of producing a
// plausible-looking screenshot of a broken build.
//
//   node tools/verify.mjs [--url http://...]

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const argVal = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(argVal('--port', 8201));
const OUT = path.resolve(ROOT, argVal('--out', 'work/verify'));
fs.mkdirSync(OUT, { recursive: true });

// ---- 0. the sources parse ---------------------------------------------------
// Cheap, and it runs before a browser is launched, because the whole page fails
// to boot on a syntax error. shaders.js holds GLSL inside template literals, so
// a stray backtick in a shader COMMENT silently ends the string and the only
// symptom is "BOOT FAILED" with no file name. This names the file and the line.
{
  const { execFileSync } = await import('node:child_process');
  const files = fs.readdirSync(path.join(ROOT, 'src'), { recursive: true })
    .filter((f) => String(f).endsWith('.js'))
    .map((f) => path.join('src', String(f)));
  const bad = [];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
    } catch (e) {
      const msg = String(e.stderr || e.message).split('\n').filter((l) => /Error|^\s+\^/.test(l)).slice(0, 2).join(' ');
      bad.push(`${f}: ${msg.trim()}`);
    }
  }
  console.log(bad.length ? `  syntax: ${bad.length} broken file(s)\n    ${bad.join('\n    ')}\n`
    : `  syntax: ${files.length} runtime modules parse cleanly`);
  if (bad.length) process.exit(1);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
let server = null;
if (!argv.includes('--url')) {
  server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/' || p === '') p = '/index.html';
    const file = path.join(ROOT, path.normalize(p).replace(/^([/\\])+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end('nope'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
}
const url = argVal('--url', `http://127.0.0.1:${PORT}/`);

const browser = await launchBrowser({ width: 1280, height: 720 });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.game && window.game.renderer', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1200));

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); };

// ---- 1. the frame is not blank ---------------------------------------------
const stats = await page.evaluate(() => {
  const c = document.getElementById('gl');
  const g = c.getContext('webgl2');
  const px = new Uint8Array(c.width * c.height * 4);
  g.readPixels(0, 0, c.width, c.height, g.RGBA, g.UNSIGNED_BYTE, px);
  let lit = 0, sum = 0;
  const colours = new Set();
  for (let i = 0; i < px.length; i += 4) {
    const v = px[i] + px[i + 1] + px[i + 2];
    sum += v;
    if (v > 24) lit++;
    if (i % 400 === 0) colours.add((px[i] >> 3) << 10 | (px[i + 1] >> 3) << 5 | (px[i + 2] >> 3));
  }
  const n = px.length / 4;
  return { lit: lit / n, mean: sum / (n * 3) / 255, colours: colours.size };
});
check('frame is lit', stats.lit > 0.85, `${(stats.lit * 100).toFixed(1)}% of pixels above black`);
check('frame has contrast', stats.mean > 0.10 && stats.mean < 0.85, `mean luminance ${stats.mean.toFixed(3)}`);
check('frame is not a flat fill', stats.colours > 40, `${stats.colours} sampled distinct colours`);

// ---- 2. characters animate --------------------------------------------------
const anim = await page.evaluate(async () => {
  window.game.state.paused = false;
  await new Promise((r) => setTimeout(r, 1400));
  const snap = () => window.game.agents.map((x) => [x.x, x.y, x.action, x.frame]);
  const a = snap();
  await new Promise((r) => setTimeout(r, 900));
  return { a, b: snap() };
});
{
  const moved = anim.a.filter((p, i) => Math.hypot(p[0] - anim.b[i][0], p[1] - anim.b[i][1]) > 0.1
    || p[2] !== anim.b[i][2]).length;
  check('characters animate', moved > 0,
    `${moved}/${anim.a.length} agents moved or changed action`);
}

// ---- 3. input works ---------------------------------------------------------
const input = await page.evaluate(async () => {
  window.game.state.paused = true;
  const t0 = window.game.state.time;
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit5' }));
  await new Promise((r) => setTimeout(r, 120));
  const t1 = window.game.state.time;
  const cam0 = { ...window.game.cam };
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD' }));
  await new Promise((r) => setTimeout(r, 220));
  const cam1 = { ...window.game.cam };
  return { t0, t1, camMoved: Math.hypot(cam1.x - cam0.x, cam1.y - cam0.y) };
});
check('time-of-day keys respond', Math.abs(input.t1 - 0.94) < 0.02, `Digit5 -> t=${input.t1.toFixed(3)}`);
check('camera keys respond', input.camMoved > 0.2, `moved ${input.camMoved.toFixed(2)} tiles`);

// ---- 4. the sun actually moves the shading --------------------------------
// Total frame energy is a poor test: morning and afternoon can be equally bright
// while every shadow has swung to the other side. Compare the images instead.
const shadow = await page.evaluate(async () => {
  const grab = () => {
    const c = document.getElementById('gl');
    const g = c.getContext('webgl2');
    const px = new Uint8Array(c.width * c.height * 4);
    g.readPixels(0, 0, c.width, c.height, g.RGBA, g.UNSIGNED_BYTE, px);
    return Array.from(px);
  };
  window.game.state.paused = true;
  window.game.state.time = 0.30; await new Promise((r) => setTimeout(r, 300));
  const a = grab();
  window.game.state.time = 0.70; await new Promise((r) => setTimeout(r, 300));
  const b = grab();
  let diff = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d > 24) diff++;
    n++;
  }
  return { frac: diff / n };
});
check('sun moves the shading', shadow.frac > 0.15,
  `${(shadow.frac * 100).toFixed(1)}% of pixels changed between 07:00 and 17:00`);

// ---- 5. cost ---------------------------------------------------------------
const perf = await page.evaluate(async () => {
  window.game.state.paused = false;
  const samples = [];
  let last = performance.now();
  await new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      const t = performance.now();
      samples.push(t - last); last = t;
      if (++n < 60) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  samples.sort((a, b) => a - b);
  const inst = window.game.renderer.instCount;
  return { median: samples[samples.length >> 1], inst, sprites: Object.keys(window.game.atlas.sprites).length };
});
console.log(`  draw: ${perf.inst} instances this frame, ${perf.sprites} sprites in atlas`);
console.log(`  frame time (SwiftShader software rasteriser): ${perf.median.toFixed(1)} ms`);

// ---- 6. two scenes, two scales ---------------------------------------------
const scenes = await page.evaluate(() => {
  const g = window.game;
  const probe = () => ({
    mode: g.mode,
    ground: g.current.groundList.length, objs: g.current.objList.length,
    scale: g.current.atlas.m.scale,
  });
  const out = probe();
  g.enter('indoor');
  const ind = probe();
  g.enter('outdoor');
  return { out, ind, hasRoom: !!g.room };
});
check('two scenes exist', scenes.hasRoom, scenes.hasRoom ? 'world + interior built' : 'interior missing');
check('scene switch changes the map', scenes.ind.ground !== scenes.out.ground,
  `world ${scenes.out.ground}+${scenes.out.objs} @${scenes.out.scale}x, `
  + `interior ${scenes.ind.ground}+${scenes.ind.objs} @${scenes.ind.scale}x`);

// ---- 6b. the third interior, and the colours in it --------------------------
//
// A new map is only worth anything if it can be ENTERED, so this walks the floor
// key through every storey the game declares and checks the room that comes back.
// The interesting half is the glass: the chapel's whole reason to exist is that
// the transmittance volume paints five different colours on the floor, and the
// colours live in the scene's marks. `buildVolume` copies them into the volume,
// the shader multiplies them into the sun, and the failure mode when any link in
// that chain is broken is a room that looks completely ordinary — which is
// exactly the kind of bug a check has to catch, because nobody files it.
const third = await page.evaluate(() => {
  const g = window.game;
  const seen = [];
  for (const name of g.STOREYS) {
    g.enter(name);
    if (g.mode !== name) { seen.push({ name, entered: false }); continue; }
    const s = g.current.scene;
    const marks = s.marks || [];
    const tints = new Set();
    let glass = 0;
    for (const m of marks) {
      if (m.kind !== 'glass') continue;
      glass++;
      tints.add((m.tint || [1, 1, 1]).map((v) => v.toFixed(2)).join(','));
    }
    seen.push({
      name, entered: true, w: s.w, h: s.h, glass, tints: [...tints],
      vol: g.current.volume ? g.current.volume.dim.join('x') : null,
      cap: g.current.volume ? g.current.volume.bounds.max[2] : 0,
    });
  }
  return seen;
});
const chapel = third.find((s) => s.name === 'chapel');
check('every declared storey can be entered', third.every((s) => s.entered),
  third.map((s) => `${s.name}${s.entered ? '' : ' MISSING'}`).join(' + '));
check('the chapel is a bigger room than the house', !!chapel && chapel.w * chapel.h > 99,
  chapel ? `${chapel.w}x${chapel.h} tiles, volume ${chapel.vol}, ceiling ${chapel.cap.toFixed(2)}` : 'not found');
check('its stained glass carries more than one colour', !!chapel && chapel.tints.length >= 5,
  chapel ? `${chapel.glass} glass marks in ${chapel.tints.length} distinct tints` : 'not found');

// ---- 7. interior light transport -------------------------------------------
// The point of the 3D occupancy volume: sunlight must actually get INSIDE
// through the windows, and the resulting patch has to move as the sun does.
// Measured by finding the brightest interior pixels, which is the sun patch.
const interior = await page.evaluate(async () => {
  const g = window.game;
  if (!g.room) return { ok: false, why: 'no interior' };
  g.enter('indoor');
  g.setZoom(2);

  const frames = {};
  const sample = async (t) => {
    g.state.paused = true;
    g.state.time = t;
    await new Promise((r) => setTimeout(r, 400));
    const c = document.getElementById('gl');
    const gl = c.getContext('webgl2');
    const px = new Uint8Array(c.width * c.height * 4);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const lum = new Float32Array(c.width * c.height);
    let sum = 0;
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const l = px[i] * 0.3 + px[i + 1] * 0.6 + px[i + 2] * 0.1;
      lum[j] = l; sum += l;
    }
    const sorted = lum.slice().sort((a, b) => b - a);
    // keep the raw frame in the PAGE: shipping ~1 MB of pixels back through the
    // CDP bridge per sample is slow, and typed arrays do not survive it intact
    frames[t] = px;
    return { peak: sorted[0], hot: sorted.filter((l) => l > 90).length, mean: sum / lum.length };
  };

  const morning = await sample(0.27);      // sunrise — the shaft rakes one way
  const evening = await sample(0.72);      // golden hour — and now the other
  const night = await sample(0.94);
  const lightsAt = async (t) => {
    g.state.time = t;
    await new Promise((r) => setTimeout(r, 200));
    return { total: g.lastLights, portals: g.lastPortals };
  };
  const lampsDay = await lightsAt(0.50);
  const lampsNight = await lightsAt(0.94);

  // The room is sealed, so the ONLY light in it arrives through an aperture.
  // What moves between morning and evening is which wall that aperture is in and
  // how far the shaft rakes across the floor, so compare the images.
  const A = frames[0.27], B = frames[0.72];
  let diff = 0, total = 0;
  for (let i = 0; i < A.length; i += 4) {
    const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
    if (d > 24) diff++;
    total++;
  }
  const moved = diff / total;
  g.setZoom(0);
  g.enter('outdoor');
  return { ok: true, morning, evening, night, moved, lampsDay, lampsNight };
});
if (!interior.ok) {
  check('interior light transport', false, interior.why);
} else {
  const m = interior.morning, e = interior.evening, n = interior.night;
  check('sunlight reaches inside', m.hot > 40 && e.hot > 40,
    `${m.hot} / ${e.hot} bright interior px at 07:30 and 16:50`);
  check('the light in the room tracks the sun', interior.moved > 0.15,
    `${(interior.moved * 100).toFixed(1)}% of interior pixels changed between sunrise and golden hour`);
  check('the room is dimmer at night', n.mean < m.mean,
    `mean luminance ${m.mean.toFixed(1)} by day vs ${n.mean.toFixed(1)} at night`);
  check('daylight fill comes from the windows, not the lamps',
    interior.lampsDay.portals > 4 && interior.lampsNight.portals === 0
    && interior.lampsNight.total - interior.lampsNight.portals > 0,
    `noon: ${interior.lampsDay.portals} window portals of ${interior.lampsDay.total} lights · `
    + `night: ${interior.lampsNight.portals} portals, `
    + `${interior.lampsNight.total - interior.lampsNight.portals} lit fixtures`);
}

// ---- 9. the cutaway --------------------------------------------------------
// "Out of the camera's way" and "out of the sun's way" have to be two different
// decisions. This checks both halves: the camera-facing walls really do move into
// the transparent layer, AND the sun still cannot get through them.
//
// The camera half is now measured on the PICTURE rather than on an internal
// list, because occlusion moved into the depth buffer and there is no longer a
// per-sprite yes/no to read off. That is a better test anyway: `focusOff` renders
// the same frame with the cutaway disabled, so "this building faded when it did
// not need to" becomes a pixel diff instead of an opinion.
const cut = await page.evaluate(async () => {
  const g = window.game;
  const layer = () => ({ ghost: g.renderer.ghostCount, opaque: g.renderer.instCount, ids: g.ghostIds.slice() });
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const grab = () => {
    const c = document.getElementById('gl');
    const gl = c.getContext('webgl2');
    const px = new Uint8Array(c.width * c.height * 4);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const diff = (a, b) => {
    let n = 0, worst = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d > 24) n++;
      if (d > worst) worst = d;
    }
    return { n, worst, frac: n / (a.length / 4) };
  };

  g.enter('outdoor');
  g.setZoom(0);
  g.state.paused = true;
  // Park EVERY villager out in the open, far from every building. Parking only
  // WREN is not enough — another villager in the kitchen garden sits behind the
  // farmhouse for most of the day.
  for (const [i, a] of g.OUT.agents.entries()) {
    a.route = null; a.speed = 0;
    a.x = 4 + (i % 3); a.y = 4 + Math.floor(i / 3);
  }
  await settle(300);
  const openOn = grab();
  g.focusOff = true;
  await settle(300);
  const openOff = grab();
  g.focusOff = false;
  await settle(300);

  // The whole point of the rewrite: with nobody behind anything, the cutaway
  // must be a NO-OP. The old rectangle test could not promise this.
  const spurious = diff(openOn, openOff);

  const wren = g.OUT.agents.find((a) => a.name === 'WREN');
  // Put WREN behind the farmhouse: in isometric depth that means a SMALLER x+y
  // than the building's own centre, which is what "behind" means here.
  wren.x = g.house.x0 + 4; wren.y = g.house.y0 - 1;
  await settle(320);
  const behindOn = grab();
  g.focusOff = true;
  await settle(320);
  const behindOff = grab();
  g.focusOff = false;

  // ...and now the pixels that differ ARE the cutaway: with the focus off she is
  // simply hidden by the building, with it on the building gets out of the way.
  const revealed = diff(behindOn, behindOff);
  // How big is the building on screen? The cutaway has to be a SILHOUETTE of the
  // villager standing behind it, not the whole frontage fading — that is the
  // property that replaced the old bounding-rectangle behaviour.
  const sp = g.current.atlas.get('bld_farmhouse');
  const buildingPx = sp ? sp.w * sp.h : 1;

  g.enter('indoor');
  await settle(300);
  const indoorLayer = layer();

  // and the lighting half: a sun ray must still be blocked by walls that are
  // currently being ghosted. Sample the shadow term on the wall's own pixels.
  g.lightDebug = 1;
  await settle(300);
  const c = document.getElementById('gl');
  const gl = c.getContext('webgl2');
  const px = new Uint8Array(c.width * c.height * 4);
  gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let lit = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) { if (px[i] > 200) lit++; n++; }
  g.lightDebug = 0;
  g.enter('outdoor');
  wren.route = [[22.6, 19.4], [30.2, 19.4], [30.2, 25.6], [24.6, 25.6], [24.6, 21.6], [22.6, 21.6]];
  wren.speed = 1.7;
  await settle(200);
  g.focusOff = true;
  await settle(300);
  const outdoorLayer = layer();
  g.focusOff = false;
  return {
    openOn: layer(), indoor: indoorLayer, outdoor: outdoorLayer,
    spurious, revealed, buildingPx, litFrac: lit / n,
  };
});
check('interior walls are ghosted for the camera', cut.indoor.ghost >= 8,
  `${cut.indoor.ghost} wall pieces in the transparent layer, ${cut.indoor.opaque} opaque`);
check('cut-away is a no-op when nothing is behind anything', cut.spurious.n === 0,
  `${cut.spurious.n} px changed with the focus off (worst channel delta ${cut.spurious.worst})`);
check('a villager behind a building is revealed', cut.revealed.n > 30 && cut.revealed.worst > 60,
  `${cut.revealed.n} px revealed, worst delta ${cut.revealed.worst}`);
check('...and only where they are, not the whole facade',
  cut.revealed.n < cut.buildingPx * 0.35,
  `${cut.revealed.n} px of a ${cut.buildingPx} px building (${(cut.revealed.n / cut.buildingPx * 100).toFixed(1)}%)`);
check('ghosted walls still block the sun', cut.litFrac < 0.25,
  `${(cut.litFrac * 100).toFixed(1)}% of interior pixels in direct sun`);

// ---- 8. screenshots --------------------------------------------------------
for (const [name, t, md] of [['day', 0.42, 'outdoor'], ['room', 0.32, 'indoor']]) {
  await page.evaluate(async (tt, mm) => {
    window.game.enter(mm);
    window.game.state.paused = true;
    window.game.state.time = tt;
    window.game.state.hud.weather = 'CLEAR';
    window.game.state.hud.weatherMix = 0;
    await new Promise((r) => setTimeout(r, 300));
  }, t, md);
  await new Promise((r) => setTimeout(r, 260));
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}
await page.evaluate(() => window.game.enter('outdoor'));
check('no runtime errors', errors.length === 0, errors.slice(0, 4).join(' | ') || 'clean');

console.log('');
let bad = 0;
for (const c of checks) {
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(34)} ${c.detail}`);
  if (!c.ok) bad++;
}
console.log(`\n${checks.length - bad}/${checks.length} checks passed -> ${path.relative(ROOT, OUT)}`);

await browser.close();
if (server) server.close();
process.exit(bad ? 1 : 0);
