import { SourceClient } from './source-client.js';
import { isValidInfoHash } from './validators.js';

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'una', 'uno', 'las', 'los', 'del', 'con']);

function titleQueries(title) {
  const words = String(title).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[\p{L}\p{N}]+/gu) || [];
  const useful = words.filter((word) => word.length >= 3 && !STOP_WORDS.has(word.toLowerCase())).sort((a, b) => b.length - a.length);
  return [...new Set([title, ...useful])].slice(0, 5);
}

function normalizeTitle(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function findMatchingCandidate(results, { tmdbId, title, year, type }) {
  if (!Array.isArray(results)) return null;
  const expectedType = type === 'movie' ? 'pelicula' : 'serie';
  const typed = results.filter((item) => item?.type === expectedType);
  const byId = typed.find((item) => String(item?.tmdb_id || '') === String(tmdbId || ''));
  if (byId) return byId;

  const expectedTitle = normalizeTitle(title);
  const expectedYear = Number.parseInt(year, 10);
  if (!expectedTitle || !Number.isInteger(expectedYear)) return null;
  return typed.find((item) => {
    const sameTitle = [item?.title, item?.original_title].some((candidate) => normalizeTitle(candidate) === expectedTitle);
    return sameTitle && Number.parseInt(item?.year, 10) === expectedYear;
  }) || null;
}

export function parseSize(value) {
  const match = /^\s*([\d.,]+)\s*(KB|MB|GB|TB)\s*$/i.exec(String(value || ''));
  if (!match) return undefined;
  const amount = Number(match[1].replace(',', '.'));
  const power = { KB: 1, MB: 2, GB: 3, TB: 4 }[match[2].toUpperCase()];
  return Number.isFinite(amount) ? Math.round(amount * 1024 ** power) : undefined;
}

export function parseMagnet(download, episodeMatched = false) {
  if (download?.download_type !== 'link' || typeof download.download_link !== 'string') return null;
  let magnet;
  try { magnet = new URL(download.download_link); } catch { return null; }
  if (magnet.protocol !== 'magnet:') return null;
  const xt = magnet.searchParams.getAll('xt').find((value) => value.toLowerCase().startsWith('urn:btih:'));
  const infoHash = xt?.slice('urn:btih:'.length);
  if (!isValidInfoHash(infoHash)) return null;
  const trackers = magnet.searchParams.getAll('tr');
  const name = magnet.searchParams.get('dn') || download.title;
  return {
    provider: 'PelisPanda',
    title: name || download.quality,
    infoHash,
    quality: download.quality,
    size: parseSize(download.size) ?? (Number(magnet.searchParams.get('xl')) || undefined),
    trackers,
    episodeMatched
  };
}

export function downloadsFromResponses(detail, supplemental) {
  if (Array.isArray(detail?.downloads) && detail.downloads.length) return detail.downloads;
  return Array.isArray(supplemental?.downloads) ? supplemental.downloads : [];
}

export class PelisPandaClient {
  constructor({ baseUrl = 'https://pelispanda.org/wp-json/wpreact/v1/', metadataUrl = 'https://v3-cinemeta.strem.io/', apiKey, timeoutMs, maxResponseBytes, catalogFallbackPages = 10, fetchImpl } = {}) {
    this.api = new SourceClient({ baseUrl, apiKey, timeoutMs, maxResponseBytes, fetchImpl });
    this.metadata = new SourceClient({ baseUrl: metadataUrl, timeoutMs, maxResponseBytes, fetchImpl });
    this.catalogFallbackPages = Math.min(25, Math.max(0, Number(catalogFallbackPages) || 0));
  }

  supports(params) {
    return Boolean(params?.imdbId);
  }

  async findInCatalog({ tmdbId, title, year, type }) {
    const resource = type === 'movie' ? 'movies' : 'series';
    const property = resource;
    let titleFallback;
    for (let page = 1; page <= this.catalogFallbackPages; page += 1) {
      const url = new URL(resource, this.api.baseUrl);
      url.searchParams.set('posts_per_page', '100');
      url.searchParams.set('page', String(page));
      const data = await this.api.getJson(url);
      const candidate = findMatchingCandidate(data?.[property], { tmdbId, title, year, type });
      if (candidate && String(candidate.tmdb_id || '') === tmdbId) return candidate;
      titleFallback ||= candidate;
      if (!Array.isArray(data?.[property]) || data[property].length < 100) break;
    }
    return titleFallback || null;
  }

  async search({ imdbId, season, episode }) {
    const type = season === undefined ? 'movie' : 'series';
    const metadata = await this.metadata.getJson(`meta/${type}/${encodeURIComponent(imdbId)}.json`);
    const tmdbId = String(metadata?.meta?.moviedb_id || '');
    const title = metadata?.meta?.name;
    const year = metadata?.meta?.year || metadata?.meta?.releaseInfo || metadata?.meta?.released;
    if (!tmdbId || !title) return [];

    let match;
    let titleFallback;
    for (const query of titleQueries(title)) {
      const url = new URL('search', this.api.baseUrl);
      url.searchParams.set('query', query);
      url.searchParams.set('posts_per_page', '100');
      url.searchParams.set('page', '1');
      const data = await this.api.getJson(url);
      const candidate = findMatchingCandidate(data?.results, { tmdbId, title, year, type });
      if (candidate && String(candidate.tmdb_id || '') === tmdbId) {
        match = candidate;
        break;
      }
      titleFallback ||= candidate;
    }
    if (!match) match = await this.findInCatalog({ tmdbId, title, year, type });
    match ||= titleFallback;
    if (!match?.slug) return [];

    const detailPath = `${type === 'movie' ? 'movie' : 'serie'}/${encodeURIComponent(match.slug)}`;
    const detail = await this.api.getJson(detailPath);
    const supplemental = Array.isArray(detail?.downloads) && detail.downloads.length
      ? null
      : await this.api.getJson(`${detailPath}/related`);
    let downloads = downloadsFromResponses(detail, supplemental);
    if (type === 'series') {
      downloads = downloads.flat(Infinity).filter((item) => Number(item?.season) === season && Number(item?.episode) === episode);
    }
    return downloads.map((item) => parseMagnet(item, type === 'series')).filter(Boolean);
  }
}
