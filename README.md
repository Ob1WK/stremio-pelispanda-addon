# streaMX para Stremio

Addon de Node.js 20+ que combina los torrents de PelisPanda con los streams HTTP/HLS directos y latinos de NOVA. También publica catálogos propios de películas y series de NOVA dentro de Stremio.

streaMX descarta los reproductores web, los embeds y las fuentes de NOVA que no estén marcadas como latino. Solo muestra fuentes NOVA que Stremio pueda reproducir internamente.

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
- `NOVA_ENABLED`: use `false` para desactivar NOVA; por defecto está activo.
- `NOVA_API_URL`: URL base de NOVA. El valor predeterminado es `https://syntorq.com/api/`.
- `NOVA_MAX_RESPONSE_BYTES`: límite de las respuestas JSON de NOVA (por defecto 4 MiB).
- `CATALOG_FALLBACK_PAGES`: páginas de 100 resultados que se revisan por TMDB cuando `/search` no indexa el título original; máximo 25.
- `CACHE_TTL_SECONDS`: duración de la caché en memoria.
- `MAX_RESPONSE_BYTES`: límite de la respuesta JSON (por defecto 1 MiB).

El addon usa los endpoints públicos observados de PelisPanda: `/search`, `/movie/{slug}`, `/serie/{slug}` y sus rutas `/related`, donde la API también entrega los torrents de episodios. Primero identifica resultados mediante `tmdb_id`; si PelisPanda tiene ese ID ausente o incorrecto, permite una coincidencia exacta y normalizada con `title` u `original_title`, siempre exigiendo también el mismo tipo y año. Los magnets se interpretan como datos; nunca se evalúa JavaScript de la fuente. En producción, la fuente debe ser HTTP(S) pública. Los hosts privados se permiten solamente para `localhost`/`127.0.0.1` fuera de producción, facilitando la API simulada.

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

Abra `http://localhost:7000/manifest.json` e instale esa URL en Stremio. Además de ofrecer PelisPanda y NOVA sobre fichas IMDb normales, aparecerán los catálogos `streaMX · NOVA Películas` y `streaMX · NOVA Series`.

Para probar desde otro dispositivo de la red local, permita el puerto `7000` en el firewall y use la IP LAN de la computadora, por ejemplo `http://192.168.1.20:7000/manifest.json`. Ambos dispositivos deben estar en la misma red. Algunas versiones o plataformas de Stremio pueden exigir HTTPS para addons remotos.

## Despliegue con HTTPS

Ejecute el proceso detrás de un proxy inverso como Caddy, nginx o un proveedor con TLS administrado. Publique únicamente el puerto HTTPS, configure un certificado válido y establezca `SOURCE_API_URL` con la API real. En producción use `NODE_ENV=production`; esto bloquea fuentes que resuelvan a redes privadas, incluso después de una redirección. Instale en Stremio `https://su-dominio.example/manifest.json`.

### Vercel

El proyecto exporta una aplicación Express compatible con la detección automática de Vercel y sigue conservando `npm start` para uso local.

1. En Vercel, seleccione **Add New → Project** e importe el repositorio privado `Ob1WK/stremio-pelispanda-addon`.
2. Deje el directorio raíz en `.`. Vercel detectará la aplicación Node/Express; no configure un directorio de salida.
3. Agregue estas variables de entorno:

```dotenv
ADDON_NAME=streaMX
ADDON_ID=com.streamx.addon
SOURCE_API_URL=https://pelispanda.org/wp-json/wpreact/v1/
METADATA_API_URL=https://v3-cinemeta.strem.io/
NOVA_ENABLED=true
NOVA_API_URL=https://syntorq.com/api/
NOVA_MAX_RESPONSE_BYTES=4194304
CATALOG_FALLBACK_PAGES=10
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
