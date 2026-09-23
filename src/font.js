// Hand-authored 5x7 bitmap font (uppercase + digits + punctuation), pre-rendered
// into per-colour glyph atlases. Everything the UI prints goes through here, so
// the interface matches the 1990s sprite art instead of borrowing a web font.

const G = {
  ' ': '00000 00000 00000 00000 00000 00000 00000',
  A: '01110 10001 10001 11111 10001 10001 10001',
  B: '11110 10001 10001 11110 10001 10001 11110',
  C: '01110 10001 10000 10000 10000 10001 01110',
  D: '11110 10001 10001 10001 10001 10001 11110',
  E: '11111 10000 10000 11110 10000 10000 11111',
  F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111',
  H: '10001 10001 10001 11111 10001 10001 10001',
  I: '11111 00100 00100 00100 00100 00100 11111',
  J: '00111 00010 00010 00010 00010 10010 01100',
  K: '10001 10010 10100 11000 10100 10010 10001',
  L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001',
  N: '10001 11001 10101 10011 10001 10001 10001',
  O: '01110 10001 10001 10001 10001 10001 01110',
  P: '11110 10001 10001 11110 10000 10000 10000',
  Q: '01110 10001 10001 10001 10101 10010 01101',
  R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110',
  T: '11111 00100 00100 00100 00100 00100 00100',
  U: '10001 10001 10001 10001 10001 10001 01110',
  V: '10001 10001 10001 10001 10001 01010 00100',
  W: '10001 10001 10001 10101 10101 11011 10001',
  X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100',
  Z: '11111 00001 00010 00100 01000 10000 11111',
  0: '01110 10011 10101 10101 10101 11001 01110',
  1: '00100 01100 00100 00100 00100 00100 01110',
  2: '01110 10001 00001 00010 00100 01000 11111',
  3: '11111 00010 00100 00010 00001 10001 01110',
  4: '00010 00110 01010 10010 11111 00010 00010',
  5: '11111 10000 11110 00001 00001 10001 01110',
  6: '00110 01000 10000 11110 10001 10001 01110',
  7: '11111 00001 00010 00100 01000 01000 01000',
  8: '01110 10001 10001 01110 10001 10001 01110',
  9: '01110 10001 10001 01111 00001 00010 01100',
  '.': '00000 00000 00000 00000 00000 01100 01100',
  ',': '00000 00000 00000 00000 01100 01100 00100',
  ':': '00000 01100 01100 00000 01100 01100 00000',
  ';': '00000 01100 01100 00000 01100 01100 01000',
  '-': '00000 00000 00000 11111 00000 00000 00000',
  '+': '00000 00100 00100 11111 00100 00100 00000',
  '/': '00001 00010 00010 00100 01000 01000 10000',
  '\\': '10000 01000 01000 00100 00010 00010 00001',
  '(': '00010 00100 01000 01000 01000 00100 00010',
  ')': '01000 00100 00010 00010 00010 00100 01000',
  '[': '01110 01000 01000 01000 01000 01000 01110',
  ']': '01110 00010 00010 00010 00010 00010 01110',
  '<': '00010 00100 01000 10000 01000 00100 00010',
  '>': '01000 00100 00010 00001 00010 00100 01000',
  '=': '00000 00000 11111 00000 11111 00000 00000',
  '%': '10001 00010 00010 00100 01000 01000 10001',
  '*': '00000 10101 01110 11111 01110 10101 00000',
  '#': '01010 01010 11111 01010 11111 01010 01010',
  '!': '00100 00100 00100 00100 00100 00000 00100',
  '?': '01110 10001 00001 00110 00100 00000 00100',
  "'": '00100 00100 00000 00000 00000 00000 00000',
  '"': '01010 01010 00000 00000 00000 00000 00000',
  '$': '00100 01111 10100 01110 00101 11110 00100',
  '&': '01100 10010 10100 01000 10101 10010 01101',
  '@': '01110 10001 10111 10101 10111 10000 01110',
  '^': '00100 01010 10001 00000 00000 00000 00000',
  _: '00000 00000 00000 00000 00000 00000 11111',
  '|': '00100 00100 00100 00100 00100 00100 00100',
  '~': '00000 00000 01000 10101 00010 00000 00000',
};

const ORDER = Object.keys(G);
const GW = 5, GH = 7, ADV = 6, LEAD = 10;
const cache = new Map();

/** glyph atlas canvas for a given css colour (built lazily) */
function atlas(color) {
  let c = cache.get(color);
  if (c) return c;
  const cv = document.createElement('canvas');
  cv.width = ORDER.length * ADV;
  cv.height = LEAD;
  const g = cv.getContext('2d');
  g.fillStyle = color;
  ORDER.forEach((ch, i) => {
    const rows = G[ch].split(' ');
    const ox = i * ADV;
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) if (rows[y][x] === '1') g.fillRect(ox + x, y + 1, 1, 1);
    }
  });
  const idx = new Map(ORDER.map((ch, i) => [ch, i]));
  c = { canvas: cv, idx };
  cache.set(color, c);
  return c;
}

export const FONT = { GW, GH, ADV, LEAD };
export const GLYPHS = G;
export const GLYPH_ORDER = ORDER;

export function textWidth(str) { return String(str).length * ADV - 1; }

/** draw pixel text, returns the width drawn */
export function text(ctx, str, x, y, color = '#e8eef6') {
  const a = atlas(color);
  const s = String(str).toUpperCase();
  let cx = x | 0;
  const cy = y | 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const k = a.idx.get(ch);
    if (k !== undefined) ctx.drawImage(a.canvas, k * ADV, 0, ADV, LEAD, cx, cy, ADV, LEAD);
    cx += ADV;
  }
  return s.length * ADV - 1;
}

export function textRight(ctx, str, right, y, color) {
  text(ctx, str, right - textWidth(str), y, color);
}

export function textCenter(ctx, str, cx, y, color) {
  text(ctx, str, Math.round(cx - textWidth(str) / 2), y, color);
}

/** Chinese / CJK fallback: the era had bitmap kanji; SimSun at 12px is the closest thing. */
export function cjk(ctx, str, x, y, color = '#c8d2e0', size = 12) {
  ctx.save();
  ctx.font = `${size}px "SimSun","MS Gothic","Noto Sans CJK SC",monospace`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;
  ctx.fillText(str, x | 0, y | 0);
  ctx.restore();
}

export function cjkWidth(ctx, str, size = 12) {
  ctx.save();
  ctx.font = `${size}px "SimSun","MS Gothic","Noto Sans CJK SC",monospace`;
  const w = ctx.measureText(str).width;
  ctx.restore();
  return w;
}
