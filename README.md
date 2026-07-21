# PelisPanda Addon para Stremio

Addon de Node.js 20+ que consulta una API HTTP, valida sus resultados y publica streams BitTorrent para películas y series. Úselo exclusivamente con contenido propio, autorizado o de dominio público.

## Instalación y configuración

```bash
npm install
copy .env.example .env
```

Edite `.env`:

- `ADDON_NAME`: nombre visible en Stremio.
- `ADDON_ID`: identificador estable y único del addon.
- `PORT`: puerto del addon (por defecto `7000`).
- `SOURCE_API_URL`: URL base de PelisPanda. El valor predeterminado es `https://pelispanda.org/wp-json/wpreact/v1/`.
- `SOURCE_API_KEY`: opcional; se envía como `Authorization: Bearer <clave>`.
- `METADATA_API_URL`: API de metadatos de Stremio/Cinemeta usada para traducir IMDb a TMDB. El resultado de PelisPanda se valida por coincidencia exacta de `tmdb_id`.
- `CACHE_TTL_SECONDS`: duración de la caché en memoria.
- `MAX_RESPONSE_BYTES`: límite de la respuesta JSON (por defecto 1 MiB).

El addon usa los endpoints públicos observados de PelisPanda: `/search`, `/movie/{slug}` y `/serie/{slug}`. Primero identifica resultados mediante `tmdb_id`; si PelisPanda tiene ese ID ausente o incorrecto, permite una coincidencia exacta y normalizada con `title` u `original_title`, siempre exigiendo también el mismo tipo y año. Los magnets se interpretan como datos; nunca se evalúa JavaScript de la fuente. En producción, la fuente debe ser HTTP(S) pública. Los hosts privados se permiten solamente para `localhost`/`127.0.0.1` fuera de producción, facilitando la API simulada.

## Prueba local

En una terminal:

```bash
npm run mock-api
```

En otra:

```bash
SOURCE_API_URL=http://127.0.0.1:7100
npm start
```

En PowerShell use `$env:SOURCE_API_URL="http://127.0.0.1:7100"` antes de `npm.cmd start`. Sin esa variable, el addon consulta directamente la API pública de PelisPanda.

Abra `http://localhost:7000/manifest.json` e instale esa URL en Stremio. Ejemplos directos: `/stream/movie/tt123.json` y `/stream/series/tt123:1:2.json`.

Para probar desde otro dispositivo de la red local, permita el puerto `7000` en el firewall y use la IP LAN de la computadora, por ejemplo `http://192.168.1.20:7000/manifest.json`. Ambos dispositivos deben estar en la misma red. Algunas versiones o plataformas de Stremio pueden exigir HTTPS para addons remotos.

## Despliegue con HTTPS

Ejecute el proceso detrás de un proxy inverso como Caddy, nginx o un proveedor con TLS administrado. Publique únicamente el puerto HTTPS, configure un certificado válido y establezca `SOURCE_API_URL` con la API real. En producción use `NODE_ENV=production`; esto bloquea fuentes que resuelvan a redes privadas, incluso después de una redirección. Instale en Stremio `https://su-dominio.example/manifest.json`.

### Vercel

El proyecto exporta una aplicación Express compatible con la detección automática de Vercel y sigue conservando `npm start` para uso local.

1. En Vercel, seleccione **Add New → Project** e importe el repositorio privado `Ob1WK/stremio-pelispanda-addon`.
2. Deje el directorio raíz en `.`. Vercel detectará la aplicación Node/Express; no configure un directorio de salida.
3. Agregue estas variables de entorno:

```dotenv
ADDON_NAME=PelisPanda Addon
ADDON_ID=org.example.authorized-torrents
SOURCE_API_URL=https://pelispanda.org/wp-json/wpreact/v1/
METADATA_API_URL=https://v3-cinemeta.strem.io/
CACHE_TTL_SECONDS=300
MAX_RESPONSE_BYTES=1048576
NODE_ENV=production
```

4. Presione **Deploy** y verifique `https://su-proyecto.vercel.app/manifest.json`.
5. Pegue esa URL completa en **Add-on Repository URL** de Stremio.

Vercel puede apagar o reemplazar instancias sin tráfico. Por ello la caché en memoria es oportunista: mejora solicitudes que llegan a la misma instancia activa, pero no es persistente ni compartida entre instancias. Esto no afecta la corrección de los streams.

## API simulada y contrato alternativo

Cuando `SOURCE_API_URL` no apunta a `pelispanda.org`, se usa el contrato genérico de la API simulada: `GET /movie` o `/series`, con una respuesta `{ "results": [...] }`. Cada resultado puede incluir `infoHash`, `fileIdx`, `quality`, `size`, `seeders` y `trackers`. Para torrents de series sin `fileIdx`, incluya `files` con objetos `{ "index", "name", "size" }`; el addon reconoce `S01E02`, `1x02` y `Season 1 Episode 2`, y excluye samples, trailers y archivos menores de 100 MiB.

## Pruebas

```bash
npm test
```

La caché es local al proceso y se vacía al reiniciarlo. Para varias réplicas, cada una conserva su propia caché.
