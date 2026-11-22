import mqtt from 'mqtt';
import type { IPublishPacket, MqttClient } from 'mqtt';

export interface BrokerConfig {
  url: string;
  token: string;
}

/** Retained messages expire after 7 days, so abandoned rooms disappear from the broker. */
export const RETAIN_EXPIRY_S = 7 * 24 * 60 * 60;

/** What the broker says about a message besides its payload. */
export interface MessageMeta {
  /** Sent from the retained store on subscribe rather than live. */
  retained: boolean;
}

export type Handler = (topic: string, payload: unknown, meta: MessageMeta) => void;

function metaOf(packet: IPublishPacket): MessageMeta {
  return { retained: packet.retain };
}

/** Thin JSON wrapper over mqtt.js with topic-filter handlers. */
export class Bus {
  private client: MqttClient;
  private handlers: { filter: string; fn: Handler }[] = [];
  private statusListeners = new Set<(online: boolean) => void>();
  online = false;

  constructor(cfg: BrokerConfig, opts: { will?: { topic: string; payload: unknown } } = {}) {
    this.client = mqtt.connect(cfg.url, {
      username: cfg.token,
      password: '',
      protocolVersion: 5,
      clean: true,
      reconnectPeriod: 2000,
      keepalive: 15, // notice a dead link within ~20 s (phones sleep, Wi-Fi drops)
      connectTimeout: 10000,
      clientId: `wb-${Math.random().toString(16).slice(2, 12)}`,
      will: opts.will
        ? {
            topic: opts.will.topic,
            payload: JSON.stringify(opts.will.payload),
            qos: 1,
            retain: true,
            properties: { messageExpiryInterval: RETAIN_EXPIRY_S },
          }
        : undefined,
    });
    this.client.on('connect', () => this.setOnline(true));
    this.client.on('close', () => this.setOnline(false));
    this.client.on('offline', () => this.setOnline(false));
    this.client.on('message', (topic, buf, packet) => {
      const payload = parse(buf);
      if (payload !== undefined) this.dispatch(topic, payload, metaOf(packet));
    });
  }

  private setOnline(v: boolean) {
    if (this.online === v) return;
    this.online = v;
    for (const l of this.statusListeners) l(v);
  }

  onStatus(fn: (online: boolean) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  /** Resolves once connected for the first time; rejects on an auth error. */
  ready(): Promise<void> {
    if (this.online) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const off = this.onStatus((on) => {
        if (on) {
          off();
          this.client.off('error', onError);
          resolve();
        }
      });
      const onError = (e: Error) => {
        off();
        reject(e);
      };
      this.client.once('error', onError);
    });
  }

  private dispatch(topic: string, payload: unknown, meta: MessageMeta) {
    for (const h of this.handlers) if (matches(h.filter, topic)) h.fn(topic, payload, meta);
  }

  /**
   * Resolves on the SUBACK; the broker sends the retained messages before
   * it, so by then the handler has seen all of them.
   */
  subscribe(filter: string, fn: Handler, qos: 0 | 1 = 1): Promise<void> {
    this.handlers.push({ filter, fn });
    const done = this.client.subscribeAsync(filter, { qos }).then(() => undefined);
    done.catch(() => {}); // most callers do not wait
    return done;
  }

  /** `expire: false` keeps a retained message for good. */
  publish(topic: string, payload: unknown, retain = false, expire = true): Promise<void> {
    const body = payload === null ? '' : JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const properties = retain && expire ? { messageExpiryInterval: RETAIN_EXPIRY_S } : undefined;
      this.client.publish(topic, body, { qos: 1, retain, properties }, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Fire and forget: QoS 0, not retained. For frequent realtime messages; dropped while offline. */
  fast(topic: string, payload: unknown): void {
    if (this.online) this.client.publish(topic, JSON.stringify(payload), { qos: 0 });
  }

  end(): Promise<void> {
    return new Promise((resolve) => this.client.end(false, {}, () => resolve()));
  }
}

/** JSON payload; null for an empty (cleared) message, undefined if malformed. */
function parse(buf: Buffer): unknown {
  if (buf.length === 0) return null;
  try {
    return JSON.parse(buf.toString());
  } catch {
    return undefined;
  }
}

export function matches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}
