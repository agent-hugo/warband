import type { TagState } from './tag';
import { SPEED, STOP, spawnPoint, step, type Vec } from './world';

/** [seq, dir]: one tick of a player's joystick. */
export type Input = [number, number];

/** [pid, x, y, dir, ack]: dir is STOP when standing; ack is the last applied input seq. */
export type SnapPlayer = [string, number, number, number, number];

export interface Snap {
  k: 's';
  /** Host tick. */
  n: number;
  /** Host clock, ms. */
  h: number;
  ps: SnapPlayer[];
  /** The game: phase, who is "it", scores. */
  g?: TagState;
}

interface SimPlayer extends Vec {
  /** Inputs waiting to be applied, in seq order. */
  q: Input[];
  /** Highest seq queued so far; 0 before the first input. */
  last: number;
  ack: number;
  dir: number;
  /** Ticks without movement. */
  idle: number;
}

/** Inputs held back to ride out jitter before the host applies two per tick. */
const QUEUE_SOFT = 4;
/** More than this and the oldest inputs are dropped (a long stall). */
const QUEUE_MAX = 45;

/**
 * The authoritative world on the host. Every input is applied once, in order:
 * one per tick, two when a player's queue has grown (it arrived in a burst),
 * none when it is empty (the player stands until the next input arrives).
 */
export class Sim {
  n = 0;
  players = new Map<string, SimPlayer>();

  add(pid: string, at?: Vec): void {
    if (this.players.has(pid)) return;
    const p = at ?? spawnPoint([...this.players.values()]);
    this.players.set(pid, { x: p.x, y: p.y, q: [], last: 0, ack: 0, dir: STOP, idle: 99 });
  }

  remove(pid: string): void {
    this.players.delete(pid);
  }

  input(pid: string, batch: Input[]): void {
    const p = this.players.get(pid);
    if (!p) return;
    for (const [seq, dir] of batch) {
      if (typeof seq !== 'number' || typeof dir !== 'number') continue;
      if (seq <= p.last) continue; // a copy we already have
      p.q.push([seq, dir | 0]);
      p.last = seq;
    }
    if (p.q.length > QUEUE_MAX) p.q.splice(0, p.q.length - QUEUE_MAX);
  }

  /** `speed`: units a second of each player during this tick. */
  tick(speed: (pid: string) => number = () => SPEED): void {
    this.n++;
    for (const [pid, p] of this.players) {
      const v = speed(pid);
      const take = p.q.length > QUEUE_SOFT ? 2 : p.q.length ? 1 : 0;
      let moved = false;
      for (let i = 0; i < take; i++) {
        const [seq, dir] = p.q.shift()!;
        const next = step(p, dir, v);
        if (next.x !== p.x || next.y !== p.y) moved = true;
        p.x = next.x;
        p.y = next.y;
        p.ack = seq;
        if (dir !== STOP) p.dir = dir;
      }
      p.idle = moved ? 0 : p.idle + 1;
    }
  }

  /** `only`: just these players (what one of them sees). */
  snapshot(h: number, only?: Set<string>, g?: TagState): Snap {
    const ps: SnapPlayer[] = [];
    for (const [pid, p] of this.players) if (!only || only.has(pid)) ps.push([pid, p.x, p.y, p.idle < 3 ? p.dir : STOP, p.ack]);
    const s: Snap = { k: 's', n: this.n, h: Math.round(h), ps };
    if (g) s.g = g;
    return s;
  }

  /** Positions to continue from on another host. */
  positions(): [string, number, number][] {
    return [...this.players].map(([pid, p]) => [pid, p.x, p.y]);
  }
}
