import { Predictor, Timeline, type Pose } from '../game/predict';
import type { Snap } from '../game/sim';
import { speedOf, type TagState } from '../game/tag';
import { TICK_MS } from '../game/world';
import { Host } from './host';
import { Bus, type BrokerConfig } from './mqtt';
import {
  randomId,
  topics,
  type DownMsg,
  type HostMsg,
  type LinkStats,
  type PresenceMsg,
  type SigMsg,
  type UpMsg,
  type Via,
} from './protocol';
import { holdMic } from './mic';
import { Diag, pairsReport, sdpCandidates, type DiagReport } from './diag';
import { CHANNEL, gathered, iceServers, routeInfo, routeLabel, type RouteInfo, type TurnConfig } from './rtc';

export interface SessionOptions {
  cfg: BrokerConfig;
  code: string;
  pid: string;
  name: string;
  color: number;
  turn: TurnConfig | null;
}

export type RtcState = 'off' | 'connecting' | 'open' | 'failed';

export interface SessionInfo {
  connected: boolean;
  host: HostMsg | null;
  /** This tab runs the host. */
  hosting: boolean;
  /** Where snapshots come from now. */
  via: Via | null;
  rtc: RtcState;
  route: string;
  rttRtc: number | null;
  rttMqtt: number | null;
  /** Snapshots per second actually used. */
  snapRate: number;
  corrections: number;
  presence: [string, PresenceMsg][];
  game: TagState | null;
  gameN: number;
}

/** How far in the past others are drawn, ms: enough to have the next snapshot already. */
const INTERP_DELAY: Record<Via, number> = { local: 50, rtc: 90, mqtt: 230 };
/** Waiting for a WebRTC link before falling back to the broker, ms. */
const RTC_TIMEOUT = 12_000;

/**
 * A player's tab in a room. Joystick inputs go to the host over a WebRTC
 * data channel or, until one is up (or if it never comes up), over the
 * broker; snapshots come back the same way. If the room has no host, the
 * awake players elect one by id and that tab starts it.
 */
export class Session {
  readonly bus: Bus;
  host: HostMsg | null = null;
  presence = new Map<string, PresenceMsg>();
  readonly pred = new Predictor();
  readonly tl = new Timeline();
  /** The game as of the last snapshot, and that snapshot's tick. */
  game: TagState | null = null;
  gameN = 0;
  /** The host running in this tab, if any. */
  local: Host | null = null;

  /** Options to feel the difference. */
  mode: 'auto' | 'mqtt' = 'auto';
  predict = true;
  interp = true;
  /** Ping the host over the broker every second even while WebRTC is up, to compare. */
  brokerPing = true;
  /** The last WebRTC attempt, for the menu. */
  diag: Diag | null = null;

  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private sid = '';
  rtc: RtcState = 'off';
  private rtcSince = 0;
  private retryAt = 0;
  route: RouteInfo | null = null;

  rttRtc: number | null = null;
  rttMqtt: number | null = null;
  private lastN = -1;
  lastVia: Via | null = null;
  private snapCount = 0;
  snapRate = 0;

  private visible = typeof document === 'undefined' || document.visibilityState === 'visible';
  private connectedAt = 0;
  private hostLostAt: number | null = null;
  private acc = 0;
  private lastFrame = 0;
  private ticks = 0;
  private timer: ReturnType<typeof setInterval>;
  private second = 0;
  private closed = false;

  constructor(readonly o: SessionOptions) {
    const { code, pid } = o;
    this.bus = new Bus(o.cfg, { will: { topic: topics.presence(code, pid), payload: this.me(false) } });
    this.bus.onStatus((on) => {
      if (!on) return;
      this.connectedAt = performance.now();
      this.announce();
    });
    void this.bus.subscribe(topics.host(code), (_t, p) => this.onHost(p as HostMsg | null));
    void this.bus.subscribe(topics.presenceAll(code), (t, p) => {
      const id = t.split('/').pop()!;
      if (p && typeof p === 'object' && 'name' in p) this.presence.set(id, p as PresenceMsg);
      else this.presence.delete(id);
    });
    void this.bus.subscribe(topics.sigTo(code, pid), (_t, p) => void this.onAnswer(p as SigMsg));
    void this.bus.subscribe(topics.dnTo(code, pid), (_t, p) => this.onDown(p as DownMsg, 'mqtt'), 0);
    this.timer = setInterval(() => this.housekeeping(), 250);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
  }

  private me(online: boolean): PresenceMsg {
    return { name: this.o.name, color: this.o.color, online };
  }

  private announce() {
    if (this.bus.online) void this.bus.publish(topics.presence(this.o.code, this.o.pid), this.me(this.visible), true).catch(() => {});
  }

  private onVisibility = () => {
    this.visible = document.visibilityState === 'visible';
    this.announce();
    // A phone freezes a hidden page: hand the room over rather than stall it.
    if (!this.visible && this.local) {
      const h = this.local;
      this.local = null;
      void h.stop();
    }
    if (this.visible) this.retryAt = 0;
  };

  get hostAlive(): boolean {
    return !!this.host?.online;
  }

  get hosting(): boolean {
    return !!this.local && !this.local.retired && this.host?.id === this.local.id;
  }

  private onHost(m: HostMsg | null) {
    const before = this.host?.online ? this.host.id : null;
    this.host = m && typeof m === 'object' && 'id' in m ? m : null;
    const after = this.host?.online ? this.host.id : null;
    if (before === after) return;
    // A new host: its clock and ticks start over, and it knows nothing of our inputs.
    this.closeRtc();
    this.pred.reset();
    this.tl.reset();
    this.game = null;
    this.lastN = -1;
    this.lastVia = null;
    this.rttRtc = null;
    this.retryAt = 0;
    this.hostLostAt = after ? null : performance.now();
  }

  // ───────── WebRTC ─────────

  private closeRtc() {
    if (this.pc && this.diag?.r.outcome === 'идёт') this.diag.r.outcome = 'прервано';
    this.dc?.close();
    this.pc?.close();
    this.pc = null;
    this.dc = null;
    this.rtc = 'off';
    this.route = null;
  }

  private failRtc(retryMs: number, why: string) {
    const pc = this.pc;
    const d = this.diag;
    this.pc = null; // keep it open a moment for its stats
    this.closeRtc();
    this.rtc = 'failed';
    this.retryAt = performance.now() + retryMs;
    if (d && pc) {
      d.add(why);
      d.r.outcome = why;
      void pairsReport(pc).then((pairs) => {
        d.r.pairs = pairs;
        pc.close();
        this.publishDiag(d.r);
      });
    } else pc?.close();
  }

  /** Kept on the broker (retained) so a failed link can be looked at later. */
  private publishDiag(r: DiagReport) {
    if (this.bus.online) void this.bus.publish(topics.diag(this.o.code, this.o.pid), r, true).catch(() => {});
  }

  private async connectRtc() {
    const host = this.host;
    if (!host || typeof RTCPeerConnection === 'undefined') {
      this.rtc = 'failed';
      this.retryAt = Infinity;
      return;
    }
    this.closeRtc();
    const sid = randomId();
    const pc = new RTCPeerConnection({ iceServers: iceServers(this.o.turn) });
    const dc = pc.createDataChannel('g', CHANNEL);
    const d = new Diag('player', host.id);
    d.watch(pc);
    this.diag = d;
    this.pc = pc;
    this.dc = dc;
    this.sid = sid;
    this.rtc = 'connecting';
    this.rtcSince = performance.now();
    const release = await holdMic(d);
    if (this.pc !== pc) return release();
    dc.onopen = () => {
      if (this.dc !== dc) return;
      this.rtc = 'open';
      d.add('канал открыт');
      d.r.outcome = 'open';
      void routeInfo(pc).then((r) => (this.route = r));
      setTimeout(() => {
        if (this.pc !== pc) return;
        void pairsReport(pc).then((pairs) => {
          d.r.pairs = pairs;
          this.publishDiag(d.r);
        });
      }, 1500);
    };
    dc.onclose = () => {
      if (this.dc === dc) this.failRtc(3000, 'канал закрылся');
    };
    dc.onmessage = (ev) => {
      try {
        this.onDown(JSON.parse(ev.data as string) as DownMsg, 'rtc');
      } catch {
        /* malformed */
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.pc === pc && pc.connectionState === 'failed') this.failRtc(10_000, 'соединение не удалось (failed)');
    };
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      release();
      if (this.pc !== pc) return;
      d.r.local = sdpCandidates(pc.localDescription?.sdp);
      d.add(`предложение отправлено хосту, адресов: ${d.r.local.length}`);
      await this.bus.publish(topics.sig(this.o.code, host.id, this.o.pid), { sid, sdp: pc.localDescription!.toJSON() } satisfies SigMsg);
    } catch (e) {
      release();
      if (this.pc === pc) this.failRtc(10_000, `ошибка: ${String(e)}`);
    }
  }

  private async onAnswer(m: SigMsg) {
    const pc = this.pc;
    if (!pc || !m?.sdp || m.sid !== this.sid || m.sdp.type !== 'answer' || pc.signalingState !== 'have-local-offer') return;
    this.diag?.add('ответ хоста получен');
    if (this.diag) this.diag.r.remote = sdpCandidates(m.sdp.sdp);
    try {
      await pc.setRemoteDescription(m.sdp);
    } catch (e) {
      if (this.pc === pc) this.failRtc(10_000, `ответ не принят: ${String(e)}`);
    }
  }

  /** Starts a new direct link now, e.g. after an option changed. */
  retryRtc() {
    if (this.mode !== 'auto') return;
    this.closeRtc();
    this.retryAt = 0;
  }

  setMode(mode: 'auto' | 'mqtt') {
    this.mode = mode;
    this.closeRtc();
    this.retryAt = 0;
  }

  // ───────── messages ─────────

  private upSend(m: UpMsg): Via | null {
    if (this.hosting) {
      this.local!.onUp(this.o.pid, m, 'local');
      return 'local';
    }
    if (!this.hostAlive) return null;
    if (this.dc?.readyState === 'open') {
      this.dc.send(JSON.stringify(m));
      return 'rtc';
    }
    this.bus.fast(topics.up(this.o.code, this.o.pid), m);
    return 'mqtt';
  }

  onDown(m: DownMsg, via: Via) {
    if (!m || typeof m !== 'object') return;
    const now = performance.now();
    if (m.k === 'o') {
      if (typeof m.c !== 'number') return;
      const rtt = Math.round(now - m.c);
      if (via === 'mqtt') this.rttMqtt = this.rttMqtt === null ? rtt : Math.round(this.rttMqtt * 0.6 + rtt * 0.4);
      else if (via === 'rtc') this.rttRtc = this.rttRtc === null ? rtt : Math.round(this.rttRtc * 0.6 + rtt * 0.4);
      return;
    }
    if (m.k !== 's' || !Array.isArray(m.ps)) return;
    if (this.hosting ? via !== 'local' : via === 'local') return;
    if (m.n <= this.lastN) return; // an older or duplicate snapshot (two routes)
    this.lastN = m.n;
    this.lastVia = via;
    this.snapCount++;
    this.tl.push(m as Snap, now);
    this.game = m.g ?? null;
    this.gameN = m.n;
    this.pred.speed = speedOf(this.game, this.o.pid, m.n + 1);
    const mine = m.ps.find((p) => p[0] === this.o.pid);
    if (mine) this.pred.server({ x: mine[1], y: mine[2] }, mine[4], this.predict);
  }

  // ───────── loop ─────────

  /** Called every animation frame with the joystick direction; runs input ticks at 30 Hz. */
  frame(now: number, dir: number) {
    if (!this.lastFrame) this.lastFrame = now;
    this.acc = Math.min(this.acc + (now - this.lastFrame), TICK_MS * 5);
    this.lastFrame = now;
    while (this.acc >= TICK_MS) {
      this.acc -= TICK_MS;
      this.inputTick(dir);
    }
  }

  private inputTick(dir: number) {
    this.ticks++;
    if (!this.hostAlive) return;
    const inp = this.pred.input(dir, this.predict);
    if (!inp) return;
    if (this.hosting) this.upSend({ k: 'i', in: [inp] });
    else if (this.dc?.readyState === 'open') this.upSend({ k: 'i', in: this.pred.pending.slice(-4) }); // copies cover lost packets
    else if (this.ticks % 3 === 0) this.upSend({ k: 'i', in: this.pred.pending.slice(-15) }); // 10 messages a second over the broker
  }

  /** Poses to draw now; `dt` since the previous frame. */
  poses(now: number, dt: number): { all: Map<string, Pose>; ghost: Pose | null } {
    const delay = INTERP_DELAY[this.lastVia ?? 'rtc'];
    const base = (this.interp ? this.tl.at(now, delay) : this.tl.latest()) ?? new Map<string, Pose>();
    const all = new Map(base);
    const server = this.tl.latest()?.get(this.o.pid) ?? null;
    const self = this.predict ? this.pred.visible(dt) : null;
    if (self) all.set(this.o.pid, { ...self, dir: server?.dir ?? -1 });
    return { all, ghost: server };
  }

  private housekeeping() {
    if (this.closed) return;
    const now = performance.now();
    this.electHost(now);
    if (this.hostAlive && !this.hosting && this.mode === 'auto' && this.visible) {
      if ((this.rtc === 'off' || this.rtc === 'failed') && now >= this.retryAt) void this.connectRtc();
      else if (this.rtc === 'connecting' && now - this.rtcSince > RTC_TIMEOUT)
        this.failRtc(15_000, this.pc?.signalingState === 'have-local-offer' ? 'хост не ответил за 12 с' : 'за 12 с не соединилось');
    }
    if (now - this.second >= 1000) {
      this.snapRate = Math.round((this.snapCount * 1000) / (now - this.second || 1000));
      this.snapCount = 0;
      this.second = now;
      if (this.hostAlive && this.visible) {
        // The same ping both ways, to compare.
        if (!this.hosting && this.dc?.readyState === 'open') this.dc.send(JSON.stringify({ k: 'p', c: now } satisfies UpMsg));
        // Without a direct link the broker is the link, so it is measured anyway.
        if (this.brokerPing || this.hosting || this.dc?.readyState !== 'open') this.bus.fast(topics.up(this.o.code, this.o.pid), { k: 'p', c: now } satisfies UpMsg);
        else this.rttMqtt = null;
        this.upSend({ k: 'st', ...this.linkStats() });
        if (this.pc && this.rtc === 'open') void routeInfo(this.pc).then((r) => (this.route = r));
      }
    }
  }

  private linkStats(): LinkStats {
    return {
      via: this.hosting ? 'local' : this.dc?.readyState === 'open' ? 'rtc' : 'mqtt',
      route: this.route ? `${this.route.local}/${this.route.remote}` : '',
      rttRtc: this.rttRtc,
      rttMqtt: this.rttMqtt,
    };
  }

  /**
   * No host: the awake players wait in id order, 1.5 s for the first and
   * 2.5 s more for each next one, and the first whose turn comes starts it.
   */
  private electHost(now: number) {
    if (this.local || !this.bus.online || !this.visible || this.hostAlive) return;
    if (now - this.connectedAt < 1500) return; // the retained host message may still be on its way
    this.hostLostAt ??= now;
    const awake = [...this.presence].filter(([, p]) => p.online).map(([id]) => id);
    if (!awake.includes(this.o.pid)) awake.push(this.o.pid);
    awake.sort();
    const delay = 1500 + awake.indexOf(this.o.pid) * 2500;
    if (now - this.hostLostAt >= delay) void this.becomeHost();
  }

  /** Starts a host in this tab; it takes over from any running host. */
  async becomeHost() {
    if (this.local && !this.local.retired) return;
    const h = new Host({ cfg: this.o.cfg, code: this.o.code, name: this.o.name, turn: this.o.turn });
    this.local = h;
    h.attachLocal(this.o.pid, (m) => this.onDown(m, 'local'));
    h.onRetire = () => {
      if (this.local === h) this.local = null;
    };
    const known = this.tl.latest();
    try {
      await h.start(known && known.size ? [...known].map(([pid, p]) => [pid, p.x, p.y]) : undefined);
    } catch {
      if (this.local === h) this.local = null;
      void h.stop();
    }
  }

  info(): SessionInfo {
    const r = this.route;
    return {
      connected: this.bus.online,
      host: this.host,
      hosting: this.hosting,
      via: this.hosting ? 'local' : this.lastVia,
      rtc: this.rtc,
      route: r ? routeLabel(r.local, r.remote) : '',
      rttRtc: this.rttRtc,
      rttMqtt: this.rttMqtt,
      snapRate: this.snapRate,
      corrections: this.pred.corrections,
      presence: [...this.presence],
      game: this.game,
      gameN: this.gameN,
    };
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    this.closeRtc();
    const h = this.local;
    this.local = null;
    await h?.stop().catch(() => {});
    if (this.bus.online) await this.bus.publish(topics.presence(this.o.code, this.o.pid), this.me(false), true).catch(() => {});
    await this.bus.end();
  }
}
