// Social preview card for the repository settings page.
//
//   node tools/social-preview.mjs
//
// GitHub renders a preview card whenever the repo link is pasted somewhere that
// unfurls links - QQ, WeChat, Discord, Bilibili dynamics, Slack, Twitter. With
// nothing configured, that card is GitHub's generic grey placeholder, which is
// what most people see first and remembers nothing.
//
// Settings -> General -> Social preview takes a 1280x640 PNG. This builds it from
// a real frame of the game rather than from a logo, because the thing being shared
// is a picture of a room with light moving across it.
//
// Needs a source frame first (tools/timelapse.mjs writes one):
//
//   node tools/timelapse.mjs --mode indoor --cutaway hide --steps 1 \
//     --no-pingpong --from 0.33 --to 0.33 --dump 0 --out work/social/_tmp.gif
//
// That path is the default input below. The frame is 640x360 with the HUD canvas
// hidden, which is what makes it usable: a card with a clock in the corner looks
// like a screenshot, not a title.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG } from './lib/png.mjs';
import { surface, fillRect, blit, text, textWidth } from './lib/canvas.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const getFlag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const FRAME = path.resolve(ROOT, getFlag('frame', 'work/timelapse/src_000.png'));
const OUT = path.resolve(ROOT, getFlag('out', 'docs/img/social-preview.png'));
const TITLE = getFlag('title', 'ISO-PRERENDER');
const LINE1 = getFlag('line1', 'A PRE-RENDERING PIPELINE FOR 2:1 ISOMETRIC GAMES');
const LINE2 = getFlag('line2', 'AND A FARMING SCENE BUILT WITH IT');
const URL = getFlag('url', 'GITHUB.COM/HE1TA0/ISO-PRERENDER');

// GitHub's recommended social preview size.
const W = 1280, H = 640;
const SCALE = 2;                       // the frame is 640x360; 2x fills the width
const CROP = (360 * SCALE - H) / 2;    // 2x is 720 tall, so 40px comes off each end

const INK = [232, 238, 246];
const DIM = [150, 168, 190];
const ACCENT = [232, 180, 92];

if (!fs.existsSync(FRAME)) {
  console.error(`no source frame at ${path.relative(ROOT, FRAME)}`);
  console.error('run the timelapse command in this file\'s header first');
  process.exit(1);
}

const img = decodePNG(fs.readFileSync(FRAME));
const buf = surface(W, H, [5, 6, 10]);

// The frame fills the card; the crop keeps the room centred rather than cutting
// the top off it.
blit(buf, W, H, img.rgba, img.width, [0, 0, img.width, img.height], 0, -CROP, SCALE);

// A gradient rather than a solid band: the top of the frame is already dark
// letterbox, so the title sits on black either way, but the falloff keeps the
// roof and the chimney from being visibly cut by a hard edge.
const BAND = 260;
for (let y = 0; y < BAND; y++) {
  fillRect(buf, W, H, 0, y, W, 1, [5, 6, 10], 0.9 * Math.pow(1 - y / BAND, 1.5));
}
const FOOT = 130;
for (let y = 0; y < FOOT; y++) {
  fillRect(buf, W, H, 0, H - FOOT + y, W, 1, [5, 6, 10], 0.85 * Math.pow(y / FOOT, 1.5));
}

const PAD = 58;
text(buf, W, H, TITLE, PAD, 46, { scale: 5, color: INK });
fillRect(buf, W, H, PAD + 2, 118, 208, 3, ACCENT);
text(buf, W, H, LINE1, PAD, 138, { scale: 2, color: INK });
text(buf, W, H, LINE2, PAD, 164, { scale: 2, color: DIM });

const uw = textWidth(URL, 2);
text(buf, W, H, URL, W - PAD - uw, H - 58, { scale: 2, color: DIM });

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, encodePNG({ width: W, height: H, data: buf, colorType: 6 }));

const kb = fs.statSync(OUT).size / 1024;
console.log(`· ${path.relative(ROOT, OUT)}  ${W}x${H}  ${kb.toFixed(0)} kB`);
if (kb > 1024) console.log('  ! over GitHub\'s 1 MB limit for social preview images');
