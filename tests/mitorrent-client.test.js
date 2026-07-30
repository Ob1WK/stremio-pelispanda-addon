import { describe, expect, it, vi } from 'vitest';
import {
  findMitorrentCandidate,
  MitorrentClient,
  parseMitorrentMagnet,
  parseMitorrentSearch,
  parseMovieDownloadLinks,
  parseSeriesSeasons
} from '../src/mitorrent-client.js';

const hash1 = '0123456789abcdef0123456789abcdef01234567';
const hash2 = 'abcdef0123456789abcdef0123456789abcdef01';
const tracker = 'udp://tracker.openbittorrent.com:80/announce';

function magnet(hash, name, size = 0) {
  const url = new URL('magnet:');
  url.searchParams.append('xt', `urn:btih:${hash}`);
  url.searchParams.set('dn', name);
  if (size) url.searchParams.set('xl', String(size));
  url.searchParams.append('tr', tracker);
  return url.href;
}

describe('parsers de MiTorrent', () => {
  it('extrae y compara resultados por tipo, título y año', () => {
    const html = `
      <a href="https://mitorrent.mx/peliculas/matrix-1999/">Matrix (1999)</a>
      <a href="/series/jack-ryan-2018/">Jack Ryan (2018)</a>
    `;
    const results = parseMitorrentSearch(html);
    expect(results).toHaveLength(2);
    expect(findMitorrentCandidate(results, {
      type: 'series',
      title: "Tom Clancy's Jack Ryan",
      year: 2018
    })).toMatchObject({ title: 'Jack Ryan', type: 'series' });
    expect(findMitorrentCandidate(results, {
      type: 'movie',
      title: 'Matrix',
      year: 2003
    })).toBeNull();
  });

  it('extrae calidades de películas y temporadas sin aceptar otros hosts', () => {
    const movie = parseMovieDownloadLinks(`
      <a class="quality-download" href="https://acortalink.net/s.php?i=abc">Torrent WEB-DL 1080p latino</a>
      <a class="quality-download" href="https://evil.example/s.php?i=abc">Torrent falso</a>
    `);
    expect(movie).toEqual([{
      url: 'https://acortalink.net/s.php?i=abc',
      label: 'WEB-DL 1080p latino'
    }]);
    const seasons = parseSeriesSeasons(`
      <div>Temporada 1 <a class="accdownload" href="https://acortalink.net/s.php?i=s1">Descargar</a></div>
      <div>Temporada 2 <a class="accdownload" href="https://acortalink.net/s.php?i=s2">Descargar</a></div>
    `);
    expect(seasons.map((item) => item.season)).toEqual([1, 2]);
  });

  it('valida magnets y conserva calidad, tamaño, idioma y trackers', () => {
    expect(parseMitorrentMagnet(magnet(hash1, 'Movie.2025.WEB-DL.1080p.Dual-Lat', 4_000_000_000), {
      label: 'WEB-DL 1080p latino'
    })).toMatchObject({
      provider: 'MiTorrent',
      infoHash: hash1,
      quality: '1080p WEB-DL Dual',
      language: 'Latino',
      size: 4_000_000_000,
      trackers: [tracker]
    });
    expect(parseMitorrentMagnet('https://example.com/file.torrent')).toBeNull();
  });
});

describe('MitorrentClient', () => {
  it('resuelve una película a través del flujo HTTP del acortador', async () => {
    const finalMagnet = magnet(hash1, 'Movie.2025.WEB-DL.1080p.Dual-Lat', 5_000_000_000);
    const calls = [];
    const fetchImpl = vi.fn(async (input, options = {}) => {
      const url = new URL(input);
      calls.push({ url: url.href, method: options.method || 'GET', cookie: options.headers?.cookie });
      if (url.hostname === 'mitorrent.mx' && url.pathname === '/search-result/') {
        return new Response('<a href="/peliculas/movie-2025/">Movie (2025)</a>');
      }
      if (url.hostname === 'mitorrent.mx' && url.pathname === '/peliculas/movie-2025/') {
        return new Response('<a class="quality-download" href="https://acortalink.net/s.php?i=encrypted">Torrent WEB-DL 1080p latino</a>');
      }
      if (url.hostname === 'acortalink.net' && url.pathname === '/s.php') {
        return new Response('<form></form>', { headers: { 'set-cookie': 'PHPSESSID=session123; Path=/; Secure' } });
      }
      if (url.hostname === 'acortalink.net' && url.pathname === '/' && options.method === 'POST') {
        return new Response('<body data-t="host||~~>ads||~~>cookieKey||~~>cmVkaXJlY3Q=||~~>40||~~>24||~~>0||~~>false||~~>||~~>"></body>');
      }
      if (url.hostname === 'acortalink.net' && url.pathname === '/check.php') return new Response('');
      if (url.hostname === 'acortalink.net' && url.pathname === '/r.php') {
        return new Response(`<script>window.location = "${finalMagnet}";</script>`);
      }
      return new Response('no encontrado', { status: 404 });
    });
    const client = new MitorrentClient({
      metadataClient: { getJson: async () => ({ meta: { name: 'Movie', year: '2025' } }) },
      fetchImpl
    });

    await expect(client.search({ imdbId: 'tt123' })).resolves.toEqual([
      expect.objectContaining({ provider: 'MiTorrent', infoHash: hash1, quality: '1080p WEB-DL Dual' })
    ]);
    expect(calls.find((call) => call.url.includes('/r.php'))?.cookie).toContain('PHPSESSID=session123');
    expect(calls.find((call) => call.url.includes('/r.php'))?.cookie).toContain('cookieKey=Wn275');
  });

  it('obtiene el magnet exacto de un episodio desde la temporada', async () => {
    const episode1 = magnet(hash1, 'Tom.Clancys.Jack.Ryan.S01.E01.2018.WEB-DL.1080p-Dual-Lat');
    const episode2 = magnet(hash2, 'Tom.Clancys.Jack.Ryan.S01.E02.2018.WEB-DL.1080p-Dual-Lat');
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(input);
      if (url.pathname === '/search-result/') {
        return new Response('<a href="/series/jack-ryan-2018/">Jack Ryan (2018)</a>');
      }
      if (url.pathname === '/series/jack-ryan-2018/' && url.searchParams.has('pkgo')) {
        expect(url.searchParams.get('pkgo')).toBe('c4ca4238a0b923820dcc509a6f75849b');
        return new Response(`<a href="${episode1}">Descargar</a><a href="${episode2}">Descargar</a>`);
      }
      if (url.pathname === '/series/jack-ryan-2018/') {
        return new Response('Temporada 1 <a class="accdownload" href="https://acortalink.net/s.php?i=s1">Descargar</a>');
      }
      return new Response('no encontrado', { status: 404 });
    });
    const client = new MitorrentClient({
      metadataClient: { getJson: async () => ({ meta: { name: "Tom Clancy's Jack Ryan", year: '2018' } }) },
      fetchImpl
    });

    await expect(client.search({ imdbId: 'tt5057054', season: 1, episode: 2 })).resolves.toEqual([
      expect.objectContaining({
        infoHash: hash2,
        episodeMatched: true,
        language: 'Latino',
        quality: '1080p WEB-DL Dual'
      })
    ]);
  });

  it('rechaza destinos ajenos devueltos por el acortador', async () => {
    const fetchImpl = vi.fn(async (input, options = {}) => {
      const url = new URL(input);
      if (url.pathname === '/s.php') {
        return new Response('', { headers: { 'set-cookie': 'PHPSESSID=s; Path=/' } });
      }
      if (url.pathname === '/' && options.method === 'POST') {
        return new Response('<body data-t="host||~~>ads||~~>cookieKey||~~>cmVkaXJlY3Q=||~~>40||~~>24||~~>0"></body>');
      }
      if (url.pathname === '/check.php') return new Response('');
      if (url.pathname === '/r.php') {
        return new Response('<script>window.location = "https://evil.example/torrent";</script>');
      }
      return new Response('', { status: 404 });
    });
    const client = new MitorrentClient({
      metadataClient: { getJson: async () => null },
      fetchImpl
    });
    await expect(client.resolveShortener('https://acortalink.net/s.php?i=x', 'https://mitorrent.mx/peliculas/x/'))
      .rejects.toThrow('no permitido');
  });
});
