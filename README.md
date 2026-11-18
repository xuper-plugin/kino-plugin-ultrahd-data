# kino-plugin-ultrahd-data

Índices de catálogo para el [plugin Ultra Hd de Kino](https://github.com/xuper-plugin/kino-plugin-ultrahd). Un workflow diario genera, de forma respetuosa con el servicio, un índice de títulos (películas y series) y lo publica en la rama `data`; el plugin lo descarga para buscar al instante, sin recorrer cientos de categorías en vivo.

## Qué contiene el índice

Por título: nombre limpio, año y las categorías en las que aparece (más `tmdb`, reservado con 0). Nada más: ni ids de reproducción, ni servidores, ni credenciales, ni contenido para adultos (las categorías ocultas o 18+ de la tabla no se piden). Los ids reales se piden en vivo al abrir un resultado, y el id de TMDB lo resuelve el plugin solo para lo que muestra.

Formato (versión 1), en la rama `data`:

| Archivo | Contenido |
| --- | --- |
| `index.json` | `v`, `generated`, `revision`, `fullAt`, `coverage`, `hash`, `movies` y `series` (`count`, `parts`, `hashes`, `bytes`) y `deltas` |
| `movies-NN.json`, `series-NN.json` | snapshot: `{ name, year, tmdb, cats }`, listas paralelas, un título por línea en `name`; ≤ 400 KB cada trozo |
| `delta-<desde>-<hasta>.json` | `{ from, to, total, added: [{k, n, y, t, c}], removed: [ids] }`; los últimos 7 |
| `categories.json` | la tabla de categorías (`vod`, `series`, `live`) |

La `revision` es `generated` sin guiones ni dos puntos. El id de un título es estable (`m-`/`s-` más un hash del nombre normalizado y el año), no depende del orden ni del trozo.

## Cómo se genera

`scripts/gen-index.mjs` (Node ≥ 20, sin dependencias):

1. Descarga el índice anterior de la rama `data` y lo usa de base; si no puede, aborta sin publicar (no asume que estaba vacío).
2. **Refresco escalonado.** A diario solo recorre las categorías que cambian (estrenos, `CINE`/`MOVIES` del año actual y el anterior, `NEW RELEASES` y las plataformas de series con más movimiento: ≈ 10 peticiones) sobre una copia del índice anterior, y detecta altas y bajas dentro de ellas. El barrido completo de todas las categorías (≈ 155 peticiones, unos 13 minutos) se hace los domingos, pasados 7 días del anterior, o con `--full`.
3. Un título que ya estaba se copia tal cual (nombre incluido); solo se procesan los nuevos.
4. Pide el bootstrap y **elige la cuenta por sus categorías**: cada panel numera las suyas a su manera, así que solo sirve una cuenta del panel del índice anterior. Prueba las cuentas en orden (primero la del índice anterior, `src`) con una sola petición cada una y se queda con la que lleva, con el mismo id y el mismo nombre, más categorías de películas del índice (según su `categories.json`); para en la primera que las lleva todas. Una cuenta que rechaza el usuario o la contraseña se salta en el acto, y una de otro panel no se usa nunca. Recorre las categorías de una en una, con 3 a 5 s entre peticiones y reintentos con espera creciente (10, 30 y 90 s). A mitad del recorrido solo cambia a otra cuenta **del mismo panel** (en el acto si rechaza el login, o tras 4 fallos seguidos si deja de responder), y a esa cuenta solo le pide las categorías que tiene. Si no queda ninguna cuenta del panel, la corrida falla sin publicar y el índice anterior sigue publicado. El manifiesto lleva en `src` la cuenta que se usó; si no es la del índice anterior, el recorrido es completo. Una categoría que falla se conserva del índice anterior; si la cobertura baja de 90 %, no se publica; si no cambió nada, tampoco. Tampoco se publica si las películas o las series pierden más de un cuarto de sus títulos (una cuenta sin una sección entera, o un panel que contesta listas vacías, la borraría a todo el mundo): `--force` lo publica igual.
5. Publica el snapshot completo y, además, el delta contra la revisión anterior (se conservan los últimos 7, encadenados).
6. `scripts/check-index.mjs` valida formato, deltas encadenados y que no haya credenciales ni urls antes de publicar.

```bash
node scripts/test.mjs                               # pruebas con un servidor falso
node scripts/gen-index.mjs --out dist --prev prev   # genera (parcial o completo según toque)
node scripts/gen-index.mjs --out dist --prev prev --full
node scripts/gen-index.mjs --out dist --prev prev --hot   # solo las categorías calientes, aunque toque el completo (prueba barata)
node scripts/check-index.mjs dist
```

Para sincronizar las reglas con el plugin: `node scripts/sync-lib.mjs <carpeta del plugin>`.

## Workflow

`.github/workflows/index.yml` corre a diario (07:17 UTC) y a mano (`force`, `full`). No necesita secretos. Publica con un solo commit huérfano en la rama `data` (autor `xuper-plugin`), sobrescrito con `--force`.
