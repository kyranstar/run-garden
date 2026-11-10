// THE NATIVE FLOW, SCRIPTED, against the native harness's local Worker and LOCAL D1 (native-harness.sh `check`):
// what the phone does with its device token and what the laptop does with the owner's cookie, each answer and the
// rows checked. Loopback only; synthetic data only. Usage: node native-harness-check.mjs <base> <cookie jar> <state dir>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

async function call(method, path, { cookie = false, bearer, body, raw, client } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = COOKIE;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  if (client) headers["CF-Connecting-IP"] = client;
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

// 5. More races on local D1: three codes (the mint bound is 5 a window, and this check mints 5 in all), each redeemed by
// four requests at once — one device each, never two. Each new code lifts the redeem throttles, so each race starts clean.
const trials = [];
for (let t = 0; t < 3; t++) {
  const code = (await call("POST", "/api/native/pairings", { cookie: true, body: {} })).json.code;
  const n0 = sql("select count(*) as n from native_devices")[0].n;
  const answers = await Promise.all([0, 1, 2, 3].map((i) => call("POST", "/api/native/pair", { body: { code, label: `Race ${t}.${i}` } })));
  trials.push([answers.filter((a) => a.status === 200).length, sql("select count(*) as n from native_devices")[0].n - n0]);
}
check("three races of four redemptions: one 200 and one device each", trials, Array.from({ length: 3 }, () => [1, 1]));

// 6. The rate controls on local D1. One client's burst of eight wrong guesses at a live code: exactly the per-client
// bound (3) is evaluated, every answer the same miss, and the code survives unburned for the phone.
const burstCode = (await call("POST", "/api/native/pairings", { cookie: true, body: {} })).json.code;
const wrong = `${burstCode[0] === "Z" ? "Y" : "Z"}${burstCode.slice(1)}`;
const burst = await Promise.all(Array.from({ length: 8 }, () => call("POST", "/api/native/pair", { body: { code: wrong, label: "Burst" }, client: "203.0.113.7" })));
check("a burst of 8 from one client: every answer 401 pair_failed", [...new Set(burst.map((a) => `${a.status} ${JSON.stringify(a.json)}`))], ['401 {"error":"pair_failed"}']);
check("…exactly 3 evaluated: the code's tries are 3, and it is unused", sql("select tries, used_at as used from native_pairings"), [{ tries: 3, used: null }]);
const sameClient = await call("POST", "/api/native/pair", { body: { code: burstCode, label: "Same client" }, client: "203.0.113.7" });
check("…and that client is throttled even with the right code", [sameClient.status, sameClient.json], [401, { error: "pair_failed" }]);
check("…while the code is untouched by the throttled attempt", sql("select tries from native_pairings")[0].tries, 3);
// Another client pairs with it. The next checks need distinct clients, which the local runtime gives only when it keeps
// a client's own CF-Connecting-IP (Cloudflare's edge sets it): checked, not assumed.
const otherClient = await call("POST", "/api/native/pair", { body: { code: burstCode, label: "Other client" }, client: "203.0.113.8" });
check("another client, the right code: 200, a pending phone (the local runtime keeps the client's CF-Connecting-IP)", [otherClient.status, otherClient.json.state], [200, "pending"]);

// THE COUNTERS' ATOMICITY, UNDER REAL CONCURRENCY. In-process tests run on one SQLite connection and can't show a lost
// update; workerd interleaves these requests across real awaits on the local D1, so a read-then-write counter would.
// Twenty new clients at once, no code live: the global count stops at exactly its bound + 1 (the refused crossing) — every
// increment landed, none lost — and the throttle is on.
const globalBefore = sql("select count from native_pair_limits where key = 'redeem:global'")[0]?.count ?? 0;
await Promise.all(Array.from({ length: 20 }, (_, i) => call("POST", "/api/native/pair", { body: { code: "ABCDEFGH", label: "Flood" }, client: `198.51.100.${i + 1}` })));
const global = sql("select count, blocked_until as blocked from native_pair_limits where key = 'redeem:global'")[0];
check(`twenty new clients at once (the global count was ${globalBefore}): it stops at exactly 11, throttled`, [global.count, global.blocked !== null], [11, true]);
// While it throttles, a new client writes nothing at all (review F3): no row for it.
const rowsBefore = sql("select count(*) as n from native_pair_limits")[0].n;
await Promise.all(Array.from({ length: 10 }, (_, i) => call("POST", "/api/native/pair", { body: { code: "ABCDEFGH", label: "Late" }, client: `2001:db8:${i + 1}::1` })));
check("…and ten more new clients during the throttle write no row", sql("select count(*) as n from native_pair_limits")[0].n, rowsBefore);
// Confirm under real concurrency: twenty wrong check numbers at once for the pending phone — exactly 3 tried, then revoked.
const pendingId = createHash("sha256").update(otherClient.json.token).digest("hex");
const okCheck = Number(otherClient.json.check);
const confirms = await Promise.all(
  Array.from({ length: 20 }, (_, i) => call("POST", `/api/native/devices/${pendingId}/confirm`, { cookie: true, body: { check: String((okCheck + 1 + i) % 10_000).padStart(4, "0") } })),
);
check("twenty wrong check numbers at once: the phone is revoked after exactly 3", sql(`select state, check_tries as tries, revoked_reason as why from native_devices where id = '${pendingId}'`), [{ state: "revoked", tries: 3, why: "check_failed" }]);
check("…and no more than 3 answers were a mismatch", confirms.filter((a) => a.json.error === "check_mismatch").length <= 3, true);
// Mint bound: this was the fifth code in the window; the sixth is refused, and says when to try again.
const sixth = await call("POST", "/api/native/pairings", { cookie: true, body: {} });
check("a sixth code in the window: 429 too_many_codes, retryAfter 600", [sixth.status, sixth.json], [429, { error: "too_many_codes", retryAfter: 600 }]);

// 7. Revoke all: the phone is stopped at once.
check("Revoke all", (await call("POST", "/api/native/devices/revoke-all", { cookie: true, body: {} })).json.ok, true);
check("revoked: 401 device_revoked", (await call("GET", "/api/native/me", { bearer: token })).json, { error: "device_revoked" });

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  ${f}`);
  process.exit(1);
}
