import { describe, expect, it, vi } from 'vitest';
import { CombinedClient, NovaClient, novaDetailMeta } from '../src/nova-client.js';

describe('adaptador de NOVA', () => {
  it('acepta solo HLS directos y latinos dentro de Stremio', async () => {
    const client = Object.create(NovaClient.prototype);
    client.mediaProxyBaseUrl = 'https://addon.example/';
    client.metadata = {
      getJson: vi.fn(async () => ({ meta: { moviedb_id: 2131, name: 'Daria', year: '1997–' } }))
    };
    client.api = {
      getJson: vi.fn(async (path) => {
        if (String(path).startsWith('series/search')) return [{ id: 4131, tmdb_id: 2131, title: 'Daria', year: 1997 }];
        if (String(path).startsWith('vod/sources')) {
          return {
            sources: [
              { host: 'Uqload', embed_url: 'https://video.example/master.m3u8', quality: 'HD', language: 'LAT', requires_extraction: false },
              { host: 'mecochi', embed_url: 'http://inyoutv.com:8080/episode.mp4', quality: 'HD', language: 'es-LA', requires_extraction: false },
              { host: 'GoodStream', embed_url: 'https://goodstream.example/embed-123.html', quality: 'HD', language: 'Latino', requires_extraction: true },
              { host: 'English', embed_url: 'https://video.example/english.m3u8', quality: 'HD', language: 'English', requires_extraction: false }
            ]
          };
        }
        return { sources: [] };
      })
    };

    const streams = await client.search({ imdbId: 'tt0118298', season: 1, episode: 1 });
    expect(streams).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'NOVA', url: 'https://video.example/master.m3u8', language: 'Latino' }),
      expect.objectContaining({
        provider: 'NOVA',
        url: 'https://addon.example/nova-media?url=http%3A%2F%2Finyoutv.com%3A8080%2Fepisode.mp4',
        language: 'Latino'
      })
    ]));
    expect(client.api.getJson).toHaveBeenCalledWith(expect.stringContaining('year=1997'));
    expect(client.api.getJson).not.toHaveBeenCalledWith(expect.stringContaining('1997%E2%80%93'));
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
