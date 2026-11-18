// Genera el índice de títulos de Ultra Hd (películas y series) y lo escribe en --out.
//   node scripts/gen-index.mjs --out dist --prev prev [--full | --hot] [--force]
// Respetuoso con el servidor: una petición a la vez, 3-5 s entre categorías, backoff ante errores. No escribe ni imprime
// nunca credenciales, usuarios, hosts de servidores IPTV ni urls con ellos.
// --hot: only the daily refresh of the hot categories, even when a full sweep is due (a cheap manual check; it never publishes
// by itself: like every run, it only writes --out).
// --force: write it even when nothing changed or when movies or series lost more than MAX_SHRINK of their titles.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { VOD as TABLE_VOD, SERIES as TABLE_SERIES, LIVE as TABLE_LIVE } from "../lib/categoryTable.js";
import { isAdultName, cleanCategoryName } from "../lib/names.js";
import { isHidden, normKey } from "../lib/categoryRules.js";

export const FORMAT = 1;
export const PART_LIMIT = 100000; // bytes por trozo sin comprimir: trozos chicos para que un TV lento los parsee y vuelque sin atascarse
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

// Etiqueta del servidor del que salen los ids de categoría y la numeración del índice: cada servidor numera y organiza las suyas, así que
// el plugin solo usa el índice con el servidor que lo generó (no es secreta: es un hash corto del host).
export const sourceTag = (base) => h32(String(base), 2166136261).toString(36);

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

// ---- the account: always one of the index's panel ---------------------------------

// Each panel numbers its categories its own way, so the index's category ids mean something only on the panel that made it.
// An account belongs to that panel when it carries at least this share of the index's categories under the same id and name.
export const MIN_ACCOUNT_FIT = 0.9;
// At most this many accounts of the list are probed, one get_vod_categories each.
export const MAX_PROBES = 30;
const PROBE_TIMEOUT_MS = 30000;
const INVALID_LOGIN = /invalid\s+(?:user(?:name)?|login|credentials)|user(?:name)?\s+(?:or|and)\s+password/i;

// A category name as the index's category table spells it ("ACCIÓN - (LAT)" and "Acción" are the same category).
const catTitle = (name) => normKey(cleanCategoryName(String(name || "")).title);

// What an account must match: { VOD category id -> name } for the categories the previous index's movies point at, named as
// in the previously published categories.json (the bundled table when it is missing). Empty without a previous index: then
// there is no panel to stay on and any account that answers fits.
export function panelReference(prev) {
  const ids = new Set();
  for (const e of prev.entries.values()) if (e.kind === "movies") for (const c of e.cats) ids.add(String(c));
  let vod = null;
  try { const c = JSON.parse(prev.files.get("categories.json") || "null"); vod = c && c.vod; } catch (_) { vod = null; }
  if (!vod || typeof vod !== "object") vod = TABLE_VOD;
  const ref = new Map();
  for (const id of ids) if (Array.isArray(vod[id]) && vod[id][0]) ref.set(id, String(vod[id][0]));
  return ref;
}

// Share of [ref]'s categories that [list] (a get_vod_categories answer) carries under the same id and name; 1 without a reference.
export function panelFit(list, ref) {
  if (!ref.size) return 1;
  const byId = new Map((Array.isArray(list) ? list : []).map((c) => [String(c.category_id || ""), c.category_name]));
  let n = 0;
  for (const [id, name] of ref) if (byId.has(id) && catTitle(byId.get(id)) === normKey(name)) n++;
  return n / ref.size;
}

// A "polite" connection to one account of the index's panel: one request at a time, a pause between categories, backoff on
// errors. start() probes the list (the previous index's account first) and takes the account that best fits [ref], stopping
// at the first that carries all of it. It never leaves the panel mid-sweep: an account that rejects its login is replaced at
// once, one that stops answering after FAILS_TO_SWITCH straight failures too, and the replacement is always another account
// that fits [ref]. A category request only goes to an account that lists that category under the same name, so a
// replacement never answers for ids it does not have. With no account of the panel left it throws an error with `fatal`.
export function makeClient({ servers, ref = new Map(), preferTag = "", fetchFn = fetch, sleep = sleepMs, minDelay = 3000, maxDelay = 5000, maxProbes = MAX_PROBES, minFit = MIN_ACCOUNT_FIT, probeTimeoutMs = PROBE_TIMEOUT_MS, log = () => {}, rand = Math.random }) {
  const preferred = servers.filter((s) => preferTag && sourceTag(s.base) === preferTag);
  const accounts = [...preferred, ...servers.filter((s) => !preferred.includes(s))].slice(0, maxProbes)
    .map((s, i) => ({ ...s, n: i + 1, tag: sourceTag(s.base), state: "new", fit: 0, lists: {} }));
  let active = null;
  let consecutive = 0;
  let requests = 0;
  const BACKOFF = [10000, 30000, 90000];
  const FAILS_TO_SWITCH = 4;
  const label = (a) => `cuenta ${a.n} (${a.tag})`;
  const shortErr = (e) => String((e && e.message) || e).slice(0, 60);
  const fitText = (a) => (ref.size ? `${Math.round(a.fit * ref.size)}/${ref.size} categorías del índice` : "sin índice anterior");

  async function once(acc, action, extra = {}, timeoutMs = 120000) {
    requests++;
    const q = new URLSearchParams({ username: acc.username, password: acc.password, action, ...extra });
    const r = await getText(fetchFn, `${acc.base}/player_api.php?${q}`, { headers: { Accept: "application/json,text/plain,*/*", "User-Agent": UA, "Cache-Control": "no-cache" }, timeoutMs });
    let data;
    try { data = JSON.parse(r.text); } catch (_) { data = undefined; }
    if (r.ok && Array.isArray(data)) return data;
    const rejected = r.status === 401 || (!!data && typeof data === "object" && !!data.user_info && String(data.user_info.auth) === "0")
      || INVALID_LOGIN.test(String(r.text).slice(0, 500));
    if (rejected) { const e = new Error("cuenta no válida"); e.auth = true; throw e; }
    if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
    if (data === null || typeof data !== "object") throw new Error("respuesta inválida");
    return data;
  }

  // One get_vod_categories, no retries: "dead" (login rejected), "down" (no usable answer), "panel" (fits) or "other".
  async function probe(acc) {
    try {
      const list = await once(acc, "get_vod_categories", {}, probeTimeoutMs);
      if (!Array.isArray(list) || !list.length) throw new Error("sin categorías");
      acc.lists.vod = list;
      acc.fit = panelFit(list, ref);
      acc.state = acc.fit >= minFit ? "panel" : "other";
      log(`${label(acc)}: ${acc.state === "panel" ? "del panel del índice" : "de otro panel"} (${fitText(acc)})`);
    } catch (e) {
      acc.state = e.auth ? "dead" : "down";
      log(`${label(acc)}: ${e.auth ? "cuenta no válida" : `no responde (${shortErr(e)})`}`);
    }
  }

  // The usable account of the panel with the best fit, probing the list in order until one carries all of [ref].
  async function choose() {
    for (const acc of accounts) {
      if (accounts.some((a) => a.state === "panel" && a.fit === 1)) break;
      if (acc.state === "new") await probe(acc);
    }
    return accounts.filter((a) => a.state === "panel").sort((a, b) => b.fit - a.fit || a.n - b.n)[0] || null;
  }

  async function select() {
    const next = await choose();
    if (!next) {
      const e = new Error(`ninguna cuenta del panel del índice responde (${accounts.filter((a) => a.state !== "new").length} probadas; no se cambia de panel)`);
      e.fatal = true;
      throw e;
    }
    if (next !== active) log(`${active ? "cambiando a la" : "se usa la"} ${label(next)}: ${fitText(next)}`);
    active = next;
    consecutive = 0;
  }

  // Whether [acc] still answers as an account of the panel: after a run of failures, it tells a broken category (the account
  // answers) from a dead account.
  async function stillServes(acc) {
    try {
      const list = await once(acc, "get_vod_categories", {}, probeTimeoutMs);
      if (Array.isArray(list) && list.length && panelFit(list, ref) >= minFit) { acc.lists.vod = list; return true; }
    } catch (e) { if (e.auth) acc.state = "dead"; }
    return false;
  }

  // Whether [acc] lists category [cat] ({ kind: "vod" | "series", id, name }) under the same name; its list is fetched once.
  async function carries(acc, cat) {
    if (!acc.lists[cat.kind]) {
      const list = await once(acc, cat.kind === "vod" ? "get_vod_categories" : "get_series_categories");
      acc.lists[cat.kind] = Array.isArray(list) ? list : [];
    }
    const want = catTitle(cat.name);
    return acc.lists[cat.kind].some((c) => String(c.category_id) === String(cat.id) && catTitle(c.category_name) === want);
  }

  // [cat]: the category a stream-list request is for, so that it only goes to an account that has it.
  async function call(action, extra = {}, cat = null) {
    let lastErr = "";
    for (let tries = 0; tries < 8; tries++) {
      const acc = active;
      try {
        if (cat && !(await carries(acc, cat))) { const e = new Error("la cuenta no tiene esta categoría"); e.notCarried = true; throw e; }
        const data = await once(acc, action, extra);
        consecutive = 0;
        return data;
      } catch (e) {
        if (e.notCarried) throw e;
        lastErr = shortErr(e);
        if (e.auth) {
          acc.state = "dead";
          log(`${label(acc)}: cuenta no válida; se busca otra del mismo panel`);
          await select();
          continue;
        }
        if (++consecutive >= FAILS_TO_SWITCH) {
          consecutive = 0;
          if (await stillServes(acc)) break; // the account answers: only this request fails
          if (acc.state !== "dead") acc.state = "down";
          log(`${label(acc)}: ${FAILS_TO_SWITCH} fallos seguidos; se busca otra del mismo panel`);
          await select();
          continue;
        }
        await sleep(BACKOFF[Math.min(consecutive, BACKOFF.length) - 1] * (e.status === 429 ? 2 : 1));
      }
    }
    throw new Error(`${action} falló: ${lastErr}`);
  }

  // The active account's own category list of [kind] ("vod" | "series"); the probe already brought "vod".
  async function categories(kind) {
    if (active.lists[kind]) return active.lists[kind];
    const list = await call(kind === "vod" ? "get_vod_categories" : "get_series_categories");
    if (!Array.isArray(list)) throw new Error(`categorías de ${kind}: no es lista`);
    active.lists[kind] = list;
    return list;
  }

  async function pause() { await sleep(minDelay + rand() * Math.max(0, maxDelay - minDelay)); }
  return {
    start: select, call, categories, pause,
    get requests() { return requests; },
    // The tag the index is stamped with: the account in use at the end, the last one known to answer (every account that
    // answered is of the index's panel, so the ids are the same on all of them).
    get source() { return active ? active.tag : ""; },
  };
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
  for (const [kind, label, itemsAction] of [["movies", "vod", "get_vod_streams"], ["series", "series", "get_series"]]) {
    let cats = visibleCategories(label, await client.categories(label));
    const visible = cats.length;
    if (partial) cats = cats.filter((c) => isHotCategory(label, c.name, year));
    status.total += cats.length;
    log(`${label}: ${cats.length} categorías${partial ? ` calientes de ${visible}` : " visibles"}`);
    for (let i = 0; i < cats.length; i++) {
      if (now() > deadline) { for (const c of cats.slice(i)) { status.failed.push(`${label}:${c.id}`); failedByKind[kind].add(c.id); } status.skipped = cats.length - i; log("tiempo agotado: el resto se conserva del índice anterior"); break; }
      try {
        const items = await client.call(itemsAction, { category_id: String(cats[i].id) }, { kind: label, id: cats[i].id, name: cats[i].name });
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
        if (e.fatal) throw e; // no account of the panel left: the whole run stops, nothing is published
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
export function buildRevision({ entries, prev, coverage, generated, fullAt, categoriesJson, source }) {
  const revision = revisionOf(generated);
  const files = new Map();
  const manifest = { v: FORMAT, generated, revision, fullAt, coverage: Math.round(coverage * 1000) / 1000, categories: "categories.json", ...(source ? { src: source } : {}) };
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
  if (pm && pm.hash === manifest.hash) {
    const files2 = new Map(prev.files);
    // Mismos datos: solo se añade (o corrige) la etiqueta del servidor, sin cambiar la revisión.
    if (source && pm.src !== source) { const m2 = { ...pm, src: source }; files2.set("index.json", JSON.stringify(m2)); return { changed: true, files: files2, manifest: m2 }; }
    return { changed: false, files: files2, manifest: pm };
  }

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

// Which sweep runs. Full without a usable previous index, on --full, when one is due, or when the account is not the one the
// previous index was made from (the index then comes whole from the account it is stamped with). --hot forces the hot refresh
// whenever a previous index exists.
export function sweepMode({ prevManifest, nowMs, full = false, hot = false, source = "" }) {
  if (full || !prevManifest || !prevManifest.revision || !prevManifest.fullAt) return "full";
  if (hot) return "partial";
  if (fullSweepDue(prevManifest, nowMs)) return "full";
  return prevManifest.src && source && source !== prevManifest.src ? "full" : "partial";
}

// A run never publishes an index that lost more than this share of the previous index's movies or of its series: coverage
// counts the categories the account lists, so an account whose bouquet lacks a whole section (the account is matched on its
// VOD categories only) or a panel answering empty lists would otherwise wipe that section for every person, through the
// delta, until the next full sweep. --force publishes it anyway (a real, deliberate cut of the catalog).
export const MAX_SHRINK = 0.25;
const SHRINK_MIN_TITLES = 1000; // a previous section smaller than this is too small to judge

// The sections of [entries] that shrank past MAX_SHRINK against [prevEntries]: [{ kind, before, after }].
export function shrunkKinds(prevEntries, entries, { maxShrink = MAX_SHRINK, minTitles = SHRINK_MIN_TITLES } = {}) {
  const count = (m, kind) => { let n = 0; for (const e of m.values()) if (e.kind === kind) n++; return n; };
  const out = [];
  for (const kind of ["movies", "series"]) {
    const before = count(prevEntries, kind);
    const after = count(entries, kind);
    if (before >= minTitles && after < before * (1 - maxShrink)) out.push({ kind, before, after });
  }
  return out;
}

export async function run(opts) {
  const {
    out = "dist", prevDir = "prev", prevUrl = PREV_URL, iptvMinutes = 150, force = false, full = false, hot = false,
    fetchFn = fetch, sleep = sleepMs, bootstrapUrl = BOOTSTRAP, minDelay, maxDelay, minFit, maxProbes, shrinkMin, verbose = true, now = Date.now,
  } = opts;
  const log = makeLog(verbose);
  const t0 = now();
  const prev = await loadPrevious({ prevDir, prevUrl, fetchFn, sleep, log });
  if (prev.status === "error") {
    log("no se pudo descargar el índice anterior: no se asume vacío; se aborta sin publicar");
    return { published: false, reason: "prev-error" };
  }
  let servers;
  try { servers = await getServerList({ bootstrapUrl, fetchFn, log }); } catch (e) {
    log(`${String((e && e.message) || e).slice(0, 60)}: no se publica; el índice anterior sigue publicado`);
    return { published: false, reason: "bootstrap" };
  }
  const ref = panelReference(prev);
  const prevSrc = (prev.manifest && prev.manifest.src) || "";
  log(ref.size ? `el índice anterior${prevSrc ? ` (servidor ${prevSrc})` : ""} usa ${ref.size} categorías de películas: se busca una cuenta de su panel`
    : prev.entries.size ? "el índice anterior no tiene categorías reconocibles: sirve cualquier cuenta" : "sin índice anterior: sirve cualquier cuenta");
  const client = makeClient({
    servers, ref, preferTag: prevSrc, fetchFn, sleep, minDelay, maxDelay, log,
    ...(minFit !== undefined ? { minFit } : {}), ...(maxProbes ? { maxProbes } : {}),
  });
  // Never another panel: without an account of the index's panel the run stops here and the old index stays published.
  const stop = (e) => {
    log(`${String((e && e.message) || e).slice(0, 160)}: no se publica; el índice anterior sigue publicado`);
    return { published: false, reason: e && e.fatal ? "no-account" : "service", requests: client.requests };
  };
  try { await client.start(); } catch (e) { if (!e.fatal) throw e; return stop(e); }
  const moved = !!prevSrc && client.source !== prevSrc;
  const mode = sweepMode({ prevManifest: prev.manifest, nowMs: t0, full, hot, source: client.source });
  log(`modo: ${mode === "full" ? "barrido completo" : "refresco de categorías calientes"}${moved ? " (la cuenta no es la del índice anterior)" : ""}`);
  let col;
  try { col = await collect({ client, prev, log, deadline: t0 + iptvMinutes * 60000, now, mode }); } catch (e) { return stop(e); }
  const swept = col.total ? col.ok / col.total : 0;
  log(`categorías leídas ${col.ok}/${col.total} (${(swept * 100).toFixed(1)}%), ${col.entries.size} títulos (${col.isNew.size} nuevos), ${client.requests} peticiones al servicio`);
  if (swept < MIN_COVERAGE) { log(`cobertura < ${MIN_COVERAGE}: no se publica`); return { published: false, reason: "coverage", coverage: swept, requests: client.requests }; }
  const shrunk = shrunkKinds(prev.entries, col.entries, shrinkMin !== undefined ? { minTitles: shrinkMin } : {});
  if (shrunk.length) {
    const what = shrunk.map((s) => `${s.kind === "movies" ? "películas" : "series"} ${s.before} → ${s.after}`).join(", ");
    if (!force) { log(`${what}: pierde más del ${MAX_SHRINK * 100} %; no se publica (con --force se publica igual)`); return { published: false, reason: "shrink", shrunk, requests: client.requests }; }
    log(`${what}: pierde más del ${MAX_SHRINK * 100} %, pero se publica (--force)`);
  }
  // La cobertura publicada es la del último barrido completo: un refresco parcial no la mejora ni la empeora.
  const coverage = mode === "full" ? swept : Number(prev.manifest.coverage) || swept;
  const fullAt = mode === "full" ? new Date(t0).toISOString().replace(/\.\d+Z$/, "Z") : prev.manifest.fullAt;

  const generated = new Date(now()).toISOString().replace(/\.\d+Z$/, "Z");
  const o = buildRevision({ entries: col.entries, prev, coverage, generated, fullAt, categoriesJson: categoriesJson(), source: client.source });
  if (!o.changed && !force) { log("sin cambios respecto al índice anterior: no se publica"); return { published: false, reason: "unchanged", manifest: o.manifest }; }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const [name, text] of o.files) writeFileSync(join(out, name), text);
  const bytes = [...o.files.values()].reduce((n, t) => n + Buffer.byteLength(t), 0);
  const last = (o.manifest.deltas || []).slice(-1)[0];
  log(`escrito ${o.files.size} archivos (${(bytes / 1048576).toFixed(2)} MB) en ${out}; revisión ${o.manifest.revision}${o.changed && last ? `, delta +${last.added} -${last.removed}` : o.changed ? "" : " (sin cambios de contenido)"}; ${((now() - t0) / 60000).toFixed(1)} min`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "changed=true\n");
  return { published: true, changed: o.changed, mode, manifest: o.manifest, coverage, entries: col.entries.size, isNew: col.isNew.size, requests: client.requests };
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
    else if (a === "--hot") o.hot = true;
  }
  return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const res = await run(parseArgs(process.argv.slice(2)));
  if (!res.published && res.reason !== "unchanged") { console.error("no publicado:", res.reason); process.exitCode = res.reason === "prev-error" ? 2 : 3; }
  else if (!res.published && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "changed=false\n");
}
