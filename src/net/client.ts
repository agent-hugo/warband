import { isRoom } from './host';
import { Bus, type BrokerConfig } from './mqtt';
import { topics, type CmdMsg, type HostMsg, type Op, type PresenceMsg, type ReplyMsg, type RoomState } from './protocol';

export interface ClientView {
  connected: boolean;
  /** No state yet: the room is new or the host never ran. */
  room: RoomState | null;
  host: HostMsg | null;
  presence: Record<string, PresenceMsg>;
  error: string;
}

/**
 * A player's link to a room: follows the retained state, host and presence
 * topics, announces this device (awake / asleep) and sends commands.
 */
export class RoomClient {
  readonly bus: Bus;
  view: ClientView = { connected: false, room: null, host: null, presence: {}, error: '' };
  private seq = Date.now();
  private listeners = new Set<() => void>();

  constructor(
    cfg: BrokerConfig,
    readonly code: string,
    readonly pid: string,
    private name: string,
  ) {
    this.bus = new Bus(cfg, { will: { topic: topics.presence(code, pid), payload: { name, online: false } } });
    this.bus.onStatus((on) => {
      this.set({ connected: on });
      if (on) this.announce();
    });
    void this.bus.subscribe(topics.state(code), (_t, p) => {
      if (isRoom(p)) this.set({ room: p });
    });
    void this.bus.subscribe(topics.host(code), (_t, p) => this.set({ host: (p as HostMsg | null) ?? null }));
    void this.bus.subscribe(topics.presenceAll(code), (t, p) => {
      const pid = t.split('/').pop()!;
      const presence = { ...this.view.presence };
      if (p && typeof p === 'object' && 'name' in p) presence[pid] = p as PresenceMsg;
      else delete presence[pid];
      this.set({ presence });
    });
    void this.bus.subscribe(topics.reply(code, pid), (_t, p) => {
      const r = p as ReplyMsg | null;
      if (r?.err) this.set({ error: r.err });
    });
  }

  private set(patch: Partial<ClientView>) {
    this.view = { ...this.view, ...patch };
    for (const l of this.listeners) l();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Awake (page visible) or asleep. */
  awake = true;
  announce(awake = this.awake) {
    this.awake = awake;
    if (this.bus.online) void this.bus.publish(topics.presence(this.code, this.pid), { name: this.name, online: awake } satisfies PresenceMsg, true);
  }

  send(op: Op) {
    this.set({ error: '' });
    void this.bus.publish(topics.cmd(this.code, this.pid), { ...op, seq: ++this.seq } as CmdMsg);
  }

  clearError() {
    this.set({ error: '' });
  }

  async close() {
    this.announce(false);
    await this.bus.end();
  }
}
