# COROS Cloud-Direct Implementation Plan (Phases A + B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The worker talks to COROS directly — activity visible ≤10s after app open with the Mac off (Phase A), watch writes without the Mac (Phase B).

**Architecture:** Extract the bridge's transport-pure COROS modules into a shared `packages/coros`; add a `provider_connections` row (provider `"coros"`, encrypted pwdMd5) + connect/disconnect routes + Settings card; a single-flighted `read-now` service (claim-token pattern) pulls activities/schedule/health on app open and on cron; the backfill walker and the write-job consumer run worker-side. Spec: `docs/superpowers/specs/2026-08-12-coros-cloud-direct-design.md`.

**Tech Stack:** Cloudflare Workers + Hono + Drizzle/D1, React + TanStack Query, vitest (`pnpm test` from repo root; suites also run per-package). Node 22 for wrangler.

## Global Constraints

- **Secrets:** plaintext password never exists server-side (browser MD5s it); pwdMd5 and tokens AES-GCM-encrypted via `encryptSecret`/`decryptSecret` with `env.TOKEN_ENCRYPTION_KEY`; nothing secret in logs, errors, or DTOs (bridge invariant, kept verbatim).
- **Exactly-once:** every COROS pull/write is claimed via the token pattern before any network call (`coach_locks` kinds `coros_read` / `coros_write`); read-now freshness window **90s**; login retry on envelope `1019` exactly once; `1030` sets `status:"error"`+`lastErrorCategory:"bad_credentials"` and STOPS retries until credentials change.
- **Read targets (spec §3):** activities list last **14 days** + detail for unseen; schedule delta **7 days**; full 90-day schedule when `meta.lastFullScheduleAt` >6h old; daily metrics 7 days. Backfill: one 90-day chunk per cron tick.
- **Copy:** sync line reads "Synced with COROS · X ago" / "COROS unreachable since X — retrying" / "COROS rejected the password — fix in Settings". Garden tone.
- Determinism: ingest → `resimulateFrom` exactly as the bridge path does; garden contract untouched.
- Bridge keeps compiling and its tests keep passing through Phase A+B (Phase C deletes it later).
- Commit each task with the standard trailers (Co-Authored-By + Claude-Session).

---

### Task 1: Extract `packages/coros` (shared transport-pure modules)

**Files:**
- Create: `packages/coros/package.json`, `packages/coros/tsconfig.json` (copy shape from `packages/providers`'s), `packages/coros/src/index.ts`
- Move (git mv, then fix imports): `services/coros-bridge/src/coros-client.ts` → `packages/coros/src/client.ts`; `services/coros-bridge/src/create-executor.ts` → `packages/coros/src/create-executor.ts`; `services/coros-bridge/src/write-executor.ts` → `packages/coros/src/write-executor.ts`
- Move their unit tests from `services/coros-bridge/test/` (client/create-executor/write-executor suites) → `packages/coros/test/`
- Modify: `services/coros-bridge/src/index.ts` + every bridge import site → import from `@rg/coros`; bridge `package.json` gains the workspace dep.

**Interfaces:**
- Produces: `@rg/coros` exporting `CorosClient` (constructor unchanged), with the md5 seam split: `login(email, password)` DELETED from the shared client; `loginWithHash(email: string, pwdMd5: string): Promise<{userId: string}>` made public. Everything else (reads, writes, `CorosApiError`, `COROS_HOSTS`, `createWorkout`, `deleteWorkout`, `write-executor` exports, `EXERCISE_METADATA`, …) re-exported verbatim.
- Bridge keeps its own `login(email, password)` as a 3-line wrapper in `services/coros-bridge/src/coros-login.ts` using `node:crypto` md5 → `client.loginWithHash`.

Steps:
- [ ] Scaffold the package (name `@rg/coros`, same tsconfig/vitest wiring as `@rg/providers`); `pnpm install`.
- [ ] `git mv` the three modules + their tests; remove `import { createHash } from "node:crypto"` from client.ts; make `loginWithHash` public and delete `login`; add the bridge-side wrapper; fix all imports (`grep -rn "coros-client\|create-executor\|write-executor" services/coros-bridge apps/worker`).
- [ ] Run: `pnpm vitest run` (root) → everything green, bridge suites included. `pnpm typecheck` → clean.
- [ ] Commit: `refactor(coros): extract transport-pure client + executors into @rg/coros (workers-compatible)`

### Task 2: Connection plumbing — routes + client factory

**Files:**
- Create: `apps/worker/src/services/coros-connection.ts`, `apps/worker/src/routes/coros.ts`
- Modify: `apps/worker/src/index.ts` (mount `/api/coros`), `packages/api-client/src/index.ts` (DTOs + methods)
- Test: `apps/worker/test/coros-connection.test.ts`

**Interfaces (produces):**
```ts
// coros-connection.ts
export interface CorosConnectResult { status: "connected" | "bad_credentials" | "login_failed" }
export async function connectCoros(db, env, userId, input: { email: string; pwdMd5: string; region: "us" | "eu" | "cn" }, fetchImpl?): Promise<CorosConnectResult>
export async function disconnectCoros(db, userId): Promise<void>
/** Authed client or null (no connection / bad credentials). Decrypts pwdMd5,
 * reuses the cached token when fresh, logs in (and persists the new token,
 * expiresAt = now+20h) when stale. On 1030 during refresh: flips the row to
 * error/bad_credentials and returns null. */
export async function corosClient(db, env, userId, fetchImpl?): Promise<CorosClient | null>
export async function corosConnectionStatus(db, userId): Promise<{ connected: boolean; status: string | null; lastSyncAt: string | null; lastErrorCategory: string | null; email: string | null; region: string | null }>
```
Routes: `POST /api/coros/connect` (validates `{email, pwdMd5(32 hex), region}`, 200 `{status}` — 401-class COROS rejection returns 200 with `status:"bad_credentials"` so the card can show copy), `DELETE /api/coros/connect`, `GET /api/coros/status`. api-client: `corosConnect`, `corosDisconnect`, `corosStatus`.

Storage mapping (spec §1): row `{provider:"coros", encryptedRefreshToken: enc(pwdMd5), encryptedAccessToken: enc(token), accessTokenExpiresAt: +20h, externalAccountId: corosUserId, meta: {email, region, lastFullScheduleAt?}, status, lastSyncAt, lastErrorCategory}`.

Tests (fake `fetchImpl` returning scripted envelopes): connect success persists encrypted row + verifies round-trip via `corosClient` (fresh token reused: exactly ONE login call across two `corosClient` calls); connect with `1030` → `bad_credentials`, no row update to connected; token expiry → re-login once and persist; `1019` mid-request → the shared client's retry (already unit-tested in Task 1) — here assert corosClient passes credentials so retry works; disconnect wipes.

- [ ] Failing tests → implement → green (`pnpm vitest run test/coros-connection.test.ts` then full) → typecheck → commit: `feat(worker): COROS cloud connection — encrypted pwdMd5, token cache, connect/status/disconnect routes`

### Task 3: Settings card (browser-side MD5, connect/disconnect UX)

**Files:**
- Create: `packages/ui/src/md5.ts` (pure-JS MD5, well-known public-domain implementation, typed `md5Hex(s: string): string`)
- Modify: `packages/ui/src/screens/settings.tsx` (new "COROS connection" card above the device/pairing card)
- Test: `packages/ui/test/md5.test.ts`, extend `packages/ui/test/render-smoke.test.ts` if settings smoke exists

Card behavior: disconnected → email + password + region select + "Connect" (password field `type=password`, hashed with `md5Hex` before the request, never stored in state longer than submit); connected → "Connected as {email} · last sync X ago" + Disconnect; error state → the bad-credentials copy from Global Constraints with the form re-opened. While a connect is in flight: disabled + "Checking with COROS…".

Tests: `md5Hex("password") === "5f4dcc3b5aa765d61d8327deb882cf99"` (RFC test vectors incl. empty string `d41d8cd98f00b204e9800998ecf8427e`); card renders each state from primed queries.

- [ ] Failing tests → implement → green → commit: `feat(ui): COROS connect card — password hashed in the browser, honest states`

### Task 4: read-now — the single-flighted pull

**Files:**
- Create: `apps/worker/src/services/coros-read.ts`
- Modify: `apps/worker/src/routes/coros.ts` (`POST /api/coros/read-now`), `apps/worker/src/index.ts` (halfHourly per-user pull for connected users), `apps/worker/src/routes/devices.ts` (extract the daily-health upsert block into a shared `ingestDailyHealth(db, userId, rows)` in `apps/worker/src/services/completion.ts` or a small `health-ingest.ts`, called from both)
- Test: `apps/worker/test/coros-read.test.ts`

**Interfaces (produces):**
```ts
export interface ReadNowResult { status: "ok" | "fresh" | "busy" | "not_connected" | "coros_unreachable" | "bad_credentials"; ingested?: number }
export async function corosReadNow(db, env, userId, prefs, opts?: { force?: boolean; fetchImpl?: typeof fetch }): Promise<ReadNowResult>
```
Pipeline (spec §3, in order): freshness gate (lastSyncAt <90s → `"fresh"`, unless force) → claim `coach_locks` kind `"coros_read"` (token pattern verbatim from `claimWakeLock`; loser → `"busy"`) → `corosClient` (null → `"not_connected"`/`"bad_credentials"` per row state) → activities list 14d → `getActivityDetail` for provider ids not in `activity_source_links` → map through the bridge's snapshot normalization (reuse `@rg/providers` raw→SourceActivity mapping — the same functions `snapshot.ts` uses; import them, don't re-derive) → `ingestActivities` → `resimulateFrom(earliest affected)` → `enqueueCoachReads` + `waitUntil(processCoachReads)` (mirror the devices.ts hook) → schedule: 7-day `getRawSchedule` → `importPlanSnapshot` (source `"cloud"`), and when `meta.lastFullScheduleAt` >6h old also the 90-day window + stamp it → `getDailyMetrics` 7d → `ingestDailyHealth` → update `lastSyncAt`, release lock (finally). Failures: network/api → `"coros_unreachable"`, `lastErrorCategory:"api_error"`; never throws.

Cron: in `halfHourly`, for each user with a connected row: `await corosReadNow(db, env, userId, prefs, { force: true }).catch(() => undefined)`.

Tests (fake client): happy path ingests a new activity end-to-end (activity row + laps exist after; `resimulateFrom` spied via garden events or a seam param); two concurrent `corosReadNow` → ONE client pull (`"busy"` for the loser); <90s repeat → `"fresh"`, zero client calls; unconnected → `"not_connected"`; client returning `CorosApiError("api_error")` → `"coros_unreachable"` + row lastErrorCategory set; full-schedule stamp: first call does 90d, second within 6h does 7d only (assert via fake client's recorded ranges).

- [ ] Failing tests → implement → green (full suite) → commit: `feat(worker): coros read-now — single-flight cloud pull on demand + halfHourly cron`

### Task 5: Backfill runs in the worker

**Files:**
- Modify: `apps/worker/src/services/backfill.ts` (a `runBackfillChunkCloud(db, env, userId, prefs)`: read `backfill_state`+next queued chunk job, pull that 90-day window via `corosClient` using the same paging the bridge used, call the existing `recordChunk` + `advanceBackfill`), `apps/worker/src/index.ts` (halfHourly: one chunk per tick per connected user with an active backfill), `apps/worker/src/routes/misc.ts` (`POST /activities/backfill`: when cloud-connected, `waitUntil(runBackfillChunkCloud(...))` so the first chunk starts immediately)
- Test: `apps/worker/test/backfill.test.ts` (extend)

**Interfaces:** `runBackfillChunkCloud(db, env, userId, prefs, fetchImpl?): Promise<{ ran: boolean }>` — no-ops (`ran:false`) when not connected, no active backfill, or no queued chunk (bridge devices keep their claim path untouched for now).

Tests: with a connected row + enqueued backfill and a fake client serving one chunk of activities: one call ingests the chunk, `backfill_state.chunksCompleted` increments, next chunk job queued (`advanceBackfill` behavior — already tested; assert integration end state); not-connected → `ran:false` and the queued job is left for a device.

- [ ] Failing tests → implement → green → commit: `feat(worker): backfill walks in the worker when COROS is cloud-connected`

### Task 6: UI — read-now on open, honest sync line, no more Mac mystery

**Files:**
- Modify: `packages/ui/src/screens/plan.tsx` + `packages/ui/src/screens/runs.tsx` (on mount: `api.corosReadNow()` mutation; while pending show a `SyncStatusLine`-adjacent "Checking COROS…" pill; on `ok` with `ingested>0` invalidate `plan`, `plan-week`, `today`, `garden`, activity queries), `packages/ui/src/components.tsx` (`SyncStatusLine` cloud mode: accepts optional `cloud: { connected: boolean; lastSyncAt: string | null; error: string | null }` and prefers it over device presence with the spec copy), `apps/worker/src/routes/sync.ts` or `sync-status.ts` (status DTO gains `cloud` block from `corosConnectionStatus`), `packages/api-client` (`corosReadNow`, DTO fields)
- Test: `packages/ui/test/plan-page.test.tsx` (extend: checking-COROS state renders), worker `sync-status` suite (cloud block presence)

Behavior detail: fire read-now at most once per mount AND only when the page is visible (`document.visibilityState === "visible"`); server's 90s freshness makes repeats free anyway. Backfill button: cloud-connected → no Mac warnings, shows "chunk N done" progress from existing status polling.

- [ ] Failing tests → implement → green → commit: `feat(ui,worker): app-open COROS pull with a visible checking state; sync line tells the cloud truth`

### Task 7 (Phase B): Writes without the Mac

**Files:**
- Create: `apps/worker/src/services/coros-write-cloud.ts`
- Modify: `apps/worker/src/services/jobs.ts` (`emitPendingWork` gains `{cloudConnected}` short-circuit: when true, skip device emission and call the cloud consumer), `apps/worker/src/index.ts` (hourly sweep: `executeCloudJobs`), enqueue sites already funnel through `emitPendingWork`/job insertion — after insert, `waitUntil(executeCloudJobs(...))` from the routes that enqueue (`studio.ts` push, `plan.ts` move/retry, coach approve path via `applyOps` → they all go through `emitPendingWork`; hook there once)
- Test: `apps/worker/test/coros-write-cloud.test.ts`

**Interfaces (produces):**
```ts
export const CLOUD_DEVICE_ID = "cloud"; // synthetic claimedByDeviceId — attempts/handshakes key off it
export async function executeCloudJobs(db, env, userId, prefs, opts?: { cap?: number; fetchImpl? }): Promise<{ executed: number }>
```
Loop (cap default 3): claim `coach_locks` kind `"coros_write"` (one executor per user) → `claimNextJob(db, userId, CLOUD_DEVICE_ID)` → build the payload exactly as `bridgeJobPayload` does (reuse it) → run `@rg/coros` `write-executor` against `corosClient` → feed the outcome through `applyJobResult(db, userId, result, prefs)` with `deviceId: CLOUD_DEVICE_ID` — identical envelope the bridge would have sent, so verify/undo/drift stay intact → release lock.

Tests (fake client): a queued `create_scheduled_workout` job executes → job `verified`-path result recorded via `applyJobResult` (assert job status + `studio_plan_pushes`/intent effects for a studio push fixture); failure envelope → `write_failed` categorized, attempts increment; two concurrent `executeCloudJobs` → single claim (lock); `emitPendingWork` with cloudConnected → 0 device emissions and jobs still get executed.

- [ ] Failing tests → implement → green → commit: `feat(worker): COROS writes execute in the worker — the watch updates with the Mac off`

### Task 8: Verification + deploy

- [ ] Full suites + typecheck (`pnpm vitest run`, `pnpm typecheck`) — bridge suites still green (it must keep working until Phase C).
- [ ] Screenshot pass for changed UI (settings card states, checking-COROS pill) at 360/390/1440 via the existing `plan-shots.mjs` pattern; mobile overflow gate must pass.
- [ ] Deploy via push to main (CI migrates + deploys — no new migration in this plan; `provider_connections` already exists).
- [ ] **Live acceptance (requires the user once):** user opens Settings → Connect COROS (email + password + region us). Then: `read-now` round-trip on the Activity page; record/verify against their real data; Backfill with Mac closed; studio re-push with Mac closed. Success criteria spec §Success 1–3.
- [ ] Update memory + report; Phase C (bridge deletion) gets its own plan after A+B run clean.

## Self-review

- Spec §1↔Tasks 2–3, §2↔Task 1, §3↔Tasks 4–6, §4↔Task 7, §5↔Task 6, §6 Phase A/B↔Tasks 1–7 (C deferred by design), §Errors↔Tasks 2/4 tests, §Testing↔each task, §Success↔Task 8.
- Names used across tasks: `corosClient`, `connectCoros`, `corosReadNow`, `runBackfillChunkCloud`, `executeCloudJobs`, `CLOUD_DEVICE_ID`, `loginWithHash` — consistent.
- No placeholders; code seams that are novel are specified, ports reference exact source files being moved.
