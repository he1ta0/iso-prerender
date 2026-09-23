// Headless screenshot harness.
//
//   node tools/shoot.mjs                          # 1920x1080, all presets
//   node tools/shoot.mjs --native                 # exactly 640x360 (1:1 pixels)
//   node tools/shoot.mjs --presets noon,night --out work/shots
//
// Freezes the game (paused) and pins the time of day so shots are comparable
// between runs. Boots its own static server unless --url is given.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const argVal = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const NATIVE = argv.includes('--native');
const OUT = path.resolve(ROOT, argVal('--out', 'work/shots'));
const PORT = Number(argVal('--port', 8199));
const W = NATIVE ? 640 : Number(argVal('--w', 1920));
const H = NATIVE ? 360 : Number(argVal('--h', 1080));

// 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset (matches daylight.js)
const PRESETS = {
  predawn: { t: 0.20, weather: 'CLEAR' },
  sunrise: { t: 0.25, weather: 'CLEAR' },
  morning: { t: 0.32, weather: 'CLEAR' },
  mist: { t: 0.29, weather: 'FOG' },
  noon: { t: 0.50, weather: 'CLEAR' },
  afternoon: { t: 0.61, weather: 'CLEAR' },
  golden: { t: 0.70, weather: 'CLEAR' },
  sunset: { t: 0.75, weather: 'CLEAR' },
  dusk: { t: 0.81, weather: 'CLEAR' },
  night: { t: 0.94, weather: 'CLEAR' },
  rain: { t: 0.44, weather: 'RAIN' },
  rainnight: { t: 0.88, weather: 'RAIN' },
};
const names = (argVal('--presets', Object.keys(PRESETS).join(',')) || '').split(',').filter(Boolean);
// --time 0.42 pins an exact time of day instead of a named preset, so a frame
// grabbed while playing (the HUD clock tells you the time) can be reproduced.
const TIME = argVal('--time', null) !== null ? Number(argVal('--time')) : null;

fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- server
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
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end('nope'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch (e) { res.writeHead(500).end(String(e.message)); }
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
}
const url = argVal('--url', `http://127.0.0.1:${PORT}/`);

const browser = await launchBrowser({ width: W, height: H, announce: true });

const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: 'domcontentloaded' });

// wait for the game to boot (main.js sets window.game)
try {
  await page.waitForFunction('window.game && window.game.renderer', { timeout: 30000 });
} catch (e) {
  console.error('boot failed');
  for (const l of logs) console.error('  ' + l);
  const boot = await page.evaluate(() => document.getElementById('boot')?.textContent || '');
  console.error('  boot panel:', boot);
  await browser.close(); if (server) server.close();
  process.exit(1);
}

// let a few frames render so the first screenshot is not the cleared buffer
await new Promise((r) => setTimeout(r, 900));

const report = [];
const DEBUG = Number(argVal('--debug', 0));
const ZOOMIDX = Number(argVal('--zoom', -1));
const CAM = argVal('--cam', null);
const CUT = argVal('--cut', null);
const MODE = argVal('--mode', null);
const LDBG = Number(argVal('--lightdebug', 0));
const HUD = argVal('--hud', null) !== '0';
// which roles to switch off 鈥?see state.hide in src/main.js
const HIDE = (argVal('--hide', '') || '').split(',').filter(Boolean);
const DEPTHOFF = argv.includes('--depthoff');
// how the camera-side walls are treated: ghost (fade) | hide | off
const CUTAWAY = argVal('--cutaway', null);
for (const name of names) {
  const p = TIME !== null ? { t: TIME, weather: PRESETS[name]?.weather || 'CLEAR' } : PRESETS[name];
  if (!p) continue;
  await page.evaluate((t, w, d, z, cam, cut, hud, md, ld, hide, cutaway) => {
    window.game.state.paused = true;
    window.game.state.time = t;
    window.game.state.hud.weather = w;
    window.game.state.hud.weatherMix = w === 'CLEAR' ? 0 : 1;
    window.game.renderer.debug = d;
    window.game.lightDebug = ld;
    window.game.state.hud.showHelp = hud && !d;
    window.game.state.hud.showStats = false;
    if (cut) window.game.state.cutaway = cut;
    if (md) window.game.enter(md);
    if (z >= 0) window.game.setZoom(z);
    if (cam) { window.game.cam.x = cam[0]; window.game.cam.y = cam[1]; }
    if (hide) for (const k of Object.keys(window.game.hide)) window.game.hide[k] = hide.includes(k);
    if (cutaway) window.game.cutaway = cutaway;
  }, p.t, p.weather, DEBUG, ZOOMIDX, CAM ? CAM.split(',').map(Number) : null, CUT, HUD, MODE, LDBG, HIDE, CUTAWAY);
  // QA: draw with no depth test at all — the pre-depth-buffer behaviour
  if (DEPTHOFF) await page.evaluate(() => { window.game.depthOff = true; });
  await new Promise((r) => setTimeout(r, 380));
  const tag = [DEBUG ? `dbg${DEBUG}` : '', LDBG ? `ldbg${LDBG}` : '', ZOOMIDX >= 0 ? `z${ZOOMIDX}` : '', MODE || '',
    CUTAWAY ? `cut-${CUTAWAY}` : '', HIDE.length ? `hide-${HIDE.join('_')}` : '']
    .filter(Boolean).join('_');
  const file = path.join(OUT, `${name}${tag ? `_${tag}` : ''}.png`);
  await page.screenshot({ path: file });
  const st = fs.statSync(file);
  report.push(`${name.padEnd(10)} t=${p.t.toFixed(2)} ${p.weather.padEnd(5)} ${(st.size / 1024).toFixed(0)} KB`);
}

const info = await page.evaluate(() => ({
  sprites: window.game.scene.objects.length,
  res: window.game.RES,
  gl: (() => { const g = window.game.renderer.gl; const d = g.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a'; })(),
}));

console.log(`\nrendered ${report.length} shot(s) -> ${path.relative(ROOT, OUT)}  [${W}x${H}]`);
for (const r of report) console.log('  ' + r);
console.log(`\nsprites placed: ${info.sprites}`);
console.log(`renderer: ${info.gl}`);
if (logs.length) {
  console.log('\nconsole:');
  for (const l of logs.slice(0, 30)) console.log('  ' + l);
}

await browser.close();
if (server) server.close();
