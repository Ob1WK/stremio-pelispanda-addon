import { SourceClient } from './source-client.js';

const DIRECT_MEDIA = /\.(?:m3u8|mp4|mkv|webm)(?:$|[?#])/i;

function normalizedTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function uniqueSources(payloads) {
  const sources = new Map();
  for (const payload of payloads) {
    for (const source of payload?.sources || []) {
      const rawUrl = source?.real_url || source?.embed_url || source?.url;
      const url = validHttpUrl(rawUrl);
      if (!url || sources.has(url)) continue;
      const direct = source.requires_extraction === false ||
        String(source.type || '').toLowerCase() === 'direct' ||
        DIRECT_MEDIA.test(url);
      sources.set(url, {
        provider: 'NOVA',
        host: source.host || source.server || source.provider || new URL(url).hostname,
        quality: source.quality || 'Auto',
        language: source.language || 'Latino',
        priority: Number(source.priority ?? 999),
        ...(direct ? {
          url,
          behaviorHints: {
            notWebReady: false,
            proxyHeaders: {
              request: {
                Referer: 'https://syntorq.com/',
                'User-Agent': 'Mozilla/5.0'
              }
            }
          }
        } : { externalUrl: url })
      });
    }
  }
  return [...sources.values()].sort((a, b) =>
    Number(Boolean(b.url)) - Number(Boolean(a.url)) || a.priority - b.priority
  );
}

function catalogPath(type, search, skip, limit) {
  const resource = type === 'series' ? 'series' : 'movies';
  const path = search ? `${resource}/search` : `${resource}/`;
  const params = new URLSearchParams({
    limit: String(Math.min(50, Math.max(1, limit))),
    skip: String(Math.max(0, skip))
  });
  if (search) params.set('q', search);
  return `${path}?${params}`;
}

function novaId(type, id) {
  return `nova:${type === 'series' ? 'series' : 'movie'}:${id}`;
}

export function novaCatalogMeta(item, type) {
  return {
    id: novaId(type, item.id),
    type,
    name: item.title,
    poster: item.poster_url,
    background: item.backdrop_url,
    description: item.overview,
    releaseInfo: item.year ? String(item.year) : undefined,
    genres: Array.isArray(item.genres) ? item.genres : undefined,
    imdbRating: item.rating ? String(item.rating) : undefined
  };
}

export function novaDetailMeta(detail, type) {
  const meta = {
    ...novaCatalogMeta(detail, type),
    runtime: detail.duration ? `${detail.duration} min` : undefined,
    status: detail.status
  };
  if (type === 'series') {
    meta.videos = (detail.seasons || []).flatMap((season, seasonIndex) => {
      const seasonNumber = Number(season.season_number ?? season.number ?? seasonIndex + 1);
      return (season.episodes || []).map((episode, episodeIndex) => {
        const episodeNumber = Number(episode.episode_number ?? episode.number ?? episodeIndex + 1);
        return {
          id: `${novaId(type, detail.id)}:${seasonNumber}:${episodeNumber}`,
          title: episode.title || episode.name || `Episodio ${episodeNumber}`,
          season: seasonNumber,
          episode: episodeNumber,
          thumbnail: episode.still_url || episode.thumbnail,
          overview: episode.overview
        };
      });
    });
  }
  return meta;
}

export class NovaClient {
  constructor({
    baseUrl = 'https://syntorq.com/api/',
    metadataUrl = 'https://v3-cinemeta.strem.io/',
    timeoutMs,
    maxResponseBytes = 4 * 1024 * 1024,
    fetchImpl
  } = {}) {
    this.api = new SourceClient({ baseUrl, timeoutMs, maxResponseBytes, fetchImpl });
    this.metadata = new SourceClient({
      baseUrl: metadataUrl,
      timeoutMs,
      maxResponseBytes,
      fetchImpl
    });
  }

  supports(params) {
    return Boolean(params?.imdbId || params?.novaId);
  }

  async catalog(type, { search = '', skip = 0, limit = 50 } = {}) {
    const data = await this.api.getJson(catalogPath(type, search.trim(), skip, limit));
    return (Array.isArray(data) ? data : []).map((item) => novaCatalogMeta(item, type));
  }

  async meta(type, id) {
    const detail = await this.api.getJson(`${type === 'series' ? 'series' : 'movies'}/${id}`);
    return novaDetailMeta(detail, type);
  }

  async findItem(type, { tmdbId, title, year }) {
    const data = await this.api.getJson(catalogPath(type, title || '', 0, 50));
    const items = Array.isArray(data) ? data : [];
    return items.find((item) => String(item?.tmdb_id || '') === String(tmdbId || '')) ||
      items.find((item) =>
        normalizedTitle(item?.title) === normalizedTitle(title) &&
        Number(item?.year) === Number.parseInt(year, 10)
      ) ||
      (tmdbId ? await this.findInRecentPages(type, tmdbId) : null);
  }

  async findInRecentPages(type, tmdbId) {
    for (let skip = 0; skip < 500; skip += 50) {
      const data = await this.api.getJson(catalogPath(type, '', skip, 50));
      const items = Array.isArray(data) ? data : [];
      const match = items.find((item) => String(item?.tmdb_id || '') === String(tmdbId));
      if (match) return match;
      if (items.length < 50) break;
    }
    return null;
  }

  async episodeSources({ tmdbId, title, year, novaId: seriesId, season, episode }) {
    const paths = [
      tmdbId ? `vod/sources/tv/${tmdbId}/${season}/${episode}?title=${encodeURIComponent(title || '')}&year=${encodeURIComponent(year || '')}` : null,
      tmdbId ? `sources/tv/${tmdbId}/${season}/${episode}` : null,
      seriesId ? `series/${seriesId}/seasons/${season}/episodes/${episode}/extract-sources` : null
    ].filter(Boolean);
    const responses = await Promise.allSettled(paths.map((path) => this.api.getJson(path)));
    return uniqueSources(responses.filter((result) => result.status === 'fulfilled').map((result) => result.value));
  }

  async search(params) {
    if (params.novaId) {
      if (params.type === 'movie') {
        const detail = await this.api.getJson(`movies/${params.novaId}`);
        return uniqueSources([detail]);
      }
      const detail = await this.api.getJson(`series/${params.novaId}`);
      return this.episodeSources({
        tmdbId: detail.tmdb_id,
        title: detail.title,
        year: detail.year,
        novaId: params.novaId,
        season: params.season,
        episode: params.episode
      });
    }

    const type = params.season === undefined ? 'movie' : 'series';
    const metadata = await this.metadata.getJson(`meta/${type}/${encodeURIComponent(params.imdbId)}.json`);
    const meta = metadata?.meta;
    const tmdbId = meta?.moviedb_id;
    const title = meta?.name;
    const year = meta?.year || meta?.releaseInfo || meta?.released;
    if (!tmdbId || !title) return [];

    if (type === 'series') {
      const item = await this.findItem(type, { tmdbId, title, year }).catch(() => null);
      return this.episodeSources({
        tmdbId,
        title,
        year,
        novaId: item?.id,
        season: params.season,
        episode: params.episode
      });
    }

    const item = await this.findItem(type, { tmdbId, title, year });
    if (!item?.id) return [];
    const detail = await this.api.getJson(`movies/${item.id}`);
    return uniqueSources([detail]);
  }
}

export class CombinedClient {
  constructor(clients = []) {
    this.clients = clients;
  }

  async search(params) {
    const eligible = this.clients.filter((client) => client.supports?.(params) !== false);
    const responses = await Promise.allSettled(eligible.map((client) => client.search(params)));
    return responses
      .filter((result) => result.status === 'fulfilled' && Array.isArray(result.value))
      .flatMap((result) => result.value);
  }
}
