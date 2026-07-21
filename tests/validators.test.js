import { describe, expect, it } from 'vitest';
import { isValidInfoHash, parseStremioId, safeTrackers } from '../src/validators.js';

describe('validaciones', () => {
  it('acepta hashes hex y Base32', () => {
    expect(isValidInfoHash('a'.repeat(40))).toBe(true);
    expect(isValidInfoHash('A'.repeat(32))).toBe(true);
    expect(isValidInfoHash('no-es-un-hash')).toBe(false);
  });
  it('interpreta IDs y rechaza formatos incorrectos', () => {
    expect(parseStremioId('movie', 'tt123')).toEqual({ imdbId: 'tt123' });
    expect(parseStremioId('series', 'tt123:1:2')).toEqual({ imdbId: 'tt123', season: 1, episode: 2 });
    expect(parseStremioId('series', 'tt123:uno:2')).toBeNull();
  });
  it('filtra trackers inválidos', () => expect(safeTrackers(['udp://ok:80/a', 'javascript:alert(1)'])).toEqual(['udp://ok:80/a']));
});
