import { randomId } from '../net/protocol';

export const DEFAULT_BROKER = 'wss://mqtt.flespi.io';

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

export const settings = {
  get brokerUrl(): string {
    return load('wb:broker') || DEFAULT_BROKER;
  },
  set brokerUrl(v: string) {
    save('wb:broker', v.trim() || null);
  },
  get token(): string {
    return load('wb:token') ?? '';
  },
  set token(v: string) {
    save('wb:token', v.trim() || null);
  },
  get name(): string {
    return load('wb:name') ?? '';
  },
  set name(v: string) {
    save('wb:name', v.trim() || null);
  },
  /** Stable id of this device's player. */
  get playerId(): string {
    let id = load('wb:pid');
    if (!id) {
      id = randomId();
      save('wb:pid', id);
    }
    return id;
  },
  get lastRoom(): string {
    return load('wb:room') ?? '';
  },
  set lastRoom(v: string) {
    save('wb:room', v || null);
  },
};
