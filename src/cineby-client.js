import { SourceClient } from './source-client.js';

const HASH_CONSTANTS = [
  1116352408, 1899447441, 3049323471, 3921009573,
  961987163, 1508970993, 2453635748, 2870763221,
  3624381080, 310598401, 607225278, 1426881987,
  1925078388, 2162078206, 2614888103, 3248222580
];
const INITIAL_HASH = 1732584193;
const STATE_SIZE = 61;
const STATE_ROUNDS = 8;
const GOLDEN_RATIO = 2654435769;
const PAYLOAD_PREFIX = Buffer.from('mvm1');
const DEFAULT_SERVERS = [
  ['Yoru', 'cdn/sources-with-title'],
  ['Breach', 'm4uhd/sources-with-title'],
  ['Neon', 'vsrc/sources-with-title'],
  ['Omen', 'lamovie/sources-with-title'],
  ['Raze', 'superflix/sources-with-title']
];

function mix32(value) {
  let result = value >>> 0;
  result ^= result >>> 16;
  result = Math.imul(result, 2246822507) >>> 0;
  result ^= result >>> 13;
  result = Math.imul(result, 3266489909) >>> 0;
  result ^= result >>> 16;
  return result >>> 0;
}

function rotateLeft(value, bits) {
  const amount = bits & 31;
  const number = value >>> 0;
  return amount === 0 ? number : (number << amount | number >>> (32 - amount)) >>> 0;
}

function seedHash(seed) {
  let result = INITIAL_HASH;
  for (let index = 0; index < seed.length; index += 1) {
    result = rotateLeft((result ^ Math.imul(seed.charCodeAt(index), HASH_CONSTANTS[index & 15])) >>> 0, 5);
  }
  return mix32(result);
}

function fnvHash(seed) {
  let result = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    result = Math.imul(result ^ seed.charCodeAt(index), 16777619) >>> 0;
  }
  return mix32(result);
}

function permutation(seed) {
  const values = Array.from({ length: 256 }, (_, index) => index);
  let cursor = 0;
  for (let index = 0; index < values.length; index += 1) {
    cursor = (cursor + values[index] + seed.charCodeAt(index % seed.length)) & 255;
    [values[index], values[cursor]] = [values[cursor], values[index]];
  }
  return values;
}

function createCipherState(seed, mediaId) {
  if ((seed.length * (seed.length + 1) & 1) === 1) {
    return { values: permutation(seed), accumulator: seedHash(seed) };
  }
  const values = new Array(STATE_SIZE);
  let accumulator = mix32(fnvHash(seed) ^ mix32(mediaId >>> 0 ^ GOLDEN_RATIO)) >>> 0;
  for (let round = 0; round < STATE_ROUNDS; round += 1) {
    if ((round * (round + 1) & 1) === 0) {
      const index = accumulator % STATE_SIZE;
      accumulator = rotateLeft(accumulator + GOLDEN_RATIO >>> 0, 7 + (round & 7));
      values[index] = (accumulator ^ mix32(accumulator)) >>> 0;
      accumulator = mix32(accumulator + index >>> 0);
    } else {
      values[round] = HASH_CONSTANTS[round & 15];
    }
  }
  return { values, accumulator: mix32(accumulator ^ 2779096485) >>> 0 };
}

function nextCipherWord(state, counter) {
  const index = state.accumulator % STATE_SIZE;
  const mask = 0 - Number(index in state.values);
  const entry = state.values[index] >>> 0;
  const salt = Math.imul(GOLDEN_RATIO, counter + 1) >>> 0;
  const alternate = (entry ^ salt) >>> 0;
  let word = ((state.accumulator ^ alternate) >>> 0 |
    (state.accumulator & alternate & mask) >>> 0) >>> 0;
  word = (rotateLeft(word + state.accumulator >>> 0, index & 31) ^
    rotateLeft(state.accumulator, Math.imul(index, 7) & 31)) >>> 0;
  state.accumulator = mix32(word + GOLDEN_RATIO >>> 0);
  state.values[index] = state.accumulator;
  return state.accumulator >>> 0;
}

export function decryptCinebyPayload(payload, seed, mediaId) {
  const bytes = Buffer.from(String(payload).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const state = createCipherState(String(seed), Number(mediaId));
  let counter = 0;
  for (let index = 0; index < bytes.length;) {
    const word = nextCipherWord(state, counter++);
    bytes[index++] ^= word & 255;
    if (index < bytes.length) bytes[index++] ^= word >>> 8 & 255;
    if (index < bytes.length) bytes[index++] ^= word >>> 16 & 255;
    if (index < bytes.length) bytes[index++] ^= word >>> 24 & 255;
  }
  if (bytes.length < PAYLOAD_PREFIX.length ||
      !PAYLOAD_PREFIX.every((value, index) => bytes[index] === value)) {
    throw new Error('Respuesta cifrada de Cineby no válida');
  }
  return JSON.parse(bytes.subarray(PAYLOAD_PREFIX.length).toString('utf8'));
}

function playableSources(payload, server, mediaProxyBaseUrl) {
  const seen = new Set();
  return (Array.isArray(payload?.sources) ? payload.sources : []).map((source) => {
    let url;
    try {
      url = new URL(source?.url);
    } catch {
      return null;
    }
    if (!['http:', 'https:'].includes(url.protocol) || seen.has(url.href)) return null;
    if (!/\.(?:m3u8|mpd)(?:$|[?#])/i.test(url.href)) return null;
    seen.add(url.href);
    let playableUrl = url.href;
    if (mediaProxyBaseUrl && url.pathname.toLowerCase().endsWith('.m3u8')) {
      const proxyUrl = new URL('/cineby-media', mediaProxyBaseUrl);
      proxyUrl.searchParams.set('url', url.href);
      playableUrl = proxyUrl.href;
    }
    return {
      provider: 'Cineby',
      host: server,
      quality: source.quality || 'Auto',
      url: playableUrl,
      behaviorHints: {
        notWebReady: false,
        proxyHeaders: {
          request: {
            Referer: 'https://www.vidking.net/',
            Origin: 'https://www.vidking.net',
            'User-Agent': 'Mozilla/5.0'
          }
        }
      }
    };
  }).filter(Boolean);
}

async function readLimitedText(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (declared && declared > maxBytes) throw new Error('Respuesta de Cineby demasiado grande');
  if (!response.body) throw new Error('Respuesta vacía de Cineby');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Respuesta de Cineby demasiado grande');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class CinebyClient {
  constructor({
    baseUrl = 'https://api.speedracelight.com/',
    metadataUrl = 'https://v3-cinemeta.strem.io/',
    timeoutMs = 10_000,
    maxResponseBytes = 4 * 1024 * 1024,
    mediaProxyBaseUrl,
    servers = DEFAULT_SERVERS,
    fetchImpl = fetch
  } = {}) {
    this.baseUrl = new URL(baseUrl);
    this.metadata = new SourceClient({ baseUrl: metadataUrl, timeoutMs, maxResponseBytes, fetchImpl });
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.mediaProxyBaseUrl = mediaProxyBaseUrl;
    this.servers = servers;
    this.fetch = fetchImpl;
  }

  supports(params) {
    return Boolean(params?.imdbId);
  }

  headers() {
    return {
      Accept: '*/*',
      Origin: 'https://www.vidking.net',
      Referer: 'https://www.vidking.net/',
      'User-Agent': 'Mozilla/5.0 streaMX',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache'
    };
  }

  async request(url) {
    const response = await this.fetch(url, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) {
      const error = new Error(`Cineby respondió HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response;
  }

  async sourcesFrom(server, endpoint, media) {
    const seedUrl = new URL('seed', this.baseUrl);
    seedUrl.searchParams.set('mediaId', media.tmdbId);
    const seedData = JSON.parse(await readLimitedText(await this.request(seedUrl), 64 * 1024));
    if (!seedData?.seed) throw new Error('Cineby no devolvió una semilla');

    const sourceUrl = new URL(endpoint, this.baseUrl);
    for (const [key, value] of Object.entries({
      title: media.title,
      mediaType: media.type,
      year: media.year || '',
      episodeId: media.episode ?? 1,
      seasonId: media.season ?? 1,
      tmdbId: media.tmdbId,
      imdbId: media.imdbId,
      enc: 2,
      seed: seedData.seed,
      _t: Date.now()
    })) sourceUrl.searchParams.set(key, String(value));
    const encrypted = await readLimitedText(await this.request(sourceUrl), this.maxResponseBytes);
    return playableSources(
      decryptCinebyPayload(encrypted, seedData.seed, media.tmdbId),
      server,
      this.mediaProxyBaseUrl
    );
  }

  async search({ imdbId, season, episode }) {
    const type = season === undefined ? 'movie' : 'series';
    const meta = (await this.metadata.getJson(`meta/${type}/${encodeURIComponent(imdbId)}.json`))?.meta;
    const tmdbId = String(meta?.moviedb_id || '');
    const title = meta?.name;
    if (!tmdbId || !title) return [];
    const parsedYear = Number.parseInt(meta?.year || meta?.releaseInfo || meta?.released, 10);
    const media = {
      type: type === 'series' ? 'tv' : 'movie',
      tmdbId,
      imdbId,
      title,
      year: Number.isInteger(parsedYear) ? parsedYear : '',
      season,
      episode
    };
    for (const [server, endpoint] of this.servers) {
      try {
        const sources = await this.sourcesFrom(server, endpoint, media);
        if (sources.length) return sources;
      } catch {
        // Cada servidor es independiente; continuar con el siguiente.
      }
    }
    return [];
  }
}
