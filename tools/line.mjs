// Per-pixel line probe: what is under this scanline, and in what WORLD units does
// the pattern repeat?
//
//   node tools/line.mjs --t 0.33 --debug 15 --row 236 --x0 336 --x1 404
//
// Prints, for every pixel on the row: the rendered luminance at 1:1, the world
// position on the floor plane, and the sprites the pixel belongs to. A "stripe"
// question can only be answered in world units: 1 voxel of the light volume is
// 1/14.04 world units here, and that is a different number of pixels depending on
// which way the stripe runs.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { decodePNG } from './lib/png.mjs';
import { launchBrowser } from './lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const argVal = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = 8297;
const MODE = argVal('--mode', 'chapel');
const T = Number(argVal('--t', 0.33));
const DEBUG = Number(argVal('--debug', 15));
const ROW = Number(argVal('--row', 236));
const X0 = Number(argVal('--x0', 336));
const X1 = Number(argVal('--x1', 404));
const OUT = path.resolve(ROOT, 'work/dsh/line.png');
// work/ is scratch and is not in the repository, so it will not exist on a fresh
// clone — create the target rather than assuming a previous run left it behind.
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404).end('nope'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await launchBrowser({ width: 640, height: 360 });
const page = await browser.newPage();
await page.setViewport({ width: 640, height: 360, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.game && window.game.renderer', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1200));
const meta = await page.evaluate((o) => {
  const g = window.game;
  g.enter(o.mode);
  g.state.paused = true;
  g.state.time = o.t;
  g.cutaway = 'hide';
  g.lightDebug = o.debug;
  g.state.hud.showHelp = false;
  g.state.hud.showStats = false;
  g.setZoom(0);
  const room = g.current.scene;
  return { mode: g.mode, w: room.w, h: room.h, cam: [g.cam.x, g.cam.y], sun: g.daylightAt(o.t).sunDir };
}, { mode: MODE, t: T, debug: DEBUG });
await new Promise((r) => setTimeout(r, 700));
await page.screenshot({ path: OUT });
const probe = await page.evaluate((o) => {
  const g = window.game;
  const out = [];
  for (let x = o.x0; x <= o.x1; x++) {
    // NB: game.worldAt takes gl_FragCoord pixels — BOTTOM-UP. Passing an image
    // row straight in silently returns the world point of the mirrored row, which
    // is how this probe first "proved" a GPU/CPU divergence that did not exist.
    const glY = 360 - 1 - o.row;
    const w = g.worldAt(x, glY, 0);
    const picks = g.pick(x, o.row) || [];
    out.push({ x, w: { x: w.x, y: w.y, z: w.z, inside: w.inside }, ids: picks.map((p) => p.id).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3) });
  }
  return out;
}, { row: ROW, x0: X0, x1: X1 });
await browser.close();
server.close();

const img = decodePNG(fs.readFileSync(OUT));
const lum = (x, y) => {
  const o = (y * img.width + x) * 4;
  return 0.2126 * img.rgba[o] + 0.7152 * img.rgba[o + 1] + 0.0722 * img.rgba[o + 2];
};
console.log(`${MODE} t=${T} debug=${DEBUG} cam=${meta.cam.map((v) => v.toFixed(2))} row ${ROW}  sun=${meta.sun.map((v) => v.toFixed(3))}`);
console.log('  x    lum   worldX  worldY   d(world)   sprites');
let prev = null;
for (const p of probe) {
  const L = lum(p.x, ROW);
  const d = (prev && p.w) ? Math.hypot(p.w.x - prev.x, p.w.y - prev.y) : 0;
  if (p.x % 1 === 0) {
    console.log('  ' + String(p.x).padStart(3) + ' ' + L.toFixed(0).padStart(5) + '  ' + p.w.x.toFixed(3).padStart(6) + '  ' + p.w.y.toFixed(3).padStart(6) + '   ' + d.toFixed(4) + '   ' + p.ids.join(','));
  }
  prev = p.w;
}
