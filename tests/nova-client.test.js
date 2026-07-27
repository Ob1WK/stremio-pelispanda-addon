import { describe, expect, it, vi } from 'vitest';
import { CombinedClient, NovaClient, novaDetailMeta } from '../src/nova-client.js';

describe('adaptador de NOVA', () => {
  it('convierte HLS directos y embeds en streams de Stremio', async () => {
    const client = Object.create(NovaClient.prototype);
    client.metadata = {
      getJson: vi.fn(async () => ({ meta: { moviedb_id: 2131, name: 'Daria', year: 1997 } }))
    };
    client.api = {
      getJson: vi.fn(async (path) => {
        if (String(path).startsWith('series/search')) return [{ id: 4131, tmdb_id: 2131, title: 'Daria', year: 1997 }];
        if (String(path).startsWith('vod/sources')) {
          return {
            sources: [
              { host: 'Uqload', embed_url: 'https://video.example/master.m3u8', quality: 'HD', requires_extraction: false },
              { host: 'GoodStream', embed_url: 'https://goodstream.example/embed-123.html', quality: 'HD', requires_extraction: true }
            ]
          };
        }
        return { sources: [] };
      })
    };

    const streams = await client.search({ imdbId: 'tt0118298', season: 1, episode: 1 });
    expect(streams).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'NOVA', url: 'https://video.example/master.m3u8' }),
      expect.objectContaining({ provider: 'NOVA', externalUrl: 'https://goodstream.example/embed-123.html' })
    ]));
  });

  it('crea episodios reproducibles para el catálogo propio', () => {
    const meta = novaDetailMeta({
      id: 20,
      title: 'Serie',
      seasons: [{ season_number: 2, episodes: [{ episode_number: 3, title: 'Tres' }] }]
    }, 'series');
    expect(meta.videos[0]).toMatchObject({
      id: 'nova:series:20:2:3',
      season: 2,
      episode: 3,
      title: 'Tres'
    });
  });

  it('mantiene resultados de una fuente cuando la otra falla', async () => {
    const combined = new CombinedClient([
      { search: async () => { throw new Error('caída'); } },
      { search: async () => [{ provider: 'NOVA', url: 'https://video.example/a.m3u8' }] }
    ]);
    await expect(combined.search({ imdbId: 'tt1' })).resolves.toHaveLength(1);
  });
});
