import { Sim } from '../game/sim';
import { TICK_MS, type Vec } from '../game/world';
import { Bus, type BrokerConfig } from './mqtt';
import {
  randomId,
  topics,
  type DownMsg,
  type HostMsg,
  type LinkStats,
  type PosMsg,
  type PresenceMsg,
  type SigMsg,
  type UpMsg,
  type Via,
} from './protocol';
import { Diag, pairsReport, sdpCandidates, type DiagReport } from './diag';
import { gathered, iceServers, routeInfo, type RouteInfo, type TurnConfig } from './rtc';

export interface HostOptions {
  cfg: BrokerConfig;
  code: string;
  /** The player running it in their tab, or '' for a host page. */
  name: string;
  turn: TurnConfig | null;
}

interface Peer {
  sid: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  route: RouteInfo | null;
  /** Writes down how the attempt went (if not yet), then closes it. */
  end: (why: string) => void;
}

export interface PlayerRow {
  pid: string;
  name: string;
  color: number;
  online: boolean;
  /** How the host reaches the player now. */
  via: Via;
  route: RouteInfo | null;
  /** What the player measured. */
  stats: LinkStats | null;
}

/** Players offline this long leave the world. */
const DROP_AFTER_MS = 120_000;
/** Snapshots over the broker go out every Nth tick (10 per second). */
const BROKER_EVERY = 3;

/**
 * Runs the world for a room: takes inputs from players over WebRTC data
 * channels (or the broker when a direct link did not come up) and sends back
 * snapshots 30 times a second. Its own broker connection has a last will on
 * the host topic, so players notice a crash. The newest host wins: an older
 * one that sees it stops.
 */
export class Host {
  readonly id = randomId();
  readonly since = Date.now();
  readonly bus: Bus;
  /** The last WebRTC attempt with each player, for the host page. */
  readonly diags = new Map<string, DiagReport>();
  readonly sim = new Sim();
  readonly presence = new Map<string, PresenceMsg>();
  private offlineAt = new Map<string, number>();
  private saved = new Map<string, Vec>();
  readonly peers = new Map<string, Peer>();
  readonly stats = new Map<string, LinkStats>();
  private local: { pid: string; deliver: (m: DownMsg) => void } | null = null;
  private stopTicker: (() => void) | null = null;
  private t0 = 0;
  private done = 0;
  private announced = false;
  retired = false;
  /** Ticks in the last second. */
  tickRate = 0;
  private ticksThisSecond = 0;
  private secondAt = 0;
  onRetire?: () => void;
  private listeners = new Set<() => void>();

  constructor(private o: HostOptions) {
    this.bus = new Bus(o.cfg, { will: { topic: topics.host(o.code), payload: this.msg(false) } });
  }

  private msg(online: boolean): HostMsg {
    return { id: this.id, online, since: this.since, name: this.o.name };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const l of this.listeners) l();
  }

  /** The player in this tab gets snapshots without a network hop. */
  attachLocal(pid: string, deliver: (m: DownMsg) => void) {
    this.local = { pid, deliver };
  }

  /** `initial`: positions the tab already knows, fresher than the saved ones. */
  async start(initial?: [string, number, number][]): Promise<void> {
    const { code } = this.o;
    await this.bus.ready();
    await this.bus.subscribe(topics.pos(code), (_t, p, meta) => {
      const m = p as PosMsg | null;
      if (meta.retained && m?.v === 2 && Array.isArray(m.ps) && !initial)
        for (const [pid, x, y] of m.ps) this.saved.set(pid, { x, y });
    });
    for (const [pid, x, y] of initial ?? []) this.saved.set(pid, { x, y });
    await this.bus.subscribe(topics.presenceAll(code), (t, p) => this.onPresence(t.split('/').pop()!, p));
    await this.bus.subscribe(topics.host(code), (_t, p) => this.onHostMsg(p as HostMsg | null));
    await this.bus.subscribe(topics.sigTo(code, this.id), (t, p) => void this.onSig(t.split('/').pop()!, p as SigMsg));
    await this.bus.subscribe(topics.upAll(code), (t, p) => this.onUp(t.split('/').pop()!, p as UpMsg, 'mqtt'), 0);
    if (this.retired) return;
    this.announced = true;
    await this.bus.publish(topics.host(code), this.msg(true), true);
    this.t0 = performance.now();
    this.secondAt = this.t0;
    this.stopTicker = startTicker(() => this.pump());
    this.changed();
  }

  private onPresence(pid: string, p: unknown) {
    if (p && typeof p === 'object' && 'name' in p) {
      const m = p as PresenceMsg;
      this.presence.set(pid, m);
      if (m.online) {
        this.offlineAt.delete(pid);
        if (!this.sim.players.has(pid)) this.sim.add(pid, this.saved.get(pid));
      } else if (!this.offlineAt.has(pid)) this.offlineAt.set(pid, Date.now());
    } else {
      this.presence.delete(pid);
      this.sim.remove(pid);
    }
    this.changed();
  }

  private onHostMsg(m: HostMsg | null) {
    if (this.retired || !m || m.id === this.id) return;
    if (m.online && (m.since > this.since || (m.since === this.since && m.id > this.id))) void this.retire();
    // An older host or a dead one's last will overwrote us: say again that we run the room.
    else if (this.announced) void this.bus.publish(topics.host(this.o.code), this.msg(true), true);
  }

  onUp(pid: string, m: UpMsg, via: Via) {
    if (this.retired || !m || typeof m !== 'object') return;
    if (m.k === 'i' && Array.isArray(m.in)) {
      if (!this.sim.players.has(pid) && this.presence.has(pid)) this.sim.add(pid, this.saved.get(pid));
      this.sim.input(pid, m.in);
    } else if (m.k === 'p') this.send(pid, { k: 'o', c: m.c }, via);
    else if (m.k === 'st') this.stats.set(pid, { via: m.via, route: m.route, rttRtc: m.rttRtc, rttMqtt: m.rttMqtt });
  }

  private send(pid: string, m: DownMsg, via: Via) {
    if (via === 'local') this.local?.deliver(m);
    else if (via === 'rtc') {
      const dc = this.peers.get(pid)?.dc;
      if (dc?.readyState === 'open') dc.send(JSON.stringify(m));
    } else this.bus.fast(topics.dnTo(this.o.code, pid), m);
  }

  private async onSig(from: string, m: SigMsg) {
    if (this.retired || typeof RTCPeerConnection === 'undefined' || !m?.sdp || m.sdp.type !== 'offer') return;
    this.peers.get(from)?.end('пришла новая попытка');
    const pc = new RTCPeerConnection({ iceServers: iceServers(this.o.turn) });
    const peer: Peer = { sid: m.sid, pc, dc: null, route: null, end: () => {} };
    this.peers.set(from, peer);
    const d = new Diag('host', from);
    this.diags.set(from, d.r);
    d.watch(pc);
    d.r.remote = sdpCandidates(m.sdp.sdp);
    d.add(`предложение игрока получено, адресов: ${d.r.remote.length}`);
    let reported = false;
    const report = async (outcome: string) => {
      if (reported) return;
      reported = true;
      d.add(outcome);
      d.r.outcome = outcome;
      d.r.pairs = await pairsReport(pc);
      this.publishDiag(from, d.r);
    };
    peer.end = (why) => {
      if (peer.dc?.readyState === 'open') pc.close();
      else void report(`${why} (ICE: ${pc.iceConnectionState})`).finally(() => pc.close());
    };
    const drop = () => {
      if (this.peers.get(from) !== peer) return;
      this.peers.delete(from);
      peer.end('не вышло');
      this.changed();
    };
    pc.ondatachannel = (e) => {
      const dc = e.channel;
      peer.dc = dc;
      dc.onmessage = (ev) => {
        try {
          this.onUp(from, JSON.parse(ev.data as string) as UpMsg, 'rtc');
        } catch {
          /* malformed */
        }
      };
      dc.onopen = () => {
        d.add('канал открыт');
        setTimeout(() => void report('open'), 1500);
        this.changed();
        void routeInfo(pc).then((r) => (peer.route = r));
      };
      dc.onclose = drop;
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') drop();
    };
    try {
      await pc.setRemoteDescription(m.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      if (this.peers.get(from) !== peer) return;
      d.r.local = sdpCandidates(pc.localDescription?.sdp);
      d.add(`ответ отправлен, адресов: ${d.r.local.length}`);
      await this.bus.publish(topics.sig(this.o.code, from, this.id), { sid: m.sid, sdp: pc.localDescription!.toJSON() } satisfies SigMsg);
    } catch {
      drop();
    }
  }

  private publishDiag(pid: string, r: DiagReport) {
    if (this.bus.online) void this.bus.publish(topics.diag(this.o.code, `h-${pid}`), r, true).catch(() => {});
  }

  private hasDirect(pid: string): boolean {
    return this.peers.get(pid)?.dc?.readyState === 'open';
  }

  /** Someone online has neither a direct link nor this tab. */
  private needsBroker(): boolean {
    for (const [pid, p] of this.presence) if (p.online && pid !== this.local?.pid && !this.hasDirect(pid)) return true;
    return false;
  }

  /** Runs the ticks that are due; a late timer catches up a little, a long stall is skipped. */
  private pump() {
    if (this.retired) return;
    const now = performance.now();
    const due = Math.floor((now - this.t0) / TICK_MS);
    for (let k = 0; this.done < due && k < 5; k++, this.done++) this.tick();
    this.done = due;
    if (now - this.secondAt >= 1000) {
      this.tickRate = Math.round((this.ticksThisSecond * 1000) / (now - this.secondAt));
      this.ticksThisSecond = 0;
      this.secondAt = now;
      this.housekeeping();
    }
  }

  private tick() {
    this.ticksThisSecond++;
    const sim = this.sim;
    sim.tick();
    const snap = sim.snapshot(performance.now());
    const json = JSON.stringify(snap);
    for (const p of this.peers.values())
      if (p.dc?.readyState === 'open' && p.dc.bufferedAmount < 65536) p.dc.send(json);
    this.local?.deliver(snap);
    if (sim.n % BROKER_EVERY === 0 && this.needsBroker()) this.bus.fast(topics.dn(this.o.code), snap);
    if (sim.n % 150 === 0) this.savePositions();
  }

  private housekeeping() {
    const now = Date.now();
    for (const [pid, at] of this.offlineAt)
      if (now - at > DROP_AFTER_MS) {
        this.sim.remove(pid);
        this.offlineAt.delete(pid);
      }
    for (const p of this.peers.values()) if (p.dc?.readyState === 'open') void routeInfo(p.pc).then((r) => (p.route = r));
    this.changed();
  }

  private savePositions() {
    for (const [pid, x, y] of this.sim.positions()) this.saved.set(pid, { x, y });
    void this.bus.publish(topics.pos(this.o.code), { v: 2, ps: [...this.saved].map(([pid, p]) => [pid, p.x, p.y]) } satisfies PosMsg, true).catch(() => {});
  }

  rows(): PlayerRow[] {
    const pids = new Set([...this.sim.players.keys()]);
    for (const [pid, p] of this.presence) if (p.online) pids.add(pid);
    return [...pids].map((pid) => {
      const p = this.presence.get(pid);
      return {
        pid,
        name: p?.name ?? '?',
        color: p?.color ?? 7,
        online: !!p?.online,
        via: pid === this.local?.pid ? 'local' : this.hasDirect(pid) ? 'rtc' : 'mqtt',
        route: this.peers.get(pid)?.route ?? null,
        stats: this.stats.get(pid) ?? null,
      };
    });
  }

  private shutdown() {
    this.retired = true;
    this.stopTicker?.();
    this.stopTicker = null;
    for (const p of this.peers.values()) p.pc.close();
    this.peers.clear();
  }

  /** Another host took over: leave quietly (a clean disconnect does not fire the last will). */
  private async retire() {
    this.shutdown();
    this.changed();
    this.onRetire?.();
    await this.bus.end();
  }

  /** Stops on purpose: saves positions and marks the room as without a host. */
  async stop(): Promise<void> {
    if (this.retired) return;
    this.savePositions();
    this.shutdown();
    this.changed();
    try {
      await this.bus.publish(topics.host(this.o.code), this.msg(false), true);
    } finally {
      await this.bus.end();
    }
  }
}

/**
 * Ticks from a worker: timers in a background tab are throttled to once a
 * second or less, a worker's are not, so a host page keeps running while the
 * laptop shows something else.
 */
function startTicker(fn: () => void): () => void {
  try {
    const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${Math.floor(TICK_MS / 2)});`], { type: 'text/javascript' }));
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    w.onmessage = fn;
    return () => w.terminate();
  } catch {
    const t = setInterval(fn, Math.floor(TICK_MS / 2));
    return () => clearInterval(t);
  }
}
