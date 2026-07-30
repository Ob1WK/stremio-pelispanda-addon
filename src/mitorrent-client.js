import crypto from 'node:crypto';
import { SourceClient } from './source-client.js';
import { isValidInfoHash } from './validators.js';

const DEFAULT_HTML_LIMIT = 2 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 streaMX';
const MITORRENT_HOSTS = new Set(['mitorrent.mx', 'www.mitorrent.mx']);
const SHORTENER_HOSTS = new Set(['acortalink.net', 'www.acortalink.net']);
const STOP_WORDS = new Set(['a', 'an', 'and', 'de', 'del', 'el', 'la', 'las', 'los', 'of', 'the', 'un', 'una', 'y']);

function decodeHtml(value) {
  const named = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
    '#039': "'"
  };
  return String(value || '').replace(/&(#x[\da-f]+|#\d+|[a-z\d]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isSafeInteger(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function stripTags(value) {
  return decodeHtml(String(value || '').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

export function normalizeMitorrentTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function splitTitleYear(value) {
  const text = String(value || '').trim();
  const match = /^(.*?)\s*\((\d{4})\)\s*$/.exec(text);
  return match ? { title: match[1].trim(), year: Number(match[2]) } : { title: text, year: null };
}

function titleScore(expected, candidate) {
  const a = normalizeMitorrentTitle(expected);
  const b = normalizeMitorrentTitle(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if ((a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= 5) return 0.9;
  const left = new Set(a.split(' ').filter((word) => word.length > 1 && !STOP_WORDS.has(word)));
  const right = new Set(b.split(' ').filter((word) => word.length > 1 && !STOP_WORDS.has(word)));
  if (!left.size || !right.size) return 0;
  const common = [...left].filter((word) => right.has(word)).length;
  return common / Math.max(left.size, right.size);
}

export function parseMitorrentSearch(html, baseUrl = 'https://mitorrent.mx/') {
  const results = [];
  const seen = new Set();
  const anchorPattern = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    let url;
    try {
      url = new URL(decodeHtml(match[2]), baseUrl);
    } catch {
      continue;
    }
    const type = url.pathname.startsWith('/peliculas/') ? 'movie' :
      (url.pathname.startsWith('/series/') ? 'series' : null);
    if (!type || url.pathname === `/${type === 'movie' ? 'peliculas' : 'series'}/`) continue;
    const label = stripTags(match[3]);
    const parsed = splitTitleYear(label);
    if (!parsed.year || !parsed.title || parsed.title.length > 180) continue;
    const key = `${type}:${url.pathname}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ type, title: parsed.title, year: parsed.year, url: url.href });
  }
  return results;
}

export function findMitorrentCandidate(results, { type, title, aliases = [], year }) {
  const expectedYear = Number.parseInt(year, 10);
  const names = [title, ...aliases].filter(Boolean);
  const ranked = results
    .filter((item) => item.type === type && (!Number.isInteger(expectedYear) || item.year === expectedYear))
    .map((item) => ({ item, score: Math.max(...names.map((name) => titleScore(name, item.title)), 0) }))
    .filter(({ score }) => score >= 0.65)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  if (ranked[1] && ranked[0].score < 0.9 && ranked[0].score - ranked[1].score < 0.15) return null;
  return ranked[0].item;
}

function attributeValue(attributes, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*([\"'])(.*?)\\1`, 'i').exec(attributes);
  return match ? decodeHtml(match[2]) : '';
}

export function parseMovieDownloadLinks(html, baseUrl = 'https://mitorrent.mx/') {
  const links = [];
  const seen = new Set();
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const className = attributeValue(match[1], 'class');
    if (!className.split(/\s+/).includes('quality-download')) continue;
    let url;
    try {
      url = new URL(attributeValue(match[1], 'href'), baseUrl);
    } catch {
      continue;
    }
    if (!SHORTENER_HOSTS.has(url.hostname.toLowerCase()) || seen.has(url.href)) continue;
    seen.add(url.href);
    const label = stripTags(match[2]).replace(/^Torrent\s+/i, '').trim();
    links.push({ url: url.href, label });
  }
  return links.slice(0, 12);
}

export function parseSeriesSeasons(html, baseUrl = 'https://mitorrent.mx/') {
  const seasons = [];
  const seen = new Set();
  const pattern = /Temporada\s*(\d+)[\s\S]{0,1200}?<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const season = Number(match[1]);
    let url;
    try {
      url = new URL(attributeValue(match[2], 'href'), baseUrl);
    } catch {
      continue;
    }
    if (!Number.isInteger(season) || season < 0 || !SHORTENER_HOSTS.has(url.hostname.toLowerCase()) || seen.has(season)) continue;
    seen.add(season);
    seasons.push({ season, url: url.href });
  }
  return seasons;
}

function qualityFromText(...values) {
  const text = values.filter(Boolean).join(' ');
  const resolution = /\b(2160p|4k)\b/i.test(text) ? '4K' :
    (/\b1080p?\b/i.test(text) ? '1080p' : (/\b720p?\b/i.test(text) ? '720p' : null));
  const source = /\bweb[- .]?dl\b/i.test(text) ? 'WEB-DL' :
    (/\bbluray\b/i.test(text) ? 'BluRay' : (/\bdvdrip\b/i.test(text) ? 'DVDRip' : null));
  const dual = /\bdual\b/i.test(text) ? 'Dual' : null;
  return [resolution, source, dual].filter(Boolean).join(' ') || 'Torrent';
}

function languageFromText(value) {
  const text = String(value || '');
  if (/\b(dual|lat|latino)\b/i.test(text)) return 'Latino';
  if (/\b(castellano|esp|spanish)\b/i.test(text)) return 'Castellano';
  return undefined;
}

export function parseMitorrentMagnet(value, { label, episodeMatched = false } = {}) {
  let magnet;
  try {
    magnet = new URL(decodeHtml(value).replace(/\\\//g, '/'));
  } catch {
    return null;
  }
  if (magnet.protocol !== 'magnet:') return null;
  const xt = magnet.searchParams.getAll('xt').find((item) => item.toLowerCase().startsWith('urn:btih:'));
  const infoHash = xt?.slice('urn:btih:'.length);
  if (!isValidInfoHash(infoHash)) return null;
  const title = magnet.searchParams.get('dn') || label || 'MiTorrent';
  const size = Number(magnet.searchParams.get('xl'));
  return {
    provider: 'MiTorrent',
    title,
    infoHash: infoHash.toLowerCase(),
    quality: qualityFromText(label, title),
    language: languageFromText(`${label || ''} ${title}`),
    ...(Number.isFinite(size) && size > 0 ? { size } : {}),
    trackers: magnet.searchParams.getAll('tr'),
    episodeMatched
  };
}

function magnetsFromHtml(html) {
  const values = [];
  const seen = new Set();
  const pattern = /(?:window\.location\s*=\s*|href\s*=\s*)(["'])(magnet:[\s\S]*?)\1/gi;
  for (const match of html.matchAll(pattern)) {
    const value = decodeHtml(match[2]).replace(/\\\//g, '/');
    if (!seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
  }
  return values;
}

function episodeMatches(value, season, episode) {
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  return new RegExp(`(?:s0*${season}[ ._-]*e0*${episode}\\b|\\b0*${season}x0*${episode}\\b|season[ ._-]*0*${season}[ ._-]*episode[ ._-]*0*${episode}\\b|S${s}[ ._-]*E${e}\\b)`, 'i')
    .test(String(value || ''));
}

function titleQueries(title) {
  const words = normalizeMitorrentTitle(title).split(' ').filter((word) => word.length >= 2 && !STOP_WORDS.has(word));
  return [...new Set([title, words.slice(-3).join(' '), words.slice(-2).join(' ')].filter(Boolean))].slice(0, 3);
}

async function readLimited(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (declared && declared > limit) throw new Error('Respuesta HTML demasiado grande');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error('Respuesta HTML demasiado grande');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class MitorrentClient {
  constructor({
    baseUrl = 'https://mitorrent.mx/',
    metadataUrl = 'https://v3-cinemeta.strem.io/',
    timeoutMs = 12_000,
    maxResponseBytes = DEFAULT_HTML_LIMIT,
    fetchImpl = fetch,
    metadataClient,
    allowPrivateMetadata = false
  } = {}) {
    this.baseUrl = new URL(baseUrl);
    if (this.baseUrl.protocol !== 'https:' || !MITORRENT_HOSTS.has(this.baseUrl.hostname.toLowerCase())) {
      throw new Error('MiTorrent debe usar https://mitorrent.mx/');
    }
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.metadata = metadataClient || new SourceClient({
      baseUrl: metadataUrl,
      timeoutMs,
      maxResponseBytes,
      allowPrivate: allowPrivateMetadata,
      fetchImpl
    });
  }

  supports(params) {
    return Boolean(params?.imdbId);
  }

  async getText(input, { hosts = MITORRENT_HOSTS, method = 'GET', headers = {}, body } = {}) {
    let url = new URL(input, this.baseUrl);
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      if (url.protocol !== 'https:' || !hosts.has(url.hostname.toLowerCase())) throw new Error('Host de MiTorrent no permitido');
      const response = await this.fetch(url, {
        method,
        headers: { accept: 'text/html,*/*;q=0.8', 'user-agent': USER_AGENT, ...headers },
        ...(body !== undefined ? { body } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirect === 3) throw new Error('Demasiadas redirecciones de MiTorrent');
        const location = response.headers.get('location');
        if (!location) throw new Error('Redirección de MiTorrent sin destino');
        url = new URL(location, url);
        if (response.status === 303) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }
      if (!response.ok) throw new Error(`MiTorrent respondió HTTP ${response.status}`);
      return { text: await readLimited(response, this.maxResponseBytes), response, url };
    }
    throw new Error('No se pudo leer MiTorrent');
  }

  async findDetail(type, meta) {
    const aliases = Array.isArray(meta?.aliases) ? meta.aliases : [];
    let candidates = [];
    for (const query of titleQueries(meta.name)) {
      const url = new URL('search-result/', this.baseUrl);
      url.searchParams.set('search_query', query);
      url.searchParams.set('calidad', '');
      url.searchParams.set('genero', '');
      url.searchParams.set('dtyear', '');
      url.searchParams.set('audio', '');
      const { text } = await this.getText(url);
      candidates = [...candidates, ...parseMitorrentSearch(text, this.baseUrl)];
      const match = findMitorrentCandidate(candidates, {
        type,
        title: meta.name,
        aliases,
        year: meta.year || meta.releaseInfo || meta.released
      });
      if (match) return match;
    }
    return null;
  }

  async resolveShortener(shortUrl, referer) {
    const first = await this.getText(shortUrl, {
      hosts: SHORTENER_HOSTS,
      headers: { referer }
    });
    const setCookie = first.response.headers.get('set-cookie') || '';
    const session = /PHPSESSID=([^;,\s]+)/i.exec(setCookie)?.[1];
    if (!session) throw new Error('El acortador no creó una sesión');
    const cookie = `PHPSESSID=${session}`;
    const form = new URLSearchParams({ linkser: 'uggcf://zvgbeerag.zk' }).toString();
    const gate = await this.getText('https://acortalink.net/', {
      hosts: SHORTENER_HOSTS,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie,
        referer: shortUrl
      },
      body: form
    });
    const packed = /data-t="([^"]+)"/i.exec(gate.text)?.[1];
    const parts = packed?.split('||~~>') || [];
    if (parts.length < 7 || !/^[\w-]{3,64}$/.test(parts[2]) || !/^[A-Za-z0-9+/=]+$/.test(parts[3])) {
      throw new Error('Respuesta desconocida del acortador');
    }
    await this.getText('https://acortalink.net/check.php', {
      hosts: SHORTENER_HOSTS,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie,
        referer: 'https://acortalink.net/'
      },
      body: 'c'
    });
    const result = await this.getText(`https://acortalink.net/r.php?l=${encodeURIComponent(parts[3])}`, {
      hosts: SHORTENER_HOSTS,
      headers: {
        cookie: `${cookie}; ${parts[2]}=Wn275`,
        referer: 'https://acortalink.net/'
      }
    });
    const target = /window\.location\s*=\s*"([^"]+)"/i.exec(result.text)?.[1] ||
      /<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>\s*AQUI\s*<\/a>/i.exec(result.text)?.[1];
    if (!target) throw new Error('El acortador no devolvió un destino');
    const decoded = decodeHtml(target).replace(/\\\//g, '/');
    if (decoded.startsWith('magnet:')) return decoded;
    const wrapper = new URL(decoded);
    const destination = wrapper.hostname === 'vk.com' ? wrapper.searchParams.get('to') : wrapper.href;
    const finalUrl = new URL(destination);
    if (finalUrl.protocol !== 'https:' || !MITORRENT_HOSTS.has(finalUrl.hostname.toLowerCase())) {
      throw new Error('Destino del acortador no permitido');
    }
    return finalUrl.href;
  }

  async movieStreams(detailUrl, html) {
    const links = parseMovieDownloadLinks(html, this.baseUrl);
    const settled = await Promise.allSettled(links.map(async ({ url, label }) => {
      const target = await this.resolveShortener(url, detailUrl);
      if (target.startsWith('magnet:')) return parseMitorrentMagnet(target, { label });
      const { text } = await this.getText(target);
      return magnetsFromHtml(text).map((magnet) => parseMitorrentMagnet(magnet, { label })).filter(Boolean);
    }));
    return settled.flatMap((item) => item.status === 'fulfilled' ? item.value : []).flat().filter(Boolean);
  }

  async seriesStreams(detailUrl, html, season, episode) {
    const available = parseSeriesSeasons(html, this.baseUrl).some((item) => item.season === season);
    if (!available) return [];
    const reveal = new URL(detailUrl);
    reveal.searchParams.set('pkgo', crypto.createHash('md5').update(String(season)).digest('hex'));
    const { text } = await this.getText(reveal);
    return magnetsFromHtml(text)
      .filter((magnet) => {
        try {
          return episodeMatches(new URL(magnet).searchParams.get('dn'), season, episode);
        } catch {
          return false;
        }
      })
      .map((magnet) => parseMitorrentMagnet(magnet, { episodeMatched: true }))
      .filter(Boolean);
  }

  async search({ imdbId, season, episode }) {
    const type = season === undefined ? 'movie' : 'series';
    const metadata = await this.metadata.getJson(`meta/${type}/${encodeURIComponent(imdbId)}.json`);
    const meta = metadata?.meta;
    if (!meta?.name) return [];
    const detail = await this.findDetail(type, meta);
    if (!detail) return [];
    const { text } = await this.getText(detail.url);
    return type === 'movie'
      ? this.movieStreams(detail.url, text)
      : this.seriesStreams(detail.url, text, Number(season), Number(episode));
  }
}
