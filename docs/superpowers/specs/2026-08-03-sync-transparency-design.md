# Sync Transparency — Design

**Date:** 2026-08-03
**Status:** Approved by user (all four sections), pending spec review
**Approach:** "C, scoped right" — worker-side sync reconciler with an intent ledger; bridge executor and job contract untouched.

## Goal

Sync between the app, Google Calendar, and COROS should be as transparent as possible: automatic in every case where automation is possible, and surfaced to the user only when (a) they can do something (wake the Mac, pair, retry, flip a toggle) or (b) an automatic resolution happened that they may want to undo. The system must never raise an alarm about its own actions.

## User decisions (recorded)

1. **Desktop model:** always-on login item with menu-bar presence. Bridge offline becomes "Mac asleep/off" only.
2. **Conflicts:** last-edit-wins, applied automatically, with a dismissible undo note. Never a stuck state.
3. **Surfacing:** a quiet **persistent** status line (user explicitly chose this over urgency-gated surfacing). Transparency = glanceable truth, not hidden machinery.
4. **Approach:** C over B — accept ~3–5x the effort to kill the coordination-bug class structurally, given it has already fired three times and mutation sources keep growing.

## Why C: the problem is structural

Four mutation sources already exist (in-app move, Google Calendar drag, studio push/retire, remove-from-plan) and two independent detectors (`jobs.ts` move states, `studio-push.ts` drift), which do not share intent memory. That matrix has produced three real bugs:

1. The app's own calendar move later reads as "Changed outside the studio" (`studio-push.ts` drift vs `jobs.ts:273` writing `lastVerifiedCorosDate`), permanently unmanaging the session behind a disabled Forget/re-adopt button.
2. "Remove from plan" (UI promises "COROS untouched") sets `archivedAt`, which `detectDrift` reads as "user deleted this on COROS."
3. Mirror-dedup archival (`import-plan.ts:552-556`) reads the same way.

Plus stored-status drift: `waiting_for_device`/`syncing` not persisted on failure paths (`jobs.ts:294-296`), an `"unchanged"` sentinel leaking out of `applyJobResult`, and a paused bridge reading as "online" on Today (`plan.ts:126` ignores `bridgePaused`).

Patch-per-cell (approach B) leaves the tax in place for every future mutation source. The reconciler makes participation automatic.

## Section 1 — Core model

### Intent ledger

New append-only table **`sync_intents`**. Every schedule mutation the app makes records an intent:

- `target` — planned workout id or studio session id
- `kind` — `move` | `create` | `delete` | `remove_local` | `restore`
- `payload` — date and/or session content reference
- `source` — `user_move` | `calendar_drag` | `studio_push` | `studio_retire` | `remove_from_plan` | `auto_resolve` | `undo` (open set for future sources, e.g. LLM coach)
- `createdAt`, `supersededBy`

### Observation ingestion (port-don't-redesign zone)

The current `import-plan.ts` admission / mirror-dedup / plan-scoped-identity logic is **ported intact** — this encodes hard-won COROS wire-model knowledge (per-row `planId`, recycled `idInPlan` slots, duplicate mirrors, template plans). One change: `archivedAt` splits into **`archiveReason`** (`absence_confirmed` | `user_removed` | `duplicate_mirror`), mapped from the existing suppression reasons. Only `absence_confirmed` may ever be interpreted as "gone on COROS."

### Reconciler

A pure function replaces the decision layers of `jobs.ts` and `studio-push.ts`:

```
(desired = fold(sync_intents), observed, in-flight jobs, device liveness)
  → jobs to emit/supersede in coros_write_jobs   (payload contract UNCHANGED)
  → derived per-target sync status               (computed on read, never stored)
```

- The bridge executor (`create-executor.ts` safety core: plan-scoped identity, stamp ownership, guarded deletes) is **not modified**.
- `coros_write_jobs` remains the durable outbox; claim/lease/reaper mechanics unchanged.
- `planned_workouts.corosSyncState` column is retired from decision-making (kept only if needed for migration audit); status is derived.
- `studio_plan_pushes` becomes an execution-history record; its `status`/`error` no longer drive UI.

### Migration & healing

- Backfill intents from current state (effectiveDate vs lastVerifiedCorosDate disagreements become pending `move` intents; studio desired sessions become `create` intents already satisfied).
- Rows stuck in `changed_on_coros` from false drift are re-derived by the reconciler and **rejoin management**.
- `archiveReason` backfilled from existing suppression reasons.
- The disabled Forget/re-adopt affordance is deleted — the state it apologized for no longer exists.

## Section 2 — Conflict policy: last-edit-wins, tie to the app, undo instead of asking

COROS provides no edit timestamps; a change is only bounded between two snapshots. Therefore:

- **Unresolved intent exists → the app wins.** The intent is re-emitted; the observed COROS value is recorded and surfaced as an undo note. (Rationale: the intent is provably the most recent thing the user did; COROS's change time is unknowable within the snapshot window; the user was looking at the app.)
- **No pending intent → COROS wins**, adopted automatically (today's behavior for upstream moves). An undo note is posted when the adoption displaces a previously synced value; a first-time import of a new workout posts nothing.
- **Undo = a new intent** (`source: undo`). Notes are dismissible, appear on Today and the affected workout's sheet, and expire after 7 days.
- `needs_attention` as a stuck, non-actionable state is **retired**.

**Studio sessions follow the same rule.** A strength workout edited in the COROS app is *adopted* as the new desired state; the undo note offers "re-push the original." The permanent `changed_on_coros`/unmanaged state disappears. Genuine external deletion (`archiveReason: absence_confirmed`) is adopted as removal, with undo (re-create).

## Section 3 — Freshness, transport, desktop

- **`read_now` job kind:** bridge performs an immediate plan-window read + snapshot push. Enqueued when the web app opens and the last snapshot is >5 min old. A **"Sync now"** button appears in web Settings and the desktop menu bar.
- **Adaptive polling:** the claim/poll response gains `pendingCount`; the bridge polls every ~10s while `pendingCount > 0` and returns to 45s once the queue drains. Writes land in seconds while the Mac is awake. The 30-min baseline snapshot remains.
- **Centralized liveness:** one server-side function derives device presence — the 3-minute `lastSeenAt` rule, now honoring `bridgePaused` and revocation — replacing the four hardcoded copies (`jobs.ts:28`, `devices.ts:110`, `plan.ts:126`, `studio.ts:126/273`). A paused bridge can never read as online. The dead `POST /api/devices/bridge/heartbeat` endpoint is deleted.
- **Desktop app:** becomes a **login item** with menu-bar presence (status glance, Sync now, Pause, Open app). Sidecar lifetime is tied to the app process (fixes orphaned `coros-bridge` sidecars observed 2026-08-01). Silent self-update already exists; capability/version refresh rides the first snapshot after update (with `read_now` making this prompt in practice).

Google Calendar sync is unchanged mechanically (server-side cron, `accept_user_move`); calendar drags simply become `calendar_drag` intents, which closes their false-drift path as a side effect.

## Section 4 — Status vocabulary & UI

One derived status served by one endpoint, rendered by one component on Today, Garden, Plan, and Studio — a quiet persistent line (user's explicit choice):

| State | Line (representative copy) | Actionable? |
|---|---|---|
| In sync | "Calendar, COROS and watch in sync · 2m ago" | No — quiet |
| Syncing | "Syncing 2 changes…" | No |
| Waiting for Mac | "2 changes waiting — wake your Mac to update your watch" | Yes: wake Mac |
| Not synced to COROS | "COROS updates are off" / "No Mac paired" + enable/pair link | Yes: configure |
| Sync issue | "1 change couldn't sync · Retry" | Yes: retry |

- Conflicts, external edits, and mirror weirdness never appear as states — they self-resolve into **In sync + undo note**.
- Per-workout detail stays on the workout sheet; per-session studio pills reduce to synced/syncing/waiting plus "edited on COROS · Undo".
- Google Calendar event bodies keep carrying the status label.
- The never-paired silent degradation becomes an explicit prompt at move time: "This will only change the app calendar — pair your Mac to update COROS."
- Settings keeps the writes toggle (default OFF until the user flips it) and diagnostics (last read, pending jobs, device presence — now from the centralized liveness function).

### Error handling

- Retries keep re-read-before-write semantics in the bridge write executor (unchanged).
- Exhausted retries land in **Sync issue** with a retry that re-derives the job from intent — never a blind replay of a stale payload.
- Job supersede-on-newer-intent moves into the reconciler (replacing `jobs.ts:112-121` and the studio push's kill-in-flight logic).

### Testing

- The reconciler is pure → property/fixture tests over (intents × observations × liveness) matrices; this is the primary correctness gate.
- Existing import fixtures port to the observation-ingestion stage.
- `pnpm coros:spike` live verification gates the first prod push of the reconciler path.
- Fail-safe defaults preserved: writes remain opt-in; unknown reconciler situations degrade to "emit nothing, report Sync issue" rather than guessing a write.

## Out of scope

- Any bridge-side/executor changes beyond the `read_now` job kind and adaptive poll interval.
- Push transport (WebSockets/Durable Objects) — polling at 10s pending / 45s idle meets the latency need.
- Redesigning COROS admission/dedup heuristics.
- Mobile/phone bridge; the Mac remains the only write path (physics of the current COROS access model).

## Known limitations accepted

- Mac asleep/off = writes queue; the watch can be stale. Surfaced honestly by the persistent status line.
- Last-edit-wins tie-breaking is approximate (COROS edit times unknowable); mitigated by undo notes.
- Single-user assumptions elsewhere in the worker (pre-existing) are not addressed here.
