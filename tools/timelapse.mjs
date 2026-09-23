// Time-of-day timelapse GIF, captured at the game's native resolution.
//
//   node tools/timelapse.mjs --mode indoor --cutaway hide --out docs/img/indoor-timelapse.gif
//   node tools/timelapse.mjs --mode chapel --cutaway hide --out docs/img/chapel-timelapse.gif
//   node tools/timelapse.mjs --mode indoor --steps 60 --delay 80 --no-pingpong
//   node tools/timelapse.mjs --mode indoor --from 0.3 --to 0.6 --dump 0,20,40
//
// `--cutaway hide` removes the camera-side walls outright instead of fading them,
// which is the mode to capture in: nothing sits between the eye and the room.
// The openings on those walls still let the sun through — they are in the
// transmittance volume, not in the sprite list (README §1).
//
// The camera is fixed and the clock is swept, so what moves on screen is only
// the light. Three things keep the file small enough to sit in a README:
//
//   1. THE SCENE IS FROZEN (`state.paused`). Only the time of day changes, so
//      villagers, crop sway and weather drift all stop. That is not just tidier
//      to look at — it is what makes point 2 work, because a static frame means
//      very few pixels differ from one frame to the next.
//   2. ONE GLOBAL PALETTE plus one index reserved for "unchanged". Each frame
//      after the first is stored as a sparse delta: only pixels whose colour
//      moved by more than --thresh are written, the rest are transparent. On a
//      frozen scene that is most of the screen.
//   3. PING-PONG ORDER — dawn to dusk, then dusk back to dawn — so the loop is
//      seamless instead of jump-cutting from night to morning every cycle.
//
// The HUD is hidden by hiding its canvas outright. There is no state flag that
// removes it: the clock, the day bar and the footer are drawn unconditionally,
// so `state.hud.showHelp = false` alone still leaves a clock in the corner.
//
// 640x360 is the game's own WIDE render resolution and `fit()` scales by whole
// numbers only, so a viewport of exactly that size gives 1:1 pixels rather than
// a resampled canvas.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import gifenc from 'gifenc';
import { launchBrowser } from './lib/browser.mjs';
import { decodePNG, encodePNG } from './lib/png.mjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const getFlag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const SIZE = getFlag('size', '640x360');
const [W, H] = SIZE.split('x').map(Number);
const MODE = getFlag('mode', 'indoor');           // indoor | upstairs | chapel
const FROM = parseFloat(getFlag('from', '0.21'));  // 0.25 sunrise, 0.5 noon, 0.75 sunset
const TO = parseFloat(getFlag('to', '0.89'));
const STEPS = parseInt(getFlag('steps', '44'), 10);
const DELAY = parseInt(getFlag('delay', '90'), 10);
const PINGPONG = !has('no-pingpong');
const ANIMATE = has('animate');                    // let agents move too: bigger file
const THRESH = parseInt(getFlag('thresh', '7'), 10);
const ZOOM = parseInt(getFlag('zoom', '0'), 10);   // 0 = WIDE (the native 640x360)
const CAM = getFlag('cam', null);
const CUTAWAY = getFlag('cutaway', 'ghost');       // ghost | hide | off — see README §1
const SHAFT = getFlag('shaft', null);              // pin game.shaftAmount; see README §13 item 1
const CENTER = !has('no-center');                  // frame the room; --cam overrides
const PORT = Number(getFlag('port', 8219));
const OUT = path.resolve(ROOT, getFlag('out', 'docs/img/timelapse.gif'));
const DUMP = (getFlag('dump', '') || '').split(',').filter(Boolean).map(Number);

const lerp = (a, b, t) => a + (b - a) * t;
const clockOf = (t) => {
  const mins = Math.round(t * 24 * 60) % 1440;
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
};

// ------------------------------------------------------------------ schedule
const times = [];
for (let i = 0; i < STEPS; i++) times.push(lerp(FROM, TO, STEPS === 1 ? 0 : i / (STEPS - 1)));
if (PINGPONG) for (let i = STEPS - 2; i >= 1; i--) times.push(times[i]);

// -------------------------------------------------------------------- server
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.css': 'text/css; charset=utf-8',
};
let server = null;
if (!argv.includes('--url')) {
  server = http.createServer((req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/' || p === '') p = '/index.html';
      const file = path.join(ROOT, path.normalize(p).replace(/^([/\\])+/, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end('nope'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch (e) { res.writeHead(500).end(String(e.message)); }
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
}
const url = getFlag('url', `http://127.0.0.1:${PORT}/`);

// ------------------------------------------------------------------- capture
const browser = await launchBrowser({ width: W, height: H, announce: true });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await page.goto(url, { waitUntil: 'domcontentloaded' });
try {
  await page.waitForFunction('window.game && window.game.renderer', { timeout: 60000 });
} catch {
  console.error('boot failed');
  for (const e of errs) console.error('  ' + e);
  console.error('  boot panel:', await page.evaluate(() => document.getElementById('boot')?.textContent || ''));
  await browser.close(); if (server) server.close();
  process.exit(1);
}

const info = await page.evaluate(([mode, zoom, cam, animate, cutaway, shaft, center]) => {
  const g = window.game;
  g.state.paused = true;                       // freeze everything but the clock
  g.state.hud.showHelp = false;
  g.state.hud.showStats = false;
  g.state.hud.weather = 'CLEAR';
  g.state.hud.weatherMix = 0;                  // clear sky: the sun is the subject

  // How the camera-side walls are treated. 'hide' removes them outright — an open
  // doll's-house view with nothing between the eye and the room. Note that the
  // windows on those walls go with them (they are the same pieces), while the
  // sunlight is unaffected: the openings live in the transmittance volume, which
  // this switch never touches (README §1).
  g.cutaway = cutaway;
  // `hide` also drops the air-scatter term from 0.28 to 0.18, which is a wart the
  // README calls out (§13 item 1): the switch is not supposed to change lighting.
  // --shaft pins it so a capture is not quietly two changes at once.
  if (shaft !== null) g.shaftAmount = shaft;

  // The HUD canvas is hidden rather than switched off — its clock and footer have
  // no off switch, and a frame with a clock in the corner is not a still.
  document.getElementById('ui').style.display = 'none';
  document.getElementById('boot').style.display = 'none';

  g.setZoom(zoom);
  if (mode && mode !== 'outdoor') g.enter(mode);
  // enter() does not move the camera — it only re-binds projection, atlas and
  // volume, and clampCam() afterwards merely stops the new camera from leaving
  // the new room. So the camera keeps whatever position it held in the previous
  // scene, clamped: the chapel comes out visibly off-centre if you walk in from
  // the world map. Centre it explicitly, which is what "frame the room" means.
  if (cam) { g.cam.x = cam[0]; g.cam.y = cam[1]; }
  else if (center) { const r = g.current.scene; g.cam.x = r.w / 2; g.cam.y = r.h / 2; }
  if (animate) g.state.paused = false;

  const r = g.current.scene;
  return { mode: g.mode, res: g.RES.slice(), storey: g.storey, cutaway: g.cutaway, shaft: g.shaftAmount, room: [r.w, r.h], cam: [g.cam.x, g.cam.y] };
}, [MODE, ZOOM, CAM ? CAM.split(',').map(Number) : null, ANIMATE, CUTAWAY, SHAFT === null ? null : Number(SHAFT), CENTER]);

console.log(`· scene ${info.mode}  ·  internal ${info.res.join('x')}  ·  canvas ${W}x${H}  ·  frames ${times.length}`);
console.log(`· cutaway ${info.cutaway}  ·  shaft ${info.shaft}  ·  room ${info.room.join('x')}  ·  cam ${info.cam.map((v) => v.toFixed(1)).join(',')}`);

// let the first frames settle (atlas upload, volume bind, camera clamp)
await new Promise((r) => setTimeout(r, 1200));

const frames = [];
for (let i = 0; i < times.length; i++) {
  await page.evaluate((t) => { window.game.state.time = t; }, times[i]);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  // puppeteer returns a Uint8Array here, and decodePNG wants a Node Buffer
  const img = decodePNG(Buffer.from(await page.screenshot({ type: 'png' })));

  // nearest-neighbour to the target size (only needed if the viewport and the
  // canvas disagree, but silently producing a resampled GIF is worse)
  let rgba;
  if (img.width === W && img.height === H) {
    rgba = img.rgba;
  } else {
    rgba = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) {
      const sy = Math.min(img.height - 1, Math.round(y * img.height / H));
      for (let x = 0; x < W; x++) {
        const sx = Math.min(img.width - 1, Math.round(x * img.width / W));
        const si = (sy * img.width + sx) * 4, di = (y * W + x) * 4;
        rgba[di] = img.rgba[si]; rgba[di + 1] = img.rgba[si + 1];
        rgba[di + 2] = img.rgba[si + 2]; rgba[di + 3] = 255;
      }
    }
  }
  frames.push(rgba);
  process.stdout.write(`\r· frame ${i + 1}/${times.length}  ${clockOf(times[i])}   `);
}
console.log('');

// ----------------------------------------------------------- global palette
// Sample across the loop, not just the first frames: dawn and dusk are the two
// ends of the range and a palette built from midday alone would band both.
const SAMPLE_N = Math.min(frames.length, 8);
const px = W * H * 4;
const sample = new Uint8Array(SAMPLE_N * px);
for (let i = 0; i < SAMPLE_N; i++) {
  const f = frames[Math.floor(i * (frames.length - 1) / Math.max(1, SAMPLE_N - 1))];
  sample.set(f, i * px);
}
const palette = quantize(sample, 255, { format: 'rgb565' });
const TRANSPARENT = palette.length;            // one spare index means "unchanged"
palette.push([0, 0, 0]);
console.log(`· palette ${palette.length - 1} colours + 1 transparent index`);

// ------------------------------------------------------------------- encode
const gif = GIFEncoder({ initialCapacity: 1 << 22 });
let changedTotal = 0;
for (let i = 0; i < frames.length; i++) {
  const index = applyPalette(frames[i], palette, 'rgb565');
  if (i === 0) {
    gif.writeFrame(index, W, H, { palette, delay: DELAY, repeat: 0 });
    continue;
  }
  const cur = frames[i], prv = frames[i - 1];
  let changed = 0;
  for (let k = 0, q = 0; k < index.length; k++, q += 4) {
    const d = Math.abs(cur[q] - prv[q]) + Math.abs(cur[q + 1] - prv[q + 1]) + Math.abs(cur[q + 2] - prv[q + 2]);
    if (d > THRESH) changed++;
    else index[k] = TRANSPARENT;
  }
  changedTotal += changed;
  gif.writeFrame(index, W, H, {
    delay: DELAY, transparent: true, transparentIndex: TRANSPARENT, dispose: 1,
  });
}
gif.finish();
const bytes = Buffer.from(gif.bytes());
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, bytes);

// raw frames on request, so the GIF can be checked against what was captured
// (the capture buffers are already RGBA, which is what encodePNG wants for 6)
if (DUMP.length) {
  const dir = path.join(ROOT, 'work/timelapse');
  fs.mkdirSync(dir, { recursive: true });
  for (const k of DUMP) {
    if (k < 0 || k >= frames.length) continue;
    const f = path.join(dir, `src_${String(k).padStart(3, '0')}.png`);
    fs.writeFileSync(f, encodePNG({ width: W, height: H, data: frames[k], colorType: 6 }));
    console.log(`· dumped ${path.relative(ROOT, f)}  (t=${times[k].toFixed(3)} ${clockOf(times[k])})`);
  }
}

const avg = (changedTotal / Math.max(1, frames.length - 1) / (W * H) * 100).toFixed(1);
console.log(`· ${path.relative(ROOT, OUT)}`);
console.log(`  ${W}x${H} · ${frames.length} frames · ${(frames.length * DELAY / 1000).toFixed(1)}s loop · ${(bytes.length / 1024).toFixed(0)} kB (${(bytes.length / frames.length / 1024).toFixed(1)} kB/frame)`);
console.log(`  mean changed pixels ${avg}% (threshold ${THRESH})`);
if (errs.length) console.log(`  errors: ${errs.join(' | ')}`);

await browser.close();
if (server) server.close();
