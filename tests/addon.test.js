import { describe, expect, it, vi } from 'vitest';
import { createAddon, resultToStream, selectEpisodeFile } from '../src/index.js';

const hash = '0123456789abcdef0123456789abcdef01234567';

describe('series', () => {
  it('elige el episodio y descarta samples', () => {
    const result = { files: [{ index: 0, name: 'Show.S01E02.sample.mkv', size: 10_000_000 }, { index: 4, name: 'Show 1x02.mkv', size: 900_000_000 }] };
    expect(selectEpisodeFile(result, 1, 2)).toBe(4);
  });
  it('no adivina si no hay archivo coincidente', () => expect(selectEpisodeFile({ files: [{ index: 0, name: 'S01E03.mkv' }] }, 1, 2)).toBeNull());
});

describe('streams', () => {
  it('produce un stream compatible', () => {
    expect(resultToStream({ infoHash: hash, fileIdx: 0, quality: '1080p', size: 4294967296, seeders: 25, trackers: [] }, { name: 'Fuente' })).toMatchObject({ name: 'Fuente', title: '1080p · 4 GB · 25 seeders', infoHash: hash, fileIdx: 0, sources: [`dht:${hash}`] });
  });
  it('ordena por calidad y luego seeders y cachea', async () => {
    const client = { search: vi.fn(async () => [{ infoHash: hash, fileIdx: 0, quality: '720p', seeders: 100 }, { infoHash: 'a'.repeat(40), fileIdx: 0, quality: '1080p', seeders: 1 }]) };
    const addon = createAddon({ client, name: 'Fuente' });
    const first = await addon.get('stream', 'movie', 'tt123');
    await addon.get('stream', 'movie', 'tt123');
    expect(first.streams.map((x) => x.infoHash)).toEqual(['a'.repeat(40), hash]);
    expect(client.search).toHaveBeenCalledTimes(1);
  });
  it('devuelve vacío ante errores', async () => {
    const addon = createAddon({ client: { search: async () => { throw new Error('fallo'); } }, logger: { error() {} } });
    expect(await addon.get('stream', 'movie', 'tt123')).toEqual({ streams: [] });
  });
  it('publica los catálogos de NOVA con el nombre streaMX', async () => {
    const novaClient = {
      catalog: vi.fn(async () => [{ id: 'nova:movie:1', type: 'movie', name: 'Película NOVA' }]),
      meta: vi.fn()
    };
    const addon = createAddon({ client: { search: async () => [] }, novaClient });
    expect(addon.manifest.name).toBe('streaMX');
    expect(addon.manifest.catalogs.map((catalog) => catalog.id)).toContain('streamx-nova-movies');
    await expect(addon.get('catalog', 'movie', 'streamx-nova-movies')).resolves.toEqual({
      metas: [{ id: 'nova:movie:1', type: 'movie', name: 'Película NOVA' }]
    });
  });
  it('migra automáticamente el nombre e ID heredados de PelisPanda', async () => {
    const { createFromEnv } = await import('../src/index.js');
    const addon = createFromEnv({
      ADDON_NAME: 'PelisPanda Addon',
      ADDON_ID: 'org.example.authorized-torrents',
      NOVA_ENABLED: 'false'
    });
    expect(addon.manifest.name).toBe('streaMX');
    expect(addon.manifest.id).toBe('com.streamx.addon');
    expect(addon.manifest.version).toBe('2.1.1');
  });
});
