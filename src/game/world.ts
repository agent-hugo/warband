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
const STEP = SPEED / TICK_HZ;
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

/** One tick of movement in a direction; walls stop each axis separately, so players slide along them. */
export function step(p: Vec, dir: number): Vec {
  if (dir < 0) return p;
  const dx = DX[dir]! * STEP;
  const dy = DY[dir]! * STEP;
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
