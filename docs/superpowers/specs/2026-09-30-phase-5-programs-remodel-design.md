# Phase 5 — One programs model: migrating training, coach and Studio plans

Date: 2026-09-30
Status: design for Phase 5 of `2026-09-30-one-workout-system-design.md` (the authority; D1, D7, A2, P4, P5).
Prerequisite: Phases 1–4 shipped; the adaptive program already lives in `programs` (kind `adaptive`).

## 1. What exists (inventory, 2026-09-30)

124 code sites read or write `training_plans`, `training_plan_versions`, `coach_plans`, `coach_plan_weeks`,
`studio_plans`, `studio_plan_pushes`, or infer a workout's origin. The facts that shape the design:

- `planned_workouts.plan_id` is a bare string in three namespaces: `training_plans.id` (uuid), `coach_plans.id`
  (`cp-<proposal>-<i>` or `adhoc-<discipline>-<user8>`), and — since Phase 2 — `programs.id`. **Studio plans never
  appear in `plan_id`**: their sessions return from COROS filed under the container `training_plans` row and are
  linked to Studio only by `source_workout_id = "<corosPlanId>:<idInPlan>"` against `studio_plan_pushes`.
- "Where did this workout come from" has no column: seven signals decide it (`lastVerifiedCorosDate === ''`,
  `sourceWorkoutId === id`, `sourceIdInPlan === null`, `structuredJson !== null`, coach write-job kinds, an open
  `content` intent, stamp names, the `adhoc-` prefix, membership in the coach plan id set). A verified coach row keeps
  its coach `plan_id` while carrying a COROS address in the container plan.
- The distinct behaviours to reproduce: plan cards (source, kind block|loose, holds); plan detail per kind; the
  week-list header (most-populated active imported plan); "week n of m", deload and race in the weekly brief
  (longest non-loose active coach plan covering the week + that week's shape); the loose bucket (deterministic id,
  widening span, excluded from every duration statement); block lifecycle (draft/active/completed/retired, hourly
  completion flip + receipt, retire archives + unpushes); block adherence; the garden's `planGap` (active IMPORTED
  plans only) and Keystone credit (a non-loose coach plan ending yesterday with adherence ≥ threshold); the coach
  dossier PLANS/UPCOMING/STRENGTH PLAN sections; guardrail authorship (`coachPlanIds`) and race dates; the coach's
  structural ops with their authorship guards; coach triggers (`plan_horizon`, `plan_ending`, `race_proximity`);
  import upsert by `(user, sourcePlanId)` with primary-plan metadata and version capture; the Studio lifecycle
  (newest-created is current; edits bump `version`; repair backups in `audit_events`); the Studio push ledger
  (keyed plan+day+title, fingerprints, address healing, drift, adoption, undo, cross-plan title uniqueness); the sync
  issue badge; export/wipe/restore ordering.
- Plan ids are persisted outside the plan tables: `planned_workouts.plan_id`, `?plan=<id>` URLs, `coach_proposals.ops`
  JSON (`planId` in structural ops, forever), `coach_triggers.evidence`, `studio_plan_pushes.plan_id`,
  `coros_write_jobs.studio_push_id`, `sync_intents.target_id` (studio sessions), `sync_notes.payload`,
  `audit_events.detail` (`studioPlanId`). **Every id must be preserved exactly** — which A2 (same ids in `programs`)
  already guarantees.

## 2. Target model

`programs` becomes the one registry of plans. Kind-specific state that is genuinely per-kind stays in extension
tables that reference `programs.id`:

| Old | New |
|---|---|
| `training_plans` | `programs` kind `coros_import`; `source = {provider, sourcePlanId, pbVersion, sourceVersion, contentFingerprint}`; status `active`/`archived` |
| `training_plan_versions` | `program_versions` (same ids) |
| `coach_plans` | `programs` kind `coach`; `disciplines = [discipline]`; `config = {loose: bool, stampPrefix}` (`loose` true exactly for `adhoc-` ids); status `draft`/`active`/`completed`/`retired`; `race_date` |
| `coach_plan_weeks` | `program_blocks` kind `firm_week`/`shape_week`, `number` = week index from the plan start, `start_date` = weekStart, `weeks` = 1, `intent` = the shape JSON (null for firm) — ids preserved |
| `studio_plans` | `programs` kind `studio`; `config = {brief, plan, version}`; "current" = newest `created_at` (one definition everywhere — the dossier's `updated_at` reading is corrected) |
| `studio_plan_pushes` | **kept** as the Studio push ledger, `plan_id` → `programs.id` (same ids); retired with the Studio code in Phase 6 once no pushed Studio session remains in the future |

`planned_workouts.origin` is backfilled from the signals above, in this order: `program`/`on_demand` (already set);
a row whose `source_workout_id` matches a live Studio push address → `studio`; `plan_id` in the coach namespace →
`coach`; otherwise `coros`. From then on every writer sets `origin` explicitly, and the seven heuristics are replaced
one by one with `origin` (each replacement a separate, tested change).

## 3. Migration protocol (expand → migrate → switch → verify → contract)

Each step is its own deploy, rehearsed first on staging with a fresh in-Cloudflare copy of prod (owner OK per
rehearsal), with the parity harness (Phase 0) run before and after.

1. **Expand (deploy 1).** A helper `mirrorProgram(db, kind, id)` upserts the `programs` (+ `program_versions`,
   `program_blocks`) rows from the legacy row. Every legacy **write site** calls it after writing (≈ 20 sites: import
   insert/update, version capture, coach createPlan/extendPlan/firmUp/retirePlan/widenLoosePlan/ensureAdhocPlan/the
   completion sweep/rename, Studio generate/edit/repair). A test enumerates every `insert/update/delete` on a legacy
   table in `apps/worker/src` and fails if the file does not also call `mirrorProgram` (the same introspection trick
   as the delete-all guard). Readers unchanged.
2. **Migrate (a resumable admin job).** Backfill `programs` for every legacy row (idempotent upsert, capped per
   invocation), then backfill `planned_workouts.origin`. Parity check: per-table counts and content hashes of the
   mapped fields; every legacy id present in `programs` with the same id.
3. **Switch reads (deploy 2).** Every reader moves to `programs` with the kind filter that reproduces its current
   behaviour exactly (e.g. `planGap` reads `kind = 'coros_import' AND status = 'active'`; Keystone reads
   `kind = 'coach' AND NOT config.loose`). Writers keep dual-writing, so reverting this deploy restores the old
   reads with correct data. Parity: garden full-history hash byte-identical; DTO hashes for `/api/plan/today`,
   `/api/plan/week` (8 weeks), `/api/plan/workouts`, `/api/coach/plans`, every `/api/coach/plans/:id/detail`,
   `/api/garden`, coach state; calendar fingerprints unchanged; zero new write jobs.
4. **Verification window.** Two weeks of normal use (P4). The parity harness runs daily on prod (hash-only, via the
   admin routes enabled with `PARITY_ENABLED` for the window) and compares programs vs legacy rows.
5. **Contract (Phase 6, deploy 3).** Writers stop writing legacy tables; a later deploy drops them (as migration 0014
   did for the device tables), after a Time Travel bookmark.

Prod cutover per deploy: confirm D1 Time Travel retention, record a bookmark immediately before, the rollback runbook
(`docs/STAGING.md`) rehearsed on staging.

## 4. Behaviour changes allowed in Phase 5 (each listed, tested, and disclosed)

1. Rename and Retire on plan cards are shown only for kinds that support them (today they silently no-op or 404 for
   imported and Studio plans).
2. Studio authoring is removed from the UI (P5). Existing Studio plans stay visible as read-only program detail;
   their pushed sessions keep working through the ledger until they age out.
3. The coach dossier's "current Studio plan" uses the same definition as everything else.
4. Watch removals for imported sessions (09-20 spec §7 Phase B): the delete lane addresses imported workouts by their
   source ids with a fingerprint from the latest schedule snapshot, refusal code `coros_changed_since_seen`; 3 jobs
   per invocation; per-session state in the UI. Verified against the real account, never the mock.

Everything else is byte-for-byte identical, proven by the parity harness.

## 5. Risks

| Risk | Mitigation |
|---|---|
| A writer missed by the mirror | The introspection test; the daily parity check in the window. |
| Garden `planGap`/Keystone semantics drift | Kind filters reproduce the exact predicates; garden hash parity from genesis. |
| Proposal ops referencing plan ids | Ids unchanged; ops keep working. |
| Studio ledger breaks during the switch | The ledger is untouched; only its parent row moves. |
| A partial backfill | Idempotent, resumable, counted; switch deploy refuses to run if counts differ (a startup check logs and serves legacy reads). |
