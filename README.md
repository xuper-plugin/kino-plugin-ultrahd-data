# kino-plugin-ultrahd-data

Índices de catálogo para el [plugin Ultra Hd de Kino](https://github.com/xuper-plugin/kino-plugin-ultrahd). Un workflow diario genera, de forma respetuosa con el servicio, un índice de títulos (películas y series) y lo publica en la rama `data`; el plugin lo descarga para buscar al instante, sin recorrer cientos de categorías en vivo.

## Qué contiene el índice

Por título: nombre limpio, forma normalizada para buscar (`find`: minúsculas, sin acentos ni signos), año, id de TMDB (si hay coincidencia segura) y las categorías en las que aparece. Nada más: ni ids de reproducción, ni servidores, ni credenciales, ni contenido para adultos (las categorías ocultas o 18+ de la tabla no se piden). Los ids reales se piden en vivo al abrir un resultado.

Formato (versión 1), en la rama `data`:

| Archivo | Contenido |
| --- | --- |
| `index.json` | `v`, `generated`, `coverage`, `hash`, `movies` y `series` con `count`, `parts`, `hashes` y `bytes` |
| `movies-NN.json`, `series-NN.json` | `{ name, find, year, tmdb, cats }`: listas paralelas, un título por línea en `name` y `find`; ≤ 190 KB cada trozo |
| `categories.json` | la tabla de categorías (`vod`, `series`, `live`) |
| `tmdb-cache.json` | títulos sin coincidencia y el día del último intento (uso interno) |

## Cómo se genera

`scripts/gen-index.mjs` (Node ≥ 20, sin dependencias):

1. Descarga el índice anterior de la rama `data` y lo usa de caché; si no puede, aborta sin publicar (no asume que estaba vacío).
2. Pide el bootstrap, elige un servidor y recorre las categorías visibles, una petición a la vez, con 3 a 5 s entre categorías, reintentos con espera creciente (10, 30 y 90 s) y cambio de servidor tras fallos seguidos.
3. Una categoría que falla se conserva del índice anterior. Si la cobertura baja de 90 %, no se publica. Si no cambió nada, tampoco.
4. Con `TMDB_API_KEY`, busca el id de TMDB solo de los títulos nuevos (≈ 4 peticiones por segundo). Los que no coinciden no se reintentan hasta pasados 14 días y, como mucho, 500 por corrida.
5. `scripts/check-index.mjs` valida el formato y que no haya credenciales ni urls antes de publicar.

```bash
node scripts/test.mjs                               # pruebas con servidores falsos
node scripts/gen-index.mjs --out dist --prev prev   # genera (tarda unos 15 minutos sin TMDB)
node scripts/check-index.mjs dist
```

Para sincronizar las reglas con el plugin: `node scripts/sync-lib.mjs <carpeta del plugin>`.

## Workflow

`.github/workflows/index.yml` corre a diario (07:17 UTC) y a mano. Secreto opcional: `TMDB_API_KEY`. Publica con un solo commit huérfano en la rama `data` (autor `xuper-plugin`), sobrescrito con `--force`.
