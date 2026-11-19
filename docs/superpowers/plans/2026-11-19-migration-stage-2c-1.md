# Stage 2c-1 (run-garden): `training-v4` and the phone's three plan reads

**Source:** the LifeOS migration's DESIGN-2c (kit v0.16), §0, §2, §3, §4, §7, §9.1, §10, §11 (2c-1, run-garden's half only),
with its §12 calls as settled; bounded by the lead's v0.17 ruling (reads only, a retryable 503 during a restore, extras
visible and never answering a planned session, same account only, no expiry change on any read, no Renew).

**Base:** `qa/phone-harness` at `e773fd0a` (live `cdee4c19` plus the QA harness). Branch `mig-v16/stage2c-1`. Not pushed:
a push to main deploys. **No migration:** the scope is a column value.

**Rules held throughout:** test-first; the garden engine stays at v7; nothing in the three reads writes but the gate's
own hourly `native_devices.last_used_at`; no `waitUntil`, no provider or model call, no Build, no preview stored, no expiry
moved.

## Tasks

- [x] **1. The scope.** `auth/device-scope.ts`: `DEVICE_SCOPE_V4 = "training-v4"`, `TRAINING_V4` (v3's fourteen entries,
  the same objects in v3's order, then `GET /api/native/days`, `GET /api/native/history`,
  `GET /api/native/sessions/:id/ahead`), `DeviceRoute.query` and its check in `inDeviceScope` after the path and before
  the body (403 `out_of_scope`); `NEWEST`/`PAIRING_SCOPE` → v4, `NEXT[v3] = v4`, `PREVIOUS[v4] = v3`. Tests first:
  `native-allowlist` (v4's list pinned, every mounted route under v4, probes carry a query in each rule's grammar),
  `native-grant` (v3 → v4 in place, v4 → v3 step-down, v2 → v4 and v4 → v2 refused, the list's next/previous), pairing
  mints v4 (`native-pairing`, the QA suites, the harness check).
- [x] **2. The plan read, factored.** `services/plan-days.ts`: `readPlanRows` (one statement: the row's read columns, the
  plan's kind and name joined by the account, `docRev`, `underWaySql()`, `stage_summary is not null`), `standingMatches`
  (per chunk of 90 ids, each match's activity start and source, held to `activities.user_id`), `planDaysV1` (the plan
  read's v1) and the device mapping. `/api/lifeos/plan` calls them; `lifeos-plan.test.ts` unchanged and green.
- [x] **3. Extras, shared.** `extraSessionsOn(acts, date)` beside `isExtraSession` in `garden-sync.ts`; `/api/plan/week`
  and `/days` both call it; `/days` reads activities bounded by `start_time` (from − 1 … to + 2).
- [x] **4. `GET /api/native/days?from&to`** and `native-days.test.ts` (22 tests).
- [x] **5. `GET /api/native/history?before&limit`**, `services/history.ts` and `native-history.test.ts` (14 tests).
- [x] **6. `GET /api/native/sessions/:id/ahead`**, `previewAhead` in `session-build.ts` and `native-ahead.test.ts`
  (10 tests).
- [x] **7. The routes.** `routes/native.ts`: the three GETs behind `requireUser`, `Cache-Control: no-store`, and
  503 `{error: "restore_in_progress", retryable: true}` during a restore (checked before any read of the account's rows).
- [x] **8. The sweep.** `qa-isolation.test.ts`'s cross-account sweep walks `DEVICE_SCOPES["training-v4"]`.
- [x] **9. Mutations to kill** (run by hand, each reverted): 21 mutations, all killed — `/days` without the account on
  matches; an extra on a future day; `tense` from UTC; the preview stored (Build's writer called); `/history` reading
  checks; the query rule dropped; v4 holding a changed v3 entry; the restore 503 removed from each of the three; the
  ladder's `NEXT[v3]`, `PREVIOUS[v4]` and `PAIRING_SCOPE`; the extras', history's activities', matched workouts' and
  said-done rows' account filters; `/ahead`'s row without the account; `/ahead` for today; a read moving the expiry; the
  label sent as the title.
- [x] **10. The laptop and the docs.** Settings → Devices words for v4 (§4), the api-client types, `docs/SECURITY.md`
  ("LifeOS reads through its device"), the harness `check`'s 2c steps (grant v4 in place, the three reads, every D1 table
  byte-identical across them, the step-down and the grant back; the QA phone's reads its own).
- [x] **11. Verify.** Typecheck, the full suite once (under the shared lock), the harness check on local D1.

## As built: where the design was silent, or where this departs

- **`/history`'s 400s:** `bad_range` for a `before` that isn't a real date, `bad_limit` for a size outside 1–30 (the gate
  lets 1–99 through); `out_of_horizon {today, earliest}` with `earliest` = today − 365, the oldest day a row may have —
  rows are bounded below by it too, not only `before`.
- **Titles in `/history`:** `planned.title` is as stored, with `planned.label` only when the humanized name differs, as
  `/days` does; a said-done row's own `title` is the words.
- **`moves` in `/history`** only for a session played in run-garden's player (`source: app`); `note` for whichever session
  `sessionPerActivity` picks. No check row is read at all (`recordedByActivity`), rather than `performedByActivity`'s three
  reads with the checks dropped.
- **Extras:** never listed on a day ahead; `time` null for an activity with no local start; `distanceMeters` for runs only.
- **The budget's chunk is 90** (`IN_ARRAY_CHUNK`), not 100: `/days` is 7 statements plus 1 per further 90 rows.
- **`kind`:** a course's written session (origin `studio`, its number held) is `course`, by mark-done's own rule; a COROS
  plan's row is `watch_plan` only while the registry holds its `coros_import` programme, else `other`.
- **`/ahead`:** a rest row is 404 like an archived one; a slot whose programme is gone answers `basis: "none"`; a course
  outline is `none` when paused on that day, not active, or finishing; the response adds `distanceMeters` (a run's
  expected distance, `stages` only); a document's place is the one it names (null when none).
- **The restore's 503** carries its code in `error` (the API's code key, the plan read's word) and `retryable: true`; no
  `Retry-After` header, which the codebase uses nowhere.
- **Extras' garden credit** (the v0.17 ruling): nothing in 2c reads or changes the garden; an extra is listed as done work
  (`extras` on `/days`, `extra: true` on `/history`) and never as a session's answer. No garden field is added.
