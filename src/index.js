import 'dotenv/config';
import express from 'express';
import stremioSdk from 'stremio-addon-sdk';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { TtlCache } from './cache.js';
import { SourceClient } from './source-client.js';
import { PelisPandaClient } from './pelispanda-client.js';
import { CombinedClient, NovaClient } from './nova-client.js';
import { CinebyClient } from './cineby-client.js';
import { isValidInfoHash, parseStremioId, safeTrackers } from './validators.js';

const { addonBuilder, getRouter } = stremioSdk;
const NOVA_DIRECT_HOSTS = new Set(['inyoutv.com', 'www.inyoutv.com', 'saludvdt.com', 'www.saludvdt.com']);
const CINEBY_MEDIA_HOSTS = new Set([
  'moon.ironwallnet.net',
  'solaratom.site',
  'winterforest.site'
]);

function isAllowedNovaMediaUrl(url) {
  return ['http:', 'https:'].includes(url.protocol) && NOVA_DIRECT_HOSTS.has(url.hostname.toLowerCase());
}

async function fetchNovaMedia(url, range) {
  let current = url;
  for (let redirect = 0; redirect < 5; redirect += 1) {
    if (!isAllowedNovaMediaUrl(current)) throw new Error('Host no permitido');
    const response = await fetch(current, {
      redirect: 'manual',
      headers: {
        Accept: '*/*',
        'User-Agent': 'Mozilla/5.0 streaMX',
        Referer: 'https://syntorq.com/',
        ...(range ? { Range: range } : {})
      }
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return response;
      current = new URL(location, current);
      continue;
    }
    return response;
  }
  throw new Error('Demasiadas redirecciones');
}

function isAllowedCinebyMediaUrl(url) {
  return url.protocol === 'https:' &&
    CINEBY_MEDIA_HOSTS.has(url.hostname.toLowerCase()) &&
    url.pathname.startsWith('/vd/');
}

async function fetchCinebyMedia(url, range) {
  let current = url;
  for (let redirect = 0; redirect < 5; redirect += 1) {
    if (!isAllowedCinebyMediaUrl(current)) throw new Error('Host de Cineby no permitido');
    const response = await fetch(current, {
      redirect: 'manual',
      headers: {
        Accept: '*/*',
        'User-Agent': 'Mozilla/5.0 streaMX',
        Referer: 'https://www.vidking.net/',
        Origin: 'https://www.vidking.net',
        ...(range ? { Range: range } : {})
      }
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return response;
      current = new URL(location, current);
      continue;
    }
    return response;
  }
  throw new Error('Demasiadas redirecciones');
}

function rewriteCinebyPlaylist(body, sourceUrl, addonBaseUrl) {
  return body.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    let mediaUrl;
    try {
      mediaUrl = new URL(trimmed, sourceUrl);
    } catch {
      return line;
    }
    if (!isAllowedCinebyMediaUrl(mediaUrl)) return line;
    const proxyUrl = new URL('/cineby-media', addonBaseUrl);
    proxyUrl.searchParams.set('url', mediaUrl.href);
    return proxyUrl.href;
  }).join('\n');
}

const qualityScore = (quality = '') => {
  const value = String(quality).toLowerCase();
  if (/\b(2160p|4k)\b/.test(value)) return 2160;
  return Number(/\b(1080|720|480)p\b/.exec(value)?.[1] || 0);
};
const formatSize = (bytes) => {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return null;
  const gb = value / 1073741824;
  return gb >= 1 ? `${Number(gb.toFixed(1))} GB` : `${Math.round(value / 1048576)} MB`;
};

function episodePattern(season, episode) {
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  return new RegExp(`(?:s0*${season}[ ._-]*e0*${episode}\\b|\\b0*${season}x0*${episode}\\b|season[ ._-]*0*${season}[ ._-]*episode[ ._-]*0*${episode}\\b)`, 'i');
}

export function selectEpisodeFile(result, season, episode) {
  if (Number.isInteger(result.fileIdx) && result.fileIdx >= 0) return result.fileIdx;
  if (!Array.isArray(result.files)) return null;
  const pattern = episodePattern(season, episode);
  const candidates = result.files.filter((file) => {
    const name = String(file?.name || file?.path || '');
    const size = Number(file?.size ?? file?.length);
    return Number.isInteger(file?.index) && file.index >= 0 && pattern.test(name) &&
      !/\b(sample|trailer|preview|featurette)\b/i.test(name) && (!Number.isFinite(size) || size >= 100 * 1024 * 1024);
  });
  candidates.sort((a, b) => Number(b.size ?? b.length ?? 0) - Number(a.size ?? a.length ?? 0));
  return candidates[0]?.index ?? null;
}

export function resultToStream(result, { name, series }) {
  if (result?.url) {
    const details = [
      result.provider,
      result.host,
      result.quality,
      result.language,
      'Directo'
    ].filter(Boolean);
    return {
      name,
      title: details.join(' · '),
      url: result.url,
      ...(result.behaviorHints ? { behaviorHints: result.behaviorHints } : {})
    };
  }
  if (!result || !isValidInfoHash(result.infoHash)) return null;
  const fileIdx = series ? selectEpisodeFile(result, series.season, series.episode) :
    (Number.isInteger(result.fileIdx) && result.fileIdx >= 0 ? result.fileIdx : undefined);
  if (series && fileIdx === null && !result.episodeMatched) return null;
  const details = [result.quality, formatSize(result.size), Number.isFinite(Number(result.seeders)) ? `${Number(result.seeders)} seeders` : null].filter(Boolean);
  return {
    name,
    title: [result.provider, ...details].filter(Boolean).join(' · ') || String(result.title || name),
    infoHash: result.infoHash,
    ...(fileIdx !== undefined ? { fileIdx } : {}),
    sources: [`dht:${result.infoHash}`, ...safeTrackers(result.trackers).map((tracker) => `tracker:${tracker}`)]
  };
}

export function createAddon({ name = 'streaMX', id = 'com.streamx.addon', client, novaClient, ttlSeconds = 300, logger = console } = {}) {
  const catalogs = novaClient ? [
    { type: 'movie', id: 'streamx-nova-movies', name: 'streaMX · NOVA Películas', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { type: 'series', id: 'streamx-nova-series', name: 'streaMX · NOVA Series', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] }
  ] : [];
  const builder = new addonBuilder({
    id,
    version: '2.2.1',
    name,
    description: 'Streams de PelisPanda, NOVA y Cineby, con catálogos NOVA integrados',
    resources: novaClient ? ['catalog', 'meta', 'stream'] : ['stream'],
    types: ['movie', 'series'],
    catalogs,
    idPrefixes: ['tt', 'nova:']
  });
  const cache = new TtlCache(ttlSeconds);

  if (novaClient) {
    builder.defineCatalogHandler(async ({ type, id: catalogId, extra = {} }) => {
      if (!['streamx-nova-movies', 'streamx-nova-series'].includes(catalogId)) return { metas: [] };
      const expectedType = catalogId.endsWith('series') ? 'series' : 'movie';
      if (type !== expectedType) return { metas: [] };
      const skip = Math.max(0, Number(extra.skip) || 0);
      const search = String(extra.search || '').trim();
      try {
        return await cache.getOrLoad(`catalog:${type}:${skip}:${search}`, async () => ({
          metas: await novaClient.catalog(type, { search, skip, limit: 50 })
        }));
      } catch (error) {
        logger.error?.('No se pudo obtener el catálogo de NOVA:', error?.message || error);
        return { metas: [] };
      }
    });

    builder.defineMetaHandler(async ({ type, id: metaId }) => {
      const match = /^nova:(movie|series):(\d+)$/.exec(metaId);
      if (!match || match[1] !== type) return { meta: null };
      try {
        return await cache.getOrLoad(`meta:${type}:${match[2]}`, async () => ({
          meta: await novaClient.meta(type, Number(match[2]))
        }));
      } catch (error) {
        logger.error?.('No se pudo obtener el detalle de NOVA:', error?.message || error);
        return { meta: null };
      }
    });
  }

  builder.defineStreamHandler(async ({ type, id: streamId }) => {
    const parsed = parseStremioId(type, streamId);
    if (!parsed) return { streams: [] };
    const key = `stream:${type}:${parsed.imdbId || `nova-${parsed.novaId}`}:${parsed.season ?? ''}:${parsed.episode ?? ''}`;
    try {
      return await cache.getOrLoad(key, async () => {
        const results = await client.search(parsed);
        results.sort((a, b) =>
          Number(Boolean(b.url)) - Number(Boolean(a.url)) ||
          qualityScore(b.quality) - qualityScore(a.quality) ||
          Number(b.seeders || 0) - Number(a.seeders || 0)
        );
        return { streams: results.map((result) => resultToStream(result, { name, series: type === 'series' ? parsed : null })).filter(Boolean) };
      });
    } catch (error) {
      logger.error?.('No se pudieron obtener streams:', error?.message || error);
      return { streams: [] };
    }
  });
  return builder.getInterface();
}

export function createFromEnv(env = process.env) {
  const sourceUrl = env.SOURCE_API_URL || 'https://pelispanda.org/wp-json/wpreact/v1/';
  const url = new URL(sourceUrl);
  const allowPrivate = ['localhost', '127.0.0.1', '::1'].includes(url.hostname) && env.NODE_ENV !== 'production';
  const common = { baseUrl: url.href, apiKey: env.SOURCE_API_KEY, maxResponseBytes: Number(env.MAX_RESPONSE_BYTES) || 1048576 };
  const pelisPandaClient = url.hostname === 'pelispanda.org'
    ? new PelisPandaClient({ ...common, metadataUrl: env.METADATA_API_URL || 'https://v3-cinemeta.strem.io/', catalogFallbackPages: Number(env.CATALOG_FALLBACK_PAGES) || 10 })
    : new SourceClient({ ...common, allowPrivate });
  const novaClient = env.NOVA_ENABLED === 'false' ? null : new NovaClient({
    baseUrl: env.NOVA_API_URL || 'https://syntorq.com/api/',
    metadataUrl: env.METADATA_API_URL || 'https://v3-cinemeta.strem.io/',
    maxResponseBytes: Number(env.NOVA_MAX_RESPONSE_BYTES) || 4 * 1024 * 1024,
    mediaProxyBaseUrl: env.ADDON_BASE_URL ||
      (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : null) ||
      (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : null) ||
      `http://127.0.0.1:${Number(env.PORT) || 7000}`
  });
  const cinebyClient = env.CINEBY_ENABLED === 'false' ? null : new CinebyClient({
    baseUrl: env.CINEBY_API_URL || 'https://api.speedracelight.com/',
    metadataUrl: env.METADATA_API_URL || 'https://v3-cinemeta.strem.io/',
    maxResponseBytes: Number(env.CINEBY_MAX_RESPONSE_BYTES) || 4 * 1024 * 1024,
    mediaProxyBaseUrl: env.ADDON_BASE_URL ||
      (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : null) ||
      (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : null) ||
      `http://127.0.0.1:${Number(env.PORT) || 7000}`
  });
  const clients = [pelisPandaClient, novaClient, cinebyClient].filter(Boolean);
  const client = clients.length > 1 ? new CombinedClient(clients) : clients[0];
  const configuredName = String(env.ADDON_NAME || '').trim();
  const configuredId = String(env.ADDON_ID || '').trim();
  const name = !configuredName || /^pelispanda(?: addon)?$/i.test(configuredName) ? 'streaMX' : configuredName;
  const id = !configuredId || configuredId === 'org.example.authorized-torrents' ? 'com.streamx.addon' : configuredId;
  return createAddon({
    name,
    id,
    client,
    novaClient,
    ttlSeconds: Number(env.CACHE_TTL_SECONDS) || 300
  });
}

export function createHttpApp(addon = createFromEnv()) {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.get('/nova-media', async (request, response) => {
    let source;
    try {
      source = new URL(String(request.query.url || ''));
      if (!isAllowedNovaMediaUrl(source)) return response.status(403).json({ error: 'Proveedor directo no habilitado' });
      const upstream = await fetchNovaMedia(source, request.headers.range);
      if (!upstream.ok && upstream.status !== 206) {
        return response.status(upstream.status).json({ error: 'La fuente no respondió' });
      }
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const value = upstream.headers.get(name);
        if (value) response.setHeader(name, value);
      }
      response.setHeader('Cache-Control', 'private, no-store');
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.status(upstream.status);
      if (!upstream.body) return response.end();
      Readable.fromWeb(upstream.body).pipe(response);
    } catch {
      return response.status(502).json({ error: 'No se pudo abrir la fuente directa' });
    }
  });
  app.get('/cineby-media', async (request, response) => {
    try {
      const source = new URL(String(request.query.url || ''));
      if (!isAllowedCinebyMediaUrl(source)) {
        return response.status(403).json({ error: 'Proveedor de Cineby no habilitado' });
      }
      const upstream = await fetchCinebyMedia(source, request.headers.range);
      if (!upstream.ok && upstream.status !== 206) {
        return response.status(upstream.status).json({ error: 'La fuente de Cineby no respondió' });
      }
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Cache-Control', 'private, no-store');
      if (source.pathname.toLowerCase().endsWith('.m3u8')) {
        const body = await upstream.text();
        const addonBaseUrl = `${request.protocol}://${request.get('host')}`;
        response.type('application/vnd.apple.mpegurl');
        return response.send(rewriteCinebyPlaylist(body, source, addonBaseUrl));
      }
      for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const value = upstream.headers.get(name);
        if (value) response.setHeader(name, value);
      }
      response.type('video/mp2t');
      response.status(upstream.status);
      if (!upstream.body) return response.end();
      Readable.fromWeb(upstream.body).pipe(response);
    } catch {
      return response.status(502).json({ error: 'No se pudo abrir la fuente de Cineby' });
    }
  });
  app.use('/', getRouter(addon));
  return app;
}

const app = createHttpApp();
export default app;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 7000;
  app.listen(port, () => console.log(`streaMX disponible en http://127.0.0.1:${port}/manifest.json`));
}
