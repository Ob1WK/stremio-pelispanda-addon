import { describe, expect, it, vi } from 'vitest';
import { CinebyClient } from '../src/cineby-client.js';

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' }
  });
}

describe('CinebyClient', () => {
  it('omite la fuente cuando faltan los metadatos TMDB', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ meta: {} }));
    const client = new CinebyClient({ fetchImpl });
    await expect(client.search({ imdbId: 'tt1' })).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('continúa con el servidor siguiente si el anterior falla', async () => {
    const client = new CinebyClient({
      servers: [['Primero', 'first'], ['Segundo', 'second']],
      fetchImpl: vi.fn(async () => jsonResponse({
        meta: { moviedb_id: 278, name: 'Cadena perpetua', year: 1994 }
      }))
    });
    client.sourcesFrom = vi.fn()
      .mockRejectedValueOnce(new Error('caído'))
      .mockResolvedValueOnce([{ provider: 'Cineby', host: 'Segundo', quality: '1080p', url: 'https://media.example/video.m3u8' }]);
    const result = await client.search({ imdbId: 'tt0111161' });
    expect(result).toHaveLength(1);
    expect(result[0].host).toBe('Segundo');
    expect(client.sourcesFrom).toHaveBeenCalledTimes(2);
  });

  it('envía temporada y episodio para series', async () => {
    const client = new CinebyClient({
      servers: [['Yoru', 'cdn/sources-with-title']],
      fetchImpl: vi.fn(async () => jsonResponse({
        meta: { moviedb_id: 66732, name: 'Stranger Things', year: 2016 }
      }))
    });
    client.sourcesFrom = vi.fn().mockResolvedValue([]);
    await client.search({ imdbId: 'tt4574334', season: 2, episode: 3 });
    expect(client.sourcesFrom).toHaveBeenCalledWith(
      'Yoru',
      'cdn/sources-with-title',
      expect.objectContaining({ type: 'tv', tmdbId: '66732', season: 2, episode: 3 })
    );
  });
});
