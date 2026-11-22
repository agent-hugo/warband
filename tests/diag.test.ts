import { describe, expect, it } from 'vitest';
import { browserName, sdpCandidates } from '../src/net/diag';

describe('diag', () => {
  it('lists candidates of a description', () => {
    const sdp = [
      'v=0',
      'a=candidate:0 1 UDP 2122252543 0f3c9a1e-1111-2222-3333-444455556666.local 51234 typ host',
      'a=candidate:1 2 UDP 2122252542 0f3c9a1e-1111-2222-3333-444455556666.local 51235 typ host',
      'a=candidate:2 1 UDP 1686052863 203.0.113.7 40000 typ srflx raddr 0.0.0.0 rport 0',
    ].join('\r\n');
    expect(sdpCandidates(sdp)).toEqual(['host udp 0f3c….local:51234', 'srflx udp 203.0.113.7:40000']);
  });

  it('names the browser', () => {
    expect(browserName('Mozilla/5.0 (Android 14; Mobile; rv:145.0) Gecko/145.0 Firefox/145.0')).toBe('Firefox 145 · Android');
    expect(browserName('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36')).toBe('Chrome 142 · Linux');
  });
});
