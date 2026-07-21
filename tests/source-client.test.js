import { describe, expect, it, vi } from 'vitest';
import { SourceClient } from '../src/source-client.js';

describe('SourceClient', () => {
  it('envía parámetros y autenticación sin ejecutar contenido', async () => {
    const fetchImpl = vi.fn(async (url, options) => new Response(JSON.stringify({ results: [{ title: '<script>alert(1)</script>' }] }), { headers: { 'content-type': 'application/json' } }));
    const client = new SourceClient({ baseUrl: 'http://127.0.0.1:7100', apiKey: 'secreta', allowPrivate: true, fetchImpl });
    const results = await client.search({ imdbId: 'tt123', season: 1, episode: 2 });
    expect(fetchImpl.mock.calls[0][0].pathname).toBe('/series');
    expect(fetchImpl.mock.calls[0][0].searchParams.get('episode')).toBe('2');
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer secreta');
    expect(results[0].title).toContain('<script>');
  });
  it('rechaza respuestas mayores al límite', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ results: ['demasiado largo'] }), { headers: { 'content-type': 'application/json' } });
    const client = new SourceClient({ baseUrl: 'http://localhost', allowPrivate: true, maxResponseBytes: 8, fetchImpl });
    await expect(client.search({ imdbId: 'tt1' })).rejects.toThrow('demasiado grande');
  });
  it('rechaza protocolos no HTTP', async () => {
    const client = new SourceClient({ baseUrl: 'file:///tmp/api', fetchImpl: vi.fn() });
    await expect(client.search({ imdbId: 'tt1' })).rejects.toThrow('HTTP o HTTPS');
  });
  it('no reenvía credenciales a otro origen', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://localhost:7200/otro' } }));
    const client = new SourceClient({ baseUrl: 'http://localhost:7100', apiKey: 'secreta', allowPrivate: true, fetchImpl });
    await expect(client.search({ imdbId: 'tt1' })).rejects.toThrow('origen diferente');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
