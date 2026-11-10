# Índices de catálogo (rama `data`)

Archivos que genera el workflow diario y lee el plugin Ultra Hd de Kino. Esta rama es un solo commit que se sobrescribe cada día.

- `index.json`: manifiesto (formato, fecha, `revision`, cobertura, trozos con su hash y los deltas disponibles).
- `movies-NN.json`, `series-NN.json`: el snapshot completo, repartido por hash, en listas paralelas (`name`, `year`, `tmdb`, `cats`).
- `delta-<desde>-<hasta>.json`: los cambios de una revisión a la siguiente (altas o modificados y los ids retirados). Se conservan los últimos 7.
- `categories.json`: la tabla de categorías curada.

Sin ids de reproducción, servidores, credenciales ni contenido para adultos. `tmdb` va reservado con 0: el plugin lo resuelve al vuelo.
