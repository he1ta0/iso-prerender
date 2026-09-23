// Canvas2D HUD. Deliberately period: 1px inset bevels, a translucent navy panel
// and the hand-authored 5x7 bitmap font from src/font.js. No web fonts, no
// rounded corners, no shadows.

import { text, textWidth, FONT } from './font.js';

const PANEL_BG = 'rgba(10,14,26,0.78)';
const PANEL_EDGE_LT = 'rgba(150,178,214,0.55)';
const PANEL_EDGE_DK = 'rgba(4,6,12,0.75)';
const INK = '#cfe0f2';
const INK_DIM = '#7d90a8';
const INK_HI = '#f2e6c8';
const ACCENT = '#e8b45c';
const WARN = '#d9705a';

export class HUD {
  constructor(canvas, w, h) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this.setSize(w, h);
  }

  setSize(w, h) {
    this.cv.width = w; this.cv.height = h;
    this.ctx.imageSmoothingEnabled = false;
    this.w = w; this.h = h;
  }

  panel(x, y, w, h, alpha = 1) {
    const c = this.ctx;
    c.save();
    c.globalAlpha = alpha;
    c.fillStyle = PANEL_BG;
    c.fillRect(x, y, w, h);
    // bevel: light on the top/left, dark on the bottom/right
    c.fillStyle = PANEL_EDGE_LT;
    c.fillRect(x, y, w, 1); c.fillRect(x, y, 1, h);
    c.fillStyle = PANEL_EDGE_DK;
    c.fillRect(x, y + h - 1, w, 1); c.fillRect(x + w - 1, y, 1, h);
    c.restore();
  }

  draw(s) {
    const c = this.ctx;
    c.clearRect(0, 0, this.w, this.h);

    // at the closer zoom levels the internal buffer is small, and the side
    // panels would eat half the picture — so the HUD goes compact instead
    const compact = this.w < 480;

    this.drawCursor(s);
    this.drawClock(s, compact);
    if (s.showStats && !compact) this.drawStats(s);
    if (s.showHelp && !compact) this.drawHelp(s);
    this.drawFooter(s, compact);
    if (s.fade > 0.001) {
      c.save();
      c.globalAlpha = Math.min(1, s.fade);
      c.fillStyle = '#05060a';
      c.fillRect(0, 0, this.w, this.h);
      c.restore();
    }
  }

  // ---- hovered tile: an isometric diamond outline -------------------------
  drawCursor(s) {
    const { hover, camPx, iso } = s;
    if (!hover || !hover.ok) return;
    const c = this.ctx;
    const cx = (hover.gx - hover.gy) * iso.HW + iso.HW + camPx[0];
    const cy = (hover.gx + hover.gy) * iso.HH + iso.HH + camPx[1];
    c.save();
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(255,236,190,0.85)';
    c.beginPath();
    c.moveTo(cx, cy - iso.HH + 0.5);
    c.lineTo(cx + iso.HW - 0.5, cy);
    c.lineTo(cx, cy + iso.HH - 0.5);
    c.lineTo(cx - iso.HW + 0.5, cy);
    c.closePath();
    c.stroke();
    c.strokeStyle = 'rgba(20,16,10,0.55)';
    c.beginPath();
    c.moveTo(cx, cy - iso.HH + 2.5);
    c.lineTo(cx + iso.HW - 2.5, cy);
    c.lineTo(cx, cy + iso.HH - 2.5);
    c.lineTo(cx - iso.HW + 2.5, cy);
    c.closePath();
    c.stroke();
    c.restore();
  }

  // ---- clock + day-phase panel -------------------------------------------
  drawClock(s, compact) {
    const c = this.ctx;
    const W = compact ? 112 : 148;
    const H = compact ? 30 : 42;
    const X = 6, Y = 6;
    this.panel(X, Y, W, H);

    text(c, s.clock, X + 6, Y + 5, INK_HI);
    if (!compact) text(c, 'H', X + 6 + textWidth(s.clock) + 3, Y + 7, INK_DIM);

    const label = s.label.length > 18 ? s.label.slice(0, 18) : s.label;
    if (compact) {
      text(c, label, X + 6, Y + 16, ACCENT);
    } else {
      text(c, label, X + 7, Y + 18, ACCENT);
    }

    // day-progress bar with sunrise / noon / sunset ticks
    const bx = X + 6, bw = W - 12, bh = 4;
    const by = Y + (compact ? 27 : 31) - bh + (compact ? -1 : 0);
    c.fillStyle = 'rgba(0,0,0,0.5)';
    c.fillRect(bx, by, bw, bh);
    const g = c.createLinearGradient(bx, 0, bx + bw, 0);
    g.addColorStop(0.00, '#1b2540');
    g.addColorStop(0.22, '#6b6a90');
    g.addColorStop(0.28, '#e8a24e');
    g.addColorStop(0.50, '#cfe2f2');
    g.addColorStop(0.72, '#e8a24e');
    g.addColorStop(0.80, '#6a5570');
    g.addColorStop(1.00, '#1b2540');
    c.fillStyle = g;
    c.fillRect(bx + 1, by + 1, bw - 2, bh - 2);
    const px = bx + 1 + Math.round((s.time01 ?? 0) * (bw - 2));
    c.fillStyle = INK_HI;
    c.fillRect(px, by - 1, 1, bh + 2);
    c.fillStyle = PANEL_EDGE_DK;
    c.fillRect(bx, by + bh - 1, bw, 1);
  }

  // ---- debug / stats -----------------------------------------------------
  drawStats(s) {
    const c = this.ctx;
    const lines = [
      `SPRITES ${s.sprites}  DRAWN ${s.drawn}`,
      `LIGHTS  ${s.lights}`,
      `NIGHT   ${(s.night * 100).toFixed(0)}%`,
      `WEATHER ${s.weather} ${(s.weatherMix * 100).toFixed(0)}%`,
    ];
    const W = 150, H = 10 + lines.length * 10;
    const X = 8, Y = 56;
    this.panel(X, Y, W, H);
    lines.forEach((l, i) => text(c, l, X + 6, Y + 5 + i * 10, INK_DIM));
  }

  // ---- control hints -----------------------------------------------------
  drawHelp(s) {
    const c = this.ctx;
    const rows = [
      ['1-8', 'TIME OF DAY'],
      ['[ ]', 'SCRUB TIME'],
      ['Z', 'ZOOM LEVEL'],
      ['E', 'GO IN / OUT'],
      ['U', 'FLOOR UP / DOWN'],
      ['SPACE', 'PAUSE'],
      ['+ -', 'SPEED'],
      ['R / F', 'RAIN / FOG'],
      ['WASD', 'PAN  (DRAG TOO)'],
      ['H', 'HELP'],
    ];
    const W = 162, H = 12 + rows.length * 10;
    const X = this.w - W - 8, Y = 8;
    this.panel(X, Y, W, H);
    text(c, 'CONTROLS', X + 6, Y + 5, ACCENT);
    rows.forEach((r, i) => {
      text(c, r[0], X + 6, Y + 15 + i * 10, INK_HI);
      text(c, r[1], X + 44, Y + 15 + i * 10, INK_DIM);
    });
  }

  // ---- bottom bar --------------------------------------------------------
  drawFooter(s, compact) {
    const c = this.ctx;
    const H = 20, Y = this.h - H - 6;
    // 330, not 300, and 'E TOGGLE' at 288: UPSTAIRS is two characters wider than
    // INDOOR, and a label that runs into the one after it reads as a bug.
    const W = compact ? 224 : 330;
    this.panel(6, Y, W, H);
    text(c, s.paused ? 'PAUSED' : `TIME x${s.speed}`, 12, Y + 7, s.paused ? WARN : INK);
    text(c, `SKY ${s.weather}`, compact ? 66 : 74, Y + 7, INK_DIM);
    if (!compact) text(c, `ZOOM ${s.zoom}`, 152, Y + 7, INK_DIM);
    // the scene you are in is the single most useful piece of state in this
    // build: the maps have different scales and different lighting models, and
    // the four are four different places
    const NAMES = { outdoor: 'OUTDOOR', indoor: 'INDOOR', upstairs: 'UPSTAIRS', chapel: 'CHAPEL' };
    const place = NAMES[s.mode] || s.mode.toUpperCase();
    const inside = s.mode !== 'outdoor';
    text(c, place, compact ? 138 : 228, Y + 7, inside ? ACCENT : INK);
    if (!compact) text(c, 'E TOGGLE', 288, Y + 7, INK_DIM);
  }
}
