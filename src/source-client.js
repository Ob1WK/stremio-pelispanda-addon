import { assertSafeApiUrl } from './validators.js';

const DEFAULT_LIMIT = 1024 * 1024;

async function readLimitedJson(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (declared && declared > limit) throw new Error('Respuesta demasiado grande');
  if (!response.body) throw new Error('Respuesta vacía');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); throw new Error('Respuesta demasiado grande'); }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  return JSON.parse(body);
}

export class SourceClient {
  constructor({ baseUrl, apiKey, timeoutMs = 10_000, maxResponseBytes = DEFAULT_LIMIT, allowPrivate = false, fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.allowPrivate = allowPrivate;
    this.fetch = fetchImpl;
  }

  async search(params) {
    let url = await assertSafeApiUrl(this.baseUrl, { allowPrivate: this.allowPrivate });
    url = new URL(params.season === undefined ? 'movie' : 'series', url.href.endsWith('/') ? url : `${url.href}/`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const data = await this.getJson(url);
    return Array.isArray(data?.results) ? data.results.slice(0, 100) : [];
  }

  async getJson(input) {
    const base = await assertSafeApiUrl(this.baseUrl, { allowPrivate: this.allowPrivate });
    let url = new URL(input, base);
    if (url.origin !== base.origin) throw new Error('Solicitud a un origen diferente bloqueada');
    const sourceOrigin = url.origin;
    const signal = AbortSignal.timeout(this.timeoutMs);
    const headers = { accept: 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    for (let redirect = 0; redirect <= 3; redirect += 1) {
      await assertSafeApiUrl(url, { allowPrivate: this.allowPrivate });
      const response = await this.fetch(url, { headers, redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirect === 3) throw new Error('Demasiadas redirecciones');
        const location = response.headers.get('location');
        if (!location) throw new Error('Redirección sin destino');
        const nextUrl = new URL(location, url);
        if (nextUrl.origin !== sourceOrigin) throw new Error('Redirección a un origen diferente bloqueada');
        url = nextUrl;
        continue;
      }
      if (!response.ok) throw new Error(`La fuente respondió HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.toLowerCase().includes('application/json')) throw new Error('La fuente no devolvió JSON');
      return readLimitedJson(response, this.maxResponseBytes);
    }
    return null;
  }
}
