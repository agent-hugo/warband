import { randomId } from '../net/protocol';
import type { TurnConfig } from '../net/rtc';

export const DEFAULT_BROKER = 'wss://mqtt.flespi.io';

function load(key: string, store: Storage = localStorage): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string | null, store: Storage = localStorage): void {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

function text(key: string) {
  return {
    get: () => load(key) ?? '',
    set: (v: string) => save(key, v.trim() || null),
  };
}

const broker = text('wb:broker');
const token = text('wb:token');
const name = text('wb:name');
const room = text('wb:room');
const turnUrl = text('wb:turn-url');
const turnUser = text('wb:turn-user');
const turnPass = text('wb:turn-pass');

export const settings = {
  get brokerUrl() {
    return broker.get() || DEFAULT_BROKER;
  },
  set brokerUrl(v: string) {
    broker.set(v);
  },
  get token() {
    return token.get();
  },
  set token(v: string) {
    token.set(v);
  },
  get name() {
    return name.get();
  },
  set name(v: string) {
    name.set(v);
  },
  get color(): number {
    const c = Number(load('wb:color'));
    return Number.isInteger(c) && c >= 0 && c < 8 ? c : Math.floor(Math.random() * 7);
  },
  set color(v: number) {
    save('wb:color', String(v));
  },
  /**
   * Player id of this tab: kept across reloads of the tab, but two tabs of
   * one browser are two players (handy for trying it on a laptop).
   */
  get playerId(): string {
    let id = load('wb:pid', sessionStorage);
    if (!id) {
      id = randomId();
      save('wb:pid', id, sessionStorage);
    }
    return id;
  },
  get lastRoom() {
    return room.get();
  },
  set lastRoom(v: string) {
    room.set(v);
  },
  get turn(): TurnConfig | null {
    const url = turnUrl.get();
    return url ? { url, user: turnUser.get(), pass: turnPass.get() } : null;
  },
  set turn(t: TurnConfig | null) {
    turnUrl.set(t?.url ?? '');
    turnUser.set(t?.user ?? '');
    turnPass.set(t?.pass ?? '');
  },
};
