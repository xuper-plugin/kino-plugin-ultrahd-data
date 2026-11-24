// Pruebas del generador contra un servidor IPTV falso: nada toca la red real.  node scripts/test.mjs
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTitle, findKey, idOf, run, fullSweepDue, isHotCategory, revisionOf, DELTAS_KEPT, panelFit, panelReference, sweepMode, sourceTag, spanishScore, fitsBundledTable, ownTable, tablesFor } from "./gen-index.mjs";
import { checkIndex } from "./check-index.mjs";

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("✓", name); };
const listen = (handler) => new Promise((res) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => res(s)); });
const port = (s) => s.address().port;
const sleep = async () => {};

// ---- datos falsos (mutables) ----
const filler = [1201, 1202, 1203, 1204, 1205, 1206, 1207, 1208].map((id) => ({ category_id: String(id), category_name: "VACÍA " + id + " - (LAT)" }));
const CATS_VOD = [
  { category_id: "1147", category_name: "ESTRENOS 2026 - (LAT)" },
  { category_id: "1149", category_name: "CINE 2025 - (LAT)" },
  { category_id: "1150", category_name: "CINE 2024 - (LAT)" },
  { category_id: "1126", category_name: "ACCIÓN - (LAT)" },
  { category_id: "1047", category_name: "EROS +18" },
  { category_id: "1158", category_name: "TestApp" },
  ...filler,
];
const CATS_SERIES = [{ category_id: "684", category_name: "NETFLIX (LAT)" }, { category_id: "1040", category_name: "NOVELAS (LAT)" }];
const fresh = () => ({
  vod: {
    1147: [{ name: "Spider-Man: Sin camino a casa (LAT) (2021)", year: "2021" }, { name: "El paseo 8 (2025)", year: "2025" }, { name: "Scream 7 (LAT) (2026)", year: "2026" }],
    1149: [{ name: "Película de 2025 (LAT) (2025)", year: "2025" }],
    1150: [{ name: "Película de 2024 (LAT) (2024)", year: "2024" }],
    1126: [{ name: "Spider-Man: Sin camino a casa (LAT) (2021)", year: "2021" }, { name: "Acción Total (CAST)", year: "1990" }, { name: "Fantasía 2000 (LAT)", year: "" }],
    1047: [{ name: "Película adulta (LAT) (2020)", year: "2020" }],
    1158: [{ name: "Prueba (2000)", year: "2000" }],
  },
  series: { 684: [{ name: "La casa de papel (2017)", year: "2017" }, { name: "Dark (LAT)", release_date: "2017-12-01" }], 1040: [{ name: "Novela Vieja (LAT) (2010)", year: "2010" }] },
});
const data = fresh();

// Accounts of the fake service. U1 and U2 are of the index's panel; OTHER is another panel (same ids, other categories);
// AUTH0 rejects its login; SUB is of the panel but lacks a category. [authAfter] / [downAfter]: after that many answers the
// account rejects its login / stops answering.
const OTHER_VOD = CATS_VOD.map((c, i) => ({ category_id: c.category_id, category_name: "DEPORTES " + i }));
const ACCOUNTS = {
  U1: { pass: "P1" }, U2: { pass: "P2" }, OTHER: { pass: "P3", vod: OTHER_VOD }, AUTH0: { pass: "P4", auth0: true },
  SUB: { pass: "P5", vod: CATS_VOD.filter((c) => c.category_id !== "1149") },
  NOSERIES: { pass: "P6", series: [] },
};
const line = (p, user) => `http://127.0.0.1:${p}/get.php?username=${user}&password=${ACCOUNTS[user].pass}&type=m3u_plus`;

function fakeIptv(state) {
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/bootstrap.php") {
      if (u.searchParams.get("servers")) { res.end(state.lines ? state.lines() : `http://127.0.0.1:${state.deadPort}/get.php?username=DEAD&password=DEAD&type=m3u_plus\n${line(port(s), "U1")} 🌐\n`); return; }
      const code = Number(req.headers["x-vegeta-version-code"] || 0);
      state.codes.push(code);
      if (code < 22) { res.statusCode = 426; res.end(JSON.stringify({ ok: false, error: "upgrade_required", minimum_version_code: 22, latest_version_code: 22 })); return; }
      res.end(JSON.stringify({ ok: true, servers_text: "", servers_url: `http://127.0.0.1:${port(s)}/bootstrap.php?servers=1` }));
      return;
    }
    if (u.pathname === "/player_api.php") {
      const action = u.searchParams.get("action");
      const cat = u.searchParams.get("category_id");
      const user = u.searchParams.get("username");
      state.calls.push(`${action}:${cat || ""}`);
      state.who.push(`${user}:${action}:${cat || ""}`);
      const acct = ACCOUNTS[user];
      if (!acct || u.searchParams.get("password") !== acct.pass) { res.statusCode = 403; res.end("{}"); return; }
      if (acct.auth0 || (acct.authAfter !== undefined && (acct.served || 0) >= acct.authAfter)) { res.end(JSON.stringify({ user_info: { auth: 0 } })); return; }
      if (acct.downAfter !== undefined && (acct.served || 0) >= acct.downAfter) { res.statusCode = 502; res.end("down"); return; }
      acct.served = (acct.served || 0) + 1;
      if (cat && state.failCats.has(cat)) { res.statusCode = 500; res.end("boom"); return; }
      const body = action === "get_vod_categories" ? acct.vod || CATS_VOD : action === "get_series_categories" ? acct.series || CATS_SERIES
        : action === "get_vod_streams" ? data.vod[cat] : action === "get_series" ? data.series[cat] : null;
      res.end(JSON.stringify(body || []));
      return;
    }
    res.statusCode = 404; res.end("");
  });
  return s;
}

const dead = await listen((req, res) => { res.statusCode = 500; res.end("dead"); });
const state = { deadPort: port(dead), codes: [], calls: [], who: [], failCats: new Set(), lines: null };
const iptv = fakeIptv(state);
await new Promise((r) => iptv.listen(0, "127.0.0.1", r));
// Two more hosts of the same fake service: an account's server tag (src) depends on its host.
const iptv2 = fakeIptv(state);
await new Promise((r) => iptv2.listen(0, "127.0.0.1", r));
const iptv3 = fakeIptv(state);
await new Promise((r) => iptv3.listen(0, "127.0.0.1", r));
const tagOf = (s) => sourceTag(`http://127.0.0.1:${port(s)}`);
const bootstrapUrl = `http://127.0.0.1:${port(iptv)}/bootstrap.php`;
const noPrev = await listen((req, res) => { res.statusCode = 404; res.end("nope"); });
const brokenPrev = await listen((req, res) => { res.statusCode = 500; res.end("err"); });

const tmp = mkdtempSync(join(tmpdir(), "uhd-data-test-"));
let clock = Date.parse("2026-11-03T07:17:00Z"); // martes
const day = 86400000;
const base = { sleep, bootstrapUrl, verbose: false, prevUrl: `http://127.0.0.1:${port(noPrev)}/`, minDelay: 0, maxDelay: 0, now: () => clock };
const json = (dir, f) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const titlesOf = (dir) => {
  const m = json(dir, "index.json");
  return m.movies.parts.concat(m.series.parts).flatMap((f) => { const p = json(dir, f); return p.name ? p.name.split("\n") : []; });
};
const logs = [];
const origErr = console.error;

try {
  await test("cleanTitle, findKey e idOf: sufijos, acentos, ids estables que no dependen del orden", () => {
    assert.deepEqual(cleanTitle("Spider-Man: Sin camino a casa (LAT) (2021)", "2021"), { name: "Spider-Man: Sin camino a casa", year: 2021 });
    assert.deepEqual(cleanTitle("Fantasía 2000 (LAT)", ""), { name: "Fantasía 2000", year: 0 });
    assert.deepEqual(cleanTitle("Dark [CAST]", ""), { name: "Dark", year: 0 });
    assert.equal(findKey("Ácción ÑANDÚ!"), "accion nandu");
    assert.equal(findKey("Государственные похороны"), "государственные похороны");
    const a = idOf("movies", "spider man", 2002);
    assert.match(a, /^m-[a-z0-9]{2,26}$/);
    assert.equal(a, idOf("movies", "spider man", 2002));
    assert.notEqual(a, idOf("series", "spider man", 2002));
    assert.notEqual(a, idOf("movies", "spider man", 2003));
  });

  await test("categorías calientes: estrenos, cine/movies del año actual y anterior, plataformas de series", () => {
    assert.equal(isHotCategory("vod", "ESTRENOS 2026 - (LAT)", 2026), true);
    assert.equal(isHotCategory("vod", "NEW RELEASES 2026 - (ENG)", 2026), true);
    assert.equal(isHotCategory("vod", "CINE 2025 - (LAT)", 2026), true);
    assert.equal(isHotCategory("vod", "MOVIES 2025 - (ENG)", 2026), true);
    assert.equal(isHotCategory("vod", "CINE 2024 - (LAT)", 2026), false);
    assert.equal(isHotCategory("vod", "ACCIÓN - (LAT)", 2026), false);
    assert.equal(isHotCategory("series", "NETFLIX (LAT)", 2026), true);
    assert.equal(isHotCategory("series", "HBO MAX (CAST)", 2026), true);
    assert.equal(isHotCategory("series", "NOVELAS (LAT)", 2026), false);
  });

  await test("barrido completo: sin índice previo, domingo o >7 días; si no, refresco parcial", () => {
    const t = Date.parse("2026-11-03T07:17:00Z"); // martes
    const m = { revision: "x", fullAt: "2026-11-02T07:17:00Z" };
    assert.equal(fullSweepDue(null, t), true);
    assert.equal(fullSweepDue({ fullAt: "2026-11-02T07:17:00Z" }, t), true, "sin revisión");
    assert.equal(fullSweepDue(m, t), false);
    assert.equal(fullSweepDue(m, t, true), true, "--full");
    assert.equal(fullSweepDue({ ...m, fullAt: "2026-10-25T07:17:00Z" }, t), true, "más de 7 días");
    const sunday = Date.parse("2026-11-08T07:17:00Z");
    assert.equal(new Date(sunday).getUTCDay(), 0);
    assert.equal(fullSweepDue({ ...m, fullAt: "2026-11-07T07:17:00Z" }, sunday), true, "domingo");
    assert.equal(fullSweepDue({ ...m, fullAt: "2026-11-08T05:00:00Z" }, sunday), false, "domingo, pero ya hubo barrido hoy");
  });

  await test("encaje con el panel: mismo id y mismo nombre (como lo escribe la tabla); sin índice anterior sirve cualquiera", () => {
    const ref = new Map([["1147", "Estrenos 2026"], ["1126", "Acción"]]);
    assert.equal(panelFit([{ category_id: "1147", category_name: "ESTRENOS 2026 - (LAT)" }, { category_id: 1126, category_name: "ACCION - (LAT)" }], ref), 1);
    assert.equal(panelFit([{ category_id: "1147", category_name: "ESTRENOS 2026 - (LAT)" }, { category_id: "1126", category_name: "DEPORTES" }], ref), 0.5);
    assert.equal(panelFit([{ category_id: "9", category_name: "ESTRENOS 2026 - (LAT)" }], ref), 0, "otro id");
    assert.equal(panelFit([], new Map()), 1);
    const prev = {
      entries: new Map([["movies:a|0", { kind: "movies", cats: new Set([1147, 9999]) }], ["series:b|0", { kind: "series", cats: new Set([684]) }]]),
      files: new Map([["categories.json", JSON.stringify({ v: 1, vod: { 1147: ["Estrenos 2026", "es-419", "estrenos", 0, "H"], 1126: ["Acción", "es-419", "generos", 1, ""] } })]]),
    };
    assert.deepEqual([...panelReference(prev)], [["1147", "Estrenos 2026"]], "solo las categorías de películas que usa el índice, con su nombre publicado");
    assert.equal(panelReference({ entries: new Map(), files: new Map() }).size, 0);
  });

  await test("modo: otra cuenta que la del índice anterior = barrido completo; --hot fuerza el parcial si hay índice", () => {
    const t = Date.parse("2026-11-03T07:17:00Z"); // martes
    const m = { revision: "x", fullAt: "2026-11-02T07:17:00Z", src: "abc" };
    assert.equal(sweepMode({ prevManifest: m, nowMs: t, source: "abc" }), "partial");
    assert.equal(sweepMode({ prevManifest: m, nowMs: t, source: "xyz" }), "full");
    assert.equal(sweepMode({ prevManifest: { ...m, src: undefined }, nowMs: t, source: "xyz" }), "partial", "índice sin src");
    assert.equal(sweepMode({ prevManifest: { ...m, fullAt: "2026-10-01T00:00:00Z" }, nowMs: t, source: "abc" }), "full", "toca barrido");
    assert.equal(sweepMode({ prevManifest: { ...m, fullAt: "2026-10-01T00:00:00Z" }, nowMs: t, source: "xyz", hot: true }), "partial", "--hot");
    assert.equal(sweepMode({ prevManifest: null, nowMs: t, hot: true }), "full", "--hot sin índice");
    assert.equal(sweepMode({ prevManifest: m, nowMs: t, source: "abc", hot: true, full: true }), "full", "--full gana");
  });

  const out1 = join(tmp, "out1");
  let r1;
  await test("primera corrida (sin índice): barrido completo; 426→código nuevo; servidor muerto→siguiente; adultas/ocultas no se piden", async () => {
    r1 = await run({ ...base, out: out1, prevDir: join(tmp, "none") });
    assert.equal(r1.published, true);
    assert.equal(r1.mode, "full");
    assert.deepEqual(state.codes.slice(0, 2), [21, 22]);
    assert.ok(!state.calls.includes("get_vod_streams:1047") && !state.calls.includes("get_vod_streams:1158"));
    assert.equal(r1.manifest.movies.count, 7);
    assert.equal(r1.manifest.series.count, 3);
    assert.equal(r1.coverage, 1);
    assert.deepEqual(r1.manifest.deltas, []);
    assert.equal(r1.manifest.revision, revisionOf(r1.manifest.generated));
    assert.deepEqual(checkIndex(out1), []);
  });

  await test("el índice no lleva credenciales, hosts ni TMDB; tmdb queda reservado en 0", () => {
    const m = json(out1, "index.json");
    for (const f of readdirSync(out1)) {
      const t = readFileSync(join(out1, f), "utf8");
      assert.ok(!/U1|P1|DEAD|username=|password=|127\.0\.0\.1/.test(t), `${f} no debe llevar credenciales ni hosts`);
    }
    assert.ok(!existsSync(join(out1, "tmdb-cache.json")));
    assert.ok(m.movies.parts.every((f) => json(out1, f).tmdb.every((x) => x === 0)));
  });

  await test("día sin cambios: refresco parcial (solo categorías calientes) y no publica", async () => {
    clock += day;
    const mark = state.calls.length;
    const r = await run({ ...base, out: join(tmp, "o2"), prevDir: out1 });
    const calls = state.calls.slice(mark).filter((c) => /streams|get_series:/.test(c));
    assert.equal(r.published, false);
    assert.equal(r.reason, "unchanged");
    assert.deepEqual(calls.sort(), ["get_series:684", "get_vod_streams:1147", "get_vod_streams:1149"], "solo las calientes");
    assert.ok(!existsSync(join(tmp, "o2")));
  });

  const out3 = join(tmp, "out3");
  await test("refresco parcial con cambios: delta con altas y bajas; lo demás se copia tal cual", async () => {
    data.vod[1147] = [{ name: "Spider-Man: Sin camino a casa (LAT) (2021)", year: "2021" }, { name: "El paseo 8 (2025)", year: "2025" }, { name: "Estreno de hoy (LAT) (2026)", year: "2026" }];
    data.vod[1126].push({ name: "Título nuevo en una no caliente (2020)", year: "2020" }); // no se ve hasta el barrido completo
    const r = await run({ ...base, out: out3, prevDir: out1 });
    assert.equal(r.published, true);
    assert.equal(r.mode, "partial");
    const m = json(out3, "index.json");
    assert.equal(m.deltas.length, 1);
    assert.equal(m.deltas[0].from, r1.manifest.revision);
    assert.equal(m.deltas[0].to, m.revision);
    const d = json(out3, m.deltas[0].file);
    assert.deepEqual(d.added.map((e) => e.n), ["Estreno de hoy"]);
    assert.deepEqual(d.removed, [idOf("movies", "scream 7", 2026)]);
    assert.equal(d.total, m.movies.count + m.series.count);
    assert.equal(m.fullAt, r1.manifest.fullAt, "el parcial no mueve fullAt");
    assert.equal(m.coverage, r1.manifest.coverage);
    assert.ok(!titlesOf(out3).includes("Título nuevo en una no caliente"));
    assert.deepEqual(checkIndex(out3), []);
  });

  await test("nombres estables: lo que ya estaba se copia tal cual (aunque el servidor cambie las mayúsculas)", async () => {
    data.vod[1147][1] = { name: "EL PASEO 8 (2025)", year: "2025" };
    const r = await run({ ...base, out: join(tmp, "o4"), prevDir: out3, full: true });
    assert.equal(r.published, true);
    assert.equal(r.mode, "full");
    const m = json(join(tmp, "o4"), "index.json");
    const d = json(join(tmp, "o4"), m.deltas.at(-1).file);
    assert.deepEqual(d.added.map((e) => e.n), ["Título nuevo en una no caliente"]);
    assert.ok(titlesOf(join(tmp, "o4")).includes("El paseo 8"));
    assert.ok(!titlesOf(join(tmp, "o4")).includes("EL PASEO 8"));
    assert.notEqual(m.fullAt, r1.manifest.fullAt);
  });

  await test("parcial: con las calientes caídas (cobertura <90%) no publica ni borra nada", async () => {
    state.failCats.add("1147");
    const r = await run({ ...base, out: join(tmp, "o5"), prevDir: out3 });
    state.failCats.clear();
    assert.equal(r.published, false);
    assert.equal(r.reason, "coverage");
  });

  await test("barrido completo: una categoría que falla se conserva del índice anterior", async () => {
    state.failCats.add("1126");
    const r = await run({ ...base, out: join(tmp, "o6"), prevDir: out3, full: true, force: true });
    state.failCats.clear();
    assert.equal(r.published, true);
    assert.ok(r.coverage >= 0.9 && r.coverage < 1, "cobertura " + r.coverage);
    assert.ok(titlesOf(join(tmp, "o6")).includes("Acción Total"), "lo de la categoría caída sigue en el índice");
  });

  await test("retención: tras 10 revisiones quedan 7 deltas, consecutivos y con sus archivos", async () => {
    let prevDir = out3;
    let lastRev = json(out3, "index.json").revision;
    for (let i = 0; i < 10; i++) {
      clock += 3600000; // varias corridas el mismo día: sigue siendo parcial
      data.vod[1147] = [...data.vod[1147], { name: `Estreno ${i} (2026)`, year: "2026" }];
      const out = join(tmp, "ret" + i);
      const r = await run({ ...base, out, prevDir });
      assert.equal(r.published, true);
      const m = json(out, "index.json");
      assert.notEqual(m.revision, lastRev);
      lastRev = m.revision;
      assert.ok(m.deltas.length <= DELTAS_KEPT);
      assert.deepEqual(checkIndex(out), []);
      prevDir = out;
    }
    const m = json(prevDir, "index.json");
    assert.equal(m.deltas.length, DELTAS_KEPT);
    assert.equal(readdirSync(prevDir).filter((f) => f.startsWith("delta-")).length, DELTAS_KEPT, "no quedan deltas sueltos");
    m.deltas.forEach((d, i) => { if (i) assert.equal(d.from, m.deltas[i - 1].to); });
    assert.equal(m.deltas.at(-1).to, m.revision);
  });

  await test("falla la descarga del índice anterior: no se asume vacío, no se pide nada al servicio", async () => {
    const n = state.calls.length;
    const r = await run({ ...base, out: join(tmp, "o8"), prevDir: join(tmp, "none"), prevUrl: `http://127.0.0.1:${port(brokenPrev)}/` });
    assert.equal(r.published, false);
    assert.equal(r.reason, "prev-error");
    assert.equal(state.calls.length, n);
  });

  const waitsInto = (list) => async (ms) => { if (ms >= 10000) list.push(ms); };
  const accountsOf = (users) => () => users.map(([s, user]) => line(port(s), user)).join("\n");

  await test("elige la cuenta por las categorías del índice: la que rechaza el login se salta sin esperar, la de otro panel no se usa; src = la usada", async () => {
    state.lines = accountsOf([[iptv, "AUTH0"], [iptv3, "OTHER"], [iptv2, "U2"]]);
    const waits = [];
    const mark = state.who.length;
    const r = await run({ ...base, sleep: waitsInto(waits), out: join(tmp, "acc1"), prevDir: out3 });
    state.lines = null;
    const who = state.who.slice(mark);
    assert.equal(r.published, true);
    assert.equal(r.mode, "full", "otra cuenta que la del índice anterior: barrido completo");
    assert.equal(r.manifest.src, tagOf(iptv2));
    assert.deepEqual(who.filter((w) => !w.startsWith("U2:")), ["AUTH0:get_vod_categories:", "OTHER:get_vod_categories:"], "una sola prueba a cada una");
    assert.ok(who.includes("U2:get_vod_streams:1126"));
    assert.deepEqual(waits, [], "ninguna espera por la cuenta no válida");
    assert.deepEqual(checkIndex(join(tmp, "acc1")), []);
  });

  await test("a mitad del barrido, la cuenta que rechaza el login se cambia en el acto por otra del mismo panel, nunca por otro panel", async () => {
    ACCOUNTS.U1.served = 0;
    ACCOUNTS.U1.authAfter = 2; // the probe and one category, then the login is rejected
    state.lines = accountsOf([[iptv, "U1"], [iptv3, "OTHER"], [iptv2, "U2"]]);
    const waits = [];
    const mark = state.who.length;
    const r = await run({ ...base, sleep: waitsInto(waits), out: join(tmp, "acc2"), prevDir: out3 });
    state.lines = null;
    delete ACCOUNTS.U1.authAfter;
    const who = state.who.slice(mark);
    assert.equal(r.published, true);
    assert.equal(r.mode, "partial", "empieza con la cuenta del índice anterior");
    assert.deepEqual(who.filter((w) => w.startsWith("U1:")), ["U1:get_vod_categories:", "U1:get_vod_streams:1147", "U1:get_vod_streams:1149"]);
    assert.deepEqual(who.filter((w) => w.startsWith("OTHER:")), ["OTHER:get_vod_categories:"], "otro panel: solo la prueba");
    assert.ok(who.includes("U2:get_vod_streams:1149") && who.includes("U2:get_series:684"));
    assert.equal(r.manifest.src, tagOf(iptv2), "src = la cuenta en uso al terminar");
    assert.deepEqual(waits, []);
    assert.deepEqual(checkIndex(join(tmp, "acc2")), []);
  });

  await test("la cuenta que deja de responder se cambia tras 4 fallos seguidos por otra del mismo panel", async () => {
    ACCOUNTS.U1.served = 0;
    ACCOUNTS.U1.downAfter = 2;
    state.lines = accountsOf([[iptv, "U1"], [iptv2, "U2"]]);
    const waits = [];
    const r = await run({ ...base, sleep: waitsInto(waits), out: join(tmp, "acc3"), prevDir: out3 });
    state.lines = null;
    delete ACCOUNTS.U1.downAfter;
    assert.equal(r.published, true);
    assert.equal(r.manifest.src, tagOf(iptv2));
    assert.deepEqual(waits, [10000, 30000, 90000]);
  });

  await test("sin otra cuenta del panel no cambia de panel: no publica y el índice anterior queda", async () => {
    ACCOUNTS.U1.served = 0;
    ACCOUNTS.U1.authAfter = 2;
    state.lines = accountsOf([[iptv, "U1"], [iptv3, "OTHER"]]);
    let mark = state.who.length;
    const r = await run({ ...base, out: join(tmp, "acc4"), prevDir: out3 });
    delete ACCOUNTS.U1.authAfter;
    assert.equal(r.published, false);
    assert.equal(r.reason, "no-account");
    assert.deepEqual(state.who.slice(mark).filter((w) => w.startsWith("OTHER:")), ["OTHER:get_vod_categories:"], "nada de otro panel");
    assert.ok(!existsSync(join(tmp, "acc4")));
    // From the start: only a rejected login and another panel.
    state.lines = accountsOf([[iptv, "AUTH0"], [iptv3, "OTHER"]]);
    mark = state.who.length;
    const r2 = await run({ ...base, out: join(tmp, "acc5"), prevDir: out3 });
    state.lines = null;
    assert.equal(r2.reason, "no-account");
    assert.deepEqual(state.who.slice(mark), ["AUTH0:get_vod_categories:", "OTHER:get_vod_categories:"]);
    assert.ok(!existsSync(join(tmp, "acc5")));
  });

  await test("a una cuenta del panel que no tiene una categoría no se le pide: se conserva del índice anterior", async () => {
    ACCOUNTS.U1.served = 0;
    ACCOUNTS.U1.authAfter = 2;
    state.lines = accountsOf([[iptv, "U1"], [iptv2, "SUB"]]);
    const mark = state.who.length;
    const r = await run({ ...base, out: join(tmp, "acc6"), prevDir: out3, minFit: 0.7 }); // SUB carries 3 of the index's 4
    state.lines = null;
    delete ACCOUNTS.U1.authAfter;
    const who = state.who.slice(mark);
    assert.ok(who.includes("SUB:get_vod_categories:") && who.includes("SUB:get_series:684"));
    assert.ok(!who.includes("SUB:get_vod_streams:1149"), "1149 no está en SUB");
    assert.equal(r.published, false);
    assert.equal(r.reason, "coverage");
  });

  await test("no publica un índice que pierde más de un cuarto de una sección (una cuenta del panel sin series); con --force sí", async () => {
    state.lines = accountsOf([[iptv, "NOSERIES"]]);
    const r = await run({ ...base, out: join(tmp, "shr1"), prevDir: out3, full: true, shrinkMin: 1 });
    assert.equal(r.published, false);
    assert.equal(r.reason, "shrink");
    assert.ok(r.shrunk.some((s) => s.kind === "series" && s.before > 0 && s.after === 0), JSON.stringify(r.shrunk));
    assert.ok(!existsSync(join(tmp, "shr1")), "nada escrito");
    const r2 = await run({ ...base, out: join(tmp, "shr2"), prevDir: out3, full: true, shrinkMin: 1, force: true });
    state.lines = null;
    assert.equal(r2.published, true);
    assert.equal(r2.manifest.series.count, 0);
    // The same run with the account's series: nothing shrank, it publishes without --force.
    const r3 = await run({ ...base, out: join(tmp, "shr3"), prevDir: out3, full: true, shrinkMin: 1 });
    assert.equal(r3.published, true);
  });

  // A Spanish-language panel with its own numbering (as the service's panels looked on 2026-11-24) and a smaller one.
  const NEW_VOD = ["ESTRENOS 2026", "ACCIÓN", "COMEDIA", "TERROR", "DRAMA", "ANIMACIÓN", "AVENTURAS", "CIENCIA FICCIÓN", "SUSPENSO", "INFANTIL", "DOCUMENTAL", "ESTRENOS CAM"]
    .map((n, i) => ({ category_id: String(30 + i), category_name: "CINE | " + n }));
  const NEW_SERIES = [{ category_id: "97", category_name: "SERIES ¦ NETFLIX" }];
  ACCOUNTS.NEWP = { pass: "P7", vod: NEW_VOD, series: NEW_SERIES };
  ACCOUNTS.NEWP2 = { pass: "P8", vod: NEW_VOD, series: NEW_SERIES };
  ACCOUNTS.SMALLES = { pass: "P9", vod: NEW_VOD.slice(0, 4).map((c) => ({ ...c, category_id: "5" + c.category_id })), series: [] };
  const newData = () => {
    data.vod[30] = [{ name: "Estreno del panel nuevo (2026)", year: "2026" }];
    data.vod[31] = [{ name: "Spider-Man: Sin camino a casa (2021)", year: "2021" }, { name: "Acción Nueva (2024)", year: "2024" }];
    data.series[97] = [{ name: "Serie Nueva (2025)", year: "2025" }];
  };

  await test("reglas del cambio de panel: categorías en español, tabla incluida, tabla propia", () => {
    assert.equal(spanishScore(NEW_VOD), 11, "la CAM no cuenta");
    assert.equal(spanishScore(OTHER_VOD), 0);
    assert.equal(spanishScore([{ category_id: "1", category_name: "→ VOD ESTRENOS 2026 ←" }, { category_id: "2", category_name: "FILM IN SALA" }, { category_id: "3", category_name: "EROS +18 COMEDIA" }]), 1);
    assert.equal(fitsBundledTable(CATS_VOD), true);
    assert.equal(fitsBundledTable(NEW_VOD), false, "ids que la tabla no conoce");
    assert.equal(fitsBundledTable(OTHER_VOD), false, "mismos ids, otros nombres");
    const t = ownTable("vod", NEW_VOD);
    assert.deepEqual(t["31"].slice(0, 3), ["Cine | Acción", "es-419", "generos"]);
    assert.equal(t["41"][4], "h", "la CAM queda oculta");
    assert.equal(tablesFor(CATS_VOD).own, false);
    assert.equal(tablesFor(NEW_VOD).own, true);
  });

  await test("panel que ya no está (su cuenta rechaza el login, ninguna lo lleva): se cambia al panel en español y se rehace entero", async () => {
    newData();
    state.lines = accountsOf([[iptv, "AUTH0"], [iptv3, "OTHER"], [iptv3, "SMALLES"], [iptv2, "NEWP"]]);
    const mark = state.who.length;
    const r = await run({ ...base, out: join(tmp, "mv1"), prevDir: out3 });
    state.lines = null;
    const who = state.who.slice(mark);
    assert.equal(r.published, true, JSON.stringify(r));
    assert.equal(r.mode, "full");
    assert.equal(r.manifest.src, tagOf(iptv2));
    assert.deepEqual(r.manifest.deltas, [], "otro panel: snapshot nuevo, sin delta contra el viejo");
    assert.deepEqual(titlesOf(join(tmp, "mv1")).sort(), ["Acción Nueva", "Estreno del panel nuevo", "Serie Nueva", "Spider-Man: Sin camino a casa"]);
    const cats = json(join(tmp, "mv1"), "categories.json");
    assert.deepEqual(cats.vod["31"].slice(0, 2), ["Cine | Acción", "es-419"], "la tabla del panel nuevo");
    assert.ok(!cats.vod["1147"], "nada de la tabla del panel viejo");
    assert.deepEqual(cats.series["97"].slice(0, 3), ["Series ¦ Netflix", "es-419", "plataformas"]);
    assert.ok(!who.some((w) => /^(OTHER|SMALLES):get_(vod_streams|series):/.test(w)), "a los otros paneles solo la prueba");
    assert.ok(!who.includes("NEWP:get_vod_streams:41"), "la CAM no se pide");
    assert.deepEqual(checkIndex(join(tmp, "mv1")), []);

    // The next day the new panel is the index's panel: a normal partial refresh on it, nothing changed, nothing published.
    const mark2 = state.who.length;
    state.lines = accountsOf([[iptv2, "NEWP"], [iptv3, "OTHER"]]);
    const r2 = await run({ ...base, out: join(tmp, "mv2"), prevDir: join(tmp, "mv1") });
    state.lines = null;
    assert.equal(r2.reason, "unchanged", JSON.stringify(r2));
    assert.deepEqual(state.who.slice(mark2).filter((w) => w.startsWith("OTHER:")), [], "la primera cuenta ya es del panel");
  });

  await test("no se cambia de panel si la cuenta del índice solo no responde, o si respondieron muy pocas", async () => {
    newData();
    ACCOUNTS.U1.served = 0;
    ACCOUNTS.U1.downAfter = 0; // the index's own account does not answer: maybe a blip, not a gone panel
    state.lines = accountsOf([[iptv, "U1"], [iptv3, "OTHER"], [iptv3, "SMALLES"], [iptv2, "NEWP"]]);
    const r = await run({ ...base, out: join(tmp, "mv3"), prevDir: out3 });
    delete ACCOUNTS.U1.downAfter;
    assert.equal(r.reason, "no-account");
    assert.ok(!existsSync(join(tmp, "mv3")));
    // Its login is rejected, but only two accounts answered (fewer than MIN_ANSWERS_TO_MOVE).
    state.lines = accountsOf([[iptv, "AUTH0"], [iptv3, "OTHER"], [iptv2, "NEWP"]]);
    const r2 = await run({ ...base, out: join(tmp, "mv4"), prevDir: out3 });
    assert.equal(r2.reason, "no-account");
    // Enough answers, but no panel with enough Spanish-language categories.
    const r3 = await run({ ...base, out: join(tmp, "mv5"), prevDir: out3, minAnswers: 2, minSpanish: 20 });
    state.lines = null;
    assert.equal(r3.reason, "no-account");
    assert.ok(!existsSync(join(tmp, "mv4")) && !existsSync(join(tmp, "mv5")));
  });

  await test("check-index detecta credenciales, desalineación, hashes y cadenas de deltas rotas", () => {
    const bad = join(tmp, "bad");
    cpSync(out3, bad, { recursive: true });
    const m = json(bad, "index.json");
    const f = join(bad, m.movies.parts.find((p) => json(bad, p).year.length > 0));
    const p = JSON.parse(readFileSync(f, "utf8"));
    p.year.pop();
    writeFileSync(f, JSON.stringify(p));
    assert.ok(checkIndex(bad).some((x) => /desalineadas|hash|bytes/.test(x)));
    cpSync(out3, join(tmp, "bad2"), { recursive: true });
    writeFileSync(join(tmp, "bad2", "categories.json"), '{"v":1,"x":"http://h/get.php?username=a&password=b"}');
    assert.ok(checkIndex(join(tmp, "bad2")).some((x) => /username=|url/.test(x)));
    cpSync(out3, join(tmp, "bad3"), { recursive: true });
    const m3 = json(join(tmp, "bad3"), "index.json");
    rmSync(join(tmp, "bad3", m3.deltas[0].file));
    assert.ok(checkIndex(join(tmp, "bad3")).some((x) => /falta/.test(x)));
    cpSync(out3, join(tmp, "bad4"), { recursive: true });
    const m4 = json(join(tmp, "bad4"), "index.json");
    const dn = join(tmp, "bad4", m4.deltas[0].file);
    const d4 = JSON.parse(readFileSync(dn, "utf8"));
    d4.total += 5;
    writeFileSync(dn, JSON.stringify(d4));
    assert.ok(checkIndex(join(tmp, "bad4")).some((x) => /bytes|total/.test(x)));
  });

  await test("el registro no imprime credenciales ni hosts del servicio", async () => {
    console.error = (...a) => logs.push(a.join(" "));
    await run({ ...base, out: join(tmp, "o9"), prevDir: out3, full: true, force: true, verbose: true });
    console.error = origErr;
    const all = logs.join("\n");
    assert.ok(all.length > 50);
    assert.ok(!/U1|P1|DEAD|username|password|127\.0\.0\.1/.test(all), all);
  });
} finally {
  console.error = origErr;
  for (const s of [dead, iptv, iptv2, iptv3, noPrev, brokenPrev]) s.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${passed} pruebas OK`);
