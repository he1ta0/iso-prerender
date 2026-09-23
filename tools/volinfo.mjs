// What volume is the LIGHT PASS actually marching?
//
//   node tools/volinfo.mjs --mode chapel --t 0.33
//
// Prints the room volume the renderer has bound (this.roomInfo), the one the
// scene says it should have (scene.volume), and the shaft volume's dims — the
// three places a per-storey volume swap can come apart.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argVal = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = 8298;

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
page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.game && window.game.renderer', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1500));

const out = await page.evaluate((o) => {
  const g = window.game;
  const snap = (tag) => {
    const ri = g.renderer.roomInfo;
    const si = g.renderer.shaftInfo;
    return {
      tag,
      mode: g.mode,
      bound: ri ? { vox: ri.vox, min: ri.min.map((v) => +v.toFixed(3)), kos: ri.kos.map((v) => +v.toFixed(3)), top: +ri.top.toFixed(3) } : null,
      shaft: si ? { dim: si.dim, min: si.min.map((v) => +v.toFixed(3)) } : null,
      sceneVol: g.current.volume ? { dim: g.current.volume.dim, bounds: g.current.volume.bounds } : null,
      sceneSet: !!g.current.volumeSet,
      volIsSet: g.renderer.volume === g.current.volumeSet,
    };
  };
  const rows = [snap('boot')];
  for (const m of ['indoor', 'upstairs', 'chapel']) {
    g.enter(m);
    rows.push(snap('enter ' + m));
  }
  g.state.time = o.t;
  rows.push(snap('after time set'));
  return rows;
}, { t: Number(argVal('--t', 0.33)) });

for (const r of out) {
  console.log(`--- ${r.tag}  (mode=${r.mode}) ---`);
  console.log(`  bound room volume : ${r.bound ? r.bound.vox.join('x') + '  min ' + r.bound.min.join(',') + '  kos ' + r.bound.kos.join(',') + '  top ' + r.bound.top : 'null'}`);
  console.log(`  scene wants       : ${r.sceneVol ? r.sceneVol.dim.join('x') + '  bounds ' + JSON.stringify(r.sceneVol.bounds) : 'none'}   volumeSet=${r.sceneSet}  renderer.volume===set: ${r.volIsSet}`);
  console.log(`  shaft volume      : ${r.shaft ? r.shaft.dim.join('x') + '  min ' + r.shaft.min.join(',') : 'null'}`);
}
await browser.close();
server.close();
