import { describe, expect, it } from 'vitest';
import { parseMagnet, parseSize } from '../src/pelispanda-client.js';

describe('adaptador de PelisPanda', () => {
  it('convierte tamaños legibles a bytes', () => {
    expect(parseSize('4 GB')).toBe(4294967296);
    expect(parseSize('820 MB')).toBe(859832320);
  });
  it('extrae hash, nombre y trackers de un magnet', () => {
    const infoHash = '0123456789abcdef0123456789abcdef01234567';
    const result = parseMagnet({
      download_type: 'link',
      quality: '1080p',
      size: '4 GB',
      download_link: `magnet:?xt=urn:btih:${infoHash}&dn=Show.S01E02.mkv&tr=udp%3A%2F%2Ftracker.example%3A80`
    }, true);
    expect(result).toMatchObject({ infoHash, title: 'Show.S01E02.mkv', quality: '1080p', size: 4294967296, episodeMatched: true });
    expect(result.trackers).toEqual(['udp://tracker.example:80']);
  });
  it('rechaza enlaces que no sean magnets válidos', () => {
    expect(parseMagnet({ download_type: 'link', download_link: 'javascript:alert(1)' })).toBeNull();
    expect(parseMagnet({ download_type: 'link', download_link: 'magnet:?xt=urn:btih:invalido' })).toBeNull();
  });
});
