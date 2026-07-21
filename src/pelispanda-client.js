import { SourceClient } from './source-client.js';
import { isValidInfoHash } from './validators.js';

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'una', 'uno', 'las', 'los', 'del', 'con']);

function titleQueries(title) {
  const words = String(title).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[\p{L}\p{N}]+/gu) || [];
  const useful = words.filter((word) => word.length >= 3 && !STOP_WORDS.has(word.toLowerCase())).sort((a, b) => b.length - a.length);
  return [...new Set([title, ...useful])].slice(0, 5);
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
    title: name || download.quality,
    infoHash,
    quality: download.quality,
    size: parseSize(download.size) ?? (Number(magnet.searchParams.get('xl')) || undefined),
    trackers,
    episodeMatched
  };
}

export class PelisPandaClient {
  constructor({ baseUrl = 'https://pelispanda.org/wp-json/wpreact/v1/', metadataUrl = 'https://v3-cinemeta.strem.io/', apiKey, timeoutMs, maxResponseBytes, fetchImpl } = {}) {
    this.api = new SourceClient({ baseUrl, apiKey, timeoutMs, maxResponseBytes, fetchImpl });
    this.metadata = new SourceClient({ baseUrl: metadataUrl, timeoutMs, maxResponseBytes, fetchImpl });
  }

  async search({ imdbId, season, episode }) {
    const type = season === undefined ? 'movie' : 'series';
    const metadata = await this.metadata.getJson(`meta/${type}/${encodeURIComponent(imdbId)}.json`);
    const tmdbId = String(metadata?.meta?.moviedb_id || '');
    const title = metadata?.meta?.name;
    if (!tmdbId || !title) return [];

    let match;
    for (const query of titleQueries(title)) {
      const url = new URL('search', this.api.baseUrl);
      url.searchParams.set('query', query);
      url.searchParams.set('posts_per_page', '100');
      url.searchParams.set('page', '1');
      const data = await this.api.getJson(url);
      match = data?.results?.find((item) => String(item?.tmdb_id) === tmdbId && item?.type === (type === 'movie' ? 'pelicula' : 'serie'));
      if (match) break;
    }
    if (!match?.slug) return [];

    const detail = await this.api.getJson(`${type === 'movie' ? 'movie' : 'serie'}/${encodeURIComponent(match.slug)}`);
    let downloads = Array.isArray(detail?.downloads) ? detail.downloads : [];
    if (type === 'series') {
      downloads = downloads.flat(Infinity).filter((item) => Number(item?.season) === season && Number(item?.episode) === episode);
    }
    return downloads.map((item) => parseMagnet(item, type === 'series')).filter(Boolean);
  }
}
