import dns from 'node:dns/promises';
import net from 'node:net';

export const isValidInfoHash = (value) =>
  typeof value === 'string' && (/^[a-f\d]{40}$/i.test(value) || /^[A-Z2-7]{32}$/i.test(value));

export function parseStremioId(type, id) {
  if (type === 'movie' && /^(tt\d+)$/.test(id)) return { imdbId: id };
  const match = type === 'series' && /^(tt\d+):(\d+):(\d+)$/.exec(id);
  if (!match) return null;
  const season = Number(match[2]);
  const episode = Number(match[3]);
  if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode) || season < 0 || episode < 0) return null;
  return { imdbId: match[1], season, episode };
}

function isPrivateIp(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(address)) {
    const ip = address.toLowerCase().split('%')[0];
    return ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') ||
      ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb') || ip.startsWith('::ffff:127.') || ip.startsWith('::ffff:10.') || ip.startsWith('::ffff:192.168.');
  }
  return true;
}

export async function assertSafeApiUrl(input, { allowPrivate = false } = {}) {
  let url;
  try { url = new URL(input); } catch { throw new Error('SOURCE_API_URL no es una URL válida'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('La API debe usar HTTP o HTTPS');
  if (url.username || url.password) throw new Error('La URL de la API no debe contener credenciales');
  const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!records.length || (!allowPrivate && records.some(({ address }) => isPrivateIp(address)))) {
    throw new Error('La API resuelve a una dirección privada o local');
  }
  return url;
}

export function safeTrackers(trackers) {
  if (!Array.isArray(trackers)) return [];
  return trackers.filter((item) => typeof item === 'string' && /^(udp|https?|wss):\/\/[^\s]+$/i.test(item)).slice(0, 20);
}
