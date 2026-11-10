// THE NATIVE FLOW, SCRIPTED, against the native harness's local Worker and LOCAL D1 (native-harness.sh `check`):
// what the phone does with its device token and what the laptop does with the owner's cookie, each answer and the
// rows checked. Loopback only; synthetic data only. Usage: node native-harness-check.mjs <base> <cookie jar> <state dir>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [base, jarPath, state] = process.argv.slice(2);
if (!base || !jarPath || !state) throw new Error("usage: native-harness-check.mjs <base> <cookie jar> <state dir>");
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error(`loopback only, not ${base}`);
const worker = join(dirname(fileURLToPath(import.meta.url)), "..");

// The owner's session cookie, from curl's jar (an HttpOnly cookie's line starts "#HttpOnly_").
const sessionCookie = readFileSync(jarPath, "utf8")
  .split("\n")
  .map((l) => l.split("\t"))
  .find((f) => f.length >= 7 && f[5] === "rg_session")?.[6];
if (!sessionCookie) throw new Error("no rg_session in the cookie jar: run `native-harness.sh up` first");
const COOKIE = `rg_session=${sessionCookie}`;

async function call(method, path, { cookie = false, bearer, body, raw } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = COOKIE;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { text };
  }
  return { status: res.status, json };
}

/** A read of the harness's LOCAL D1 (never --remote). */
function sql(command) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "run-garden-db", "--local", "-c", "wrangler.dev.toml", "--persist-to", state, "--json", "--command", command], {
    cwd: worker,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  return JSON.parse(out)[0].results;
}

let passed = 0;
const failed = [];
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed += 1;
  else failed.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
}

// 1. The laptop mints a code; two phones redeem it at once: one device.
const minted = await call("POST", "/api/native/pairings", { cookie: true, body: {} });
check("mint: 200 and an 8-character Crockford code", [minted.status, /^[0-9A-HJKMNP-TV-Z]{8}$/.test(minted.json.code ?? "")], [200, true]);
const before = sql("select count(*) as n from native_devices")[0].n;
const both = await Promise.all([
  call("POST", "/api/native/pair", { body: { code: minted.json.code, label: "Harness phone A" } }),
  call("POST", "/api/native/pair", { body: { code: minted.json.code, label: "Harness phone B" } }),
]);
check("two concurrent redemptions on local D1: one 200, one 401 pair_failed", both.map((a) => a.status).sort(), [200, 401]);
check("…and exactly one device row", sql("select count(*) as n from native_devices")[0].n - before, 1);
const won = both.find((a) => a.status === 200).json;
const token = won.token;
check("the token is shown once and stored nowhere", sql(`select count(*) as n from native_devices where id = '${token}' or label = '${token}'`)[0].n, 0);
check("pending: the device is 401 device_pending", (await call("GET", "/api/native/me", { bearer: token })).json, { error: "device_pending" });

// 2. The laptop sees it with its check number and confirms it.
const listed = await call("GET", "/api/native/devices", { cookie: true });
const pending = listed.json.devices.find((d) => d.state === "pending" && d.check === won.check);
check("the laptop lists the pending phone with the phone's check number", !!pending, true);
check("Confirm: 200", (await call("POST", `/api/native/devices/${pending.id}/confirm`, { cookie: true, body: { check: won.check } })).status, 200);
const me = await call("GET", "/api/native/me", { bearer: token });
check("active: /api/native/me is {userId, device}", Object.keys(me.json).sort(), ["device", "userId"]);

// 3. Off the slice: refused.
for (const [method, path] of [["GET", "/api/plan/today"], ["GET", "/api/auth/me"], ["POST", "/api/native/pairings"], ["GET", "/api/native/devices"], ["POST", "/api/settings/delete-all"]]) {
  check(`${method} ${path} with the token: 403 out_of_scope`, (await call(method, path, { bearer: token, body: method === "POST" ? {} : undefined })).json, { error: "out_of_scope" });
}
check("a cookie and the token together: 400", (await call("GET", "/api/native/me", { cookie: true, bearer: token })).status, 400);

// 4. The smallest authenticated workout: a session made on the laptop for today, then the phone's GET, Build, Start, save.
const day = (await call("GET", "/api/native/today", { bearer: token })).json.today;
const doc = {
  version: 1,
  title: "Harness hips and back",
  intent: { summary: "Wake the glutes and brace the trunk.", goals: ["posture"], focus: [], effort: "maintain" },
  parts: [{ purpose: "main", format: "straight", items: [{ kind: "exercise", libraryId: "bridge", dose: { sets: 2, reps: 12, restSec: 30 } }, { kind: "exercise", libraryId: "deadBug", dose: { sets: 2, reps: 8, restSec: 30 } }] }],
  source: { kind: "studio" },
};
const made = await call("POST", "/api/workouts", { cookie: true, body: { doc, date: day, time: "23:30", clientId: `harness-${Date.now()}` } });
check("the laptop makes today's session", made.status < 300, true);
const id = made.json.workout.id;
check("the phone's day lists it, trimmed", (await call("GET", "/api/native/today", { bearer: token })).json.sessions.find((s) => s.id === id) && Object.keys((await call("GET", "/api/native/today", { bearer: token })).json.sessions.find((s) => s.id === id)).sort(), ["category", "date", "id", "sport", "state", "time", "title"]);
check("GET /api/sessions/:id with the token: 200", (await call("GET", `/api/sessions/${id}`, { bearer: token })).status, 200);
check("Build with an override: 403 out_of_scope", (await call("POST", `/api/sessions/${id}/build`, { bearer: token, body: { overrides: { mode: "build" } } })).json, { error: "out_of_scope" });
const built = await call("POST", `/api/sessions/${id}/build`, { bearer: token, body: {} });
check("Build {}: 200", built.status, 200);
const b = built.json.build;
const started = await call("POST", `/api/sessions/${id}/start`, { bearer: token, body: { buildId: b.buildId } });
check("Start {buildId}: 200, started", [started.status, started.json.contentState], [200, "started"]);
const performedId = `harness-${id}`;
const now = Date.now();
const save = {
  id: performedId, source: "app", sourceRef: null, workoutId: id, buildId: b.buildId, localDate: b.date,
  startedAt: new Date(now - 30 * 60_000).toISOString(), endedAt: new Date(now).toISOString(), seconds: 1800, plannedSeconds: b.plannedSeconds ?? 1800,
  minutes: b.minutes ?? 30, mode: b.mode ?? "build", theme: b.theme ?? null, locationId: b.locationId ?? null, blockRef: b.blockRef ?? null, blockNumber: null,
  completed: true, stepsTotal: (b.steps ?? []).length || 1, stepsDone: (b.steps ?? []).length || 1,
  movesDone: (b.items ?? []).map((i) => ({ exerciseId: i.exerciseId, seconds: 120, ...(i.slotKey ? { slotKey: i.slotKey } : {}) })),
  note: null, newMove: b.newMove ?? null,
  entries: [{ exerciseId: b.items?.[0]?.exerciseId ?? "bridge", implement: null, format: "straight", perSide: false, sets: [{ setIndex: 0, reps: 10, seconds: null, load: null }] }],
  checks: [], review: {},
};
const exercise = save.entries[0].exerciseId;
check("a save carrying a graduation: 403 out_of_scope", (await call("PUT", `/api/sessions/performed/${performedId}`, { bearer: token, body: { ...save, review: { graduations: [{ family: "hinge", to: exercise }] } } })).json, { error: "out_of_scope" });
const raw = JSON.stringify(save);
const first = await call("PUT", `/api/sessions/performed/${performedId}`, { bearer: token, raw });
check("the save: saved, matched", [first.json.status, first.json.matched], ["saved", true]);
check("the same save again (an answer lost): same_payload", (await call("PUT", `/api/sessions/performed/${performedId}`, { bearer: token, raw })).json, { status: "same_payload" });
check("the web sees it done", (await call("GET", `/api/sessions/${id}`, { cookie: true })).json.contentState, "done");
check("one performed session, by the phone's id", sql(`select id, workout_id as w, activity_id as a from performed_sessions where workout_id = '${id}'`), [{ id: performedId, w: id, a: performedId }]);
check("one live match, the app session's", sql(`select activity_id as a, method from workout_completion_matches where workout_id = '${id}' and undone_at is null`), [{ a: performedId, method: "app_session" }]);

// 5. More races on local D1: ten codes, each redeemed by four requests at once — one device each, never two.
const trials = [];
for (let t = 0; t < 10; t++) {
  const code = (await call("POST", "/api/native/pairings", { cookie: true, body: {} })).json.code;
  const n0 = sql("select count(*) as n from native_devices")[0].n;
  const answers = await Promise.all([0, 1, 2, 3].map((i) => call("POST", "/api/native/pair", { body: { code, label: `Race ${t}.${i}` } })));
  trials.push([answers.filter((a) => a.status === 200).length, sql("select count(*) as n from native_devices")[0].n - n0]);
}
check("ten races of four redemptions: one 200 and one device each", trials, Array.from({ length: 10 }, () => [1, 1]));

// 6. Revoke all: the phone is stopped at once.
check("Revoke all", (await call("POST", "/api/native/devices/revoke-all", { cookie: true, body: {} })).json.ok, true);
check("revoked: 401 device_revoked", (await call("GET", "/api/native/me", { bearer: token })).json, { error: "device_revoked" });

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  ${f}`);
  process.exit(1);
}
