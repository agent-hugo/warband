import type { Input, Snap } from '../game/sim';

/** Every topic of the game lives under this prefix. */
export const PREFIX = 'warband/r';

export const topics = {
  /** Retained: which host runs the room and whether it is connected. */
  host: (room: string) => `${PREFIX}/${room}/host`,
  /** Retained: positions saved by the host now and then, for the next host. */
  pos: (room: string) => `${PREFIX}/${room}/pos`,
  /** Retained: a player's name, colour and whether the device is awake. */
  presence: (room: string, pid: string) => `${PREFIX}/${room}/p/${pid}`,
  presenceAll: (room: string) => `${PREFIX}/${room}/p/+`,
  /** WebRTC offers and answers: sig/<to>/<from>. */
  sig: (room: string, to: string, from: string) => `${PREFIX}/${room}/sig/${to}/${from}`,
  sigTo: (room: string, to: string) => `${PREFIX}/${room}/sig/${to}/+`,
  /** Player → host over the broker (inputs, pings, stats), QoS 0. */
  up: (room: string, pid: string) => `${PREFIX}/${room}/up/${pid}`,
  upAll: (room: string) => `${PREFIX}/${room}/up/+`,
  /** Host → one player over the broker: snapshots (without a direct link) and pongs. */
  dnTo: (room: string, pid: string) => `${PREFIX}/${room}/dn/${pid}`,
  /** Retained: how the last WebRTC attempt of a player (or of the host with a player: h-<pid>) went. */
  diag: (room: string, id: string) => `${PREFIX}/${room}/diag/${id}`,
};

export interface HostMsg {
  id: string;
  online: boolean;
  /** When this host took the room (ms, its own clock): the newer host wins. */
  since: number;
  /** Who runs it: a player's name, or empty for a host page. */
  name: string;
}

export interface PresenceMsg {
  name: string;
  color: number;
  online: boolean;
}

export interface PosMsg {
  v: 2;
  ps: [string, number, number][];
}

export interface SigMsg {
  sid: string;
  sdp: RTCSessionDescriptionInit;
}

/** How a message travelled. */
export type Via = 'local' | 'rtc' | 'mqtt';

/** What a player reports about its link, shown on the host page. */
export interface LinkStats {
  /** 'local' | 'rtc' | 'mqtt' */
  via: Via;
  /** Candidate types of the WebRTC pair, e.g. "host/host". */
  route: string;
  rttRtc: number | null;
  rttMqtt: number | null;
}

export type UpMsg = { k: 'i'; in: Input[] } | { k: 'p'; c: number } | ({ k: 'st' } & LinkStats);
export type DownMsg = Snap | { k: 'o'; c: number };

export const COLORS = ['#e5484d', '#f0b429', '#4cc38a', '#3e9bf0', '#a875ff', '#ff7ab8', '#ff8f3f', '#e6e8ec'];

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
