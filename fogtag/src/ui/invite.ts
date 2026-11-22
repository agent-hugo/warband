/**
 * Invite links. A link with the broker token packs the room and the token
 * into one base64url parameter, `#i=...`, so the token is not readable at a
 * glance. This is obfuscation, not encryption: anyone can decode it.
 */

export interface Invite {
  room?: string;
  token?: string;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(data: string): string {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Hash of an invite link: plain `r=X`, or `i=<base64url>` with the token. */
export function inviteHash(room: string, token?: string): string {
  if (!token) return `r=${encodeURIComponent(room)}`;
  return `i=${toBase64Url(new URLSearchParams({ r: room, t: token }).toString())}`;
}

/** Room and token from an `i=` parameter; empty if it is missing or malformed. */
export function decodeInvite(i: string | null): Invite {
  if (!i) return {};
  try {
    const p = new URLSearchParams(fromBase64Url(i));
    return { room: p.get('r') || undefined, token: p.get('t') || undefined };
  } catch {
    return {};
  }
}
