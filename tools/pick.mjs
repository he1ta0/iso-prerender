// QA: ask the running game what is actually drawn at a set of pixels.
//
//   node tools/pick.mjs <x,y> [x,y ...] [--mode indoor|outdoor] [--preset morning]
//                           [--cutaway ghost|hide|off] [--cut none|<id>] [--hide a,b]
//                           [--w 1600] [--h 901]
//
// Answers the question "which sprite is this pale patch" from the draw list
// itself instead of by hiding things one at a time.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const argVal = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const pts = argv.filter((a) => /^\d+,\d+$/.test(a)).map((s) => s.split(',').map(Number));
if (!pts.length) { console.error('usage: node tools/pick.mjs <x,y> [...]'); process.exit(1); }

const MODE = argVal('--mode', 'indoor');
const CUTAWAY = argVal('--cutaway', 'hide');
const HIDE = (argVal('--hide', '') || '').split(',').filter(Boolean);
const TIME = Number(argVal('--time', 0.32));
const W = Number(argVal('--w', 1600));
const H = Number(argVal('--h', 901));
const PORT = Number(argVal('--port', 8231));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await launchBrowser({ width: W, height: H });
const URLARG = argVal('--url', null);
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(URLARG || `http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.game && window.game.renderer', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 800));

const info = await page.evaluate((mode, cutaway, hide, time) => {
  const g = window.game;
  g.state.paused = true;
  g.state.time = time;
  g.state.hud.showHelp = false;
  g.state.hud.showStats = false;
  g.enter(mode);
  g.cutaway = cutaway;
  for (const k of Object.keys(g.hide)) g.hide[k] = hide.includes(k);
  return { res: g.RES, iso: { HW: g.current.iso?.HW, HH: g.current.iso?.HH }, mode: g.mode };
}, MODE, CUTAWAY, HIDE, TIME);
await new Promise((r) => setTimeout(r, 400));

console.log(`mode=${info.mode} cutaway=${CUTAWAY} hide=[${HIDE}] res=${info.res}`
  + (URLARG ? `  url=${URLARG}` : ''));
// The live light descriptor and the atlas metadata: two builds that disagree on
// screen usually disagree here first, and this says which one moved.
const dump = await page.evaluate(() => {
  const g = window.game;
  const L = g.renderer.light || {};
  const num = {};
  for (const k of Object.keys(L)) if (typeof L[k] === 'number') num[k] = Number(L[k].toFixed(4));
  const m = (g.atlas && g.atlas.m) || {};
  return {
    light: num, sunDir: L.sunDir,
    sprites: m.sprites ? Object.keys(m.sprites).length : null,
    scale: m.scale, volumes: m.volumes ? Object.keys(m.volumes).length : null,
    shaftDim: g.renderer.shaftInfo ? g.renderer.shaftInfo.dim : null,
    shaftMin: g.renderer.shaftInfo ? g.renderer.shaftInfo.min.map((v) => Number(v.toFixed(3))) : null,
    roomDim: g.renderer.roomInfo ? g.renderer.roomInfo.dim : null,
  };
});
console.log(`  atlas ${dump.sprites} sprites scale ${dump.scale} volumes ${dump.volumes}  `
  + `shaftDim ${JSON.stringify(dump.shaftDim)} min ${JSON.stringify(dump.shaftMin)}  roomDim ${JSON.stringify(dump.roomDim)}`);
console.log(`  sunDir ${JSON.stringify(dump.sunDir)}`);
console.log(`  light ${JSON.stringify(dump.light)}`);
for (const [x, y] of pts) {
  const w = await page.evaluate((px, py) => window.game.worldAt(px, py), x, y);
  console.log(`\n=== (${x},${y})  world (${w.x.toFixed(2)}, ${w.y.toFixed(2)}) tile [${w.tile}]  insideRoom=${w.inside}`);
  const hits = await page.evaluate((px, py) => window.game.pick(px, py), x, y);
  console.log(`   ${hits.length} sprite rect(s) cover this pixel`);
  for (const h of hits) {
    console.log(`   ${h.layer.padEnd(6)} #${String(h.order).padStart(4)}  a=${String(h.alpha).padEnd(5)} `
      + `z=[${h.z[0]}, ${h.z[1]}]  @${h.screen.join(',')}  ${h.id}`);
  }
  if (!hits.length) console.log('   (nothing - this pixel is floor/ground or sky)');
}

await browser.close();
server.close();
