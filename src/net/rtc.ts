/** WebRTC helpers: ICE servers, waiting for candidates, what route the link took. */

export interface TurnConfig {
  url: string;
  user: string;
  pass: string;
}

export function iceServers(turn: TurnConfig | null): RTCIceServer[] {
  const list: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (turn?.url) list.push({ urls: turn.url, username: turn.user, credential: turn.pass });
  return list;
}

/** Datagram-like channel: no retransmits, no ordering. A lost snapshot is simply replaced by the next one. */
export const CHANNEL: RTCDataChannelInit = { ordered: false, maxRetransmits: 0 };

/**
 * Waits until the browser has gathered its addresses (or `ms` passes), so
 * the whole description goes in one message instead of many candidates.
 */
export function gathered(pc: RTCPeerConnection, ms = 2500): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }
    function check() {
      if (pc.iceGatheringState === 'complete') done();
    }
    pc.addEventListener('icegatheringstatechange', check);
  });
}

export interface RouteInfo {
  /** Candidate types, local/remote: host (same network), srflx/prflx (through NAT via STUN), relay (TURN). */
  local: string;
  remote: string;
  /** WebRTC's own RTT of the pair, ms. */
  rtt: number | null;
}

/** The candidate pair the connection is using. */
export async function routeInfo(pc: RTCPeerConnection): Promise<RouteInfo | null> {
  try {
    const stats = await pc.getStats();
    let pair: any = null;
    stats.forEach((r: any) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
    });
    if (!pair)
      stats.forEach((r: any) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r;
      });
    if (!pair) return null;
    const l: any = stats.get(pair.localCandidateId);
    const r: any = stats.get(pair.remoteCandidateId);
    return {
      local: l?.candidateType ?? '?',
      remote: r?.candidateType ?? '?',
      rtt: typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null,
    };
  } catch {
    return null;
  }
}

/** Human words for a route. */
export function routeLabel(local: string, remote: string): string {
  if (local === 'relay' || remote === 'relay') return 'через TURN';
  if (local === 'srflx' || remote === 'srflx') return 'напрямую через NAT';
  if (local === '?' || remote === '?') return 'напрямую';
  return 'напрямую, одна сеть'; // host / peer-reflexive candidates
}
