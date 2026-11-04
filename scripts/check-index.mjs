// Verifica un índice generado: formato, tamaños, listas paralelas alineadas, hashes y que no haya credenciales ni urls.
//   node scripts/check-index.mjs dist
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findKey, sha1, idOf, revisionOf, PART_LIMIT, MIN_COVERAGE, MAX_TITLE, FORMAT, DELTAS_KEPT } from "./gen-index.mjs";

export function checkIndex(dir) {
  const problems = [];
  const bad = (m) => problems.push(m);
  const read = (f) => readFileSync(join(dir, f), "utf8");
  let manifest;
  try { manifest = JSON.parse(read("index.json")); } catch (e) { return ["index.json ilegible: " + e.message]; }

  if (manifest.v !== FORMAT) bad(`v debe ser ${FORMAT}`);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(manifest.generated || "")) bad("generated inválido");
  if (!(manifest.coverage >= MIN_COVERAGE && manifest.coverage <= 1)) bad(`coverage fuera de [${MIN_COVERAGE}, 1]`);
  if (manifest.categories !== "categories.json") bad("categories debe ser categories.json");
  if (!/^\d{8}T\d{6}Z$/.test(manifest.revision || "") || manifest.revision !== revisionOf(manifest.generated)) bad("revision debe ser generated sin guiones ni dos puntos");
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(manifest.fullAt || "")) bad("fullAt inválido");

  const hashes = [];
  const seen = new Set();
  let total = 0;
  for (const kind of ["movies", "series"]) {
    const m = manifest[kind];
    if (!m || !Array.isArray(m.parts) || !Array.isArray(m.hashes) || !Array.isArray(m.bytes)) { bad(`${kind}: manifiesto incompleto`); continue; }
    if (m.parts.length !== m.hashes.length || m.parts.length !== m.bytes.length) bad(`${kind}: parts, hashes y bytes no coinciden`);
    let lines = 0;
    m.parts.forEach((file, i) => {
      if (!new RegExp(`^${kind}-\\d+\\.json$`).test(file)) bad(`${file}: nombre inválido`);
      let text;
      try { text = read(file); } catch (_) { bad(`${file}: falta`); return; }
      const size = Buffer.byteLength(text);
      if (size > PART_LIMIT) bad(`${file}: ${size} bytes, pasa de ${PART_LIMIT}`);
      if (size !== m.bytes[i]) bad(`${file}: bytes no coinciden con el manifiesto`);
      if (sha1(text).slice(0, 12) !== m.hashes[i]) bad(`${file}: hash no coincide`);
      hashes.push(file + sha1(text));
      let p;
      try { p = JSON.parse(text); } catch (e) { bad(`${file}: JSON inválido`); return; }
      const names = p.name === "" ? [] : String(p.name).split("\n");
      const n = names.length;
      if (p.find !== undefined) bad(`${file}: ya no lleva find (Kino normaliza el título)`);
      if (p.year.length !== n || p.tmdb.length !== n || p.cats.length !== n) { bad(`${file}: listas paralelas desalineadas (${n}/${p.year.length}/${p.tmdb.length}/${p.cats.length})`); return; }
      for (let j = 0; j < n; j++) {
        if (!names[j] || names[j].length > MAX_TITLE) { bad(`${file}[${j}]: nombre vacío o de más de ${MAX_TITLE} caracteres`); break; }
        const k = kind + ":" + findKey(names[j]) + "|" + p.year[j];
        if (seen.has(k)) { bad(`${file}[${j}]: título repetido (${names[j].slice(0, 40)})`); break; }
        seen.add(k);
        if (!Number.isInteger(p.year[j]) || p.year[j] < 0 || p.year[j] > 2100) { bad(`${file}[${j}]: año inválido`); break; }
        if (!Number.isInteger(p.tmdb[j]) || p.tmdb[j] < 0) { bad(`${file}[${j}]: tmdb inválido`); break; }
        if (!Array.isArray(p.cats[j]) || !p.cats[j].length || p.cats[j].some((c) => !Number.isInteger(c) || c <= 0)) { bad(`${file}[${j}]: categorías inválidas`); break; }
      }
      lines += n;
    });
    if (lines !== m.count) bad(`${kind}: count ${m.count} pero hay ${lines} títulos`);
    total += lines;
  }
  if (total === 0) bad("el índice no tiene títulos");

  let cats;
  try { cats = read("categories.json"); JSON.parse(cats); hashes.push(sha1(cats)); } catch (_) { bad("categories.json inválido"); }
  if (!problems.length && sha1(hashes.join("|")).slice(0, 16) !== manifest.hash) bad("hash del manifiesto no coincide");

  // ---- deltas ----
  const deltas = manifest.deltas;
  if (!Array.isArray(deltas)) bad("deltas debe ser una lista");
  else {
    if (deltas.length > DELTAS_KEPT) bad(`más de ${DELTAS_KEPT} deltas`);
    deltas.forEach((d, i) => {
      const ok = /^\d{8}T\d{6}Z$/;
      if (!d || !ok.test(d.from) || !ok.test(d.to) || d.file !== `delta-${d.from}-${d.to}.json`) { bad(`deltas[${i}]: forma inválida`); return; }
      if (i > 0 && d.from !== deltas[i - 1].to) bad(`deltas[${i}]: la cadena no es consecutiva`);
      let text;
      try { text = read(d.file); } catch (_) { bad(`${d.file}: falta`); return; }
      if (Buffer.byteLength(text) !== d.bytes) bad(`${d.file}: bytes no coinciden`);
      let p;
      try { p = JSON.parse(text); } catch (_) { bad(`${d.file}: JSON inválido`); return; }
      if (p.from !== d.from || p.to !== d.to || !Array.isArray(p.added) || !Array.isArray(p.removed) || !Number.isInteger(p.total)) { bad(`${d.file}: contenido inválido`); return; }
      if (p.added.length !== d.added || p.removed.length !== d.removed) bad(`${d.file}: conteos no coinciden`);
      for (const e of p.added) {
        if (!(e && (e.k === "m" || e.k === "s") && typeof e.n === "string" && e.n && e.n.length <= MAX_TITLE && Number.isInteger(e.y) && e.y >= 0 && Number.isInteger(e.t) && e.t >= 0 && Array.isArray(e.c) && e.c.length && e.c.every((c) => Number.isInteger(c) && c > 0))) { bad(`${d.file}: entrada inválida`); break; }
      }
      if (p.removed.some((id) => !/^[ms]-[a-z0-9]{2,26}$/.test(id))) bad(`${d.file}: id retirado inválido`);
      for (const e of p.added.slice(0, 50)) if (!/^[ms]-[a-z0-9]{2,26}$/.test(idOf(e.k === "m" ? "movies" : "series", findKey(e.n), e.y))) bad("id calculado inválido");
      if (i === deltas.length - 1) {
        if (d.to !== manifest.revision) bad("el último delta debe terminar en la revisión actual");
        if (p.total !== total) bad(`${d.file}: total ${p.total} no coincide con el índice (${total})`);
      }
    });
  }

  for (const file of readdirSync(dir)) {
    const text = read(file);
    if (/(?:user(?:name)?|pass(?:word)?)=/i.test(text)) bad(`${file}: contiene un patrón username=/password=`);
    if (/https?:\/\//i.test(text)) bad(`${file}: contiene una url`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] || "dist";
  const problems = checkIndex(dir);
  if (problems.length) { for (const p of problems.slice(0, 30)) console.error("✗", p); process.exit(1); }
  const m = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
  console.log(`✓ índice válido: ${m.movies.count} películas, ${m.series.count} series, ${m.movies.parts.length + m.series.parts.length} trozos, cobertura ${m.coverage}`);
}
