# R1 (run-garden): `training-v5` — the library, take-back and the coach on the phone

**Source:** the LifeOS migration's DESIGN-3 revision 2 (kit v0.20): the v0.20 deltas, §3 (architecture, crossings,
training changes, `training-v5`, identity, memory, cost, failure modes, the laptop), §5 (risks, invariants, tests) and
§7 (R1's build list); bounded by the lead's v0.20 rulings (sharing built disabled; no free text crosses; receipt-bound
take-back; explicit operation and version approval; incomplete output never approvable; the $20 cutoff kept; no new
notifications and no automatic training writes).

**Base:** `mig-v19/renew` at `8ca91aad` (Renew, under its own review; it ships alone first). Branch `mig-v20/r1`. Not
pushed: a push to main deploys. **One migration, `0040_take_back_receipts`:** additive only, no backfill, no lock on a hot
table; rolling the code back leaves its tables idle and harmless.

**Rules held throughout:** test-first; every training write through run-garden's own services and rules; v4's list
unchanged inside v5; nothing new notifies; nothing writes the plan without the owner's explicit approval naming its ops
and version; the calls the design left open are in the migration's private `v0.20/r1/CALLS.md`.

## Tasks

- [x] **1. The scope and the gate.** `auth/device-scope.ts`: `DEVICE_SCOPE_V5`, `TRAINING_V5` = v4's seventeen entries (the
  same objects) and 28 pairs of its own — 9 native (templates, library, place, take-back, receipts, switch A) and 19 coach
  (runs, conversation, proposals, drain, memory, nudges, spend) — each with a body or query rule; `DeviceRoute.method`
  gains PATCH and DELETE; NEWEST/PAIRING v5, `NEXT[v4] = v5`, `PREVIOUS[v5] = v4`. Tests: `native-allowlist` (v5 pinned,
  every mounted route under v5), `native-grant` (v4 → v5, v5 → v4; v3 → v5 and v5 → v3 refused), `native-gate` (PATCH and
  DELETE), pairing mints v5.
- [x] **2. The laptop's words** (`devices.tsx`): v5's capability line, *Allow your library and coach* (saying it shares
  nothing of the day) and *Stop library and coach*; api-client types for every new answer.
- [x] **3. Migration 0040**: `take_back_receipts` and `native_device_sharing` (CALLS C1); schema; registry (`user`, and a
  sign-in); delete-all; QA purge (25 → 24 deletes a step); the copier; `SCHEMA_VERSION`; `taken_back` (a decision for the
  import's healing). `take-back-tables.test.ts`: additive only, applied to a 0039 database holding rows, rows unchanged.
- [x] **4. The library reads** (`routes/native-library.ts`): templates without documents, moves trimmed to one verdict.
- [x] **5. Place**: `createDocWorkout` with the use count and the receipt in its batch (`alsoInBatch`, `afterPlaced`).
- [x] **6. Take-back** (`services/take-back.ts`, `routes/native-take-back.ts`): claim-first (CALLS C6), the inverse through
  run-garden's own writers (`removeFromPlan`, `reviseDocWorkout`, `applyMove`, `unskipWorkout` with one-batch paths), every
  refusal, idempotency, the budget's `remaining`, compensation read live.
- [x] **7. Receipts on approve** (`design-approve.ts`, `coach-apply.ts`): new and revised workouts, moves and skips (CALLS
  C4, C5); the declared costs count them.
- [x] **8. Version and completeness** (`design-version.ts`, `proposal-version.ts`): the proposal read's `version`,
  `complete`, `missing`, `opsSummary`, `receipts`, `takeBackable`; 409 `proposal_changed`, `incomplete`, `not_designed`.
- [x] **9. The coach on the device**: the QA gate after `requireUser` (`coach-device-gate.ts`); `frame` (`design-frame.ts`,
  exact keys, 409 `sharing_off` unless switch A is on under its consent); `via: "lifeos"` from the device (CALLS C2);
  `frameLines`; the header; `maxTokens` 32,000; `POST /api/coach/memory` (CALLS C9).
- [x] **10. From LifeOS on the laptop** (the coach conversation's turn, the tolerant reader, api-client).
- [x] **11. The harness check** (section 4h: the v5 grant, library, place, take-back, switch A off, a scripted run →
  proposal → approve with its version → take-back after a laptop edit, From LifeOS, the step-down) with the fixture
  designer on loopback; `docs/SECURITY.md`.
- [x] **12. Gate** (rebased on `mig-v19/renew` `f08c4c3f`): typecheck, all 18 packages clean; the full suite under Node 21,
  797 files and 14,881 tests passed, none failed (the first pass caught 17: the laptop's approve answer gained keys —
  now a device's only — and budget pins that moved with the receipts and 32k); the native harness check under Node 22 on
  workerd and local D1 with the scripted designer, 206 passed, 0 failed; migration 0040 applied to a fresh local D1 and
  to a copy of a local D1 at 0039 holding rows, the rows unchanged.

**Mutations killed** (by hand, each reverted): take-back without the compare; without the account filter; the receipt out
of the place's batch and of the approve's; `frame` accepting free text; `frame` ignoring switch A; origin from the body; the
QA gate removed; the version check removed; `complete` ignored for devices; a device approve without its version at the
gate; v4's list changed inside v5; the step-down keeping switch A on; the library row untrimmed.
