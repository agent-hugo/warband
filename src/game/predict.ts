import type { Input, Snap } from './sim';
import { SPEED, STOP, step, type Vec } from './world';

/** Unacknowledged inputs kept for replay: 3 s. */
const PENDING_MAX = 90;
/** A correction larger than this is a jump, not smoothed. */
const SNAP_DIST = 80;

/**
 * Client-side prediction of the player's own sprite: inputs move it at once;
 * when the host's position arrives, inputs it has not applied yet are replayed
 * on top of it. The visible position eases out the difference.
 */
export class Predictor {
  self: Vec | null = null;
  pending: Input[] = [];
  /** Visible offset from `self`, decays to zero. */
  smooth: Vec = { x: 0, y: 0 };
  seq = Date.now(); // grows across page reloads, so a host never takes new inputs for old copies
  idle = 0;
  /** Own speed, as the host's last snapshot says (it changes with the role). */
  speed = SPEED;
  /** Corrections in a row bigger than a pixel: mispredictions. */
  corrections = 0;

  /** Next input for this tick; null while standing still with nothing to confirm. */
  input(dir: number, predict: boolean): Input | null {
    this.idle = dir === STOP ? this.idle + 1 : 0;
    if (dir === STOP && this.idle > 3 && !this.pending.length) return null;
    const inp: Input = [++this.seq, dir];
    this.pending.push(inp);
    if (this.pending.length > PENDING_MAX) this.pending.shift();
    if (predict && this.self) this.self = step(this.self, dir, this.speed);
    return inp;
  }

  /** The host's position of this player with the seq of the last input it applied. */
  server(pos: Vec, ack: number, predict: boolean): void {
    this.pending = this.pending.filter(([s]) => s > ack);
    let p: Vec = { x: pos.x, y: pos.y };
    if (!predict || !this.self) {
      // First position (or no prediction): inputs the host has not applied yet still count.
      if (predict) for (const [, dir] of this.pending) p = step(p, dir, this.speed);
      this.self = p;
      this.smooth = { x: 0, y: 0 };
      return;
    }
    for (const [, dir] of this.pending) p = step(p, dir, this.speed);
    const ex = this.self.x + this.smooth.x - p.x;
    const ey = this.self.y + this.smooth.y - p.y;
    if (Math.abs(this.self.x - p.x) > 1 || Math.abs(this.self.y - p.y) > 1) this.corrections++;
    this.self = p;
    this.smooth = Math.hypot(ex, ey) > SNAP_DIST ? { x: 0, y: 0 } : { x: ex, y: ey };
  }

  /** Where to draw the player; `dt` in ms eases the correction out. */
  visible(dt: number): Vec | null {
    if (!this.self) return null;
    const k = Math.exp(-dt / 80);
    this.smooth.x *= k;
    this.smooth.y *= k;
    return { x: this.self.x + this.smooth.x, y: this.self.y + this.smooth.y };
  }

  reset(): void {
    this.self = null;
    this.pending = [];
    this.smooth = { x: 0, y: 0 };
    this.speed = SPEED;
  }
}

export interface Pose extends Vec {
  dir: number;
}

interface Frame {
  h: number;
  ps: Map<string, Pose>;
}

/**
 * Snapshots on the host's clock. Others are drawn a little in the past,
 * between two snapshots, so they move smoothly despite uneven arrival.
 */
export class Timeline {
  frames: Frame[] = [];
  /** local clock − host clock, from the fastest recent snapshot. */
  offset: number | null = null;
  private lastAt = 0;

  push(s: Snap, now: number): void {
    const sample = now - s.h;
    if (this.offset === null) this.offset = sample;
    // Creep up slowly (clock drift, a route got slower), drop at once to a faster sample.
    else this.offset = Math.min(sample, this.offset + (now - this.lastAt) * 0.003);
    this.lastAt = now;
    const ps = new Map<string, Pose>();
    for (const [pid, x, y, dir] of s.ps) ps.set(pid, { x, y, dir });
    const last = this.frames[this.frames.length - 1];
    if (last && s.h <= last.h) return;
    this.frames.push({ h: s.h, ps });
    if (this.frames.length > 90) this.frames.shift();
  }

  latest(): Map<string, Pose> | null {
    return this.frames[this.frames.length - 1]?.ps ?? null;
  }

  /** Poses at local time `now` drawn `delay` ms in the past. */
  at(now: number, delay: number): Map<string, Pose> | null {
    if (this.offset === null || !this.frames.length) return null;
    const t = now - this.offset - delay;
    const f = this.frames;
    if (t <= f[0]!.h) return f[0]!.ps;
    for (let i = f.length - 1; i > 0; i--) {
      const a = f[i - 1]!;
      const b = f[i]!;
      if (a.h <= t) {
        if (t >= b.h) return b.ps;
        const k = (t - a.h) / (b.h - a.h);
        const out = new Map<string, Pose>();
        for (const [pid, pb] of b.ps) {
          const pa = a.ps.get(pid);
          out.set(pid, pa ? { x: pa.x + (pb.x - pa.x) * k, y: pa.y + (pb.y - pa.y) * k, dir: pb.dir } : pb);
        }
        return out;
      }
    }
    return f[f.length - 1]!.ps;
  }

  reset(): void {
    this.frames = [];
    this.offset = null;
  }
}
