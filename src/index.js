import 'dotenv/config';
import express from 'express';
import stremioSdk from 'stremio-addon-sdk';
import { pathToFileURL } from 'node:url';
import { TtlCache } from './cache.js';
import { SourceClient } from './source-client.js';
import { PelisPandaClient } from './pelispanda-client.js';
import { isValidInfoHash, parseStremioId, safeTrackers } from './validators.js';

const { addonBuilder, getRouter } = stremioSdk;

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
  if (!result || !isValidInfoHash(result.infoHash)) return null;
  const fileIdx = series ? selectEpisodeFile(result, series.season, series.episode) :
    (Number.isInteger(result.fileIdx) && result.fileIdx >= 0 ? result.fileIdx : undefined);
  if (series && fileIdx === null && !result.episodeMatched) return null;
  const details = [result.quality, formatSize(result.size), Number.isFinite(Number(result.seeders)) ? `${Number(result.seeders)} seeders` : null].filter(Boolean);
  return {
    name,
    title: details.join(' · ') || String(result.title || name),
    infoHash: result.infoHash,
    ...(fileIdx !== undefined ? { fileIdx } : {}),
    sources: [`dht:${result.infoHash}`, ...safeTrackers(result.trackers).map((tracker) => `tracker:${tracker}`)]
  };
}

export function createAddon({ name = 'PelisPanda Addon', id = 'org.example.authorized-torrents', client, ttlSeconds = 300, logger = console } = {}) {
  const builder = new addonBuilder({ id, version: '1.0.0', name, description: 'Streams BitTorrent de una fuente autorizada', resources: ['stream'], types: ['movie', 'series'], catalogs: [], idPrefixes: ['tt'] });
  const cache = new TtlCache(ttlSeconds);
  builder.defineStreamHandler(async ({ type, id: streamId }) => {
    const parsed = parseStremioId(type, streamId);
    if (!parsed) return { streams: [] };
    const key = `${type}:${parsed.imdbId}:${parsed.season ?? ''}:${parsed.episode ?? ''}`;
    try {
      return await cache.getOrLoad(key, async () => {
        const results = await client.search(parsed);
        results.sort((a, b) => qualityScore(b.quality) - qualityScore(a.quality) || Number(b.seeders || 0) - Number(a.seeders || 0));
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
  const client = url.hostname === 'pelispanda.org'
    ? new PelisPandaClient({ ...common, metadataUrl: env.METADATA_API_URL || 'https://v3-cinemeta.strem.io/' })
    : new SourceClient({ ...common, allowPrivate });
  return createAddon({ name: env.ADDON_NAME || 'PelisPanda Addon', id: env.ADDON_ID || 'org.example.authorized-torrents', client, ttlSeconds: Number(env.CACHE_TTL_SECONDS) || 300 });
}

export function createHttpApp(addon = createFromEnv()) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/', getRouter(addon));
  return app;
}

const app = createHttpApp();
export default app;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 7000;
  app.listen(port, () => console.log(`PelisPanda Addon disponible en http://127.0.0.1:${port}/manifest.json`));
}
