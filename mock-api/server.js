import http from 'node:http';

const hash = '0123456789abcdef0123456789abcdef01234567';
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('content-type', 'application/json; charset=utf-8');
  if (url.pathname === '/movie' && /^tt\d+$/.test(url.searchParams.get('imdbId') || '')) {
    return response.end(JSON.stringify({ results: [{ title: 'Película de prueba', infoHash: hash, fileIdx: 0, quality: '1080p', size: 4294967296, seeders: 25, trackers: ['udp://tracker.example.org:1337/announce'] }] }));
  }
  if (url.pathname === '/series' && /^tt\d+$/.test(url.searchParams.get('imdbId') || '')) {
    const season = url.searchParams.get('season');
    const episode = url.searchParams.get('episode');
    return response.end(JSON.stringify({ results: [{ title: 'Serie de prueba', infoHash: hash, quality: '720p', size: 1500000000, seeders: 12, files: [{ index: 0, name: 'sample.mkv', size: 20000000 }, { index: 1, name: `Show.S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}.mkv`, size: 1500000000 }] }] }));
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ results: [] }));
});

server.listen(Number(process.env.MOCK_PORT) || 7100, '0.0.0.0', () => console.log('API simulada: http://localhost:7100'));
