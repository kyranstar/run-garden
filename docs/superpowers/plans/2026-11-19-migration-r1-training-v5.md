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

- [ ] **1. The scope and the gate.** `auth/device-scope.ts`: `DEVICE_SCOPE_V5`, `TRAINING_V5` (v4's seventeen entries,
  the same objects, then the library, place, take-back, sharing and coach pairs, each with its body or query rule),
  `DeviceRoute.method` gains `PATCH` and `DELETE`; NEWEST/PAIRING v5, `NEXT[v4] = v5`, `PREVIOUS[v5] = v4`. Tests:
  `native-allowlist` (v5 pinned; every mounted route under v5), `native-grant` (v4 → v5, v5 → v4, v3 → v5 refused).
- [ ] **2. The laptop's words** (`devices.tsx`): v5's capability line, grant and step-down; api-client types.
- [ ] **3. Migration 0040**: `take_back_receipts` and `native_device_sharing`; schema; registry; delete-all; QA purge;
  the copier; `SCHEMA_VERSION`; `ARCHIVE_REASONS` gains `taken_back`.
- [ ] **4. The library reads** (`routes/native-library.ts`): templates list and detail, moves list and detail, trimmed.
- [ ] **5. Place** (`POST /api/native/templates/:id/place`): `createDocWorkout` with the use count and the receipt in
  its batch.
- [ ] **6. Take-back** (`services/take-back.ts`, `routes/native-take-back.ts`): the receipt's compare, the refusals,
  idempotency, the inverse writes through run-garden's own services, compensation read live.
- [ ] **7. Receipts on approve** (`design-approve.ts`): one per applied op it can take back, in that op's batch.
- [ ] **8. Version and completeness**: the proposal read's `version`, `complete`, `missing`, `opsSummary`, `receipts`,
  `takeBackable`; the device approve's version check and `incomplete`.
- [ ] **9. The coach on the device**: the QA gate after `requireUser`; `frame` (exact keys, switch A's flag); `via`
  from the device; `frameLines`; the header; `maxTokens` 32,000; `POST /api/coach/memory`.
- [ ] **10. From LifeOS on the laptop** (`run-card.tsx`, `coach-conversation.tsx`).
- [ ] **11. The harness check** (local D1, the fixture model) and `docs/SECURITY.md`.
- [ ] **12. Gate**: typecheck; the full suite; the harness under Node 22; the migration on a fresh and a copied local D1.
