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
// A new pairing is minted at the newest scope (stage 2b RG-NOTES §3.5, §8: training-v3), and /me says so.
check("…and its device is training-v3: {label, expiresAt, scope}", [Object.keys(me.json.device ?? {}).sort(), me.json.device?.scope], [["expiresAt", "label", "scope"], "training-v3"]);

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
// Paired at v3 (the newest), the phone starts here a rung down, as a phone paired before 2b's release is: the laptop's
// step-down, in place, then the grant back.
check("the phone paired at v3 is stepped down to v2 on the laptop, in place", (await call("POST", `/api/native/devices/${phoneId}/reduce`, { cookie: true, body: { scope: "training-v2" } })).json, { ok: true, scope: "training-v2", reduced: true });
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
check("never a downgrade: v3 → v2 is 409 not_next_scope", (await grantAs(phoneId, "training-v2")).json, { error: "not_next_scope", scope: "training-v3", next: null });
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

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  ${f}`);
  process.exit(1);
}
