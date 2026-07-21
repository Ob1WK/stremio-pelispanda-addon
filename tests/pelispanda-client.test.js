import { describe, expect, it } from 'vitest';
import { findMatchingCandidate, parseMagnet, parseSize } from '../src/pelispanda-client.js';

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
  it('prioriza TMDB y permite título original con el mismo año', () => {
    const results = [
      { type: 'pelicula', tmdb_id: 'incorrecto', title: 'El Club de la Pelea', original_title: 'Fight Club', year: '1999' },
      { type: 'pelicula', tmdb_id: '550', title: 'Otro título', year: '2000' }
    ];
    expect(findMatchingCandidate(results, { tmdbId: '550', title: 'Fight Club', year: 1999, type: 'movie' })).toBe(results[1]);
    expect(findMatchingCandidate(results.slice(0, 1), { tmdbId: '550', title: 'Fight Club', year: 1999, type: 'movie' })).toBe(results[0]);
  });
  it('no usa el fallback de título si el año o tipo no coinciden', () => {
    const results = [{ type: 'serie', title: 'Dark', original_title: 'Dark', year: '2017' }];
    expect(findMatchingCandidate(results, { tmdbId: 'x', title: 'Dark', year: 2024, type: 'series' })).toBeNull();
    expect(findMatchingCandidate(results, { tmdbId: 'x', title: 'Dark', year: 2017, type: 'movie' })).toBeNull();
  });
});
