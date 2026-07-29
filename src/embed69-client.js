import crypto from 'node:crypto';

const IMDB_ID = /^tt\d+$/;
const EMBED_HOSTS = new Set(['minochinos.com', 'www.minochinos.com']);

export function buildEmbed69Url(baseUrl, { imdbId, season, episode }) {
  if (!IMDB_ID.test(String(imdbId || ''))) return null;
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:') throw new Error('Embed69 debe usar HTTPS');

  let id = imdbId;
  if (season !== undefined || episode !== undefined) {
    const seasonNumber = Number(season);
    const episodeNumber = Number(episode);
    if (!Number.isInteger(seasonNumber) || seasonNumber < 0 ||
        !Number.isInteger(episodeNumber) || episodeNumber < 1) return null;
    id += `-${seasonNumber}x${String(episodeNumber).padStart(2, '0')}`;
  }
  return new URL(encodeURIComponent(id), base.href.endsWith('/') ? base : `${base.href}/`).href;
}

function decodeQuoted(value) {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\') {
      result += value[index];
      continue;
    }
    index += 1;
    const escaped = value[index];
    if (escaped === 'n') result += '\n';
    else if (escaped === 'r') result += '\r';
    else if (escaped === 't') result += '\t';
    else result += escaped;
  }
  return result;
}

export function unpackDeanEdwards(source) {
  const match = /eval\(function\(p,a,c,k,e,d\).*?\}\('((?:\\.|[^'])*)',(\d+),(\d+),'((?:\\.|[^'])*)'\.split\('\|'\)\)\)/s.exec(source);
  if (!match) return null;
  let payload = decodeQuoted(match[1]);
  const radix = Number(match[2]);
  const count = Number(match[3]);
  const words = decodeQuoted(match[4]).split('|');
  for (let index = count - 1; index >= 0; index -= 1) {
    if (!words[index]) continue;
    payload = payload.replace(new RegExp(`\\b${index.toString(radix)}\\b`, 'g'), words[index]);
  }
  return payload;
}

function parsePlayerData(html) {
  const challenge = /POW_CHALLENGE\s*=\s*'([^']+)'/.exec(html)?.[1];
  const difficulty = Number(/POW_DIFFICULTY\s*=\s*(\d+)/.exec(html)?.[1]);
  const salt = /POW_SALT\s*=\s*'([^']+)'/.exec(html)?.[1];
  const serialized = /let\s+dataLink\s*=\s*(\[[^;]+\]);/.exec(html)?.[1];
  if (!challenge || !salt || !Number.isInteger(difficulty) || !serialized) return null;
  return { challenge, difficulty, salt, files: JSON.parse(serialized) };
}

function solveKey({ challenge, difficulty, salt }) {
  const prefix = '0'.repeat(difficulty);
  for (let nonce = 0; nonce < 10_000_000; nonce += 1) {
    const hash = crypto.createHash('sha256').update(challenge + nonce).digest('hex');
    if (hash.startsWith(prefix)) {
      return crypto.createHash('sha256').update(challenge + nonce + salt).digest();
    }
  }
  throw new Error('No se pudo resolver la verificación de Embed69');
}

function decryptLink(value, key) {
  const raw = Buffer.from(value, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, raw.subarray(0, 16));
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8');
}

function directMediaFromPackedHtml(html) {
  const unpacked = unpackDeanEdwards(html);
  if (!unpacked) return null;
  const urls = unpacked.match(/https?:\/\/[^"'\\\s]+/g) || [];
  return urls.find((url) => /\.m3u8(?:\?|$)/i.test(url)) ||
    urls.find((url) => /\.mp4(?:\?|$)/i.test(url)) ||
    null;
}

export class Embed69Client {
  constructor({
    baseUrl = 'https://embed69.org/f/',
    timeoutMs = 10_000,
    maxResponseBytes = 512 * 1024,
    fetchImpl = fetch
  } = {}) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.fetch = fetchImpl;
  }

  async getText(url, referer) {
    const response = await this.fetch(url, {
      headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 streaMX', ...(referer ? { referer } : {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) return null;
    const declared = Number(response.headers.get('content-length'));
    if (declared && declared > this.maxResponseBytes) throw new Error('Respuesta de Embed69 demasiado grande');
    const body = await response.text();
    if (Buffer.byteLength(body) > this.maxResponseBytes) throw new Error('Respuesta de Embed69 demasiado grande');
    return body;
  }

  async search(params) {
    const playerUrl = buildEmbed69Url(this.baseUrl, params);
    if (!playerUrl) return [];
    const playerHtml = await this.getText(playerUrl);
    if (!playerHtml) return [];
    const data = parsePlayerData(playerHtml);
    if (!data) return [];
    const key = solveKey(data);
    const latino = data.files.find((file) => file?.video_language === 'LAT');
    const candidates = latino?.sortedEmbeds || [];

    for (const candidate of candidates) {
      if (candidate?.servername !== 'vidhide' || !candidate?.link) continue;
      let embedUrl;
      try {
        embedUrl = new URL(decryptLink(candidate.link, key));
      } catch {
        continue;
      }
      if (embedUrl.protocol !== 'https:' || !EMBED_HOSTS.has(embedUrl.hostname.toLowerCase())) continue;
      const hostHtml = await this.getText(embedUrl.href, playerUrl);
      const url = hostHtml && directMediaFromPackedHtml(hostHtml);
      if (!url) continue;
      return [{
        provider: 'Embed69',
        host: 'VidHide',
        language: 'Latino',
        quality: 'HD',
        url,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: { request: { Referer: embedUrl.href } }
        }
      }];
    }
    return [];
  }
}
