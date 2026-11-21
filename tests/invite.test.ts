import { describe, expect, it } from 'vitest';
import { decodeInvite, inviteHash } from '../src/ui/invite';

describe('ссылки-приглашения', () => {
  it('без токена — обычная ссылка на комнату', () => {
    expect(inviteHash('ABCD')).toBe('r=ABCD');
  });

  it('комната и токен упакованы в один base64url-параметр', () => {
    const token = 'FlespiToken a+b/c=d&e?ü';
    const hash = inviteHash('ABCD', token);
    expect(hash).toMatch(/^i=[A-Za-z0-9_-]+$/);
    expect(hash).not.toContain('Flespi');
    expect(decodeInvite(new URLSearchParams(hash).get('i'))).toEqual({ room: 'ABCD', token });
  });

  it('пустые и битые данные игнорируются', () => {
    expect(decodeInvite(null)).toEqual({});
    expect(decodeInvite('%%%')).toEqual({});
  });
});
