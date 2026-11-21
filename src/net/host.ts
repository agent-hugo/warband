import { HERO_ORDER } from '../engine/content';
import { allReady, resolveRound } from '../engine/engine';
import type { HeroId } from '../engine/types';
import type { Bus } from './mqtt';
import {
  applyGameOp,
  emptyRoom,
  isGameOp,
  slimSteps,
  startGame,
  topics,
  type CmdMsg,
  type HostMsg,
  type PresenceMsg,
  type RoomState,
} from './protocol';

/**
 * The authoritative game of one room. All changes go through it and are
 * published as one retained state message, so another host can take over
 * from the broker at any moment: the newest host announces itself on the
 * host topic, and a host that sees another one there stops.
 */
export class Host {
  room: RoomState = emptyRoom();
  presence = new Map<string, PresenceMsg>();
  private seen = new Map<string, number[]>();
  private retired = false;
  private announced = false;
  private listeners = new Set<() => void>();

  constructor(
    private bus: Bus,
    readonly code: string,
    readonly id: string,
  ) {}

  get stopped(): boolean {
    return this.retired;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const l of this.listeners) l();
  }

  async start(): Promise<void> {
    // Retained state arrives before the SUBACK: continue the stored game.
    let stored: RoomState | null = null;
    const unsub = this.bus.subscribe(topics.state(this.code), (_t, p) => {
      if (!stored && isRoom(p)) stored = p;
    });
    await unsub;
    if (stored) this.room = stored;
    await this.bus.subscribe(topics.presenceAll(this.code), (t, p) => {
      const pid = t.split('/').pop()!;
      if (p && typeof p === 'object' && 'name' in p) this.presence.set(pid, p as PresenceMsg);
      else this.presence.delete(pid);
      this.changed();
    });
    await this.bus.subscribe(topics.host(this.code), (_t, p) => {
      const m = p as HostMsg | null;
      if (this.retired || !m || !this.announced) return;
      if (m.id !== this.id && m.online) {
        this.retired = true;
        this.changed();
      } else if (m.id !== this.id || !m.online) {
        // A previous host's last will overwrote us: announce again.
        void this.announce();
      }
    });
    await this.bus.subscribe(topics.cmdAll(this.code), (t, p) => {
      const pid = t.split('/').pop()!;
      if (p && typeof p === 'object') this.handle(pid, p as CmdMsg);
    });
    this.announced = true;
    await this.announce();
    await this.publish();
  }

  private announce() {
    return this.bus.publish(topics.host(this.code), { id: this.id, online: true } satisfies HostMsg, true);
  }

  /** Whether the player's device is connected and awake. */
  online(pid: string | null): boolean {
    return !!pid && !!this.presence.get(pid)?.online;
  }

  private handle(pid: string, c: CmdMsg) {
    if (this.retired || typeof c.seq !== 'number') return;
    const seen = this.seen.get(pid) ?? [];
    if (seen.includes(c.seq)) return; // QoS 1 may deliver twice
    this.seen.set(pid, [...seen.slice(-20), c.seq]);
    const err = this.apply(pid, c);
    if (err) void this.bus.publish(topics.reply(this.code, pid), { seq: c.seq, err });
    else void this.publish();
  }

  /** Applies a command; an error text if refused. */
  apply(pid: string, c: CmdMsg): string | null {
    const r = this.room;
    if (isGameOp(c)) {
      if (!r.game) return 'Игра ещё не началась';
      const owner = r.seats[c.seat];
      if (owner !== pid && this.online(owner)) return 'Этим героем играет другой игрок';
      const g = structuredClone(r.game);
      const err = applyGameOp(g, c);
      if (err) return err;
      if (allReady(g)) {
        const { state, steps } = resolveRound(g);
        r.game = state;
        r.anim = { id: (r.anim?.id ?? 0) + 1, steps: slimSteps(steps) };
      } else r.game = g;
      return null;
    }
    if (c.op === 'seat') {
      if (!HERO_ORDER.includes(c.seat)) return 'Нет такого героя';
      const owner = r.seats[c.seat];
      if (c.take) {
        if (owner && owner !== pid && this.online(owner)) return 'Место занято';
        r.seats[c.seat] = pid;
        const name = this.presence.get(pid)?.name;
        if (name) r.names[pid] = name;
      } else if (owner === pid) r.seats[c.seat] = null;
      return null;
    }
    if (c.op === 'start') {
      const free = HERO_ORDER.filter((id) => !r.seats[id]);
      if (free.length) return 'Сначала займите всех героев (один игрок может взять несколько)';
      r.game = startGame(Math.max(0, Math.min(3, c.battle | 0)));
      r.anim = undefined;
      return null;
    }
    if (c.op === 'lobby') {
      r.game = null;
      r.anim = undefined;
      return null;
    }
    return 'Неизвестная команда';
  }

  async publish(): Promise<void> {
    if (this.retired) return;
    this.room.rev++;
    for (const [pid, p] of this.presence) if (Object.values(this.room.seats).includes(pid)) this.room.names[pid] = p.name;
    this.changed();
    await this.bus.publish(topics.state(this.code), this.room, true);
  }

  /** Marks the host as gone on purpose (the last will covers crashes). */
  async stop(): Promise<void> {
    if (this.retired) return;
    this.retired = true;
    await this.bus.publish(topics.host(this.code), { id: this.id, online: false } satisfies HostMsg, true);
  }

  /** Seats a player controls right now. */
  seatsOf(pid: string): HeroId[] {
    return HERO_ORDER.filter((id) => this.room.seats[id] === pid);
  }
}

export function isRoom(p: unknown): p is RoomState {
  return !!p && typeof p === 'object' && (p as RoomState).v === 1 && 'seats' in p;
}
