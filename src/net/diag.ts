/**
 * What happened while a WebRTC link was coming up: the addresses each side
 * offered, the browser's state changes, and the address pairs it tried.
 * Shown in the menu and kept on the broker, to see why a link did not come up.
 */

export interface DiagReport {
  /** Who wrote it: 'player' or 'host'. */
  side: 'player' | 'host';
  /** The other end's id. */
  peer: string;
  browser: string;
  /** Wall clock, ms. */
  at: number;
  /** Still going, 'open' or why it failed. */
  outcome: string;
  log: string[];
  local: string[];
  remote: string[];
  pairs: string[];
}

/** Browser and OS in a few words, e.g. "Firefox 145 · Android". */
export function browserName(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  const known: [string, RegExp][] = [
    ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
    ['Samsung', /SamsungBrowser\/(\d+)/],
    ['Edge', /EdgA?\/(\d+)/],
    ['Opera', /OPR\/(\d+)/],
    ['Яндекс', /YaBrowser\/(\d+)/],
    ['Chrome', /(?:Chrome|CriOS)\/(\d+)/],
    ['Safari', /Version\/(\d+).*Safari/],
  ];
  let b = 'браузер ?';
  for (const [name, re] of known) {
    const m = re.exec(ua);
    if (m) {
      b = `${name} ${m[1]}`;
      break;
    }
  }
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} · ${os}` : b;
}

/** "abcdef12-….local" → "abcd….local": enough to tell names apart. */
function shortAddr(a: string): string {
  return a.endsWith('.local') ? `${a.slice(0, 4)}….local` : a;
}

/** Candidates of a description, one per line: "host udp abcd….local:51234". */
export function sdpCandidates(sdp: string | undefined): string[] {
  const out: string[] = [];
  for (const line of (sdp ?? '').split(/\r?\n/)) {
    const m = /^a=candidate:\S+ (\d) (\S+) \d+ (\S+) (\d+) typ (\S+)/.exec(line);
    if (!m || m[1] !== '1') continue;
    out.push(`${m[5]} ${m[2]!.toLowerCase()} ${shortAddr(m[3]!)}:${m[4]}`);
  }
  return out;
}

/** Every address pair the browser tried, with its state. */
export async function pairsReport(pc: RTCPeerConnection): Promise<string[]> {
  try {
    const stats = await pc.getStats();
    const cand = (id: string) => {
      const c: any = stats.get(id);
      if (!c) return '?';
      const addr = c.address ?? c.ip ?? '?';
      return `${c.candidateType ?? '?'} ${shortAddr(String(addr))}:${c.port ?? '?'}`;
    };
    const out: string[] = [];
    stats.forEach((r: any) => {
      if (r.type !== 'candidate-pair') return;
      const flags = [r.nominated && 'nominated', r.selected && 'selected'].filter(Boolean).join(',');
      const sent = typeof r.requestsSent === 'number' ? ` req ${r.requestsSent}/${r.responsesReceived ?? 0}` : '';
      out.push(`${cand(r.localCandidateId)} → ${cand(r.remoteCandidateId)}: ${r.state}${flags ? ` (${flags})` : ''}${sent}`);
    });
    // Candidates the browser knows, also those in no pair (e.g. a name it could not resolve).
    stats.forEach((r: any) => {
      if (r.type === 'remote-candidate') out.push(`  удалённый: ${cand(r.id)}`);
    });
    return out;
  } catch (e) {
    return [`getStats: ${String(e)}`];
  }
}

/** Collects one attempt's report and watches the connection's states. */
export class Diag {
  private t0 = performance.now();
  readonly r: DiagReport;

  constructor(side: 'player' | 'host', peer: string) {
    this.r = { side, peer, browser: browserName(), at: Date.now(), outcome: 'идёт', log: [], local: [], remote: [], pairs: [] };
  }

  add(s: string): void {
    if (this.r.log.length < 60) this.r.log.push(`${((performance.now() - this.t0) / 1000).toFixed(1)}с ${s}`);
  }

  watch(pc: RTCPeerConnection): void {
    pc.addEventListener('icegatheringstatechange', () => this.add(`сбор адресов: ${pc.iceGatheringState}`));
    pc.addEventListener('iceconnectionstatechange', () => this.add(`ICE: ${pc.iceConnectionState}`));
    pc.addEventListener('connectionstatechange', () => this.add(`соединение: ${pc.connectionState}`));
    pc.addEventListener('icecandidateerror', (e: any) => this.add(`ошибка адреса ${e.url ?? ''}: ${e.errorCode ?? ''} ${e.errorText ?? ''}`.trim()));
  }
}

export function diagText(r: DiagReport | null): string {
  if (!r) return 'Попыток WebRTC ещё не было.';
  const t = new Date(r.at).toLocaleTimeString();
  return [
    `${r.side === 'player' ? 'игрок' : 'хост'} · ${r.browser} · ${t} · итог: ${r.outcome}`,
    'свои адреса:',
    ...(r.local.length ? r.local.map((s) => `  ${s}`) : ['  —']),
    'адреса другой стороны:',
    ...(r.remote.length ? r.remote.map((s) => `  ${s}`) : ['  —']),
    'ход:',
    ...r.log.map((s) => `  ${s}`),
    'пары адресов:',
    ...(r.pairs.length ? r.pairs.map((s) => `  ${s}`) : ['  —']),
  ].join('\n');
}
