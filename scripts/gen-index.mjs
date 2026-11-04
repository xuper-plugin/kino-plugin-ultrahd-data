// Genera el índice de títulos de Ultra Hd (películas y series) y lo escribe en --out.
//   node scripts/gen-index.mjs --out dist --prev prev [--hours 4.5] [--force]
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
export const PART_LIMIT = 190000; // bytes por trozo sin comprimir: cabe en los 256 KB que escribe un job de Kino por ejecución
export const MIN_COVERAGE = 0.9;
export const MISS_RETRY_DAYS = 14;
export const MISS_RETRY_CAP = 500;
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
export const dayNumber = (ms = Date.now()) => Math.floor(ms / 86400000);

function makeLog(verbose = true) {
  return (...a) => { if (verbose) console.error(new Date().toISOString().slice(11, 19), ...a); };
}

async function getText(fetchFn, url, { headers = {}, timeoutMs = 90000 } = {}) {
  const r = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text, headers: r.headers };
}

// ---- el índice anterior ----------------------------------------------------------

// { status: "ok" | "none" | "error", manifest, entries: Map(key -> entry), miss }
export async function loadPrevious({ prevDir, prevUrl = PREV_URL, fetchFn = fetch, sleep = sleepMs, log = () => {} }) {
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
  if (!m.ok) return { status: m.status === 404 ? "none" : "error", manifest: null, entries: new Map(), miss: {} };
  let manifest;
  try { manifest = JSON.parse(m.text); } catch (_) { return { status: "error", manifest: null, entries: new Map(), miss: {} }; }
  const entries = new Map();
  for (const kind of ["movies", "series"]) {
    for (const part of (manifest[kind] && manifest[kind].parts) || []) {
      const r = await read(part);
      if (!r.ok) return { status: "error", manifest: null, entries: new Map(), miss: {} };
      const p = JSON.parse(r.text);
      const names = p.name === "" ? [] : p.name.split("\n");
      const finds = p.find === "" ? [] : p.find.split("\n");
      names.forEach((name, i) => {
        const year = p.year[i] || 0;
        entries.set(kind + ":" + keyOf(finds[i], year), { kind, name, find: finds[i], year, tmdb: p.tmdb[i] || 0, cats: new Set(p.cats[i] || []) });
      });
    }
  }
  let miss = {};
  const mc = await read("tmdb-cache.json");
  if (mc.ok) { try { miss = JSON.parse(mc.text).miss || {}; } catch (_) { miss = {}; } }
  log(`índice anterior: ${entries.size} títulos`);
  return { status: "ok", manifest, entries, miss };
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

function addItems(entries, kind, items, catId) {
  for (const x of items) {
    const raw = x.name || x.title;
    if (!raw) continue;
    const yearField = x.year || (x.release_date || x.releaseDate ? String(x.release_date || x.releaseDate).slice(0, 4) : "");
    const { name, year } = cleanTitle(raw, yearField);
    const find = findKey(name);
    if (!find) continue;
    const k = kind + ":" + keyOf(find, year);
    const e = entries.get(k);
    if (e) e.cats.add(catId);
    else entries.set(k, { kind, name, find, year, tmdb: 0, cats: new Set([catId]) });
  }
}

// Recorre las categorías de películas y series. Devuelve { entries, ok, failed, total }.
export async function collect({ client, prev, log, deadline, now = Date.now }) {
  const entries = new Map();
  const status = { ok: 0, failed: [], total: 0, skipped: 0 };
  const failedByKind = { movies: new Set(), series: new Set() };
  for (const [kind, label, listAction, itemsAction] of [["movies", "vod", "get_vod_categories", "get_vod_streams"], ["series", "series", "get_series_categories", "get_series"]]) {
    const cats = visibleCategories(label, await client.call(listAction));
    status.total += cats.length;
    log(`${label}: ${cats.length} categorías visibles`);
    for (let i = 0; i < cats.length; i++) {
      if (now() > deadline) { for (const c of cats.slice(i)) { status.failed.push(`${label}:${c.id}`); failedByKind[kind].add(c.id); } status.skipped = cats.length - i; log("tiempo agotado: el resto se conserva del índice anterior"); break; }
      try {
        const items = await client.call(itemsAction, { category_id: String(cats[i].id) });
        if (!Array.isArray(items)) throw new Error("no es lista");
        addItems(entries, kind, items, cats[i].id);
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
  // Lo que no se pudo leer hoy se conserva de ayer: solo las pertenencias a esas categorías.
  let kept = 0;
  for (const [k, p] of prev.entries) {
    const lost = [...p.cats].filter((c) => failedByKind[p.kind].has(c));
    if (!lost.length) continue;
    let e = entries.get(k);
    if (!e) { e = { kind: p.kind, name: p.name, find: p.find, year: p.year, tmdb: p.tmdb, cats: new Set() }; entries.set(k, e); kept++; }
    for (const c of lost) e.cats.add(c);
  }
  if (kept) log(`conservados del índice anterior: ${kept} títulos de categorías que fallaron`);
  return { entries, ...status };
}

// ---- TMDB -----------------------------------------------------------------------

function yearOfResult(r, kind) {
  const d = kind === "movies" ? r.release_date : r.first_air_date;
  return /^\d{4}/.test(d || "") ? Number(d.slice(0, 4)) : 0;
}

// Coincidencia segura: título (o título original) igual y año ±1, o un único resultado compatible con el año.
export function pickTmdb(results, entry) {
  const list = Array.isArray(results) ? results : [];
  const okYear = (r) => !entry.year || !yearOfResult(r, entry.kind) || Math.abs(yearOfResult(r, entry.kind) - entry.year) <= 1;
  const same = list.filter((r) => [r.title, r.name, r.original_title, r.original_name].some((t) => t && findKey(t) === entry.find) && okYear(r));
  if (same.length) return same[0].id;
  if (list.length === 1 && okYear(list[0]) && entry.year) return list[0].id;
  return 0;
}

export async function tmdbPhase({ entries, prev, apiKey, base = "https://api.themoviedb.org/3", fetchFn = fetch, sleep = sleepMs, rps = 4, deadline, now = Date.now, today = dayNumber(), log }) {
  const stats = { cached: 0, queried: 0, retried: 0, found: 0, missed: 0, skippedFresh: 0, deferred: 0 };
  const miss = {};
  // Los ids ya conocidos salen del índice anterior; los sin coincidencia recientes no se vuelven a buscar.
  const queue = [];
  const retries = [];
  for (const [k, e] of entries) {
    const p = prev.entries.get(k);
    if (p && p.tmdb > 0) { e.tmdb = p.tmdb; stats.cached++; continue; }
    const mk = k;
    const tried = prev.miss[mk];
    if (tried !== undefined) {
      if (today - tried < MISS_RETRY_DAYS) { miss[mk] = tried; stats.skippedFresh++; continue; }
      retries.push([k, e]);
    } else queue.push([k, e]);
  }
  const work = [...queue, ...retries.slice(0, MISS_RETRY_CAP)];
  for (const [k] of retries.slice(MISS_RETRY_CAP)) { miss[k] = prev.miss[k]; stats.deferred++; }
  log(`TMDB: ${stats.cached} ids de caché, ${queue.length} claves nuevas, ${Math.min(retries.length, MISS_RETRY_CAP)} reintentos (≥${MISS_RETRY_DAYS} días), ${stats.skippedFresh} sin coincidencia reciente`);
  if (!apiKey) { log("TMDB: sin clave, no se consulta"); stats.deferred += work.length; return { stats, miss: { ...prev.miss, ...miss } }; }

  const bearer = apiKey.length > 40;
  let netFails = 0;
  for (let i = 0; i < work.length; i++) {
    const [k, e] = work[i];
    if (now() > deadline) { stats.deferred += work.length - i; log("TMDB: tiempo agotado, el resto queda para la próxima corrida"); break; }
    const mk = k;
    const q = new URLSearchParams({ query: e.name, language: "es-MX", include_adult: "false" });
    if (e.year) q.set(e.kind === "movies" ? "year" : "first_air_date_year", String(e.year));
    if (!bearer) q.set("api_key", apiKey);
    let done = false;
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      try {
        const r = await fetchFn(`${base}/search/${e.kind === "movies" ? "movie" : "tv"}?${q}`, { headers: bearer ? { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } : { Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
        if (r.status === 429) { await sleep(Math.min(60, Number(r.headers.get("retry-after")) || 5) * 1000); continue; }
        if (!r.ok) throw new Error("HTTP " + r.status);
        const data = await r.json();
        const id = pickTmdb(data.results, e);
        netFails = 0;
        done = true;
        if (id) { e.tmdb = id; stats.found++; } else { miss[mk] = today; stats.missed++; }
        if (prev.miss[mk] !== undefined) stats.retried++; else stats.queried++;
      } catch (err) { netFails++; await sleep(2000 * (attempt + 1)); }
    }
    if (!done && netFails >= 8) { stats.deferred += work.length - i; log("TMDB: demasiados fallos seguidos, se detiene"); break; }
    await sleep(1000 / rps);
  }
  return { stats, miss };
}

// ---- trozos y manifiesto --------------------------------------------------------

const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };

function partJson(list) {
  return JSON.stringify({
    name: list.map((e) => e.name).join("\n"), find: list.map((e) => e.find).join("\n"),
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

export function buildOutput({ entries, miss, coverage, generated, categoriesJson, prevHash }) {
  const files = new Map();
  const manifest = { v: FORMAT, generated, coverage: Math.round(coverage * 1000) / 1000, categories: "categories.json" };
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
  const missJson = JSON.stringify({ v: 1, miss });
  hashes.push(sha1(missJson));
  manifest.hash = sha1(hashes.join("|")).slice(0, 16);
  files.set("tmdb-cache.json", missJson);
  files.set("index.json", JSON.stringify(manifest));
  return { manifest, files, changed: manifest.hash !== prevHash };
}

export function categoriesJson() {
  return JSON.stringify({ v: FORMAT, vod: TABLE_VOD, series: TABLE_SERIES, live: TABLE_LIVE });
}

// ---- ejecución completa ---------------------------------------------------------

export async function run(opts) {
  const {
    out = "dist", prevDir = "prev", prevUrl = PREV_URL, hours = 4.5, iptvMinutes = 150, force = false, apiKey = process.env.TMDB_API_KEY || "",
    fetchFn = fetch, sleep = sleepMs, bootstrapUrl = BOOTSTRAP, tmdbBase, minDelay, maxDelay, rps = 4, verbose = true, now = Date.now,
  } = opts;
  const log = makeLog(verbose);
  const t0 = now();
  const prev = await loadPrevious({ prevDir, prevUrl, fetchFn, sleep, log });
  if (prev.status === "error") {
    log("no se pudo descargar el índice anterior: no se asume vacío; se aborta sin publicar");
    return { published: false, reason: "prev-error" };
  }
  const servers = await getServerList({ bootstrapUrl, fetchFn, log });
  const client = makeClient({ servers, fetchFn, sleep, minDelay, maxDelay, log });
  const col = await collect({ client, prev, log, deadline: t0 + iptvMinutes * 60000, now });
  const coverage = col.total ? col.ok / col.total : 0;
  log(`cobertura ${(coverage * 100).toFixed(1)}% (${col.ok}/${col.total} categorías), ${col.entries.size} títulos, ${client.calls} peticiones al servicio`);
  if (coverage < MIN_COVERAGE) { log(`cobertura < ${MIN_COVERAGE}: no se publica`); return { published: false, reason: "coverage", coverage }; }

  const tm = await tmdbPhase({ entries: col.entries, prev, apiKey, base: tmdbBase, fetchFn, sleep, rps, deadline: t0 + hours * 3600000, now, log });
  log(`TMDB: ${tm.stats.cached} de caché, ${tm.stats.queried} consultas nuevas, ${tm.stats.retried} reintentos, ${tm.stats.found} encontrados, ${tm.stats.missed} sin coincidencia, ${tm.stats.deferred} pendientes`);

  const generated = new Date(now()).toISOString().replace(/\.\d+Z$/, "Z");
  const o = buildOutput({ entries: col.entries, miss: tm.miss, coverage, generated, categoriesJson: categoriesJson(), prevHash: prev.manifest ? prev.manifest.hash : "" });
  if (!o.changed && !force) { log("sin cambios respecto al índice anterior: no se publica"); return { published: false, reason: "unchanged", manifest: o.manifest }; }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const [name, text] of o.files) writeFileSync(join(out, name), text);
  const bytes = [...o.files.values()].reduce((n, t) => n + Buffer.byteLength(t), 0);
  log(`escrito ${o.files.size} archivos (${(bytes / 1048576).toFixed(2)} MB) en ${out}; ${((now() - t0) / 60000).toFixed(1)} min`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "changed=true\n");
  return { published: true, manifest: o.manifest, stats: tm.stats, coverage, entries: col.entries.size };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") o.out = argv[++i];
    else if (a === "--prev") o.prevDir = argv[++i];
    else if (a === "--hours") o.hours = Number(argv[++i]);
    else if (a === "--iptv-minutes") o.iptvMinutes = Number(argv[++i]);
    else if (a === "--min-delay") o.minDelay = Number(argv[++i]);
    else if (a === "--max-delay") o.maxDelay = Number(argv[++i]);
    else if (a === "--tmdb-rps") o.rps = Number(argv[++i]);
    else if (a === "--force") o.force = true;
  }
  return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const res = await run(parseArgs(process.argv.slice(2)));
  if (!res.published && res.reason !== "unchanged") { console.error("no publicado:", res.reason); process.exitCode = res.reason === "prev-error" ? 2 : 3; }
  else if (!res.published && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "changed=false\n");
}
