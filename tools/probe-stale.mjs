// Does the cut-away survive a scene that never publishes a focus?
//
//   node tools/probe-stale.mjs
//
// This reproduces the one failure that matters: a browser running a stale (or
// half-updated) src/main.js against a current renderer, so `setFocus` is never
// called. Before the fail-safe, that silently turned every cut-able wall solid
// and swallowed the furniture behind it — a room with no error message. The
// test asserts the walls still fade, and that the console says why.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8213;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end('nope'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await launchBrowser({ width: 640, height: 360 });
const page = await browser.newPage();
await page.setViewport({ width: 640, height: 360, deviceScaleFactor: 1 });
const warnings = [];
// puppeteer reports console.warn as type 'warn' in some versions and 'warning'
// in others; accept both rather than silently testing nothing
page.on('console', (m) => { const t = m.type(); if (t === 'warn' || t === 'warning') warnings.push(m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.game && window.game.renderer', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 800));

const r = await page.evaluate(async () => {
  const g = window.game;
  // Simulate the stale module: from here on, nothing publishes a focus. Every
  // piece of bookkeeping is reset too, because that is what a page whose main.js
  // never called setFocus looks like from inside the renderer — including
  // focusCount, which would otherwise still hold the last frame's outdoor focus
  // and leave the shader refining against a stale image.
  g.renderer.setFocus = () => {};
  g.renderer.focusCount = 0;
  g.renderer.focusEver = false;
  g.renderer.warnedFocusMissing = false;
  g.renderer.framesSinceFocus = 0;
  g.enter('indoor');
  g.state.paused = true;
  g.state.time = 0.5;
  g.state.hud.showHelp = false;
  await new Promise((q) => setTimeout(q, 700));
  const c = document.getElementById('gl');
  const gl = c.getContext('webgl2');
  const grab = () => {
    const px = new Uint8Array(c.width * c.height * 4);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const withCut = grab();
  const layer = { ghost: g.renderer.ghostCount, opaque: g.renderer.instCount };
  g.focusOff = true;
  await new Promise((q) => setTimeout(q, 600));
  const noCut = grab();
  g.focusOff = false;
  return {
    ...layer,
    focusCount: g.renderer.focusCount,
    pixels: (() => {
      let n = 0;
      for (let i = 0; i < withCut.length; i += 4) {
        const d = Math.abs(withCut[i] - noCut[i]) + Math.abs(withCut[i + 1] - noCut[i + 1]) + Math.abs(withCut[i + 2] - noCut[i + 2]);
        if (d > 24) n++;
      }
      return n;
    })(),
  };
});
// the warning is frame-counted, and a software rasteriser is slow: wait for it
for (let i = 0; i < 60 && !warnings.some((w) => /no cut-away focus/.test(w)); i++) {
  await new Promise((q) => setTimeout(q, 500));
}

const ok1 = r.ghost >= 8;
const ok2 = r.pixels > 3000;      // the walls really did fade
const ok3 = warnings.some((w) => /no cut-away focus/.test(w));
console.log(`\nstale-scene probe (renderer never receives a focus)`);
console.log(`  ${ok1 ? 'PASS' : 'FAIL'}  cut-able pieces still go to the ghost layer   ${r.ghost} ghost / ${r.opaque} opaque`);
console.log(`  ${ok2 ? 'PASS' : 'FAIL'}  walls still fade without a focus image         ${r.pixels} px differ from no-cut-away`);
console.log(`  ${ok3 ? 'PASS' : 'FAIL'}  the cause is reported out loud                 ${warnings.length} warning(s)`);
if (!ok3 && warnings.length) console.log(`    got: ${warnings.slice(0, 2).join(' | ')}`);

await browser.close();
server.close();
process.exit(ok1 && ok2 && ok3 ? 0 : 1);
