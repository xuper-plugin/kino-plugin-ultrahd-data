// Reglas para clasificar categorías: las usa el generador de la tabla (scripts/gen-categories.mjs) y, para las categorías
// que la tabla no conoce, el respaldo automático. Funciones puras.
import { cleanCategoryName, isAdultName, isJunkCategory, countryOf, liveGenreOf, prettyLiveTitle, titleCase } from "./names.js";

export const GROUPS = ["estrenos", "generos", "plataformas", "canales", "otros"];
// Orden de los grupos al mostrar: las series arrancan por plataformas.
export const GROUP_ORDER = { vod: GROUPS, series: ["plataformas", "estrenos", "generos", "canales", "otros"] };
export const LIVE_GROUPS = ["premium", "paises", "deportes", "tematicos", "radio", "otros"];

export const normKey = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const ESTRENOS = /\b(estrenos?|new releases?)\b|\b(cine|movies?|peliculas?) (19|20)\d\d\b/;
const PLATFORMS = ["netflix", "disney", "hbo", "amazon", "apple", "paramount", "max", "hulu", "peacock", "showtime", "skyshowtime", "starz", "mgm", "crunchyroll", "filmin", "movistar", "vix", "tivify", "quibi", "youtube", "otras plataformas"];
const CHANNELS = ["abc", "fox", "nbc", "cbs", "tnt", "amc", "fx", "the cw", "syfy", "usa network", "freeform", "lifetime", "discovery", "history", "bbc", "itv", "channel 4", "svt", "zdf", "das erste", "rte one", "cbc", "rtve", "france tv", "rai", "sky", "telecinco", "antena 3", "atresplayer", "atresmedia", "canal", "las estrellas", "viaplay", "stan"];
const VOD_GENRES = ["accion", "action", "comedia", "comedy", "terror", "horror", "drama", "animacion", "animation", "aventura", "adventure", "ciencia ficcion", "science fiction", "suspenso", "thriller", "romance", "familia", "family", "crimen", "crime", "fantasia", "fantasy", "misterio", "mystery", "belica", "war", "documental", "documentary", "historia", "history", "musica", "music", "western"];
const SERIES_GENRES = ["novelas", "telenovelas", "series animadas", "animadas", "series anime", "anime", "series documentales", "docuseries", "series dramas", "k dramas", "turkas", "latinas", "series retro", "variadas"];

const hasWord = (t, w) => (" " + t + " ").includes(" " + w + " ");
const indexIn = (list, t) => list.findIndex((w) => hasWord(t, w));

// { group, rank }: rank pequeño = antes dentro de su grupo.
export function groupOf(kind, title) {
  const t = normKey(title);
  if (ESTRENOS.test(t)) {
    if (/\b(estrenos?|new releases?)\b/.test(t)) return { group: "estrenos", rank: 0 };
    const year = Number((t.match(/(?:19|20)\d\d/) || [2025])[0]);
    return { group: "estrenos", rank: 1 + Math.abs(2025 - year) };
  }
  if (kind === "series") {
    let i = indexIn(PLATFORMS, t);
    if (i >= 0) return { group: "plataformas", rank: i };
    i = indexIn(SERIES_GENRES, t);
    if (i >= 0) return { group: "generos", rank: i };
    i = indexIn(CHANNELS, t);
    if (i >= 0) return { group: "canales", rank: i };
    return { group: "otros", rank: 400 };
  }
  const g = indexIn(VOD_GENRES, t);
  if (g >= 0) return { group: "generos", rank: Math.floor(g / 2) };
  return { group: "otros", rank: 400 };
}

export function orderOf(kind, group, rank, tie = 0) {
  return GROUP_ORDER[kind].indexOf(group) * 10000 + Math.min(rank, 89) * 100 + Math.min(tie, 99);
}

export function liveGroupOf(title, country, genre) {
  const t = normKey(title);
  if (/\b(premium|eventos diarios|exclusivos)\b/.test(t)) return "premium";
  if (/^radio\b/.test(t)) return "radio";
  if (genre === "deportes") return "deportes";
  if (country) return "paises";
  if (genre) return "tematicos";
  return "otros";
}

export const liveOrderOf = (group, i) => LIVE_GROUPS.indexOf(group) * 10000 + Math.min(i, 8999);

// Clasificación automática de una categoría VOD/serie desconocida (queda al final de su grupo).
export function fallbackVod(kind, id, name, i) {
  const { title, lang } = cleanCategoryName(name);
  const { group } = groupOf(kind, title);
  return { id: String(id), name, title: titleCase(title), lang, group, order: GROUP_ORDER[kind].indexOf(group) * 10000 + 9000 + Math.min(i, 999), home: false, adult: isAdultName(name), known: false };
}

export function fallbackLive(name, i) {
  const title = prettyLiveTitle(name);
  const country = countryOf(title) || countryOf(name) || "";
  const genre = liveGenreOf(title) || liveGenreOf(name) || "";
  const group = liveGroupOf(title, country, genre);
  return { name, title, country, genre, group, order: LIVE_GROUPS.indexOf(group) * 10000 + 9000 + Math.min(i, 999), adult: isAdultName(name), known: false };
}

export const isHidden = (name) => isJunkCategory(name) || /\bCAM\b/i.test(String(name || ""));
