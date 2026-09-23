// A minimal RGBA compositing surface for the offline tools, plus the game's own
// bitmap font.
//
// src/font.js draws its glyphs through a Canvas2D context, which a Node tool
// does not have — but the glyph data itself is plain strings, so the offline
// sheets can be labelled in the game's actual typeface instead of borrowing a
// system font and ending up looking like they document something else.
//
// Importing src/font.js here is safe: `document` is only touched inside the
// lazily-called atlas() helper, never at module scope.

import { GLYPHS, FONT } from '../../src/font.js';

/** An RGBA8 surface, as a Node Buffer of width*height*4. */
export function surface(width, height, [r, g, b] = [0, 0, 0]) {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
  }
  return buf;
}

/** Filled rectangle, opaque. */
export function fillRect(buf, W, H, x, y, w, h, [r, g, b], alpha = 1) {
  const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
  const x1 = Math.min(W, (x | 0) + (w | 0)), y1 = Math.min(H, (y | 0) + (h | 0));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const i = (py * W + px) * 4;
      if (alpha >= 1) { buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255; continue; }
      buf[i] = Math.round(buf[i] * (1 - alpha) + r * alpha);
      buf[i + 1] = Math.round(buf[i + 1] * (1 - alpha) + g * alpha);
      buf[i + 2] = Math.round(buf[i + 2] * (1 - alpha) + b * alpha);
      buf[i + 3] = 255;
    }
  }
}

/** 1px outline, for separating a plate from its background. */
export function strokeRect(buf, W, H, x, y, w, h, rgb) {
  fillRect(buf, W, H, x, y, w, 1, rgb);
  fillRect(buf, W, H, x, y + h - 1, w, 1, rgb);
  fillRect(buf, W, H, x, y, 1, h, rgb);
  fillRect(buf, W, H, x + w - 1, y, 1, h, rgb);
}

/**
 * Alpha-composite a sub-rectangle of an RGBA source onto the surface, at an
 * integer scale. Nearest-neighbour only: these are hard-pixel sprites, and
 * anything that interpolates turns them to mush.
 *
 * `srcStride` is the source's full width in pixels — a sprite is a window into
 * an atlas, so the row stride is the atlas width, not the sprite width.
 */
export function blit(buf, W, H, src, srcStride, rect, dx, dy, scale = 1) {
  const [rx, ry, rw, rh] = rect;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const si = ((ry + y) * srcStride + (rx + x)) * 4;
      const a = src[si + 3] / 255;
      if (a <= 0.004) continue;
      for (let py = 0; py < scale; py++) {
        const ty = dy + y * scale + py;
        if (ty < 0 || ty >= H) continue;
        for (let px = 0; px < scale; px++) {
          const tx = dx + x * scale + px;
          if (tx < 0 || tx >= W) continue;
          const di = (ty * W + tx) * 4;
          buf[di] = Math.round(buf[di] * (1 - a) + src[si] * a);
          buf[di + 1] = Math.round(buf[di + 1] * (1 - a) + src[si + 1] * a);
          buf[di + 2] = Math.round(buf[di + 2] * (1 - a) + src[si + 2] * a);
          buf[di + 3] = 255;
        }
      }
    }
  }
}

/** Pixel width of `str` in the game font, matching src/font.js textWidth(). */
export function textWidth(str, scale = 1) {
  return String(str).length * FONT.ADV * scale - scale;
}

export function textHeight(scale = 1) {
  return FONT.LEAD * scale;
}

/**
 * Draw `str` in the game's 5x7 font. Uppercase only — the font has no lowercase
 * glyphs, exactly like the HUD, so callers do not have to remember.
 * `y` is the top of the line box; glyphs sit one pixel down inside it, as they
 * do in src/font.js.
 */
export function text(buf, W, H, str, x, y, { scale = 1, color = [232, 238, 246] } = {}) {
  const s = String(str).toUpperCase();
  let cx = x | 0;
  const cy = (y | 0) + scale;            // +1px in font.js terms, scaled
  for (let n = 0; n < s.length; n++) {
    const rows = GLYPHS[s[n]] ? GLYPHS[s[n]].split(' ') : null;
    if (rows) {
      for (let gy = 0; gy < FONT.GH; gy++) {
        for (let gx = 0; gx < FONT.GW; gx++) {
          if (rows[gy][gx] !== '1') continue;
          fillRect(buf, W, H, cx + gx * scale, cy + gy * scale, scale, scale, color);
        }
      }
    }
    cx += FONT.ADV * scale;
  }
  return textWidth(s, scale);
}

export function textCenter(buf, W, H, str, cx, y, opts) {
  text(buf, W, H, str, Math.round(cx - textWidth(str, opts?.scale ?? 1) / 2), y, opts);
}
