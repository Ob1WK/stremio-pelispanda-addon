import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildEmbed69Url, Embed69Client, unpackDeanEdwards } from '../src/embed69-client.js';

const packed = "eval(function(p,a,c,k,e,d){return p}('0=\"1://2.3/4.5\";',36,6,'var|https|cdn|example|video|m3u8'.split('|')))";

function encrypt(value, challenge, salt) {
  const key = crypto.createHash('sha256').update(challenge + 0 + salt).digest();
  const iv = Buffer.alloc(16, 7);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([iv, cipher.update(value), cipher.final()]).toString('base64');
}

describe('Embed69Client', () => {
  it('construye URLs para películas y episodios', () => {
    expect(buildEmbed69Url('https://embed69.org/f/', { imdbId: 'tt8814476' }))
      .toBe('https://embed69.org/f/tt8814476');
    expect(buildEmbed69Url('https://embed69.org/f/', {
      imdbId: 'tt2861424',
      season: 9,
      episode: 3
    })).toBe('https://embed69.org/f/tt2861424-9x03');
  });

  it('desempaqueta una fuente HLS sin ejecutar JavaScript externo', () => {
    expect(unpackDeanEdwards(packed)).toContain('https://cdn.example/video.m3u8');
  });

  it('extrae solamente HLS latino desde un host permitido', async () => {
    const challenge = 'challenge';
    const salt = 'salt';
    const encrypted = encrypt('https://minochinos.com/embed/abc123', challenge, salt);
    const player = `<script>
      const POW_CHALLENGE = '${challenge}';
      const POW_DIFFICULTY = 0;
      const POW_SALT = '${salt}';
      let dataLink = [{"video_language":"LAT","sortedEmbeds":[{"servername":"vidhide","link":"${encrypted}"}]}];
    </script>`;
    const fetchImpl = async (url) => new Response(
      String(url).includes('minochinos.com') ? packed : player,
      { status: 200, headers: { 'content-type': 'text/html' } }
    );
    const client = new Embed69Client({ fetchImpl });
    await expect(client.search({ imdbId: 'tt8814476' })).resolves.toEqual([
      expect.objectContaining({
        provider: 'Embed69',
        host: 'VidHide',
        language: 'Latino',
        url: 'https://cdn.example/video.m3u8'
      })
    ]);
  });

  it('rechaza identificadores incompletos sin consultar la red', async () => {
    const client = new Embed69Client({ fetchImpl: async () => { throw new Error('no debe consultar'); } });
    await expect(client.search({ imdbId: '1234' })).resolves.toEqual([]);
    await expect(client.search({ imdbId: 'tt1234', season: 1 })).resolves.toEqual([]);
  });
});
