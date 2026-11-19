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

/** Several reads of the LOCAL D1 in one wrangler call (`;`-separated): each statement's rows, in order. */
function sqlAll(statements) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "run-garden-db", "--local", "-c", "wrangler.dev.toml", "--persist-to", state, "--json", "--command", statements.join(";\n")], {
    cwd: worker,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  return JSON.parse(out).map((r) => r.results);
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
// A new pairing is minted at the newest scope (stage 2b RG-NOTES §3.5, §8; DESIGN-2c §3; DESIGN-3 §3.5: training-v5), and
// /me says so.
check("…and its device is training-v5: {label, expiresAt, scope}", [Object.keys(me.json.device ?? {}).sort(), me.json.device?.scope], [["expiresAt", "label", "scope"], "training-v5"]);

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
const listed4 = (await call("GET", "/api/native/today", { bearer: token })).json.sessions.find((s) => s.id === id);
// `written` and `docRev`: the phone's read contract (kit v0.10), beside the fields it had.
check("the phone's day lists it, trimmed", listed4 && Object.keys(listed4).sort(), ["category", "date", "docRev", "id", "sport", "state", "time", "title", "written"]);
check("…written, at its document's revision 1", listed4 && [listed4.written, listed4.docRev], [true, 1]);
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
check("a save that is not the app's own (a watch review's source): 403 out_of_scope", (await call("PUT", `/api/sessions/performed/${performedId}`, { bearer: token, body: { ...save, source: "watch_review" } })).json, { error: "out_of_scope" });
const raw = JSON.stringify(save);
const first = await call("PUT", `/api/sessions/performed/${performedId}`, { bearer: token, raw });
check("the save: saved, matched", [first.json.status, first.json.matched], ["saved", true]);
check("the same save again (an answer lost): same_payload", (await call("PUT", `/api/sessions/performed/${performedId}`, { bearer: token, raw })).json, { status: "same_payload" });
check("the web sees it done", (await call("GET", `/api/sessions/${id}`, { cookie: true })).json.contentState, "done");
check("one performed session, by the phone's id", sql(`select id, workout_id as w, activity_id as a from performed_sessions where workout_id = '${id}'`), [{ id: performedId, w: id, a: performedId }]);
check("one live match, the app session's", sql(`select activity_id as a, method from workout_completion_matches where workout_id = '${id}' and undone_at is null`), [{ a: performedId, method: "app_session" }]);

// 4b. The phone's read contract (kit v0.10) on local D1: a course's outline is unwritten, and the phone's opening, Build and
// save of it are refused 409 not_written and write nothing — the row, its revisions, builds, saves and notes as they were.
const courseStart = await call("POST", "/api/plans/courses", { cookie: true, body: { course: "posture-neck", weekdays: [0, 1, 2, 3, 4, 5, 6], time: "23:45" } });
check("the laptop starts a course", courseStart.status, 200);
const [outline] = sql(
  "select w.id, w.effective_date as date from planned_workouts w join programs p on p.id = w.plan_id and p.user_id = w.user_id " +
    "where p.kind = 'course' and w.origin = 'program' and coalesce(w.content_state, 'outline') = 'outline' and w.archived_at is null order by w.effective_date, w.id limit 1",
);
check("…which places an unwritten outline", !!outline, true);
if (outline) {
  const trace = () =>
    sql(
      `select (select origin || ':' || coalesce(content_state, '-') || ':' || (workout_doc is null) || ':' || updated_at from planned_workouts where id = '${outline.id}') as row, ` +
        `(select count(*) from workout_doc_revisions where workout_id = '${outline.id}') as revisions, (select count(*) from sync_notes where workout_id = '${outline.id}') as notes, ` +
        `(select count(*) from session_builds where workout_id = '${outline.id}') as builds, (select count(*) from performed_sessions where workout_id = '${outline.id}') as saves`,
    )[0];
  const before = trace();
  check("the phone's GET of the outline: 409 not_written", (await call("GET", `/api/sessions/${outline.id}`, { bearer: token })).json, { error: "not_written" });
  check("…and its review basis: 409 not_written", (await call("GET", `/api/sessions/${outline.id}/review-basis`, { bearer: token })).json, { error: "not_written" });
  check("…and its Build {}: 409 not_written", (await call("POST", `/api/sessions/${outline.id}/build`, { bearer: token, body: {} })).json, { error: "not_written" });
  // A save naming it with no build (review finding 1): it would have completed the outline without a document.
  const outlineSave = {
    ...save, id: `harness-outline-${outline.id}`, workoutId: outline.id, buildId: null, localDate: outline.date, plannedSeconds: null, minutes: null, mode: null,
    theme: null, locationId: null, blockRef: null, stepsTotal: null, stepsDone: null, movesDone: [], newMove: null, entries: [],
  };
  check("…and a save naming it, no build: 409 not_written", (await call("PUT", `/api/sessions/performed/${outlineSave.id}`, { bearer: token, body: outlineSave })).json, { error: "not_written" });
  check("…and nothing was written: the row, its revisions, builds, saves and notes", trace(), before);
  if (outline.date === day) {
    check("the phone's day lists today's outline as unwritten", (await call("GET", "/api/native/today", { bearer: token })).json.sessions.find((s) => s.id === outline.id)?.written, false);
  }
}

// 4c. Stage 2a on local D1 (DESIGN §9, "Moves in run-garden too"): the phone (v3 holds v2's plan edits) moves, skips and puts back a session the
// laptop made; a move made against a stale view (Move's `from`) is refused 409 session_changed with nothing written; two
// moves from the same slot at once, interleaved by workerd on the local D1, land one and refuse the other; a v1 phone is
// still refused.
const plusDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const [d1, d2, d3] = [plusDays(day, 1), plusDays(day, 2), plusDays(day, 3)];
const planned = await call("POST", "/api/workouts", { cookie: true, body: { doc: { ...doc, title: "Harness plan edit" }, date: d1, time: "07:00", clientId: `harness-edit-${Date.now()}` } });
check("the laptop makes tomorrow's session", planned.status < 300, true);
const pid = planned.json.workout.id;
const editTrace = () =>
  sql(
    `select (select effective_date || ' ' || effective_time || ' ' || completion_state || ' ' || updated_at from planned_workouts where id = '${pid}') as row, ` +
      `(select count(*) from schedule_overrides where workout_id = '${pid}') as overrides, (select count(*) from audit_events where kind = 'workout_moved') as audits, ` +
      `(select count(*) from sync_intents where target_id = '${pid}') as intents`,
  )[0];
const slotOf = () => sql(`select effective_date as date, effective_time as time, completion_state as state from planned_workouts where id = '${pid}'`)[0];
const moveAs = (bearer, body) => call("POST", `/api/plan/workouts/${pid}/move`, bearer ? { bearer, body } : { cookie: true, body });
const moved = await moveAs(token, { toDate: d2, toTime: "07:30", from: { date: d1, time: "07:00" } });
check("the phone moves it to another day, from where it saw it: 200", [moved.status, moved.json.workoutId], [200, pid]);
check("…and it stands there on local D1", slotOf(), { date: d2, time: "07:30", state: "scheduled" });
// Its answer lost, the phone resends the same move (kit v0.14): 200 as the first was, and nothing new.
const beforeResend = editTrace();
const resent = await moveAs(token, { toDate: d2, toTime: "07:30", from: { date: d1, time: "07:00" } });
check("the same move resent (its answer lost): 200, the first answer", [resent.status, resent.json], [200, moved.json]);
check("…and nothing new: the row, its overrides, intents and the move audits", editTrace(), beforeResend);
const beforeStale = editTrace();
const stale = await moveAs(token, { toDate: d3, toTime: "18:00", from: { date: d1, time: "07:00" } });
check("a move from the old slot (a stale view): 409 session_changed, moved since", [stale.status, stale.json], [409, { error: "session_changed", why: "This session was moved since this change was made, so it stays where it is now." }]);
check("…and nothing was written: the row, its overrides, intents and the move audits", editTrace(), beforeStale);
check("a move with a body outside the phone's grammar: 403 out_of_scope", (await moveAs(token, { toDate: d3, toTime: "18:00", force: true })).json, { error: "out_of_scope" });
// Two at once from the same slot: the guarded write takes exactly one.
const race = await Promise.all([
  moveAs(token, { toDate: d3, toTime: "06:00", from: { date: d2, time: "07:30" } }),
  moveAs(token, { toDate: d3, toTime: "19:00", from: { date: d2, time: "07:30" } }),
]);
check("two moves at once from the same slot: one 200, one 409 session_changed", race.map((a) => `${a.status} ${a.json.error ?? ""}`.trim()).sort(), ["200", "409 session_changed"]);
const winner = race.find((a) => a.status === 200) === race[0] ? "06:00" : "19:00";
check("…and the row is the winner's", slotOf(), { date: d3, time: winner, state: "scheduled" });
// The laptop moves it meanwhile; the phone's Undo (back, from its own new slot) is refused, never an overwrite.
check("the laptop moves it (no from: the web's move as before)", (await moveAs(null, { toDate: d2, toTime: "12:00" })).status, 200);
const undo = await moveAs(token, { toDate: d2, toTime: "07:30", from: { date: d3, time: winner } });
check("…so the phone's late Undo is 409 session_changed, the laptop's choice kept", [undo.status, undo.json.error, slotOf()], [409, "session_changed", { date: d2, time: "12:00", state: "scheduled" }]);
check("the phone skips it: 200 ok", (await call("POST", `/api/plan/workouts/${pid}/skip`, { bearer: token })).json, { ok: true });
check("…skipped on local D1", slotOf().state, "skipped");
const afterSkip = editTrace();
check("the skip resent: 200 ok, and nothing new", [(await call("POST", `/api/plan/workouts/${pid}/skip`, { bearer: token })).json, editTrace()], [{ ok: true }, afterSkip]);
check("the phone puts it back: 200 ok", (await call("POST", `/api/plan/workouts/${pid}/unskip`, { bearer: token })).json, { ok: true });
check("…scheduled again", slotOf().state, "scheduled");
const afterUnskip = editTrace();
check("the unskip resent: 200 ok (not 422), and nothing new", [(await call("POST", `/api/plan/workouts/${pid}/unskip`, { bearer: token })).json, editTrace()], [{ ok: true }, afterUnskip]);
check("the session the phone saved (section 4) is done: its move is 409 session_completed", (await call("POST", `/api/plan/workouts/${id}/move`, { bearer: token, body: { toDate: d1, toTime: "07:00", from: { date: day, time: "23:30" } } })).json.error, "session_completed");
check("the phone's watch drain names its session; the switch off here: 404 not_found, as for the web", (await call("POST", "/api/sessions/watch/drain", { bearer: token, body: { workoutId: pid } })).json, { error: "not_found" });
check("…and a drain naming none is outside the phone's grammar: 403 out_of_scope", (await call("POST", "/api/sessions/watch/drain", { bearer: token, body: {} })).json, { error: "out_of_scope" });
// A phone paired before v2 (its row written as one was then): it keeps v1, and v1 is refused the plan edits.
const v1Token = `rgd_${createHash("sha256").update(`harness-v1-${Date.now()}`).digest("base64url")}`;
const at = new Date().toISOString();
sql(
  `insert into native_devices (id, user_id, scope, label, state, check_number, created_at, expires_at, confirmed_at, check_tries) values ` +
    `('${createHash("sha256").update(v1Token).digest("hex")}', '${me.json.userId}', 'training-slice-v1', 'Harness v1 phone', 'active', '0000', '${at}', '${new Date(Date.now() + 86_400_000).toISOString()}', '${at}', 0)`,
);
check("a v1 phone: /me says training-slice-v1", (await call("GET", "/api/native/me", { bearer: v1Token })).json.device?.scope, "training-slice-v1");
const v1Before = editTrace();
check("…and its move, skip, unskip and drain are 403 out_of_scope", await Promise.all([
  moveAs(v1Token, { toDate: d3, toTime: "07:00", from: { date: d2, time: "12:00" } }),
  call("POST", `/api/plan/workouts/${pid}/skip`, { bearer: v1Token }),
  call("POST", `/api/plan/workouts/${pid}/unskip`, { bearer: v1Token }),
  call("POST", "/api/sessions/watch/drain", { bearer: v1Token, body: { workoutId: pid } }),
]).then((all) => all.map((a) => `${a.status} ${a.json.error}`)), Array(4).fill("403 out_of_scope"));
check("…with nothing written", editTrace(), v1Before);
check("…while its own slice still answers", (await call("GET", "/api/native/today", { bearer: v1Token })).status, 200);

// 4d. Stage 2b on local D1 (kit v0.15, "Fit it to the day"): the laptop grants the v2 phone training-v3 in place; the same
// token, refused a v3 route a moment before, reaches it at once; Make it fit (Build's choices, a document edit by its
// revision), the review's Not for me applied once; the grant's refusals; two grants at once on workerd land once.
const phoneId = createHash("sha256").update(token).digest("hex");
const grantAs = (id, scope) => call("POST", `/api/native/devices/${id}/grant`, { cookie: true, body: { scope } });
const grantAudits = () => sql("select count(*) as n from audit_events where kind = 'native_device_scope_granted'")[0].n;
const deviceRowOf = (id) => sql(`select id, user_id, label, state, check_number, created_at, expires_at, confirmed_at, revoked_at, check_tries, scope from native_devices where id = '${id}'`)[0];
const fitted = await call("POST", "/api/workouts", { cookie: true, body: { doc: { ...doc, title: "Harness fit" }, date: day, time: "23:50", clientId: `harness-fit-${Date.now()}` } });
check("the laptop makes another of today's sessions", fitted.status < 300, true);
const fid = fitted.json.workout.id;
// Paired at v5 (the newest), the phone starts here three rungs down, as a phone paired before 2b's release is: the laptop's
// step-down, in place, one rung at a time (v5 → v4, v4 → v3, v3 → v2), then the grants back (here, in 4f and in 4h).
check("the phone paired at v5 is stepped down to v4 on the laptop, in place", (await call("POST", `/api/native/devices/${phoneId}/reduce`, { cookie: true, body: { scope: "training-v4" } })).json, { ok: true, scope: "training-v4", reduced: true });
check("…then to v3", (await call("POST", `/api/native/devices/${phoneId}/reduce`, { cookie: true, body: { scope: "training-v3" } })).json, { ok: true, scope: "training-v3", reduced: true });
check("…and to v2, one rung more", (await call("POST", `/api/native/devices/${phoneId}/reduce`, { cookie: true, body: { scope: "training-v2" } })).json, { ok: true, scope: "training-v2", reduced: true });
const listedPhone = (await call("GET", "/api/native/devices", { cookie: true })).json.devices.find((d) => d.id === phoneId);
check("the laptop lists the phone at v2, with v3 to grant", [listedPhone?.scope, listedPhone?.nextScope], ["training-v2", "training-v3"]);
check("under v2, the phone's document read is 403 out_of_scope", (await call("GET", `/api/workouts/${fid}/doc`, { bearer: token })).json, { error: "out_of_scope" });
check("…and Build with a choice is 403 out_of_scope", (await call("POST", `/api/sessions/${fid}/build`, { bearer: token, body: { checks: {} } })).json, { error: "out_of_scope" });
check("…and a v1 phone can't skip a step: v1 → v3 is 409 not_next_scope", (await grantAs(createHash("sha256").update(v1Token).digest("hex"), "training-v3")).json, { error: "not_next_scope", scope: "training-slice-v1", next: "training-v2" });
const rowBefore = deviceRowOf(phoneId);
const auditsBefore = grantAudits();
check("the laptop grants the phone v3: 200 granted", (await grantAs(phoneId, "training-v3")).json, { ok: true, scope: "training-v3", granted: true });
check("…its row the same but its scope (token, account, label, state, expiry)", deviceRowOf(phoneId), { ...rowBefore, scope: "training-v3" });
check("…with one audit", grantAudits() - auditsBefore, 1);
check("the same grant again: 200 granted false, and no second audit", [(await grantAs(phoneId, "training-v3")).json, grantAudits() - auditsBefore], [{ ok: true, scope: "training-v3", granted: false }, 1]);
check("never a downgrade: v3 → v2 is 409 not_next_scope", (await grantAs(phoneId, "training-v2")).json, { error: "not_next_scope", scope: "training-v3", next: "training-v4" });
check("the same token, on its next request: /me says training-v3", (await call("GET", "/api/native/me", { bearer: token })).json.device?.scope, "training-v3");
const docRead = await call("GET", `/api/workouts/${fid}/doc`, { bearer: token });
check("…and its document read, refused a moment ago, answers: 200 at revision 1", [docRead.status, docRead.json.rev, docRead.json.origin], [200, 1, "studio"]);
const oneMove = { ...docRead.json.doc, parts: [{ ...docRead.json.doc.parts[0], items: docRead.json.doc.parts[0].items.slice(0, 1) }] };
const edited = await call("PUT", `/api/workouts/${fid}/doc`, { bearer: token, body: { doc: oneMove, baseRev: 1 } });
check("Make it fit, a document: a move removed, by its revision: 200 at revision 2", [edited.status, edited.json.rev], [200, 2]);
const docTrace = () => sql(`select (select workout_doc_rev || ' ' || updated_at from planned_workouts where id = '${fid}') as row, (select count(*) from workout_doc_revisions where workout_id = '${fid}') as revisions`)[0];
const beforeStaleEdit = docTrace();
check("an edit from the old revision: 409 stale_revision with the current one", (await call("PUT", `/api/workouts/${fid}/doc`, { bearer: token, body: { doc: docRead.json.doc, baseRev: 1 } })).json, { error: "stale_revision", rev: 2 });
check("…and nothing written", docTrace(), beforeStaleEdit);
check("a document edit outside the phone's grammar: 403 out_of_scope", (await call("PUT", `/api/workouts/${fid}/doc`, { bearer: token, body: { doc: oneMove, baseRev: 2, force: true } })).json, { error: "out_of_scope" });
const fitBuild = await call("POST", `/api/sessions/${fid}/build`, { bearer: token, body: { checks: {} } });
check("Build after the edit, with the body check: 200, playing revision 2", [fitBuild.status, fitBuild.json.build?.fromDoc?.rev], [200, 2]);
check("Build with a mode (not the phone's to choose): 403 out_of_scope", (await call("POST", `/api/sessions/${fid}/build`, { bearer: token, body: { overrides: { mode: "build" } } })).json, { error: "out_of_scope" });
// An engine slot: the laptop starts an adaptive programme; the phone fits its first session's length.
const programme = await call("POST", "/api/programs", { cookie: true, body: { name: "Harness strength", config: {} } });
check("the laptop starts an adaptive programme", programme.status, 201);
const [slot] = sql(
  `select w.id, w.effective_date as date from planned_workouts w where w.plan_id = '${programme.json.program?.id}' and w.archived_at is null and w.effective_date >= '${day}' order by w.effective_date, w.id limit 1`,
);
check("…which places a session", !!slot, true);
if (slot) {
  const fit = await call("POST", `/api/sessions/${slot.id}/build`, { bearer: token, body: { overrides: { minutes: 20 } } });
  check(`Make it fit, an engine slot (${slot.date === day ? "today" : "a preview"}): Build with 20 minutes: 200, 20 minutes`, [fit.status, fit.json.build?.minutes], [200, 20]);
  check("…and 5 minutes, outside the route's schema: 422 invalid_build", (await call("POST", `/api/sessions/${slot.id}/build`, { bearer: token, body: { overrides: { minutes: 5 } } })).json.error, "invalid_build");
}
// The review's Not for me, from the phone, once.
const fb = fitBuild.json.build;
check("Start the fitted session: 200", (await call("POST", `/api/sessions/${fid}/start`, { bearer: token, body: { buildId: fb.buildId } })).status, 200);
const feedbackSave = {
  ...save, id: `harness-fit-${fid}`, workoutId: fid, buildId: fb.buildId, localDate: fb.date, plannedSeconds: fb.plannedSeconds ?? 1800, minutes: fb.minutes ?? 30,
  stepsTotal: (fb.steps ?? []).length || 1, stepsDone: (fb.steps ?? []).length || 1,
  movesDone: (fb.items ?? []).map((i) => ({ exerciseId: i.exerciseId, seconds: 120, ...(i.slotKey ? { slotKey: i.slotKey } : {}) })),
  entries: [{ exerciseId: "bridge", implement: null, format: "straight", perSide: false, sets: [{ setIndex: 0, reps: 12, seconds: null, load: null }] }],
  review: { excluded: { bridge: true } },
};
const feedbackRaw = JSON.stringify(feedbackSave);
check("the save with the review's Not for me: saved", (await call("PUT", `/api/sessions/performed/${feedbackSave.id}`, { bearer: token, raw: feedbackRaw })).json.status, "saved");
const prefsAfter = sql("select exercise_id as id, excluded, updated_at as at from exercise_prefs where excluded = 1");
check("…Not for me recorded", prefsAfter.map((r) => r.id), ["bridge"]);
check("the same save again (its answer lost): same_payload", (await call("PUT", `/api/sessions/performed/${feedbackSave.id}`, { bearer: token, raw: feedbackRaw })).json, { status: "same_payload" });
check("…and the preference not written again", sql("select exercise_id as id, excluded, updated_at as at from exercise_prefs where excluded = 1"), prefsAfter);
// Two grants at once on workerd, for a phone of v2 (its row written as a pairing writes one): one lands, with one audit.
const raceToken = `rgd_${createHash("sha256").update(`harness-grant-race-${Date.now()}`).digest("base64url")}`;
const raceId = createHash("sha256").update(raceToken).digest("hex");
sql(
  `insert into native_devices (id, user_id, scope, label, state, check_number, created_at, expires_at, confirmed_at, check_tries) values ` +
    `('${raceId}', '${me.json.userId}', 'training-v2', 'Harness race phone', 'active', '0000', '${at}', '${new Date(Date.now() + 86_400_000).toISOString()}', '${at}', 0)`,
);
const raceAudits = grantAudits();
const raced = await Promise.all([grantAs(raceId, "training-v3"), grantAs(raceId, "training-v3"), grantAs(raceId, "training-v3")]);
check("three grants at once on local D1: one granted, two not", raced.map((a) => `${a.status} ${a.json.granted}`).sort(), ["200 false", "200 false", "200 true"]);
check("…and exactly one audit", grantAudits() - raceAudits, 1);
check("…the race phone at v3", (await call("GET", "/api/native/me", { bearer: raceToken })).json.device?.scope, "training-v3");
// The laptop's step-down (review r-m4): one rung down, in place — an undo, and a rollback without Revoke.
const reduceAs = (id, scope) => call("POST", `/api/native/devices/${id}/reduce`, { cookie: true, body: { scope } });
const reducedAudits = () => sql("select count(*) as n from audit_events where kind = 'native_device_scope_reduced'")[0].n;
const beforeReduce = deviceRowOf(phoneId);
const reducedBefore = reducedAudits();
check("the laptop steps the phone down, v3 → v2: 200 reduced", (await reduceAs(phoneId, "training-v2")).json, { ok: true, scope: "training-v2", reduced: true });
check("…its row the same but its scope, with one audit", [deviceRowOf(phoneId), reducedAudits() - reducedBefore], [{ ...beforeReduce, scope: "training-v2" }, 1]);
check("…and the same token is judged by v2 on its next request: the document read is 403", (await call("GET", `/api/workouts/${fid}/doc`, { bearer: token })).json, { error: "out_of_scope" });
check("…while v2's own routes answer: /me says training-v2", (await call("GET", "/api/native/me", { bearer: token })).json.device?.scope, "training-v2");
check("…and never below v2 (review r2-m2: Revoke stops plan edits): v2 → v1 is 409 not_previous_scope, the phone keeps v2", [(await reduceAs(phoneId, "training-slice-v1")).json, deviceRowOf(phoneId).scope], [{ error: "not_previous_scope", scope: "training-v2", previous: null }, "training-v2"]);
check("the same step-down again: reduced false, no second audit", [(await reduceAs(phoneId, "training-v2")).json, reducedAudits() - reducedBefore], [{ ok: true, scope: "training-v2", reduced: false }, 1]);
check("never two rungs at once: v2 → … asked as v3 → v1 is 409 not_previous_scope", (await reduceAs(raceId, "training-slice-v1")).json, { error: "not_previous_scope", scope: "training-v3", previous: "training-v2" });
const raceReduced = reducedAudits();
const downs = await Promise.all([reduceAs(raceId, "training-v2"), reduceAs(raceId, "training-v2"), reduceAs(raceId, "training-v2")]);
check("three step-downs at once on local D1: one reduced, two not, one audit", [downs.map((a) => `${a.status} ${a.json.reduced}`).sort(), reducedAudits() - raceReduced], [["200 false", "200 false", "200 true"], 1]);
check("the laptop grants the phone v3 back: 200 granted, and its document read answers again", [(await grantAs(phoneId, "training-v3")).json.granted, (await call("GET", `/api/workouts/${fid}/doc`, { bearer: token })).status], [true, 200]);

// 4f. Stage 2c on local D1 (kit v0.16, DESIGN-2c §2, §3): the laptop grants the v3 phone training-v4 in place; the same token,
// refused the plan reads a moment before, reads its days, its history and What's in it for sessions ahead — and EVERY table
// of the local D1 is byte-identical across those reads (the device row compared apart: only its hourly last use may move,
// and its expiry never). Then the step-down to v3 refuses them again, and the grant back reads again.
const allTables = sql(
  "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%' and name <> 'd1_migrations' order by name",
).map((t) => t.name);
/** Every table's rows but the device rows', in one wrangler call, hashed; and the phone's row without its last use. */
const d1Hash = () =>
  createHash("sha256")
    .update(JSON.stringify(sqlAll(allTables.filter((t) => t !== "native_devices").map((t) => `select * from "${t}" order by rowid`))))
    .digest("hex");
const phoneRow = () => sql(`select id, user_id, label, state, scope, expires_at, confirmed_at, revoked_at from native_devices where id = '${phoneId}'`)[0];
const window2c = [plusDays(day, -3), plusDays(day, 10)];
const daysAs = (bearer, q = `?from=${window2c[0]}&to=${window2c[1]}`) => call("GET", `/api/native/days${q}`, { bearer });
const listed2c = (await call("GET", "/api/native/devices", { cookie: true })).json.devices.find((d) => d.id === phoneId);
check("2c: the laptop lists the phone at v3, with v4 to grant", [listed2c?.scope, listed2c?.nextScope], ["training-v3", "training-v4"]);
check("2c: under v3, /days, /history and /ahead are 403 out_of_scope", await Promise.all([daysAs(token), call("GET", "/api/native/history", { bearer: token }), call("GET", `/api/native/sessions/${pid}/ahead`, { bearer: token })]).then((all) => all.map((a) => `${a.status} ${a.json.error}`)), Array(3).fill("403 out_of_scope"));
const before2c = phoneRow();
check("2c: the laptop grants the phone v4: 200 granted", (await grantAs(phoneId, "training-v4")).json, { ok: true, scope: "training-v4", granted: true });
check("2c: …its row the same but its scope (token, account, label, state, expiry)", phoneRow(), { ...before2c, scope: "training-v4" });
const hash2c = d1Hash();
const days2c = await daysAs(token);
check("2c: /days over 14 days: 200, each day once, today the account's", [days2c.status, days2c.json.days?.length, days2c.json.today, days2c.json.days?.find((d) => d.date === day)?.tense], [200, 14, day, "today"]);
const done2c = days2c.json.days?.flatMap((d) => d.sessions).find((s) => s.id === id);
check("2c: …the session the phone saved is done, by the app, at its save's start", [done2c?.state, done2c?.doneBy, typeof done2c?.doneAt], ["completed", "app", "string"]);
const edit2c = days2c.json.days?.flatMap((d) => d.sessions).find((s) => s.id === pid);
check("2c: …the session the phone moved stands on its day, a document, movable", [edit2c?.state, edit2c?.content, edit2c?.can?.move, days2c.json.days?.find((d) => d.sessions.some((x) => x.id === pid))?.date], ["scheduled", "document", true, d2]);
check("2c: /days's query beyond its rule: 403 out_of_scope", (await daysAs(token, `?from=${day}&to=${day}&x=1`)).json, { error: "out_of_scope" });
check("2c: /days beyond the horizon: 400 out_of_horizon", (await daysAs(token, `?from=${plusDays(day, 2)}&to=${plusDays(day, 15)}`)).json.error, "out_of_horizon");
const history2c = await call("GET", "/api/native/history", { bearer: token });
const saved2c = history2c.json.rows?.find((r) => r.id === performedId);
check("2c: /history: 200, the phone's save with its planned session and its sets", [history2c.status, saved2c?.source, saved2c?.planned?.workoutId, Array.isArray(saved2c?.sets)], [200, "app", id, true]);
check("2c: …each row's keys exactly the contract's", [...new Set((history2c.json.rows ?? []).map((r) => Object.keys(r).join(",")))], ["id,date,time,source,sport,title,seconds,distanceMeters,planned,extra,moves,sets,note"]);
const ahead2c = await call("GET", `/api/native/sessions/${pid}/ahead`, { bearer: token });
check("2c: /ahead of the session moved ahead: 200, its document's moves", [ahead2c.status, ahead2c.json.basis, (ahead2c.json.moves ?? []).map((m) => m.exerciseId)], [200, "document", ["bridge", "deadBug"]]);
check("2c: /ahead of today's session: 409 not_ahead", (await call("GET", `/api/native/sessions/${id}/ahead`, { bearer: token })).json, { error: "not_ahead", date: day, today: day });
const [slotAhead] = slot ? sql(`select id from planned_workouts where plan_id = '${programme.json.program?.id}' and archived_at is null and effective_date > '${day}' order by effective_date, id limit 1`) : [];
if (slotAhead) {
  const engine2c = await call("GET", `/api/native/sessions/${slotAhead.id}/ahead`, { bearer: token });
  check("2c: /ahead of an engine slot ahead: 200, built in memory, with moves", [engine2c.status, engine2c.json.basis, (engine2c.json.moves ?? []).length > 0], [200, "engine", true]);
}
check("2c: every table of the local D1 byte-identical across the reads", d1Hash(), hash2c);
check("2c: …and the phone's row too, but its last use (its expiry never moves)", phoneRow(), { ...before2c, scope: "training-v4" });
check("2c: the laptop steps the phone down, v4 → v3: 200 reduced", (await reduceAs(phoneId, "training-v3")).json, { ok: true, scope: "training-v3", reduced: true });
check("2c: …and the same token's /days is 403 at once, while its document read still answers", [(await daysAs(token)).json, (await call("GET", `/api/workouts/${fid}/doc`, { bearer: token })).status], [{ error: "out_of_scope" }, 200]);
check("2c: the laptop grants v4 again: the reads answer again, no tap on the phone", [(await grantAs(phoneId, "training-v4")).json.granted, (await daysAs(token)).status], [true, 200]);

// 4g. Renew on local D1 (LifeOS Q-172, the lead's v0.17/v0.18 rulings): the laptop gives the v4 phone 30 days from the
// server's acceptance, in place — its token, account, label, state and scope kept — with one audit; again at once, nothing;
// three renews at once on workerd, one lands; the phone's own token can't renew itself; no read renews; and its /me says the
// new expiry at the same scope.
const renewAs = (rid) => call("POST", `/api/native/devices/${rid}/renew`, { cookie: true, body: {} });
const renewAudits = () => sql("select count(*) as n from audit_events where kind = 'native_device_renewed'")[0].n;
// Five days from its expiry, as a phone inside the 7-day warning is (its row written so on the local D1): a phone confirmed
// minutes ago already holds its 30 days, and a renew then is the same renew (`renewed: false`).
sql(`update native_devices set expires_at = '${new Date(Date.now() + 5 * 86_400_000).toISOString()}' where id = '${phoneId}'`);
const beforeRenew = deviceRowOf(phoneId);
const renewAuditsBefore = renewAudits();
check("renew: the phone's own token can't renew itself: 403 out_of_scope, its row unchanged", [(await call("POST", `/api/native/devices/${phoneId}/renew`, { bearer: token, body: {} })).json, deviceRowOf(phoneId)], [{ error: "out_of_scope" }, beforeRenew]);
check("renew: …nor does any read: /days leaves the expiry where it was", [(await daysAs(token)).status, deviceRowOf(phoneId).expires_at], [200, beforeRenew.expires_at]);
const renewSent = Date.now();
const renewed = await renewAs(phoneId);
const renewBack = Date.now();
const renewedAt = Date.parse(renewed.json.expiresAt ?? "");
check("renew: the laptop renews the phone: 200 renewed", [renewed.status, renewed.json.ok, renewed.json.renewed], [200, true, true]);
check("renew: …to 30 days from the server's acceptance", renewedAt >= renewSent + 30 * 86_400_000 - 1000 && renewedAt <= renewBack + 30 * 86_400_000 + 1000, true);
check("renew: …its row the same but its expiry (token, account, label, state, scope), with one audit", [deviceRowOf(phoneId), renewAudits() - renewAuditsBefore], [{ ...beforeRenew, expires_at: renewed.json.expiresAt }, 1]);
check("renew: the same renew again: 200 renewed false, the same expiry, no second audit", [(await renewAs(phoneId)).json, renewAudits() - renewAuditsBefore], [{ ok: true, expiresAt: renewed.json.expiresAt, renewed: false }, 1]);
check("renew: the phone's /me says the new expiry, at v4 still", [(await call("GET", "/api/native/me", { bearer: token })).json.device?.expiresAt, (await call("GET", "/api/native/me", { bearer: token })).json.device?.scope], [renewed.json.expiresAt, "training-v4"]);
const renewRaceToken = `rgd_${createHash("sha256").update(`harness-renew-race-${Date.now()}`).digest("base64url")}`;
const renewRaceId = createHash("sha256").update(renewRaceToken).digest("hex");
sql(
  `insert into native_devices (id, user_id, scope, label, state, check_number, created_at, expires_at, confirmed_at, check_tries) values ` +
    `('${renewRaceId}', '${me.json.userId}', 'training-v4', 'Harness renew race phone', 'active', '0000', '${at}', '${new Date(Date.now() + 5 * 86_400_000).toISOString()}', '${at}', 0)`,
);
const renewRaceAudits = renewAudits();
const renews = await Promise.all([renewAs(renewRaceId), renewAs(renewRaceId), renewAs(renewRaceId)]);
check("renew: three at once on local D1: one renewed, two not, one audit", [renews.map((a) => `${a.status} ${a.json.renewed}`).sort(), renewAudits() - renewRaceAudits], [["200 false", "200 false", "200 true"], 1]);
check("renew: …all three answer the one expiry", new Set(renews.map((a) => a.json.expiresAt)).size, 1);


// 4h. R1 on local D1 (kit v0.20, DESIGN-3 §3.4, §3.5, §5.3 "end to end"): the laptop grants the v4 phone training-v5 in place;
// its library reads (nothing written), a saved workout put on the plan with its receipt in the same batch, /days showing it,
// taken back (archived as taken_back, compensation said), the same take-back again answering what it did; a place the laptop
// moved since refused changed_since; switch A off refusing a frame; then the coach on the phone with the scripted designer —
// a run, its proposal (version, complete, the typed ops), an approve without its version refused at the gate, a stale one
// 409, the right one applied with its receipt, the drain, /days, a laptop edit, and the take-back refused changed_since; the
// laptop's coach says From LifeOS; the step-down to v4 stops it all and turns switch A off.
const POST_STATE = `json_object(${["effective_date", "effective_time", "completion_state", "content_state", "archived_at", "archive_reason", "workout_doc_rev", "sanctioned_by", "category", "title", "calendar_block_duration_seconds", "structured_json", "session_params"].map((c) => `'${c}', ${c}`).join(", ")})`;
check("R1: the laptop lists the phone at v4, with v5 to grant", [(await call("GET", "/api/native/devices", { cookie: true })).json.devices.find((d) => d.id === phoneId)?.nextScope], ["training-v5"]);
check("R1: under v4, the library and the coach are 403 out_of_scope", [(await call("GET", "/api/native/templates", { bearer: token })).json, (await call("GET", "/api/coach/spend", { bearer: token })).json], [{ error: "out_of_scope" }, { error: "out_of_scope" }]);
const beforeR1 = phoneRow();
check("R1: the laptop grants the phone v5: 200 granted, its row the same but its scope", [(await grantAs(phoneId, "training-v5")).json, phoneRow()], [{ ok: true, scope: "training-v5", granted: true }, { ...beforeR1, scope: "training-v5" }]);
check("R1: switch A starts off", (await call("GET", "/api/native/sharing", { bearer: token })).json, { toTraining: false, disclosureVersion: null, setAt: null });
const tpl = await call("POST", "/api/templates", { cookie: true, body: { name: "Harness hip reset", doc } });
check("R1: the laptop saves a template", tpl.status, 201);
const tplId = tpl.json.template?.id;
const hashLib = d1Hash();
const tplList = await call("GET", "/api/native/templates", { bearer: token });
check("R1: /templates: the saved one, its exact keys, no document", [tplList.status, Object.keys(tplList.json.templates?.find((t) => t.id === tplId) ?? {}).sort()], [200, ["discipline", "id", "lastUsedAt", "minutes", "name", "pinned", "updatedAt", "uses"]]);
const lib = await call("GET", "/api/native/library?limit=5", { bearer: token });
check("R1: /library?limit=5: five rows, each exactly its keys, one verdict", [lib.status, lib.json.items?.length, [...new Set((lib.json.items ?? []).map((r) => Object.keys(r).sort().join(",")))]], [200, 5, ["difficulty,equipment,excluded,family,id,lastDoneOn,name,pinned,regions,summary,verdict"]]);
check("R1: /library/:id: the move's page, no profile's notes", [(await call("GET", `/api/native/library/${lib.json.items?.[0]?.id}`, { bearer: token })).status], [200]);
check("R1: every table byte-identical across the library reads", d1Hash(), hashLib);
const d4 = plusDays(day, 4);
const placeKey = `harness-place-${Date.now()}`;
const placed = await call("POST", `/api/native/templates/${tplId}/place`, { bearer: token, body: { date: d4, time: "18:00", clientId: placeKey } });
check("R1: Put it on… Thu 18:00: 201 with its workout and receipt", [placed.status, typeof placed.json.workoutId, /^tb_[0-9a-f]{32}$/.test(placed.json.receiptId ?? "")], [201, "string", true]);
const [placedRow] = sql(`select archived_at, archive_reason, effective_date, effective_time, ${POST_STATE} as state from planned_workouts where id = '${placed.json.workoutId}'`);
const [placedReceipt] = sql(`select source, op, status, post_state, made_by from take_back_receipts where id = '${placed.json.receiptId}'`);
check("R1: …the row on its day, and its receipt holds the row exactly as written", [placedRow?.effective_date, placedRow?.effective_time, placedReceipt?.source, placedReceipt?.op, placedReceipt?.status, placedReceipt?.post_state === placedRow?.state, placedReceipt?.made_by], [d4, "18:00", "place", "create", "open", true, `device:${phoneId}`]);
check("R1: the same clientId again: the same row and receipt, nothing new", [(await call("POST", `/api/native/templates/${tplId}/place`, { bearer: token, body: { date: d4, time: "18:00", clientId: placeKey } })).json.receiptId, sql(`select count(*) as n from take_back_receipts where source = 'place'`)[0].n], [placed.json.receiptId, 1]);
check("R1: /days shows it on its day", (await daysAs(token, `?from=${d4}&to=${d4}`)).json.days?.[0]?.sessions?.some((x) => x.id === placed.json.workoutId), true);
const tbReq = `harness-tb-${Date.now()}`;
const tb = await call("POST", "/api/native/take-back", { bearer: token, body: { receiptIds: [placed.json.receiptId], requestId: tbReq } });
check("R1: Take back: taken_back, compensation listed", [tb.status, tb.json.outcomes?.[0]?.outcome, Array.isArray(tb.json.outcomes?.[0]?.compensation)], [200, "taken_back", true]);
check("R1: …the row archived as taken_back — never deleted — and its receipt marked with the request", [sql(`select archive_reason from planned_workouts where id = '${placed.json.workoutId}'`)[0]?.archive_reason, sql(`select status, request_id from take_back_receipts where id = '${placed.json.receiptId}'`)[0]], ["taken_back", { status: "taken_back", request_id: tbReq }]);
const hashTb = d1Hash();
// The same answer (its compensation read live: a provider may have moved on meanwhile), and nothing written.
const stable = (a) => (a.outcomes ?? []).map(({ compensation: _c, ...o }) => o);
const tbAgain = await call("POST", "/api/native/take-back", { bearer: token, body: { receiptIds: [placed.json.receiptId], requestId: tbReq } });
check("R1: the same take-back again: the same answer, nothing written", [JSON.stringify(stable(tbAgain.json)) === JSON.stringify(stable(tb.json)), tbAgain.json.remaining, d1Hash() === hashTb], [true, [], true]);
check("R1: another request id: already_taken_back", (await call("POST", "/api/native/take-back", { bearer: token, body: { receiptIds: [placed.json.receiptId], requestId: `${tbReq}-b` } })).json.outcomes?.[0]?.outcome, "already_taken_back");
check("R1: /receipts/:id: taken back, its compensation live", [(await call("GET", `/api/native/receipts/${placed.json.receiptId}`, { bearer: token })).json.status], ["taken_back"]);
const placed2 = await call("POST", `/api/native/templates/${tplId}/place`, { bearer: token, body: { date: d4, time: "07:00", clientId: `${placeKey}-2` } });
check("R1: a second place, and the laptop moves it", [placed2.status, (await call("POST", `/api/plan/workouts/${placed2.json.workoutId}/move`, { cookie: true, body: { toDate: plusDays(day, 5), toTime: "07:00" } })).status], [201, 200]);
const hashMoved = d1Hash();
const tb2 = await call("POST", "/api/native/take-back", { bearer: token, body: { receiptIds: [placed2.json.receiptId], requestId: `${tbReq}-2` } });
check("R1: …its take-back refused changed_since, with how it stands in the phone's words; nothing written", [tb2.json.outcomes?.[0]?.error, tb2.json.outcomes?.[0]?.now, d1Hash() === hashMoved], ["changed_since", { date: plusDays(day, 5), time: "07:00", state: "scheduled", archived: false, title: "Harness hips and back", minutes: tb2.json.outcomes?.[0]?.now?.minutes }, true]);
const runsBefore = sql("select count(*) as n from coach_runs")[0].n;
const frameR1 = { days: [day], energy: "low", free: { [day]: [{ from: "17:30", to: "19:30" }] }, dayEnd: "23:00", load: { [day]: "full" }, coverage: { [day]: { planAsOf: new Date().toISOString(), calendarAsOf: null, drafted: false } }, consent: "harness.1" };
check("R1: switch A off: a run with a frame is 409 sharing_off, nothing started", [(await call("POST", "/api/coach/runs", { bearer: token, body: { scope: { kind: "now" }, frame: frameR1 } })).json.error, sql("select count(*) as n from coach_runs")[0].n - runsBefore], ["sharing_off", 0]);
const ran = await call("POST", "/api/coach/runs", { bearer: token, body: { scope: { kind: "now" }, request: "A short mobility session now" } });
check("R1: the phone asks the training coach: a run via lifeos", [ran.status, ran.json.run?.via], [200, "lifeos"]);
const runId = ran.json.run?.id;
let runNow = ran.json.run;
for (let i = 0; i < 90 && runNow && !["finished", "failed", "stopped_cap", "cancelled", "expired"].includes(runNow.status); i++) {
  await call("POST", `/api/coach/runs/${runId}/step?afterSeq=0`, { bearer: token, body: {} });
  await new Promise((r) => setTimeout(r, 1000));
  runNow = (await call("GET", `/api/coach/runs/${runId}`, { bearer: token })).json.run;
}
check("R1: …its steps run in the run's own alarm, and it finishes with a proposal (the scripted designer)", [runNow?.status, typeof runNow?.proposalId], ["finished", "string"]);
const prop = await call("GET", `/api/coach/proposals/${runNow?.proposalId}`, { bearer: token });
const opIds = (prop.json.opsSummary ?? []).map((o) => o.opId);
check("R1: the proposal read: its version, complete, one op typed (add, today), no receipts yet", [prop.status, /^[0-9a-f]{64}$/.test(prop.json.version ?? ""), prop.json.complete, prop.json.opsSummary?.[0]?.op, prop.json.opsSummary?.[0]?.day, prop.json.receipts], [200, true, true, "add", day, []]);
check("R1: approve without its version: 403 at the gate", (await call("POST", `/api/coach/proposals/${runNow?.proposalId}/approve`, { bearer: token, body: { opIds } })).json, { error: "out_of_scope" });
check("R1: approve with a stale version: 409 proposal_changed with the fresh one", (await call("POST", `/api/coach/proposals/${runNow?.proposalId}/approve`, { bearer: token, body: { opIds, version: "0".repeat(64) } })).json, { error: "proposal_changed", version: prop.json.version });
const approved = await call("POST", `/api/coach/proposals/${runNow?.proposalId}/approve`, { bearer: token, body: { opIds, version: prop.json.version } });
const approvedId = approved.json.applied?.[0]?.workout?.id;
check("R1: approve with its ops and version: applied, with its receipt and the version it leaves", [approved.status, approved.json.applied?.length, approved.json.receipts?.length, /^[0-9a-f]{64}$/.test(approved.json.version ?? "") && approved.json.version !== prop.json.version], [200, 1, 1, true]);
check("R1: the drain answers", (await call("POST", "/api/coach/drain", { bearer: token, body: {} })).status, 200);
check("R1: /days shows the approved workout today", (await daysAs(token, `?from=${day}&to=${day}`)).json.days?.[0]?.sessions?.some((x) => x.id === approvedId), true);
check("R1: the proposal says it can be taken back", (await call("GET", `/api/coach/proposals/${runNow?.proposalId}`, { bearer: token })).json.takeBackable, opIds);
check("R1: the laptop edits it between approve and take-back", (await call("POST", `/api/plan/workouts/${approvedId}/move`, { cookie: true, body: { toDate: day, toTime: "23:55" } })).status, 200);
const tb3 = await call("POST", "/api/native/take-back", { bearer: token, body: { receiptIds: [approved.json.receipts?.[0]?.receiptId], requestId: `${tbReq}-3` } });
check("R1: …the take-back refused changed_since, the laptop's edit kept", [tb3.json.outcomes?.[0]?.error, sql(`select effective_time, archived_at from planned_workouts where id = '${approvedId}'`)[0]], ["changed_since", { effective_time: "23:55", archived_at: null }]);
const convo = await call("GET", "/api/coach/conversation", { cookie: true });
check("R1: the laptop's coach says the phone's turn came From LifeOS", (convo.json.turns ?? []).some((t) => t.runId === runId && t.via === "lifeos"), true);
check("R1: the QA gate's opposite: the owner's phone has its coach (spend answers)", (await call("GET", "/api/coach/spend", { bearer: token })).status, 200);
check("R1: switch A on, then the step-down to v4: the library and coach 403 at once, switch A off", [
  (await call("PUT", "/api/native/sharing", { bearer: token, body: { toTraining: true, disclosureVersion: "harness.1" } })).json.toTraining,
  (await reduceAs(phoneId, "training-v4")).json.reduced,
  (await call("GET", "/api/native/library", { bearer: token })).json,
  (await call("GET", "/api/coach/memory", { bearer: token })).json,
  sql(`select to_training from native_device_sharing where device_id = '${phoneId}'`)[0]?.to_training,
], [true, true, { error: "out_of_scope" }, { error: "out_of_scope" }, 0]);

// 4e. The LifeOS QA account on local D1 (the phone QA harness, routes/qa.ts): the laptop sets it up (account, fixtures, a code
// and the run's tokens); a phone pairs to it, active at once, and does what the on-device suite does; the harness token reads
// the state and purges; then EVERY table of the real local D1 that has a user_id column, and every child of the QA account's
// plan rows, holds nothing of it — read straight from sqlite_master, not through the registry the purge used. The owner's
// rows are counted before and after: unchanged.
/** Every table of the local D1 with a `user_id` column, read from sqlite_master and each table's own columns. */
const userIdTables = sql(
  "select m.name from sqlite_master m where m.type = 'table' and m.name not like 'sqlite_%' and m.name not like '_cf_%' and m.name <> 'd1_migrations' " +
    "and exists (select 1 from pragma_table_info(m.name) p where p.name = 'user_id') order by m.name",
).map((t) => t.name);
/** Each of those tables' rows for `userId`, in one call. */
const rowsByTable = (userId) =>
  Object.fromEntries(sqlAll(userIdTables.map((name) => `select '${name}' as t, count(*) as n from "${name}" where user_id = '${userId}'`)).map(([r]) => [r.t, r.n]));
const ownerTables = () => rowsByTable(me.json.userId);
const ownerBefore = ownerTables();
// The laptop's Set up, as Settings → Developer sends it: the account, its fixtures, a code with the run's tokens.
const qaMade = await call("POST", "/api/qa/user", { cookie: true, body: {} });
const qaSeeded = await call("POST", "/api/qa/seed", { cookie: true, body: {} });
const qaSetup = await call("POST", "/api/qa/pairings", { cookie: true, body: {} });
check("QA: the laptop's Set up makes the account, its fixtures and a code with the run's tokens", [qaMade.status, qaSeeded.status, qaSeeded.json.fixtures?.length, qaSetup.status, /^rgq_/.test(qaSetup.json.harnessToken ?? ""), /^[0-9a-f]{64}$/.test(qaSetup.json.planToken ?? "")], [201, 200, 5, 200, true, true]);
const [qaRow] = sql("select id, email, google_sub as sub from users where email = 'lifeos-qa@invalid'");
check("QA: one account at lifeos-qa@invalid, no Google identity, not the owner's", [qaRow?.email, qaRow?.sub, qaRow?.id !== me.json.userId], ["lifeos-qa@invalid", null, true]);
const qaId = qaRow.id;
check("QA: a device token can't reach the owner's QA routes: 403 out_of_scope", (await call("GET", "/api/qa/status", { bearer: token })).json, { error: "out_of_scope" });
const qaPair = await call("POST", "/api/native/pair", { body: { code: qaSetup.json.code, label: "LifeOS phone" } });
check("QA: its code pairs a phone (the owner's wire shape: pending)", [qaPair.status, qaPair.json.state], [200, "pending"]);
const qaToken = qaPair.json.token;
const qaMe = await call("GET", "/api/native/me", { bearer: qaToken });
check("QA: …active at once, as the QA account, at v5", [qaMe.status, qaMe.json.userId, qaMe.json.device?.scope], [200, qaId, "training-v5"]);
const qaDay = (await call("GET", "/api/native/today", { bearer: qaToken })).json;
check("QA: the phone's day is today's three QA fixtures, and nothing of the owner's", qaDay.sessions.map((s) => s.title).sort(), ["QA Easy run", "QA Hips and back", "QA Mobility"]);
// Stage 2c's reads on the QA phone: its own days and record, never a row of the owner's (on real local D1).
const qaDays = await call("GET", `/api/native/days?from=${plusDays(qaDay.today, -3)}&to=${plusDays(qaDay.today, 3)}`, { bearer: qaToken });
const ownerIds2c = [id, pid, fid, performedId, ...sql(`select id from activities where user_id = '${me.json.userId}'`).map((r) => r.id)];
check("QA: its /days is its own: today's three QA fixtures, no owner id", [qaDays.status, qaDays.json.days?.find((d) => d.date === qaDay.today)?.sessions.map((s) => s.title).sort(), ownerIds2c.some((x) => JSON.stringify(qaDays.json).includes(x))], [200, ["QA Easy run", "QA Hips and back", "QA Mobility"], false]);
const qaHistory = await call("GET", "/api/native/history", { bearer: qaToken });
check("QA: its /history holds no owner id; /ahead of an owner session is 404", [qaHistory.status, ownerIds2c.some((x) => JSON.stringify(qaHistory.json).includes(x)), (await call("GET", `/api/native/sessions/${pid}/ahead`, { bearer: qaToken })).status], [200, false, 404]);
const qaPlan = await call("GET", `/api/lifeos/plan?from=${qaDay.today}&to=${qaDay.today}`, { bearer: qaSetup.json.planToken });
check("QA: its plan token reads its plan at /api/lifeos/plan", [qaPlan.status, (qaPlan.json.days?.[0]?.sessions ?? []).map((s) => s.title).sort()], [200, ["QA Easy run", "QA Hips and back", "QA Mobility"]]);
const hips = qaDay.sessions.find((s) => s.title === "QA Hips and back");
const qaMoved = await call("POST", `/api/plan/workouts/${hips.id}/move`, { bearer: qaToken, body: { toDate: qaDay.today, toTime: "23:50", from: { date: qaDay.today, time: hips.time } } });
check("QA: the phone moves it later today, from where it saw it", [qaMoved.status, qaMoved.json.watchDrain], [200, undefined]);
check("QA: skip, then unskip", [(await call("POST", `/api/plan/workouts/${hips.id}/skip`, { bearer: qaToken })).json, (await call("POST", `/api/plan/workouts/${hips.id}/unskip`, { bearer: qaToken })).json], [{ ok: true }, { ok: true }]);
const qaBuilt = (await call("POST", `/api/sessions/${hips.id}/build`, { bearer: qaToken, body: {} })).json.build;
check("QA: Build and Start", (await call("POST", `/api/sessions/${hips.id}/start`, { bearer: qaToken, body: { buildId: qaBuilt.buildId } })).status, 200);
const qaSaveId = `harness-qa-${hips.id}`;
const qaSave = {
  ...save, id: qaSaveId, workoutId: hips.id, buildId: qaBuilt.buildId, localDate: qaBuilt.date, plannedSeconds: qaBuilt.plannedSeconds ?? 600, minutes: qaBuilt.minutes ?? 10,
  mode: qaBuilt.mode ?? "build", theme: qaBuilt.theme ?? null, locationId: qaBuilt.locationId ?? null, blockRef: qaBuilt.blockRef ?? null,
  stepsTotal: (qaBuilt.steps ?? []).length || 1, stepsDone: (qaBuilt.steps ?? []).length || 1,
  movesDone: (qaBuilt.items ?? []).map((i) => ({ exerciseId: i.exerciseId, seconds: 60, ...(i.slotKey ? { slotKey: i.slotKey } : {}) })),
  entries: [{ exerciseId: qaBuilt.items?.[0]?.exerciseId ?? "bridge", implement: null, format: "straight", perSide: false, sets: [{ setIndex: 0, reps: 10, seconds: null, load: null }] }],
};
// The review's MAJOR-1, on real local D1: the QA phone's save naming one of the OWNER's activities (its app session's, here)
// is refused, and the owner's activities, matches and source links are as they were, row for row.
const ownerActivityRows = () =>
  sqlAll([
    `select * from activities where user_id = '${me.json.userId}' order by id`,
    `select m.* from workout_completion_matches m join planned_workouts w on w.id = m.workout_id where w.user_id = '${me.json.userId}' order by m.id`,
    `select l.* from activity_source_links l join activities a on a.id = l.activity_id where a.user_id = '${me.json.userId}' order by l.id`,
  ]);
const [ownerActivity] = sql(`select id from activities where user_id = '${me.json.userId}' order by id limit 1`);
const ownerActivitiesBefore = ownerActivityRows();
const crafted = ownerActivity
  ? await call("PUT", `/api/sessions/performed/${ownerActivity.id}`, { bearer: qaToken, body: { ...qaSave, id: ownerActivity.id } })
  : { status: 0, json: {} };
check("QA: a save naming the owner's activity id is refused 409, and the owner's activities, matches and links are unchanged", [
  Boolean(ownerActivity), crafted.status, crafted.json, JSON.stringify(ownerActivityRows()) === JSON.stringify(ownerActivitiesBefore),
], [true, 409, { error: "conflict" }, true]);
check("QA: the save", (await call("PUT", `/api/sessions/performed/${qaSaveId}`, { bearer: qaToken, body: qaSave })).json.status, "saved");
const harnessAs = (method, path, body) => call(method, `/api/qa/run${path}`, { bearer: qaSetup.json.harnessToken, body });
const qaFresh = await harnessAs("POST", "/pairings", {});
check("QA: the harness token mints a fresh code, and only a code (no token to renew itself)", [qaFresh.status, Object.keys(qaFresh.json).sort()], [200, ["accountTag", "code", "expiresAt", "scope"]]);
const qaState = (await harnessAs("GET", "/state")).json;
check("QA: the harness reads it done at its new time, one move audit, one performed session, matched", [
  qaState.plan.find((p) => p.id === hips.id)?.state, qaState.plan.find((p) => p.id === hips.id)?.time,
  qaState.audits.filter((a) => a.kind === "workout_moved").length, qaState.performed.map((p) => p.id), qaState.matches.filter((m) => m.undoneAt === null).map((m) => m.method),
], ["completed", "23:50", 1, [qaSaveId], ["app_session"]]);
check("QA: …and no provider row at all", [qaState.providers.connections, qaState.providers.corosWriteJobs, qaState.providers.calendarEventLinks, qaState.providers.syncRuns], [0, 0, 0, 0]);
const qaPlanIds = sql(`select id from planned_workouts where user_id = '${qaId}'`).map((r) => r.id);
// The purge goes in steps, each one request within Workers Free's budget, until it says done.
let qaPurged = { json: { done: false } };
let qaSteps = 0;
while (!qaPurged.json.done && qaSteps < 10) {
  qaPurged = await harnessAs("POST", "/purge", { confirm: "purge qa" });
  qaSteps += 1;
  if (qaPurged.status !== 200) break;
}
check("QA: the harness purges it: every table checked, zero remain", [qaPurged.status, qaPurged.json.done, qaPurged.json.total], [200, true, 0]);
check("QA: the harness's own zero-row check, after", [(await harnessAs("GET", "/verify")).json.total, (await harnessAs("GET", "/verify")).json.exists], [0, false]);
const leftByUser = Object.entries(rowsByTable(qaId)).filter(([, n]) => n > 0);
check(`QA: on the real local D1, every one of the ${userIdTables.length} tables with a user_id holds nothing of it`, leftByUser, []);
const inList = qaPlanIds.map((id) => `'${id}'`).join(",") || "''";
const leftChildren = sqlAll(
  ["planned_workout_stages", "schedule_overrides", "workout_completion_matches", "calendar_event_links", "calendar_event_suppressions"].map(
    (name) => `select '${name}' as t, count(*) as n from "${name}" where workout_id in (${inList})`,
  ),
)
  .map(([r]) => [r.t, r.n])
  .filter(([, n]) => n > 0);
check("QA: …nor any child of its plan rows, by the ids they had", leftChildren, []);
check("QA: …which were there before the purge (the check reads real rows)", qaPlanIds.length, 5);
check("QA: …nor its user row, pairing code or mint counter", [
  sql(`select count(*) as n from users where id = '${qaId}' or email = 'lifeos-qa@invalid'`)[0].n,
  sql(`select count(*) as n from native_pair_limits where key = 'mint:${qaId}'`)[0].n,
], [0, 0]);
check("QA: the phone is signed out with it: 401", (await call("GET", "/api/native/me", { bearer: qaToken })).status, 401);
check("QA: the owner's rows, table by table, as they were", ownerTables(), ownerBefore);

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
check(`twenty new clients at once (the global count was ${globalBefore}): it stops at exactly 11, throttled`, [global?.count ?? null, (global?.blocked ?? null) !== null], [11, true]);
// While it throttles, a new client writes nothing at all (review F3): no row for it.
const rowsBefore = sql("select count(*) as n from native_pair_limits")[0].n;
await Promise.all(Array.from({ length: 10 }, (_, i) => call("POST", "/api/native/pair", { body: { code: "ABCDEFGH", label: "Late" }, client: `2001:db8:${i + 1}::1` })));
check("…and ten more new clients during the throttle write no row", sql("select count(*) as n from native_pair_limits")[0].n, rowsBefore);
// Confirm under real concurrency: twenty wrong check numbers at once for the pending phone — exactly 3 tried, then revoked.
// If the other client didn't pair (a check above failed), there is no pending phone to confirm: both checks are recorded
// as failed, and the rest still run to the summary.
const revokedLabel = "twenty wrong check numbers at once: the phone is revoked after exactly 3";
const mismatchLabel = "…and no more than 3 answers were a mismatch";
if (typeof otherClient.json?.token === "string") {
  const pendingId = createHash("sha256").update(otherClient.json.token).digest("hex");
  const okCheck = Number(otherClient.json.check);
  const confirms = await Promise.all(
    Array.from({ length: 20 }, (_, i) => call("POST", `/api/native/devices/${pendingId}/confirm`, { cookie: true, body: { check: String((okCheck + 1 + i) % 10_000).padStart(4, "0") } })),
  );
  check(revokedLabel, sql(`select state, check_tries as tries, revoked_reason as why from native_devices where id = '${pendingId}'`), [{ state: "revoked", tries: 3, why: "check_failed" }]);
  check(mismatchLabel, confirms.filter((a) => a.json?.error === "check_mismatch").length <= 3, true);
} else {
  const none = `no pending phone to confirm (the other client got ${otherClient.status})`;
  check(revokedLabel, none, "a pending phone");
  check(mismatchLabel, none, "a pending phone");
}
// Mint bound: this was the fifth code in the window; the sixth is refused, and says when to try again.
const sixth = await call("POST", "/api/native/pairings", { cookie: true, body: {} });
check("a sixth code in the window: 429 too_many_codes, retryAfter 600", [sixth.status, sixth.json], [429, { error: "too_many_codes", retryAfter: 600 }]);

// 7. Revoke all: the phone is stopped at once.
check("Revoke all", (await call("POST", "/api/native/devices/revoke-all", { cookie: true, body: {} })).json.ok, true);
check("revoked: 401 device_revoked", (await call("GET", "/api/native/me", { bearer: token })).json, { error: "device_revoked" });
check("…and a grant never brings a revoked phone back: 409 device_revoked", [(await grantAs(raceId, "training-v3")).json, deviceRowOf(raceId).state], [{ error: "device_revoked" }, "revoked"]);
check("…nor does a renew: 409 device_revoked, its expiry unchanged", [(await renewAs(renewRaceId)).json, deviceRowOf(renewRaceId).state, deviceRowOf(renewRaceId).expires_at === renews[0].json.expiresAt], [{ error: "device_revoked" }, "revoked", true]);

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  ${f}`);
  process.exit(1);
}
