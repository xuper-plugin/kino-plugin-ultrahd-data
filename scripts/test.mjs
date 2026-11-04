// Pruebas del generador contra servidores falsos (IPTV y TMDB): nada toca la red real.  node scripts/test.mjs
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTitle, findKey, run, dayNumber, pickTmdb, MISS_RETRY_DAYS } from "./gen-index.mjs";
import { checkIndex } from "./check-index.mjs";

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("✓", name); };
const listen = (handler) => new Promise((res) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => res(s)); });
const port = (s) => s.address().port;
const sleep = async () => {};

// ---- datos falsos ----
const CATS_VOD = [
  { category_id: "1147", category_name: "ESTRENOS 2026 - (LAT)" },
  { category_id: "1126", category_name: "ACCIÓN - (LAT)" },
  { category_id: "1047", category_name: "EROS +18" },
  { category_id: "1158", category_name: "TestApp" },
  ...[1201, 1202, 1203, 1204, 1205, 1206, 1207, 1208].map((id) => ({ category_id: String(id), category_name: "VACÍA " + id + " - (LAT)" })),
];
const ITEMS_VOD = {
  1147: [{ name: "Spider-Man: Sin camino a casa (LAT) (2021)", year: "2021" }, { name: "El paseo 8 (2025)", year: "2025" }, { name: "Scream 7 (LAT) (2026)", year: "2026" }],
  1126: [{ name: "Spider-Man: Sin camino a casa (LAT) (2021)", year: "2021" }, { name: "Acción Total (CAST)", year: "1990" }, { name: "Fantasía 2000 (LAT)", year: "" }],
  1047: [{ name: "Película adulta (LAT) (2020)", year: "2020" }],
  1158: [{ name: "Prueba (2000)", year: "2000" }],
};
const CATS_SERIES = [{ category_id: "684", category_name: "NETFLIX (LAT)" }];
const ITEMS_SERIES = { 684: [{ name: "La casa de papel (2017)", year: "2017" }, { name: "Dark (LAT)", release_date: "2017-12-01" }] };

function fakeIptv(state) {
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/bootstrap.php") {
      if (u.searchParams.get("servers")) { res.end(`http://127.0.0.1:${state.deadPort}/get.php?username=DEAD&password=DEAD&type=m3u_plus\nhttp://127.0.0.1:${port(s)}/get.php?username=U1&password=P1&type=m3u_plus 🌐\n`); return; }
      const code = Number(req.headers["x-vegeta-version-code"] || 0);
      state.codes.push(code);
      if (code < 22) { res.statusCode = 426; res.end(JSON.stringify({ ok: false, error: "upgrade_required", minimum_version_code: 22, latest_version_code: 22 })); return; }
      res.end(JSON.stringify({ ok: true, servers_text: "", servers_url: `http://127.0.0.1:${port(s)}/bootstrap.php?servers=1` }));
      return;
    }
    if (u.pathname === "/player_api.php") {
      const action = u.searchParams.get("action");
      const cat = u.searchParams.get("category_id");
      state.calls.push(`${action}:${cat || ""}`);
      if (u.searchParams.get("username") !== "U1") { res.statusCode = 403; res.end("{}"); return; }
      if (cat && state.failCats.has(cat)) { res.statusCode = 500; res.end("boom"); return; }
      const body = action === "get_vod_categories" ? CATS_VOD : action === "get_series_categories" ? CATS_SERIES
        : action === "get_vod_streams" ? ITEMS_VOD[cat] : action === "get_series" ? ITEMS_SERIES[cat] : null;
      res.end(JSON.stringify(body || []));
      return;
    }
    res.statusCode = 404; res.end("");
  });
  return s;
}

const mkState = (deadPort) => ({ deadPort, codes: [], calls: [], failCats: new Set() });
const dead = await listen((req, res) => { res.statusCode = 500; res.end("dead"); });
const state = mkState(port(dead));
const iptv = fakeIptv(state);
await new Promise((r) => iptv.listen(0, "127.0.0.1", r));
const bootstrapUrl = `http://127.0.0.1:${port(iptv)}/bootstrap.php`;

const tmdbState = { queries: [] };
const tmdb = await listen((req, res) => {
  const u = new URL(req.url, "http://x");
  const q = u.searchParams.get("query");
  tmdbState.queries.push(q);
  const known = { "Spider-Man: Sin camino a casa": [{ id: 634649, title: "Spider-Man: No Way Home", original_title: "Spider-Man: No Way Home", release_date: "2021-12-15" }, { id: 1, title: "Spider-Man: Sin camino a casa", release_date: "2021-12-15" }],
    "El paseo 8": [{ id: 777, title: "El paseo 8", release_date: "2025-02-02" }], "La casa de papel": [{ id: 71446, name: "La casa de papel", original_name: "La casa de papel", first_air_date: "2017-05-02" }] };
  res.end(JSON.stringify({ results: known[q] || [] }));
});
const tmdbBase = `http://127.0.0.1:${port(tmdb)}`;

const tmp = mkdtempSync(join(tmpdir(), "uhd-data-test-"));
const noPrev = await listen((req, res) => { res.statusCode = 404; res.end("nope"); });
const brokenPrev = await listen((req, res) => { res.statusCode = 500; res.end("err"); });
const base = { sleep, bootstrapUrl, verbose: false, prevUrl: `http://127.0.0.1:${port(noPrev)}/`, minDelay: 0, maxDelay: 0, rps: 1e6 };
const logs = [];
const origErr = console.error;

try {
  await test("cleanTitle: sufijos de idioma, año entre paréntesis y campo year", () => {
    assert.deepEqual(cleanTitle("Spider-Man: Sin camino a casa (LAT) (2021)", "2021"), { name: "Spider-Man: Sin camino a casa", year: 2021 });
    assert.deepEqual(cleanTitle("Acción Total (CAST)", "1990"), { name: "Acción Total", year: 1990 });
    assert.deepEqual(cleanTitle("Fantasía 2000 (LAT)", ""), { name: "Fantasía 2000", year: 0 });
    assert.deepEqual(cleanTitle("Dark [CAST]", ""), { name: "Dark", year: 0 });
    assert.deepEqual(cleanTitle("007: Skyfall (ENG) (2012)", ""), { name: "007: Skyfall", year: 2012 });
  });

  await test("findKey: minúsculas, sin acentos ni signos, conserva otras escrituras", () => {
    assert.equal(findKey("Spider-Man: Sin camino a casa"), "spider man sin camino a casa");
    assert.equal(findKey("Ácción ÑANDÚ!"), "accion nandu");
    assert.equal(findKey("Государственные похороны"), "государственные похороны");
  });

  await test("pickTmdb: igual y año ±1, o único resultado; si no, 0", () => {
    const e = { kind: "movies", find: "el paseo 8", year: 2025 };
    assert.equal(pickTmdb([{ id: 5, title: "El Paseo 8", release_date: "2024-12-30" }], e), 5);
    assert.equal(pickTmdb([{ id: 5, title: "Otra", release_date: "2025-01-01" }, { id: 6, title: "Otra más", release_date: "2025-01-01" }], e), 0);
    assert.equal(pickTmdb([{ id: 9, title: "Otra", release_date: "2025-01-01" }], e), 9);
    assert.equal(pickTmdb([{ id: 5, title: "El paseo 8", release_date: "2010-01-01" }], e), 0);
  });

  const out1 = join(tmp, "out1");
  let r1;
  await test("primera corrida: bootstrap 426→código nuevo, servidor muerto→siguiente, adultas/ocultas no se piden", async () => {
    r1 = await run({ ...base, out: out1, prevDir: join(tmp, "none"), apiKey: "test-key", tmdbBase });
    assert.equal(r1.published, true);
    assert.deepEqual(state.codes.slice(0, 2), [21, 22]);
    assert.ok(!state.calls.includes("get_vod_streams:1047") && !state.calls.includes("get_vod_streams:1158"), "no debe pedir adultas ni de prueba");
    assert.equal(r1.manifest.movies.count, 5); // spider(1) + el paseo + scream + acción total + fantasía 2000
    assert.equal(r1.manifest.series.count, 2);
    assert.equal(r1.coverage, 1);
  });

  await test("check-index pasa y el contenido es el esperado (cats fusionadas, TMDB, sin credenciales)", () => {
    assert.deepEqual(checkIndex(out1), []);
    const m = JSON.parse(readFileSync(join(out1, "index.json"), "utf8"));
    const p = JSON.parse(readFileSync(join(out1, m.movies.parts[0]), "utf8"));
    const all = m.movies.parts.map((f) => JSON.parse(readFileSync(join(out1, f), "utf8")));
    const names = all.flatMap((x) => (x.name ? x.name.split("\n") : []));
    const cats = all.flatMap((x) => x.cats);
    const tmdbIds = all.flatMap((x) => x.tmdb);
    const spider = names.indexOf("Spider-Man: Sin camino a casa");
    assert.deepEqual(cats[spider], [1126, 1147]);
    assert.equal(tmdbIds[spider], 1); // coincidencia exacta con el título en español (la primera con id 634649 es otro título)
    assert.ok(!names.some((n) => /adulta|Prueba/.test(n)));
    assert.ok(p.year.every(Number.isInteger));
    for (const f of ["index.json", "categories.json", "tmdb-cache.json", ...m.movies.parts, ...m.series.parts]) {
      const t = readFileSync(join(out1, f), "utf8");
      assert.ok(!/U1|P1|DEAD|username=|password=|127\.0\.0\.1/.test(t), `${f} no debe llevar credenciales ni hosts`);
    }
  });

  await test("TMDB: solo consulta claves nuevas; segunda corrida no repite búsquedas", async () => {
    const first = tmdbState.queries.length;
    assert.equal(first, 7); // 7 títulos, 0 en caché
    const out2 = join(tmp, "out2");
    const r2 = await run({ ...base, out: out2, prevDir: out1, apiKey: "test-key", tmdbBase, force: true });
    assert.equal(tmdbState.queries.length, first, "ni un solo query nuevo");
    assert.equal(r2.stats.cached, r1.stats.found);
    assert.equal(r2.stats.queried, 0);
    assert.equal(r2.stats.queried + r2.stats.retried, 0);
  });

  await test("sin coincidencia: no se reintenta antes de 14 días y luego sí (con tope)", async () => {
    const out3 = join(tmp, "out3");
    const before = tmdbState.queries.length;
    await run({ ...base, out: out3, prevDir: out1, apiKey: "test-key", tmdbBase, force: true });
    assert.equal(tmdbState.queries.length, before, "dentro de 14 días no hay reintentos");
    const cache = JSON.parse(readFileSync(join(out1, "tmdb-cache.json"), "utf8"));
    const old = dayNumber() - MISS_RETRY_DAYS - 1;
    for (const k of Object.keys(cache.miss)) cache.miss[k] = old;
    writeFileSync(join(out1, "tmdb-cache.json"), JSON.stringify(cache));
    const misses = Object.keys(cache.miss).length;
    assert.ok(misses > 0);
    await run({ ...base, out: join(tmp, "out4"), prevDir: out1, apiKey: "test-key", tmdbBase, force: true });
    assert.equal(tmdbState.queries.length, before + misses, "pasados 14 días se reintentan los sin coincidencia");
  });

  const outBase = join(tmp, "base");
  await run({ ...base, out: outBase, prevDir: out1, apiKey: "", force: true });
  await test("sin cambios: no publica; una categoría que falla se conserva del índice anterior", async () => {
    const r = await run({ ...base, out: join(tmp, "out5"), prevDir: outBase, apiKey: "" });
    assert.equal(r.published, false);
    assert.equal(r.reason, "unchanged");
    state.failCats.add("1126");
    const r6 = await run({ ...base, out: join(tmp, "out6"), prevDir: outBase, apiKey: "", force: true });
    assert.equal(r6.published, true);
    assert.ok(r6.coverage < 1 && r6.coverage >= 0.9, "cobertura " + r6.coverage);
    const m = JSON.parse(readFileSync(join(tmp, "out6", "index.json"), "utf8"));
    assert.equal(m.movies.count, 5, "los títulos de la categoría caída siguen en el índice");
    state.failCats.clear();
  });

  await test("cobertura < 90%: no se publica", async () => {
    for (const c of ["1147", "1126", "684"]) state.failCats.add(c);
    for (const c of ["1201", "1202"]) state.failCats.add(c);
    const r = await run({ ...base, out: join(tmp, "out7"), prevDir: outBase, apiKey: "" });
    assert.equal(r.published, false);
    assert.equal(r.reason, "coverage");
    assert.ok(!existsSync(join(tmp, "out7")));
    state.failCats.clear();
  });

  await test("falla la descarga del índice anterior: no se asume vacío, no se consulta nada", async () => {
    const calls = state.calls.length;
    const r = await run({ ...base, out: join(tmp, "out8"), prevDir: join(tmp, "none"), prevUrl: `http://127.0.0.1:${port(brokenPrev)}/`, apiKey: "test-key", tmdbBase });
    assert.equal(r.published, false);
    assert.equal(r.reason, "prev-error");
    assert.equal(state.calls.length, calls, "no debe pedir nada al servicio");
  });

  await test("check-index detecta credenciales, desalineación y hashes rotos", () => {
    const bad = join(tmp, "bad");
    cpSync(out1, bad, { recursive: true });
    const m = JSON.parse(readFileSync(join(bad, "index.json"), "utf8"));
    const f = join(bad, m.movies.parts.find((p) => JSON.parse(readFileSync(join(bad, p), "utf8")).year.length > 0));
    const p = JSON.parse(readFileSync(f, "utf8"));
    p.year.pop();
    writeFileSync(f, JSON.stringify(p));
    assert.ok(checkIndex(bad).some((x) => /desalineadas|hash|bytes/.test(x)));
    cpSync(out1, join(tmp, "bad2"), { recursive: true });
    writeFileSync(join(tmp, "bad2", "categories.json"), '{"v":1,"x":"http://h/get.php?username=a&password=b"}');
    assert.ok(checkIndex(join(tmp, "bad2")).some((x) => /username=|url/.test(x)));
  });

  await test("el registro no imprime credenciales ni hosts del servicio", async () => {
    console.error = (...a) => logs.push(a.join(" "));
    await run({ ...base, out: join(tmp, "out9"), prevDir: out1, apiKey: "test-key", tmdbBase, force: true, verbose: true });
    console.error = origErr;
    const all = logs.join("\n");
    assert.ok(all.length > 50);
    assert.ok(!/U1|P1|DEAD|username|password|127\.0\.0\.1|test-key/.test(all), all);
  });
} finally {
  console.error = origErr;
  for (const s of [dead, iptv, tmdb, noPrev, brokenPrev]) s.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${passed} pruebas OK`);
