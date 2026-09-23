// Day/night lighting model — the art direction of the whole game lives here.
//
// Rather than driving the sun from an astronomical model, the day is authored as
// a set of keyframes: each one is a complete lighting "mood" (sun colour and
// intensity, sky and bounce ambient, exposure, fog, mist, saturation). Between
// keyframes everything is interpolated, so the day drifts continuously instead
// of snapping between presets.
//
// Colours are authored in display space (what you would pick in a paint
// program) and squared to linear here, because the light shader works in linear.

const srgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  return c.map((v) => v * v);
};

const hex2 = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
};

/**
 * t: 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset.
 *
 * `ambGain` is deliberately well below the sun's contribution during the day:
 * a strong sky ambient flattens the image into a uniform wash, and the whole
 * point of this renderer is that the sun has a direction. `mist` is kept low
 * because the world is essentially a flat ground plane at z = 0 — a mist value
 * that looks reasonable for a valley will tint the entire map.
 */
export const STOPS = [
  { t: 0.00, name: 'MIDNIGHT', sun: '#22304f', sky: '#33477a', ground: '#141a2a', sunGain: 0.10, ambGain: 0.30, exposure: 1.95, fog: '#16203a', fogAmt: 0.22, mist: 0.05, sat: 0.88, bloom: 0.55 },
  { t: 0.19, name: 'PRE-DAWN', sun: '#4b3f6b', sky: '#4b5a86', ground: '#242a3c', sunGain: 0.14, ambGain: 0.36, exposure: 1.78, fog: '#33405e', fogAmt: 0.26, mist: 0.10, sat: 0.92, bloom: 0.55 },
  { t: 0.25, name: 'SUNRISE', sun: '#ff8f3c', sky: '#7a8cb0', ground: '#3c3849', sunGain: 0.62, ambGain: 0.44, exposure: 1.36, fog: '#c39a90', fogAmt: 0.26, mist: 0.16, sat: 1.02, bloom: 0.62 },
  { t: 0.32, name: 'EARLY MORNING', sun: '#ffc47f', sky: '#93aac9', ground: '#4c4a3a', sunGain: 0.88, ambGain: 0.52, exposure: 1.15, fog: '#cdbba6', fogAmt: 0.20, mist: 0.13, sat: 1.00, bloom: 0.52 },
  { t: 0.42, name: 'LATE MORNING', sun: '#fff2d8', sky: '#a9c1dd', ground: '#5a5540', sunGain: 1.00, ambGain: 0.58, exposure: 1.02, fog: '#ccd6dc', fogAmt: 0.13, mist: 0.05, sat: 1.00, bloom: 0.42 },
  { t: 0.50, name: 'NOON', sun: '#fff8ea', sky: '#b9cde5', ground: '#63604a', sunGain: 1.00, ambGain: 0.60, exposure: 1.00, fog: '#d6dfe8', fogAmt: 0.10, mist: 0.02, sat: 1.00, bloom: 0.40 },
  { t: 0.60, name: 'AFTERNOON', sun: '#ffefc6', sky: '#aec5dd', ground: '#5e5a46', sunGain: 1.00, ambGain: 0.58, exposure: 1.02, fog: '#d6d2c8', fogAmt: 0.12, mist: 0.04, sat: 1.02, bloom: 0.42 },
  { t: 0.69, name: 'GOLDEN HOUR', sun: '#ffb055', sky: '#a0b2ce', ground: '#564c3c', sunGain: 0.94, ambGain: 0.52, exposure: 1.08, fog: '#dcb488', fogAmt: 0.20, mist: 0.11, sat: 1.07, bloom: 0.50 },
  { t: 0.75, name: 'SUNSET', sun: '#ff6f2c', sky: '#8e8aac', ground: '#473c3e', sunGain: 0.66, ambGain: 0.44, exposure: 1.24, fog: '#cc8068', fogAmt: 0.26, mist: 0.15, sat: 1.10, bloom: 0.60 },
  { t: 0.80, name: 'DUSK', sun: '#8f5a7c', sky: '#535a7e', ground: '#2c2c3e', sunGain: 0.32, ambGain: 0.36, exposure: 1.50, fog: '#665f84', fogAmt: 0.28, mist: 0.13, sat: 1.00, bloom: 0.55 },
  { t: 0.88, name: 'NIGHTFALL', sun: '#2b375c', sky: '#31405f', ground: '#171d2e', sunGain: 0.15, ambGain: 0.32, exposure: 1.84, fog: '#22304a', fogAmt: 0.24, mist: 0.07, sat: 0.90, bloom: 0.55 },
  { t: 1.00, name: 'MIDNIGHT', sun: '#22304f', sky: '#33477a', ground: '#141a2a', sunGain: 0.10, ambGain: 0.30, exposure: 1.95, fog: '#16203a', fogAmt: 0.22, mist: 0.05, sat: 0.88, bloom: 0.55 },
];

const mix = (a, b, k) => a + (b - a) * k;
const mix3 = (a, b, k) => [mix(a[0], b[0], k), mix(a[1], b[1], k), mix(a[2], b[2], k)];
const smooth = (k) => k * k * (3 - 2 * k);

/** horizontal direction the sun comes *from*, as a function of day progress */
function sunAzimuth(t) {
  // Sweeps from just south of +x at sunrise to just past +y at sunset. Biased
  // toward +x on purpose: the interiors keep their +x wall solid precisely so it
  // can carry windows, and a longer morning spent on that side is what puts a
  // readable patch of sun on an interior floor for most of the day.
  const day = Math.min(1, Math.max(0, (t - 0.25) / 0.5));
  return mix(-0.13, 0.63, day) * Math.PI;
}

const MAX_ALT = 1.02;   // radians (~58 degrees)

export function daylightAt(t) {
  t = ((t % 1) + 1) % 1;
  let i = 0;
  while (i < STOPS.length - 2 && STOPS[i + 1].t <= t) i++;
  const a = STOPS[i], b = STOPS[i + 1];
  const raw = (t - a.t) / Math.max(1e-6, b.t - a.t);
  const k = smooth(Math.min(1, Math.max(0, raw)));

  const sunColor = mix3(srgb(a.sun), srgb(b.sun), k);
  const skyColor = mix3(srgb(a.sky), srgb(b.sky), k);
  const groundColor = mix3(srgb(a.ground), srgb(b.ground), k);
  const fogColor = mix3(srgb(a.fog), srgb(b.fog), k);

  // ---- sun geometry
  const dayProg = (t - 0.25) / 0.5;                 // 0 at sunrise, 1 at sunset
  const alt = Math.sin(Math.min(1, Math.max(0, dayProg)) * Math.PI) * MAX_ALT;
  const az = sunAzimuth(t);
  const above = dayProg > 0 && dayProg < 1;
  const ca = Math.cos(Math.max(0, alt)), sa = Math.sin(Math.max(0, alt));
  let dir = [ca * Math.cos(az), ca * Math.sin(az), sa];

  // ---- below the horizon: swap in a moon on a mirrored, higher arc so the
  //      night still has a direction and long soft shadows instead of going flat
  if (!above) {
    const nightT = t < 0.25 ? t + 0.5 : t - 0.5;    // 0.25..0.75 range
    const np = (nightT - 0.25) / 0.5;
    const malt = Math.sin(Math.min(1, Math.max(0, np)) * Math.PI) * 0.78;
    const maz = mix(0.72, 0.12, np) * Math.PI;
    const mc = Math.cos(malt), ms = Math.sin(malt);
    dir = [mc * Math.cos(maz), mc * Math.sin(maz), Math.max(0.12, ms)];
  }
  const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  dir = [dir[0] / dl, dir[1] / dl, dir[2] / dl];

  const exposure = mix(a.exposure, b.exposure, k);
  const sunGain = mix(a.sunGain, b.sunGain, k);
  const ambGain = mix(a.ambGain, b.ambGain, k);

  // low sun -> longer, softer shadows
  const low = 1 - Math.min(1, Math.max(0, dir[2] / 0.9));

  // how "on" the artificial lights are: ramps up through dusk, fully on at night
  const sunAlt = above ? Math.max(0, Math.sin(alt)) : 0;
  const nightFactor = 1 - Math.min(1, Math.max(0, sunAlt / 0.22));

  return {
    t,
    label: (raw < 0.5 ? a.name : b.name),
    sunDir: dir,
    sunColor, skyColor, groundColor, fogColor,
    sunGain, ambGain, exposure,
    saturation: mix(a.sat, b.sat, k),
    bloom: mix(a.bloom, b.bloom, k),
    fogAmount: mix(a.fogAmt, b.fogAmt, k),
    mistAmount: mix(a.mist, b.mist, k),
    fogNear: 14 + 10 * (1 - mix(a.fogAmt, b.fogAmt, k)),
    fogFar: 44,
    mistHeight: 0.9 + 0.5 * (1 - low),
    shadowSoft: 0.34 + 1.5 * low,
    shadowStep: 0.075 + 0.05 * low,
    ambShadow: 0.52 + 0.16 * (1 - low),
    nightFactor,
    isNight: !above,
  };
}

/** clock label for a 6:00-26:00 style day starting at 06:00 */
export function clockLabel(t) {
  const total = (t * 24 + 6) % 24;
  const h = Math.floor(total);
  const m = Math.floor((total - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
