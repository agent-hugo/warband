import { HERO_ORDER } from '../engine/content';
import { hero, newGame, pickReward, planCard, planMove, setReady, unplan } from '../engine/engine';
import type { GameState, HeroId, Step } from '../engine/types';

/** Every topic of the game lives under this prefix. */
export const PREFIX = 'warband/r';

export const topics = {
  /** Retained: which host runs the room and whether it is connected. */
  host: (room: string) => `${PREFIX}/${room}/host`,
  /** Retained: the whole room (lobby, game, last resolution). */
  state: (room: string) => `${PREFIX}/${room}/state`,
  /** Retained: a player's name and whether the device is awake. */
  presence: (room: string, pid: string) => `${PREFIX}/${room}/p/${pid}`,
  presenceAll: (room: string) => `${PREFIX}/${room}/p/+`,
  /** Player → host commands. */
  cmd: (room: string, pid: string) => `${PREFIX}/${room}/cmd/${pid}`,
  cmdAll: (room: string) => `${PREFIX}/${room}/cmd/+`,
  /** Host → player answers to commands that failed. */
  reply: (room: string, pid: string) => `${PREFIX}/${room}/reply/${pid}`,
};

export interface HostMsg {
  id: string;
  online: boolean;
}

export interface PresenceMsg {
  name: string;
  online: boolean;
}

export type Seats = Record<HeroId, string | null>;

export interface RoomState {
  v: 1;
  /** Grows with every publish. */
  rev: number;
  /** Player id on each hero. One player may take several heroes. */
  seats: Seats;
  /** Names of the players who took seats. */
  names: Record<string, string>;
  game: GameState | null;
  /** The last round resolution, for playback on the phones. */
  anim?: { id: number; steps: Step[] };
}

export type GameOp =
  | { op: 'card'; seat: HeroId; uid: string; target?: string }
  | { op: 'move'; seat: HeroId; dir: 1 | -1 }
  | { op: 'unplan'; seat: HeroId; index: number }
  | { op: 'ready'; seat: HeroId; ready: boolean }
  | { op: 'reward'; seat: HeroId; card: string | null };

export type RoomOp =
  | { op: 'seat'; seat: HeroId; take: boolean }
  | { op: 'start'; battle: number }
  | { op: 'lobby' };

export type Op = GameOp | RoomOp;
export type CmdMsg = Op & { seq: number };

export interface ReplyMsg {
  seq: number;
  err: string;
}

export function emptyRoom(): RoomState {
  return { v: 1, rev: 0, seats: { guard: null, blade: null, mystic: null }, names: {}, game: null };
}

export const isGameOp = (o: Op): o is GameOp =>
  o.op === 'card' || o.op === 'move' || o.op === 'unplan' || o.op === 'ready' || o.op === 'reward';

/** Applies a game command to a state in place; an error text if it is not allowed. */
export function applyGameOp(s: GameState, o: GameOp): string | null {
  if (!HERO_ORDER.includes(o.seat)) return 'Нет такого героя';
  const h = hero(s, o.seat);
  if (o.op === 'reward') {
    if (s.phase !== 'reward') return 'Сейчас не время наград';
    if (!s.offers[o.seat]) return 'Награда уже выбрана';
    pickReward(s, o.seat, o.card);
    return null;
  }
  if (s.phase !== 'plan') return 'Сейчас не планирование';
  if (h.down) return `${h.name} без сознания`;
  if (o.op === 'ready') {
    setReady(s, o.seat, o.ready);
    return null;
  }
  if (h.ready) return 'Сначала снимите «Готов»';
  if (o.op === 'card') return planCard(s, o.seat, o.uid, o.target);
  if (o.op === 'move') return planMove(s, o.seat, o.dir);
  if (o.index < 0 || o.index >= h.plan.length) return 'Нет такого пункта плана';
  unplan(s, o.seat, o.index);
  return null;
}

/** Steps without what playback never shows, to keep the message small. */
export function slimSteps(steps: Step[]): Step[] {
  return steps.map((st) => ({
    text: st.text,
    state: { ...st.state, log: [], heroes: st.state.heroes.map((h) => ({ ...h, owned: [], draw: [] })) },
  }));
}

export function startGame(battle: number): GameState {
  return newGame(Date.now(), battle);
}

const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomRoomCode(): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
  return s;
}

export function normalizeRoom(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

export function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
