// Nombres de categorías: limpieza, idioma, basura, adultos, país y género. Funciones puras (sin kino).

export const LANG_ORDER = ["es-419", "es-ES", "en"];
const SUFFIX_LANG = { LAT: "es-419", CAST: "es-ES", ENG: "en" };

export function cleanCategoryName(name) {
  const raw = String(name || "").trim();
  const m = raw.match(/[\s\-–]*\(\s*(LAT|CAST|ENG)\s*\)\s*$/i);
  const title = (m ? raw.slice(0, m.index) : raw).replace(/[\s\-–]+$/, "").trim();
  return { title: title || raw, lang: m ? SUFFIX_LANG[m[1].toUpperCase()] : "es-419" };
}

const JUNK = [/^\s*test/i, /\(\s*TEST\s*\)/i, /temporal/i, /\btestapp\b/i];
const ADULT = /(\bxxx\b|\badult[oa]?s?\b|\bporn\w*|\ber[oó]tic\w*|\bsex(o|y)?\b|\bhentai\b|\beros\b|\+\s?18|18\s?\+|\b18\s?plus\b)/i;

export const isAdultName = (name) => ADULT.test(String(name || ""));

export function isJunkCategory(name) {
  const raw = String(name || "");
  if (JUNK.some((re) => re.test(raw))) return true;
  return !/[\p{L}\p{N}]/u.test(raw); // cabecera decorativa: solo símbolos
}

const KEEP_UPPER = new Set(["NBA", "NFL", "NHL", "MLB", "UFC", "WNBA", "NCAAB", "PPV", "DAZN", "RFEF", "ESPN", "HBO", "CNN", "LMP", "VIX", "USA", "UK", "TV", "FHD", "HD", "LAT", "DC", "ABC", "NBC", "CBS", "TNT", "AMC", "SVT", "ITV", "BBC", "RAI", "ZDF", "CBC", "RTVE", "NHK"]);
const LOWER_WORDS = new Set(["Y", "E", "O", "A", "DE", "DEL", "LA", "LAS", "LOS", "EL", "EN", "THE", "OF", "AND"]);

export function titleCase(text) {
  const s = String(text || "");
  if (/\p{Ll}/u.test(s)) return s;
  let first = true;
  return s.split(/([\s\-/]+)/).map((w) => {
    if (w === "" || /^[\s\-/]+$/.test(w)) return w;
    const letters = w.replace(/[^\p{L}]/gu, "");
    const atStart = first;
    first = false;
    if (/\d/.test(w) || KEEP_UPPER.has(letters)) return w;
    if (!atStart && LOWER_WORDS.has(letters)) return w.toLowerCase();
    if (letters.length <= 2 && letters === w) return w;
    return w.charAt(0) + w.slice(1).toLocaleLowerCase();
  }).join("");
}

// "✨   E V E N T O S   D I A R I O S   03/11   ✨" -> "Eventos Diarios 03/11"
export function prettyLiveTitle(raw) {
  const original = String(raw || "").trim();
  let s = original.replace(/[︎️‍]/g, "");
  s = s.replace(/[^\p{L}\p{N}\s&+\-./'|,:()]/gu, " ").replace(/\|/g, "   |   ");
  const chunks = s.split(/\s{3,}/).map((c) => c.trim()).filter(Boolean).map((c) => {
    if (c === "|") return "·";
    return /^(?:[\p{L}\p{N}] ){2,}[\p{L}\p{N}]$/u.test(c) ? c.replace(/ /g, "") : c.replace(/\s+/g, " ");
  });
  const out = chunks.join(" ").replace(/^[\s\-·|:]+|[\s\-·|:]+$/g, "").trim();
  return out ? titleCase(out) : original;
}

const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

export const COUNTRY_PHRASES = [
  ["ARGENTINA", "AR"], ["BRASIL", "BR"], ["BRAZIL", "BR"], ["BOLIVIA", "BO"], ["CHILE", "CL"], ["COLOMBIA", "CO"],
  ["COSTA RICA", "CR"], ["CUBA", "CU"], ["CURACAO", "CW"], ["ECUADOR", "EC"], ["EL SALVADOR", "SV"], ["GUATEMALA", "GT"],
  ["HAITI", "HT"], ["HONDURAS", "HN"], ["JAMAIKA", "JM"], ["JAMAICA", "JM"], ["MEXICO", "MX"], ["NICARAGUA", "NI"],
  ["PANAMA", "PA"], ["PARAGUAY", "PY"], ["PERU", "PE"], ["PUERTO RICO", "PR"], ["R DOMINICANA", "DO"],
  ["REPUBLICA DOMINICANA", "DO"], ["DOMINICANA", "DO"], ["URUGUAY", "UY"], ["VENEZUELA", "VE"], ["ESPANA", "ES"],
  ["CANADA", "CA"], ["USA", "US"], ["ESTADOS UNIDOS", "US"], ["FRANCE", "FR"], ["GERMANY", "DE"], ["ITALY", "IT"],
  ["PORTUGAL", "PT"], ["UK", "GB"], ["NETHERLANDS", "NL"], ["MARRUECOS", "MA"],
].sort((a, b) => b[0].length - a[0].length);

// { cc, exact }: el país del nombre; exact = el nombre ES el país (con número opcional: "COLOMBIA 2").
export function countryMatch(title) {
  const t = norm(title);
  const padded = ` ${t} `;
  for (const [phrase, cc] of COUNTRY_PHRASES) {
    if (padded.includes(` ${phrase} `)) return { cc, exact: t === phrase || t.replace(/ \d+$/, "") === phrase, starts: t.startsWith(phrase + " ") };
  }
  return null;
}

export const countryOf = (title) => { const m = countryMatch(title); return m ? m.cc : null; };

export function liveGenreOf(title) {
  const t = norm(title);
  if (/\b(RADIO|MUSICA|MUSIC)\b/.test(t)) return "musica";
  if (/\b(KIDS|INFANTIL|INFANTILES|CARTOON|CARTOONS|ANIMACION|DIBUJOS)\b/.test(t)) return "infantil";
  if (/\bANIME\b/.test(t)) return "anime";
  if (/\b(DOCUMENTARY|DOCUMENTALES|DOCUMENTAL|SCIENCE|CULTURA)\b/.test(t)) return "documentales";
  if (/\b(NEWS|NOTICIAS)\b/.test(t)) return "noticias";
  if (/\b(SPORTS|SPORT|DEPORTES|FUTBOL|LEAGUE|LIGA|NBA|NFL|NHL|MLB|WNBA|UFC|NCAAB|F1|FORMULA|MOTOR|TENIS|BEISBOL|BASEBALL|CHAMPIONS|LIBERTADORES|SUDAMERICANA|PPV|EVENTOS|EVENTS|EVENT)\b/.test(t)) return "deportes";
  if (/\b(MOVIES|CINE|PELICULAS|FILM)\b/.test(t)) return "peliculas";
  if (/\b(SERIES|REALITY|NOVELAS)\b/.test(t)) return "series";
  if (/\b(ENTRETENIMIENTO|ENTERTAINMENT)\b/.test(t)) return "entretenimiento";
  return null;
}

const POPULAR = /\b(ACCION|ACTION|COMEDIA|COMEDY|TERROR|HORROR|DRAMA|ANIMACION|AVENTURA|CIENCIA FICCION|SUSPENSO|THRILLER|ROMANCE|FAMILIA|NETFLIX|DISNEY|HBO|AMAZON|APPLE|PARAMOUNT)\b/;

// Menor = antes. ESTRENOS, CINE del año pasado, géneros populares; las grabaciones de cámara al final.
export function vodRank(title) {
  const t = norm(title);
  if (/\bCAM\b/.test(t)) return 9;
  if (/\bESTRENOS\b/.test(t)) return 0;
  if (/\bCINE 2025\b/.test(t)) return 1;
  if (/\bCINE 20\d\d\b/.test(t)) return 2;
  if (POPULAR.test(t)) return 3;
  return 4;
}

export const isCamCategory = (title) => /\bCAM\b/.test(norm(title));

export const LANG_LABELS = {
  "es-419": ["Latino", "Latin"],
  "es-ES": ["España", "Spain"],
  en: ["English", "English"],
};
