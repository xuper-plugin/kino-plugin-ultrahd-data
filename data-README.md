# Índices de catálogo (rama `data`)

Archivos que genera el workflow diario y lee el plugin Ultra Hd de Kino. Esta rama es un solo commit que se sobrescribe cada día.

- `index.json`: manifiesto (versión de formato, fecha, cobertura, trozos y sus hashes).
- `movies-NN.json`, `series-NN.json`: títulos repartidos por hash, en listas paralelas (`name`, `find`, `year`, `tmdb`, `cats`).
- `categories.json`: la tabla de categorías curada.
- `tmdb-cache.json`: caché interna de títulos sin coincidencia en TMDB (el plugin no la descarga).

Sin ids de reproducción, servidores, credenciales ni contenido para adultos.
