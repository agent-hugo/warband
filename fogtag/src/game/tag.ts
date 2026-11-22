/**
 * Tag in the fog. One player is "it" and runs faster; touching another
 * passes the role on, and the new one stands still for a moment so the old
 * one can get away. A round lasts two minutes; whoever was "it" for the
 * shortest time wins it. Everyone sees only what is near and not behind a
 * wall, and someone in a bush only from close by.
 *
 * A round starts only once everyone has a direct link to the host, so nobody
 * plays the first seconds through the slower broker.
 *
 * Whoever hides standing still for too long is warned, and a little later
 * "it" sees them on the minimap until they have run about for a while.
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
export const FREEZE_TICKS = 5 * TICK_HZ;
/** A hider standing still this long in the chase is warned... */
export const STILL_TICKS = 15 * TICK_HZ;
/** ...and has to run about this long (in all) to be let off... */
export const RUN_OFF_TICKS = 5 * TICK_HZ;
/** ...or "it" sees them on the minimap once they have stood this long since the warning. */
export const WARN_TICKS = 5 * TICK_HZ;
/** Centre to centre: the two boxes touch, plus a little for lag, half as much again (36 px). */
export const TOUCH = (HALF * 2 + 6) * 1.5;
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
  /** In 'wait': who the round waits for (no direct link yet). */
  wt?: string[];
  /** Hiders who stood still too long: [pid, ticks they may still stand before "it" sees them on the minimap, ticks run since the warning]. */
  lz?: [string, number, number][];
}

/** Whether `pid` stands out on the minimap of "it". */
export function exposed(g: TagState | null | undefined, pid: string): boolean {
  return !!g?.lz?.some(([id, left]) => id === pid && left <= 0);
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
  st: TagState = { ph: 'wait', end: 0, it: '', fz: 0, sc: [], tag: null, wt: [], lz: [] };
  private itTicks = new Map<string, number>();
  private wins = new Map<string, number>();
  /** viewer → target → last tick seen. */
  private seen = new Map<string, Map<string, number>>();
  /** Where everyone was on the last tick, to tell who moves. */
  private last = new Map<string, Vec>();
  /** Ticks each hider has been standing still. */
  private still = new Map<string, number>();
  /** Warned hiders: how long they may still stand, and how long they have run since the warning. */
  private lazy = new Map<string, { left: number; run: number }>();

  constructor(private rnd: () => number = Math.random) {}

  speed(pid: string, n: number): number {
    return speedOf(this.st, pid, n);
  }

  /**
   * After the world moved to tick `n`; `ps` holds the players in the game
   * (awake), `ready` tells whether one may start a round (has a direct link).
   */
  update(n: number, ps: Map<string, Vec>, ready: (pid: string) => boolean = () => true): void {
    const st = this.st;
    const ids = [...ps.keys()];
    st.wt = [];
    st.lz = [];
    if (ids.length < 2) {
      Object.assign(st, { ph: 'wait', end: 0, it: '', fz: 0 });
      this.refreshScores(ids);
      return;
    }
    if (st.ph === 'wait') {
      st.wt = ids.filter((id) => !ready(id));
      if (st.wt.length) return this.refreshScores(ids);
      this.startRound(n, this.pick(ids));
    }
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
      this.watchStill(ps);
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

  /** Who stands still too long, and who has run enough to be let off. */
  private watchStill(ps: Map<string, Vec>) {
    for (const [id, p] of ps) {
      const q = this.last.get(id);
      this.last.set(id, { x: p.x, y: p.y });
      if (id === this.st.it) {
        this.still.delete(id);
        this.lazy.delete(id);
        continue;
      }
      const moved = !q || q.x !== p.x || q.y !== p.y;
      const lz = this.lazy.get(id);
      if (lz) {
        // Running pays the debt off; only standing brings "it" closer to seeing them.
        if (!moved) lz.left = Math.max(0, lz.left - 1);
        else if (++lz.run >= RUN_OFF_TICKS) {
          this.lazy.delete(id);
          this.still.set(id, 0);
        }
        continue;
      }
      const s = moved ? 0 : (this.still.get(id) ?? 0) + 1;
      this.still.set(id, s);
      if (s >= STILL_TICKS) this.lazy.set(id, { left: WARN_TICKS, run: 0 });
    }
    for (const id of this.lazy.keys()) if (!ps.has(id)) this.lazy.delete(id);
    this.st.lz = [...this.lazy].map(([id, l]) => [id, l.left, l.run]);
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
    this.last.clear();
    this.still.clear();
    this.lazy.clear();
  }

  private pick(ids: string[]): string {
    return ids[Math.floor(this.rnd() * ids.length)]!;
  }

  private refreshScores(ids: string[]) {
    this.st.sc = ids.map((id) => [id, this.itTicks.get(id) ?? 0, this.wins.get(id) ?? 0]);
  }

  /**
   * Who `viewer` gets in its snapshot at tick `n`: itself always; others in
   * the fog only when seen now or a moment ago (and "it" also gets whoever
   * stood still too long, for the minimap); everyone otherwise.
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
      if (n - (mem.get(id) ?? -Infinity) <= SEEN_GRACE || (viewer === this.st.it && exposed(this.st, id))) out.add(id);
    }
    return out;
  }

  forget(pid: string): void {
    this.seen.delete(pid);
    this.last.delete(pid);
    this.still.delete(pid);
    this.lazy.delete(pid);
    for (const m of this.seen.values()) m.delete(pid);
  }
}
