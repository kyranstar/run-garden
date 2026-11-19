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

- [ ] **1. The scope.** `auth/device-scope.ts`: `DEVICE_SCOPE_V4 = "training-v4"`, `TRAINING_V4` (v3's fourteen entries,
  the same objects in v3's order, then `GET /api/native/days`, `GET /api/native/history`,
  `GET /api/native/sessions/:id/ahead`), `DeviceRoute.query` and its check in `inDeviceScope` after the path and before
  the body (403 `out_of_scope`); `NEWEST`/`PAIRING_SCOPE` → v4, `NEXT[v3] = v4`, `PREVIOUS[v4] = v3`. Tests first:
  `native-allowlist` (v4's list pinned, every mounted route under v4, probes carry a query in each rule's grammar),
  `native-grant` (v3 → v4 in place, v4 → v3 step-down, v2 → v4 and v4 → v2 refused, the list's next/previous), pairing
  mints v4 (`native-pairing`, the QA suites, the harness check).
- [ ] **2. The plan read, factored.** `services/plan-days.ts`: `readPlanRows` (one statement: the row's read columns, the
  plan's kind and name joined by the account, `docRev`, `underWaySql()`, `stage_summary is not null`), `standingMatches`
  (per 100 ids, each match's activity start and source, held to `activities.user_id`), `planDaysV1` (the plan read's v1,
  moved, not changed) and the device mapping. `/api/lifeos/plan` calls them; `lifeos-plan.test.ts` unchanged and green.
- [ ] **3. Extras, shared.** `extraSessionsOn(acts, date)` beside `isExtraSession` in `garden-sync.ts`; `/api/plan/week`
  and `/days` both call it; `/days` reads activities bounded by `start_time` (from − 1 … to + 2).
- [ ] **4. `GET /api/native/days?from&to`.** Tests first (`native-days.test.ts`): bounds (14/15 days, from > to, T − 90/91,
  T + 14/15, bad dates), the query rule at the gate and the cookie's 400, every kind on one day, every state and `doneBy`,
  `can`, extras (unmatched COROS/app/strength/yoga, matched not extra, import never, near-midnight dating), tense under a
  faked clock at 23:30 and 00:30, two accounts, writes nothing (every table, `waitUntil` never called, expiry unchanged),
  parity with the plan read for ≤ 14 days, the gate (v1–v3 403, v4 200, cookie 200, restore 503, switch off 401), the
  budget (7, plus 1 per further 100 rows).
- [ ] **5. `GET /api/native/history?before&limit`.** `services/history.ts`: the page of activities by `start_time` with a
  day's margin, whole days by run-garden's date rule, the matched workouts (held to the account), the athlete's own
  recorded sets and note (`sessionPerActivity`, no check rows read), the build item counts, the said-done rows. Tests first
  (`native-history.test.ts`): pages, sources, the exact key set of a row, two accounts, writes nothing, budget ≤ 15.
- [ ] **6. `GET /api/native/sessions/:id/ahead`.** `previewAhead` in `session-build.ts`: document, engine (`dayInputs` +
  `composeBuild`, or the stored preview when its hash still matches; never `beginWrite`/`storeBuild`/`saveProgramState`),
  course (`coursePreviewDoc`), stages, none. Tests first (`native-ahead.test.ts`): Build `{}` parity, `session_builds` and
  `program_blocks` unchanged where Build changes them, the laptop's preview choices honoured, writers spied at zero,
  409 `not_ahead`, 404 another account's, budget ≤ 30.
- [ ] **7. The routes.** `routes/native.ts`: the three GETs behind `requireUser`, `Cache-Control: no-store`, and
  503 `{error: "restore_in_progress", retryable: true}` during a restore (checked before any read of the account's rows).
- [ ] **8. The sweep.** `qa-isolation.test.ts`'s cross-account sweep walks `DEVICE_SCOPES["training-v4"]`: the QA phone
  sent the owner's ids on all three reads, the owner's ids never in an answer, the owner's hashes unchanged.
- [ ] **9. Mutations to kill** (run by hand, each reverted): `/days` without the account on matches; an extra on a future
  day; `tense` from UTC; the preview stored; `/history` with checks; the query rule dropped; v4 holding a v3 entry
  changed; the restore 503 removed; the grant ladder's `NEXT[v3]`; the extras' account filter.
- [ ] **10. The laptop and the docs.** Settings → Devices words for v4 (§4), the api-client types, `docs/SECURITY.md`
  ("LifeOS reads through its device"), the harness `check`'s 2c steps (grant v4 in place, the three reads, a D1 table hash
  unchanged across them).
- [ ] **11. Verify.** Typecheck, the full suite once (under the shared lock), the harness check on local D1.
