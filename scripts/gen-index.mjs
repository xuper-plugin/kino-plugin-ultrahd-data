// Genera el índice de títulos de Ultra Hd (películas y series) y lo escribe en --out.
//   node scripts/gen-index.mjs --out dist --prev prev [--full] [--force]
// Respetuoso con el servidor: una petición a la vez, 3-5 s entre categorías, backoff ante errores. No escribe ni imprime
// nunca credenciales, usuarios, hosts de servidores IPTV ni urls con ellos.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { VOD as TABLE_VOD, SERIES as TABLE_SERIES, LIVE as TABLE_LIVE } from "../lib/categoryTable.js";
import { isAdultName } from "../lib/names.js";
import { isHidden } from "../lib/categoryRules.js";

export const FORMAT = 1;
export const PART_LIMIT = 400000; // bytes por trozo sin comprimir (Kino recomienda valores de ≤ 512 KB en memoria)
export const MAX_TITLE = 300; // kino.catalog: maxTitleChars
export const MIN_COVERAGE = 0.9;
const PREV_URL = "https://raw.githubusercontent.com/xuper-plugin/kino-plugin-ultrahd-data/data/";
const BOOTSTRAP = "http://vegetatvv2.duckdns.org/bootstrap.php";
const UA = "Mozilla/5.0 (compatible; VegetaTVCache/2.0)";

// ---- nombres ---------------------------------------------------------------------

const isYear = (s) => /^(19|20)\d\d$/.test(String(s || "").trim());

// "Spider-Man: Sin camino a casa (LAT) (2021)" -> { name: "Spider-Man: Sin camino a casa", year: 2021 }
export function cleanTitle(raw, yearField) {
  let name = String(raw || "").replace(/[\r\n\t]+/g, " ");
  let year = 0;
  for (let i = 0; i < 6; i++) {
    const before = name;
    name = name.replace(/\s*\(\s*(LAT|CAST|ENG|SUB|DUAL|4K|UHD|FHD|HD)\s*\)\s*$/i, "")
      .replace(/\s*\[\s*(LAT|CAST|ENG|SUB)\s*\]\s*$/i, "");
    const y = name.match(/\s*\(\s*((?:19|20)\d\d)\s*\)\s*$/);
    if (y) { if (!year) year = Number(y[1]); name = name.slice(0, y.index); }
    if (name === before) break;
  }
  if (isYear(yearField)) year = Number(String(yearField).trim());
  name = name.replace(/\s+/g, " ").trim();
  if (name.length > MAX_TITLE) name = name.slice(0, MAX_TITLE).replace(/[\uD800-\uDBFF]$/, "").trim();
  return { name, year };
}

// minúsculas, sin acentos ni signos: la forma en que se busca ("Spider-Man: Acción" -> "spider man accion").
export function findKey(text) {
  return String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export const keyOf = (find, year) => `${find}|${year || 0}`;

// ---- servidores ------------------------------------------------------------------

export function parseServerLine(line) {
  const url = String(line).split(/\s/)[0].trim();
  if (!/^https?:\/\//.test(url)) return null;
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    if (!path.endsWith("player_api.php") && !path.endsWith("get.php")) return null;
    const username = u.searchParams.get("username") || u.searchParams.get("user") || "";
    const password = u.searchParams.get("password") || u.searchParams.get("pass") || "";
    if (!username) return null;
    return { base: `${u.protocol}//${u.host}`, username, password };
  } catch (_) { return null; }
}

export function parseServers(text) {
  const seen = new Set();
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const s = parseServerLine(t);
    if (!s) continue;
    const k = s.base + "|" + s.username;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out.sort((a, b) => (b.base.startsWith("https://") ? 1 : 0) - (a.base.startsWith("https://") ? 1 : 0));
}

const vegetaHeaders = (code) => ({
  "X-Vegeta-Version-Code": String(code), "X-Vegeta-Servers-Direct": "1",
  "Cache-Control": "no-cache, no-store", Pragma: "no-cache", "User-Agent": UA,
});

// ---- utilidades ------------------------------------------------------------------

export const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha1 = (text) => createHash("sha1").update(text).digest("hex");

function makeLog(verbose = true) {
  return (...a) => { if (verbose) console.error(new Date().toISOString().slice(11, 19), ...a); };
}

async function getText(fetchFn, url, { headers = {}, timeoutMs = 90000 } = {}) {
  const r = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text, headers: r.headers };
}

// ---- el índice anterior ----------------------------------------------------------

export const revisionOf = (iso) => String(iso || "").replace(/[-:]/g, "");

function h32(s, seed) {
  let h = seed;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// Id estable de un título: no depende del orden ni del trozo, solo de tipo + nombre normalizado + año. Idéntico al del plugin.
export function idOf(kind, find, year) {
  const k = `${find}|${year || 0}`;
  return (kind === "movies" ? "m-" : "s-") + h32(k, 2166136261).toString(36) + h32(k, 0x9747b28c).toString(36);
}

const emptyPrev = (status) => ({ status, manifest: null, entries: new Map(), files: new Map() });

// { status: "ok" | "none" | "error", manifest, entries: Map(kind:key -> entry), miss, files: Map(nombre -> texto) }
export async function loadPrevious({ prevDir, prevUrl = PREV_URL, fetchFn = fetch, sleep = sleepMs, log = () => {} }) {
  const files = new Map();
  const read = async (name) => {
    if (prevDir && existsSync(join(prevDir, "index.json"))) {
      return existsSync(join(prevDir, name)) ? { ok: true, text: readFileSync(join(prevDir, name), "utf8") } : { ok: false, status: 404 };
    }
    if (prevDir && existsSync(prevDir) && !prevUrl) return { ok: false, status: 404 };
    let last = null;
    for (let i = 0; i < 4; i++) {
      try {
        const r = await getText(fetchFn, prevUrl + name + "?v=" + Date.now(), { timeoutMs: 60000 });
        if (r.ok) return { ok: true, text: r.text };
        if (r.status === 404) return { ok: false, status: 404 };
        last = r.status;
      } catch (e) { last = "red"; }
      await sleep(5000 * (i + 1));
    }
    return { ok: false, status: last };
  };
  const m = await read("index.json");
  if (!m.ok) return emptyPrev(m.status === 404 ? "none" : "error");
  let manifest;
  try { manifest = JSON.parse(m.text); } catch (_) { return emptyPrev("error"); }
  files.set("index.json", m.text);
  const entries = new Map();
  for (const kind of ["movies", "series"]) {
    for (const part of (manifest[kind] && manifest[kind].parts) || []) {
      const r = await read(part);
      if (!r.ok) return emptyPrev("error");
      files.set(part, r.text);
      const p = JSON.parse(r.text);
      const names = p.name === "" ? [] : p.name.split("\n");
      names.forEach((name, i) => {
        const year = p.year[i] || 0;
        const find = findKey(name);
        entries.set(kind + ":" + keyOf(find, year), { kind, name, find, year, tmdb: p.tmdb[i] || 0, cats: new Set(p.cats[i] || []) });
      });
    }
  }
  const cats = await read("categories.json");
  if (cats.ok) files.set("categories.json", cats.text);
  for (const d of manifest.deltas || []) {
    const r = await read(d.file);
    if (!r.ok) { manifest.deltas = []; break; } // cadena rota: sin deltas, el plugin usará el snapshot
    files.set(d.file, r.text);
  }
  log(`índice anterior: ${entries.size} títulos, revisión ${manifest.revision || "(sin revisión)"}, ${(manifest.deltas || []).length} deltas`);
  return { status: "ok", manifest, entries, files };
}

// ---- bootstrap y API del servicio -----------------------------------------------

export async function getServerList({ bootstrapUrl = BOOTSTRAP, fetchFn = fetch, log = () => {} }) {
  let code = 21;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await getText(fetchFn, `${bootstrapUrl}?v=${Date.now()}`, { headers: { ...vegetaHeaders(code), Accept: "application/json" }, timeoutMs: 30000 });
    let data = null;
    try { data = JSON.parse(r.text); } catch (_) { data = null; }
    if (!r.ok || !data || data.ok === false) {
      const want = data ? Math.max(Number(data.minimum_version_code) || 0, Number(data.latest_version_code) || 0) : 0;
      if (attempt === 0 && want > code) { code = want; continue; }
      throw new Error("bootstrap " + r.status);
    }
    let list = [];
    if (typeof data.servers_text === "string" && data.servers_text.trim()) list = parseServers(data.servers_text);
    if (!list.length && typeof data.servers_url === "string" && data.servers_url.trim()) {
      const r2 = await getText(fetchFn, data.servers_url, { headers: { ...vegetaHeaders(code), Accept: "text/plain" }, timeoutMs: 30000 });
      if (r2.ok) list = parseServers(r2.text);
    }
    if (!list.length) {
      const want = Math.max(Number(data.minimum_version_code) || 0, Number(data.latest_version_code) || 0);
      if (attempt === 0 && want > code) { code = want; continue; }
      throw new Error("bootstrap sin servidores");
    }
    log(`bootstrap ok (código ${code}), ${list.length} servidores`);
    return list;
  }
  throw new Error("bootstrap sin servidores");
}

// Una conexión "amable": una petición a la vez, pausa entre categorías, backoff y cambio de servidor tras fallos seguidos.
export function makeClient({ servers, fetchFn = fetch, sleep = sleepMs, minDelay = 3000, maxDelay = 5000, maxServers = 12, log = () => {}, rand = Math.random }) {
  const list = servers.slice(0, maxServers);
  let idx = 0;
  let consecutive = 0;
  let calls = 0;
  const BACKOFF = [10000, 30000, 90000];
  const FAILS_TO_SWITCH = 4;

  async function once(action, extra) {
    const s = list[idx];
    const q = new URLSearchParams({ username: s.username, password: s.password, action, ...extra });
    const r = await getText(fetchFn, `${s.base}/player_api.php?${q}`, { headers: { Accept: "application/json,text/plain,*/*", "User-Agent": UA, "Cache-Control": "no-cache" }, timeoutMs: 120000 });
    if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
    const data = JSON.parse(r.text);
    if (data === null || typeof data !== "object") throw new Error("respuesta inválida");
    if (!Array.isArray(data) && data.user_info && String(data.user_info.auth) === "0") throw new Error("cuenta no válida");
    return data;
  }

  async function call(action, extra = {}) {
    let lastErr = "";
    let switched = false;
    for (let tries = 0; tries < 8; tries++) {
      try {
        const data = await once(action, extra);
        consecutive = 0;
        calls++;
        return data;
      } catch (e) {
        lastErr = String((e && e.message) || e).slice(0, 60);
        consecutive++;
        if (consecutive >= FAILS_TO_SWITCH && list.length > 1) {
          idx = (idx + 1) % list.length;
          consecutive = 0;
          switched = true;
          log(`cambiando al servidor ${idx + 1} de ${list.length}`);
          continue;
        }
        if (tries >= BACKOFF.length && !switched) break;
        await sleep(BACKOFF[Math.min(Math.max(consecutive, 1) - 1, BACKOFF.length - 1)] * (e && e.status === 429 ? 2 : 1));
      }
    }
    throw new Error(`${action} falló: ${lastErr}`);
  }

  async function pause() { await sleep(minDelay + rand() * Math.max(0, maxDelay - minDelay)); }
  return { call, pause, get calls() { return calls; }, get server() { return idx + 1; } };
}

// ---- categorías -----------------------------------------------------------------

// Categorías visibles (ni ocultas ni adultas), según la tabla curada y, si la categoría no está, las reglas automáticas.
export function visibleCategories(kind, list) {
  const table = kind === "vod" ? TABLE_VOD : TABLE_SERIES;
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    const id = String(c.category_id || "");
    const name = String(c.category_name || "").trim();
    if (!/^\d+$/.test(id) || !name) continue;
    const e = table[id];
    const flags = e ? e[4] : "";
    const hide = e ? flags.includes("h") : isHidden(name);
    const adult = e ? flags.includes("a") : isAdultName(name);
    if (hide || adult) continue;
    out.push({ id: Number(id), name });
  }
  return out;
}

// ---- recolección ----------------------------------------------------------------

// Categorías "calientes": las que cambian a diario. El resto se barre una vez por semana.
export const SERIES_HOT = ["netflix", "disney", "hbo", "max", "amazon", "apple tv", "paramount"];
const normCat = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function isHotCategory(kind, name, year = new Date().getUTCFullYear()) {
  const t = normCat(name);
  if (kind === "vod") {
    if (/\b(estrenos?|new releases?)\b/.test(t)) return true;
    const m = t.match(/\b(?:cine|movies?|peliculas?) ((?:19|20)\d\d)\b/);
    return !!m && (Number(m[1]) === year || Number(m[1]) === year - 1);
  }
  return SERIES_HOT.some((w) => ` ${t} `.includes(` ${w} `));
}

const cloneEntry = (e) => ({ ...e, cats: new Set(e.cats) });

// Añade los items de una categoría. Un título que ya estaba en el índice anterior se copia tal cual (nombre, TMDB); solo
// los nuevos se procesan de cero. Devuelve las claves vistas en esta categoría.
function addItems(entries, prev, kind, items, catId, isNew) {
  const seenHere = new Set();
  for (const x of items) {
    const raw = x.name || x.title;
    if (!raw) continue;
    const yearField = x.year || (x.release_date || x.releaseDate ? String(x.release_date || x.releaseDate).slice(0, 4) : "");
    const { name, year } = cleanTitle(raw, yearField);
    const find = findKey(name);
    if (!find) continue;
    const k = kind + ":" + keyOf(find, year);
    seenHere.add(k);
    let e = entries.get(k);
    if (!e) {
      const p = prev.entries.get(k);
      if (p) e = { ...p, cats: new Set() };
      else { e = { kind, name, find, year, tmdb: 0, cats: new Set() }; isNew.add(k); }
      entries.set(k, e);
    }
    e.cats.add(catId);
  }
  return seenHere;
}

// mode "full": recorre todas las categorías visibles. mode "partial": solo las calientes, sobre una copia del índice anterior
// (detecta altas y bajas dentro de ellas). Devuelve { entries, ok, failed, total, isNew, mode }.
export async function collect({ client, prev, log, deadline, now = Date.now, mode = "full", year = new Date(now()).getUTCFullYear() }) {
  const partial = mode === "partial";
  const entries = new Map();
  if (partial) for (const [k, e] of prev.entries) entries.set(k, cloneEntry(e));
  const isNew = new Set();
  const status = { ok: 0, failed: [], total: 0, skipped: 0 };
  const failedByKind = { movies: new Set(), series: new Set() };
  for (const [kind, label, listAction, itemsAction] of [["movies", "vod", "get_vod_categories", "get_vod_streams"], ["series", "series", "get_series_categories", "get_series"]]) {
    let cats = visibleCategories(label, await client.call(listAction));
    const visible = cats.length;
    if (partial) cats = cats.filter((c) => isHotCategory(label, c.name, year));
    status.total += cats.length;
    log(`${label}: ${cats.length} categorías${partial ? ` calientes de ${visible}` : " visibles"}`);
    for (let i = 0; i < cats.length; i++) {
      if (now() > deadline) { for (const c of cats.slice(i)) { status.failed.push(`${label}:${c.id}`); failedByKind[kind].add(c.id); } status.skipped = cats.length - i; log("tiempo agotado: el resto se conserva del índice anterior"); break; }
      try {
        const items = await client.call(itemsAction, { category_id: String(cats[i].id) });
        if (!Array.isArray(items)) throw new Error("no es lista");
        const seenHere = addItems(entries, prev, kind, items, cats[i].id, isNew);
        if (partial) {
          // Lo que estaba en esta categoría y hoy ya no: se le quita la categoría; sin categorías, el título desaparece.
          for (const [k, e] of entries) {
            if (e.kind !== kind || !e.cats.has(cats[i].id) || seenHere.has(k)) continue;
            e.cats.delete(cats[i].id);
            if (!e.cats.size) entries.delete(k);
          }
        }
        status.ok++;
        log(`${label} ${i + 1}/${cats.length}: ${items.length} títulos`);
      } catch (e) {
        status.failed.push(`${label}:${cats[i].id}`);
        failedByKind[kind].add(cats[i].id);
        log(`${label} ${i + 1}/${cats.length}: falló (${e.message})`);
      }
      await client.pause();
    }
  }
  // Barrido completo: lo que no se pudo leer hoy se conserva de ayer (solo sus pertenencias a esas categorías).
  let kept = 0;
  if (!partial) {
    for (const [k, p] of prev.entries) {
      const lost = [...p.cats].filter((c) => failedByKind[p.kind].has(c));
      if (!lost.length) continue;
      let e = entries.get(k);
      if (!e) { e = { ...p, cats: new Set() }; entries.set(k, e); kept++; }
      for (const c of lost) e.cats.add(c);
    }
  }
  if (kept) log(`conservados del índice anterior: ${kept} títulos de categorías que fallaron`);
  return { entries, ...status, isNew, mode };
}

// ---- trozos, deltas y manifiesto --------------------------------------------------

const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };

function partJson(list) {
  return JSON.stringify({
    name: list.map((e) => e.name).join("\n"),
    year: list.map((e) => e.year), tmdb: list.map((e) => e.tmdb), cats: list.map((e) => [...e.cats].sort((a, b) => a - b)),
  });
}

// Reparte por hash de la clave (un título nuevo solo cambia un trozo) en 2^n trozos de ≤ PART_LIMIT bytes.
export function buildParts(kind, entries, limit = PART_LIMIT) {
  const list = [...entries.values()].filter((e) => e.kind === kind).sort((a, b) => (a.find < b.find ? -1 : a.find > b.find ? 1 : a.year - b.year));
  for (let n = 1; n <= 256; n *= 2) {
    const buckets = Array.from({ length: n }, () => []);
    for (const e of list) buckets[fnv(keyOf(e.find, e.year)) % n].push(e);
    const texts = buckets.map(partJson);
    if (texts.every((t) => Buffer.byteLength(t) <= limit) || n === 256) {
      const width = Math.max(2, String(n - 1).length);
      return { count: list.length, files: texts.map((t, i) => [`${kind}-${String(i).padStart(width, "0")}.json`, t, buckets[i].length]) };
    }
  }
  throw new Error("no se pudo repartir");
}

export const DELTAS_KEPT = 7;
const sameCats = (a, b) => a.size === b.size && [...a].every((c) => b.has(c));
const wire = (e) => ({ k: e.kind === "movies" ? "m" : "s", n: e.name, y: e.year, t: e.tmdb, c: [...e.cats].sort((a, b) => a - b) });

// Qué cambió entre dos índices: títulos nuevos o modificados (nombre, TMDB, categorías) y los ids de los que desaparecieron.
export function computeDelta(prevEntries, entries, from, to) {
  const added = [];
  const removed = [];
  for (const [k, e] of entries) {
    const p = prevEntries.get(k);
    if (!p || p.tmdb !== e.tmdb || p.name !== e.name || !sameCats(p.cats, e.cats)) added.push(wire(e));
  }
  for (const [k, p] of prevEntries) if (!entries.has(k)) removed.push(idOf(p.kind, p.find, p.year));
  return { from, to, total: entries.size, added, removed };
}

// Una revisión completa (puro, sin disco): snapshot por trozos + delta contra la anterior + deltas conservados.
// { changed, files, manifest }: si el contenido no cambió, el manifiesto es el anterior (misma revisión).
export function buildRevision({ entries, prev, coverage, generated, fullAt, categoriesJson }) {
  const revision = revisionOf(generated);
  const files = new Map();
  const manifest = { v: FORMAT, generated, revision, fullAt, coverage: Math.round(coverage * 1000) / 1000, categories: "categories.json" };
  const hashes = [];
  for (const kind of ["movies", "series"]) {
    const { count, files: parts } = buildParts(kind, entries);
    manifest[kind] = { count, parts: [], hashes: [], bytes: [] };
    for (const [name, text] of parts) {
      files.set(name, text);
      manifest[kind].parts.push(name);
      manifest[kind].hashes.push(sha1(text).slice(0, 12));
      manifest[kind].bytes.push(Buffer.byteLength(text));
      hashes.push(name + sha1(text));
    }
  }
  files.set("categories.json", categoriesJson);
  hashes.push(sha1(categoriesJson));
  manifest.hash = sha1(hashes.join("|")).slice(0, 16);

  const pm = prev && prev.manifest;
  if (pm && pm.hash === manifest.hash) return { changed: false, files: new Map(prev.files), manifest: pm };

  manifest.deltas = [];
  if (pm && pm.revision && prev.entries.size) {
    const delta = computeDelta(prev.entries, entries, pm.revision, revision);
    const name = `delta-${pm.revision}-${revision}.json`;
    const text = JSON.stringify(delta);
    const chain = (pm.deltas || []).filter((d, i, a) => (i === 0 || d.from === a[i - 1].to) && prev.files.has(d.file));
    const lastOk = chain.length && chain[chain.length - 1].to === pm.revision;
    const keep = (lastOk ? chain : []).slice(-(DELTAS_KEPT - 1));
    for (const d of keep) files.set(d.file, prev.files.get(d.file));
    manifest.deltas = [...keep, { from: pm.revision, to: revision, file: name, added: delta.added.length, removed: delta.removed.length, bytes: Buffer.byteLength(text) }];
    files.set(name, text);
  }
  files.set("index.json", JSON.stringify(manifest));
  return { changed: true, files, manifest };
}

export function categoriesJson() {
  return JSON.stringify({ v: FORMAT, vod: TABLE_VOD, series: TABLE_SERIES, live: TABLE_LIVE });
}

// ---- ejecución completa ---------------------------------------------------------

// ¿Toca barrido completo? Sin índice anterior (o sin revisión), pasados 7 días del último, los domingos, o si se pide.
export function fullSweepDue(prevManifest, nowMs, full = false) {
  if (full || !prevManifest || !prevManifest.revision || !prevManifest.fullAt) return true;
  const age = nowMs - Date.parse(prevManifest.fullAt);
  if (!(age >= 0) || age > 7 * 86400000) return true;
  return new Date(nowMs).getUTCDay() === 0 && age > 20 * 3600 * 1000;
}

export async function run(opts) {
  const {
    out = "dist", prevDir = "prev", prevUrl = PREV_URL, iptvMinutes = 150, force = false, full = false,
    fetchFn = fetch, sleep = sleepMs, bootstrapUrl = BOOTSTRAP, minDelay, maxDelay, verbose = true, now = Date.now,
  } = opts;
  const log = makeLog(verbose);
  const t0 = now();
  const prev = await loadPrevious({ prevDir, prevUrl, fetchFn, sleep, log });
  if (prev.status === "error") {
    log("no se pudo descargar el índice anterior: no se asume vacío; se aborta sin publicar");
    return { published: false, reason: "prev-error" };
  }
  const mode = fullSweepDue(prev.manifest, t0, full) ? "full" : "partial";
  log(`modo: ${mode === "full" ? "barrido completo" : "refresco de categorías calientes"}`);
  const servers = await getServerList({ bootstrapUrl, fetchFn, log });
  const client = makeClient({ servers, fetchFn, sleep, minDelay, maxDelay, log });
  const col = await collect({ client, prev, log, deadline: t0 + iptvMinutes * 60000, now, mode });
  const swept = col.total ? col.ok / col.total : 0;
  log(`categorías leídas ${col.ok}/${col.total} (${(swept * 100).toFixed(1)}%), ${col.entries.size} títulos (${col.isNew.size} nuevos), ${client.calls} peticiones al servicio`);
  if (swept < MIN_COVERAGE) { log(`cobertura < ${MIN_COVERAGE}: no se publica`); return { published: false, reason: "coverage", coverage: swept }; }
  // La cobertura publicada es la del último barrido completo: un refresco parcial no la mejora ni la empeora.
  const coverage = mode === "full" ? swept : Number(prev.manifest.coverage) || swept;
  const fullAt = mode === "full" ? new Date(t0).toISOString().replace(/\.\d+Z$/, "Z") : prev.manifest.fullAt;

  const generated = new Date(now()).toISOString().replace(/\.\d+Z$/, "Z");
  const o = buildRevision({ entries: col.entries, prev, coverage, generated, fullAt, categoriesJson: categoriesJson() });
  if (!o.changed && !force) { log("sin cambios respecto al índice anterior: no se publica"); return { published: false, reason: "unchanged", manifest: o.manifest }; }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const [name, text] of o.files) writeFileSync(join(out, name), text);
  const bytes = [...o.files.values()].reduce((n, t) => n + Buffer.byteLength(t), 0);
  const last = (o.manifest.deltas || []).slice(-1)[0];
  log(`escrito ${o.files.size} archivos (${(bytes / 1048576).toFixed(2)} MB) en ${out}; revisión ${o.manifest.revision}${o.changed && last ? `, delta +${last.added} -${last.removed}` : o.changed ? "" : " (sin cambios de contenido)"}; ${((now() - t0) / 60000).toFixed(1)} min`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "changed=true\n");
  return { published: true, changed: o.changed, mode, manifest: o.manifest, coverage, entries: col.entries.size, isNew: col.isNew.size, requests: client.calls };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") o.out = argv[++i];
    else if (a === "--prev") o.prevDir = argv[++i];
    else if (a === "--iptv-minutes") o.iptvMinutes = Number(argv[++i]);
    else if (a === "--min-delay") o.minDelay = Number(argv[++i]);
    else if (a === "--max-delay") o.maxDelay = Number(argv[++i]);
    else if (a === "--force") o.force = true;
    else if (a === "--full") o.full = true;
  }
  return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const res = await run(parseArgs(process.argv.slice(2)));
  if (!res.published && res.reason !== "unchanged") { console.error("no publicado:", res.reason); process.exitCode = res.reason === "prev-error" ? 2 : 3; }
  else if (!res.published && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "changed=false\n");
}
