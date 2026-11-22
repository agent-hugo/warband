/**
 * The world: a walled arena with obstacles. Players move at a constant speed
 * in one of 256 directions; walls stop them, nothing else interacts.
 * Every operation rounds to 0.01 so the host and the phones get the same
 * numbers from the same inputs.
 */

export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;
/** World units per second. */
export const SPEED = 150;
/** Half the side of a player's square hit box. */
export const HALF = 9;

export const WORLD = { w: 1200, h: 900 };
export const BORDER = 30;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Vec {
  x: number;
  y: number;
}

export const WALLS: Rect[] = [
  { x: 0, y: 0, w: WORLD.w, h: BORDER },
  { x: 0, y: WORLD.h - BORDER, w: WORLD.w, h: BORDER },
  { x: 0, y: 0, w: BORDER, h: WORLD.h },
  { x: WORLD.w - BORDER, y: 0, w: BORDER, h: WORLD.h },
  // four corner rooms
  { x: 180, y: 170, w: 260, h: 36 },
  { x: 180, y: 170, w: 36, h: 200 },
  { x: 760, y: 170, w: 260, h: 36 },
  { x: 984, y: 170, w: 36, h: 200 },
  { x: 180, y: 694, w: 260, h: 36 },
  { x: 180, y: 530, w: 36, h: 200 },
  { x: 760, y: 694, w: 260, h: 36 },
  { x: 984, y: 530, w: 36, h: 200 },
  // centre block and two spurs from the long walls
  { x: 540, y: 390, w: 120, h: 120 },
  { x: 585, y: BORDER, w: 30, h: 150 },
  { x: 585, y: WORLD.h - BORDER - 150, w: 30, h: 150 },
];

/** Bushes: walk through them; whoever stands inside is seen only from close by. */
export const BUSHES: Rect[] = [
  { x: 60, y: 415, w: 90, h: 70 },
  { x: 1050, y: 415, w: 90, h: 70 },
  { x: 290, y: 255, w: 95, h: 65 },
  { x: 815, y: 580, w: 95, h: 65 },
  { x: 440, y: 55, w: 110, h: 55 },
  { x: 650, y: 790, w: 110, h: 55 },
  { x: 540, y: 570, w: 120, h: 50 },
  { x: 540, y: 280, w: 120, h: 50 },
];

/** Directions: index 0..255 → unit vector (rounded, the same on every engine). Screen axes: y grows down. */
export const DIRS = 256;
const DX: number[] = [];
const DY: number[] = [];
for (let i = 0; i < DIRS; i++) {
  const a = (i / DIRS) * Math.PI * 2;
  DX.push(Math.round(Math.cos(a) * 1e4) / 1e4);
  DY.push(Math.round(Math.sin(a) * 1e4) / 1e4);
}

/** -1 = stand still. */
export const STOP = -1;

/** Direction index of a vector, or STOP if it is shorter than `dead`. */
export function quantize(x: number, y: number, dead = 0): number {
  if (Math.hypot(x, y) <= dead || (x === 0 && y === 0)) return STOP;
  const i = Math.round((Math.atan2(y, x) / (Math.PI * 2)) * DIRS);
  return ((i % DIRS) + DIRS) % DIRS;
}

/** Whether the direction points left (for sprite flipping). */
export function facesLeft(dir: number): boolean {
  return dir > DIRS / 4 && dir < (DIRS * 3) / 4;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

function hits(x: number, y: number, w: Rect): boolean {
  return x - HALF < w.x + w.w && x + HALF > w.x && y - HALF < w.y + w.h && y + HALF > w.y;
}

/** One tick of movement in a direction at `speed` units a second; walls stop each axis separately, so players slide along them. */
export function step(p: Vec, dir: number, speed = SPEED): Vec {
  if (dir < 0 || speed <= 0) return p;
  const dx = DX[dir]! * (speed / TICK_HZ);
  const dy = DY[dir]! * (speed / TICK_HZ);
  let x = r2(p.x + dx);
  for (const w of WALLS) if (hits(x, p.y, w)) x = dx > 0 ? w.x - HALF : w.x + w.w + HALF;
  let y = r2(p.y + dy);
  for (const w of WALLS) if (hits(x, y, w)) y = dy > 0 ? w.y - HALF : w.y + w.h + HALF;
  return { x, y };
}

export function blocked(p: Vec): boolean {
  return WALLS.some((w) => hits(p.x, p.y, w));
}

/** A free spot near the middle, away from the given players. */
export function spawnPoint(others: Vec[], rnd = Math.random): Vec {
  for (let i = 0; i < 200; i++) {
    const p = { x: Math.round(300 + rnd() * 600), y: Math.round(250 + rnd() * 400) };
    if (blocked(p)) continue;
    if (others.some((o) => Math.hypot(o.x - p.x, o.y - p.y) < 40)) continue;
    return p;
  }
  return { x: 450, y: 450 };
}

/** The bush a point stands in, or -1. */
export function bushAt(p: Vec): number {
  return BUSHES.findIndex((b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h);
}

/**
 * Where a ray from `a` towards `b` first enters the rect, as a fraction of
 * a→b (0..1), or Infinity if it misses. Slab method; `a` is outside the rect.
 */
function enters(a: Vec, dx: number, dy: number, r: Rect): number {
  let t0 = 0;
  let t1 = 1;
  for (const [o, d, lo, hi] of [
    [a.x, dx, r.x, r.x + r.w],
    [a.y, dy, r.y, r.y + r.h],
  ] as const) {
    if (d === 0) {
      if (o <= lo || o >= hi) return Infinity;
      continue;
    }
    let ta = (lo - o) / d;
    let tb = (hi - o) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 >= t1) return Infinity;
  }
  return t0;
}

/** Whether no wall stands between two points. */
export function clearLine(a: Vec, b: Vec): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return WALLS.every((w) => enters(a, dx, dy, w) === Infinity);
}

/** How far one sees, world units. */
export const VIEW = 190;
/** Someone in a bush is seen only this close, or from the same bush. */
export const BUSH_VIEW = 45;

/** Whether a player at `from` sees one at `to`. */
export function sees(from: Vec, to: Vec): boolean {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  if (d > VIEW) return false;
  const b = bushAt(to);
  if (b >= 0 && d > BUSH_VIEW && bushAt(from) !== b) return false;
  return clearLine(from, to);
}

/**
 * The area seen from `p`: the end of each of `rays` rays, cut by walls and by
 * the view distance. For drawing the fog.
 */
export function sightPolygon(p: Vec, rays = 360): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    const dx = Math.cos(a) * VIEW;
    const dy = Math.sin(a) * VIEW;
    let t = 1;
    for (const w of WALLS) t = Math.min(t, enters(p, dx, dy, w));
    out.push({ x: p.x + dx * t, y: p.y + dy * t });
  }
  return out;
}
