/**
 * Tag in the fog. One player is "it" and runs faster; touching another
 * passes the role on, and the new one stands still for a moment so the old
 * one can get away. A round lasts two minutes; whoever was "it" for the
 * shortest time wins it. Everyone sees only what is near and not behind a
 * wall, and someone in a bush only from close by.
 *
 * Runs on the host. The state goes out in every snapshot, so a phone knows
 * its own speed (for prediction) and what to show.
 */

import { HALF, SPEED, TICK_HZ, sees, type Vec } from './world';

export type Phase = 'wait' | 'hide' | 'chase' | 'end';

/** Speed of the one who is "it". */
export const IT_SPEED = Math.round(SPEED * 1.25);
/** Ticks. */
export const HIDE_TICKS = 5 * TICK_HZ;
export const ROUND_TICKS = 120 * TICK_HZ;
export const END_TICKS = 8 * TICK_HZ;
/** The new "it" stands still this long after being touched. */
export const FREEZE_TICKS = 2 * TICK_HZ;
/** Centre to centre: the two boxes touch, plus a little for lag. */
export const TOUCH = HALF * 2 + 6;
/** Someone just out of sight stays in the snapshots this long, so they do not flicker at the edge. */
const SEEN_GRACE = 6;

export interface TagState {
  ph: Phase;
  /** Tick when the phase ends (0 in 'wait'). */
  end: number;
  /** Who is "it"; '' in 'wait'. */
  it: string;
  /** "It" may not move before this tick. */
  fz: number;
  /** [pid, ticks as "it" this round, rounds won]. */
  sc: [string, number, number][];
  /** The last touch: [from, to, tick]. */
  tag: [string, string, number] | null;
}

/** Speed of a player at tick `n` under state `g` (no game: normal). */
export function speedOf(g: TagState | null | undefined, pid: string, n: number): number {
  if (!g || g.it !== pid) return SPEED;
  if (g.ph === 'hide' || n < g.fz) return 0;
  return g.ph === 'chase' ? IT_SPEED : SPEED;
}

/** Whether the fog is on: everyone sees everything while waiting and between rounds. */
export function foggy(g: TagState | null | undefined): boolean {
  return !!g && (g.ph === 'hide' || g.ph === 'chase');
}

export class Tag {
  st: TagState = { ph: 'wait', end: 0, it: '', fz: 0, sc: [], tag: null };
  private itTicks = new Map<string, number>();
  private wins = new Map<string, number>();
  /** viewer → target → last tick seen. */
  private seen = new Map<string, Map<string, number>>();

  constructor(private rnd: () => number = Math.random) {}

  speed(pid: string, n: number): number {
    return speedOf(this.st, pid, n);
  }

  /** After the world moved to tick `n`; `ps` holds the players in the game (awake). */
  update(n: number, ps: Map<string, Vec>): void {
    const st = this.st;
    const ids = [...ps.keys()];
    if (ids.length < 2) {
      Object.assign(st, { ph: 'wait', end: 0, it: '', fz: 0 });
      this.refreshScores(ids);
      return;
    }
    if (st.ph === 'wait') this.startRound(n, this.pick(ids));
    else if (!ps.has(st.it)) {
      // "It" left: someone else takes over, standing still for a moment.
      st.it = this.pick(ids);
      st.fz = st.ph === 'hide' ? st.end : n + FREEZE_TICKS;
    }

    if (st.ph === 'hide' && n >= st.end) {
      st.ph = 'chase';
      st.end = n + ROUND_TICKS;
    } else if (st.ph === 'chase') {
      this.itTicks.set(st.it, (this.itTicks.get(st.it) ?? 0) + 1);
      if (n >= st.fz) this.touch(n, ps);
      if (n >= st.end) {
        st.ph = 'end';
        st.end = n + END_TICKS;
        for (const w of this.leaders(ids)) this.wins.set(w, (this.wins.get(w) ?? 0) + 1);
      }
    } else if (st.ph === 'end' && n >= st.end) this.startRound(n, st.it);
    this.refreshScores(ids);
  }

  /** Whoever was "it" the least this round (several on a draw). */
  leaders(ids: string[]): string[] {
    const t = (id: string) => this.itTicks.get(id) ?? 0;
    const best = Math.min(...ids.map(t));
    return ids.filter((id) => t(id) === best);
  }

  private touch(n: number, ps: Map<string, Vec>) {
    const st = this.st;
    const it = ps.get(st.it)!;
    let near: string | null = null;
    let nd = TOUCH;
    for (const [id, p] of ps) {
      if (id === st.it) continue;
      const d = Math.hypot(p.x - it.x, p.y - it.y);
      if (d <= nd) {
        nd = d;
        near = id;
      }
    }
    if (!near) return;
    st.tag = [st.it, near, n];
    st.it = near;
    st.fz = n + FREEZE_TICKS;
  }

  private startRound(n: number, it: string) {
    Object.assign(this.st, { ph: 'hide', end: n + HIDE_TICKS, it, fz: n + HIDE_TICKS, tag: null });
    this.itTicks.clear();
  }

  private pick(ids: string[]): string {
    return ids[Math.floor(this.rnd() * ids.length)]!;
  }

  private refreshScores(ids: string[]) {
    this.st.sc = ids.map((id) => [id, this.itTicks.get(id) ?? 0, this.wins.get(id) ?? 0]);
  }

  /**
   * Who `viewer` gets in its snapshot at tick `n`: itself always; others in
   * the fog only when seen now or a moment ago; everyone otherwise.
   * `all` is everyone in the world, `ps` the players in the game.
   */
  visibleTo(viewer: string, n: number, all: Map<string, Vec>, ps: Map<string, Vec>): Set<string> {
    if (!foggy(this.st)) return new Set(all.keys());
    const out = new Set<string>([viewer]);
    const from = ps.get(viewer);
    if (!from) return out;
    let mem = this.seen.get(viewer);
    if (!mem) this.seen.set(viewer, (mem = new Map()));
    for (const [id, p] of ps) {
      if (id === viewer) continue;
      if (sees(from, p)) mem.set(id, n);
      if (n - (mem.get(id) ?? -Infinity) <= SEEN_GRACE) out.add(id);
    }
    return out;
  }

  forget(pid: string): void {
    this.seen.delete(pid);
    for (const m of this.seen.values()) m.delete(pid);
  }
}
