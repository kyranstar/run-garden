# COROS Phase C — Bridge Decommission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the desktop bridge era entirely — `services/coros-bridge`, `apps/desktop`, device routes/pairing/handshakes, the `desktop_devices`/`device_handshakes` tables, and every "Mac presence" branch — leaving the cloud COROS connection as the only executor.

**Architecture:** Replace `devicePresence` (Mac liveness) with cloud-connection liveness everywhere it gates behavior; delete the device HTTP surface and its auth; delete the two repos' worth of bridge/desktop code; port the census dev tool onto `@rg/coros`; drop the tables in a **separate final deploy** so no live worker ever queries a dropped table.

**Tech Stack:** Cloudflare Workers + Hono + Drizzle/D1, React + TanStack Query, vitest (better-sqlite3), Playwright smoke suite.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-12-coros-cloud-direct-design.md` §Phase C (lines 122–127): remove bridge service, desktop app, device routes/handshakes, both device tables, the desktop release workflow, and the pairing settings surface; census moves to a local CLI on the vendored client.
- R1: no overflow/clipping or unnecessary wrapping on mobile (390px gate).
- R2: nothing processed twice by the LLM; job claim machinery (claim tokens, `CLOUD_DEVICE_ID`) stays intact.
- `corosWriteJobs.claimedByDeviceId` / `corosWriteAttempts.deviceId` columns STAY (the cloud writes `"cloud"` into them).
- The `user_locks` kind `"wake"` is the coach LLM wake — unrelated to devices; do not touch.
- Deploy order: Tasks 1–6 are one deploy; Task 7 (DROP migration) pushes only after that deploy is verified live.
- Full gates per task: `pnpm typecheck` and `pnpm vitest run` from repo root; Playwright smoke + 390px overflow probe before each deploy.

---

### Task 1: Presence goes cloud (worker core + DTOs + UI sync line)

**Files:**
- Modify: `apps/worker/src/services/sync-status.ts` (devicePresence → cloud-backed; drop `waiting_for_mac`)
- Modify: `apps/worker/src/services/jobs.ts:19,48,52` (online/writeCapable from cloud connection)
- Modify: `apps/worker/src/routes/plan.ts:46,89,216,256`, `apps/worker/src/routes/sync.ts:6,314–319`, `apps/worker/src/routes/misc.ts` (today DTO `sync.deviceOnline`/`deviceRegistered`)
- Modify: `packages/api-client/src/index.ts` (SyncStatusResponse/TodayResponse device fields)
- Modify: `packages/ui/src/components.tsx` (SyncStatusLine: delete `waiting_for_mac` + `not_synced`-registered legacy branches)
- Test: `apps/worker/test/helpers.ts` (new `connectTestCoros`), `apps/worker/test/sync-status.test.ts`, `sync-routes.test.ts`, `plan-routes.test.ts`

**Interfaces:**
- Consumes: `provider_connections` rows written by `connectCoros` (provider `"coros"`, status `"connected"`).
- Produces: `cloudPresence(db, userId): Promise<{online: boolean; writeCapable: boolean}>` in sync-status.ts (both flags = coros row connected); `SyncStatusState = "in_sync" | "syncing" | "not_synced" | "sync_issue"`; test helper `connectTestCoros(db, userId): Promise<void>` inserting a connected coros row directly (no mock server needed when only presence matters).

- [ ] **Step 1: Add the failing-first helper + test.** In `apps/worker/test/helpers.ts`:

```ts
/** A connected cloud COROS row, directly — for tests where only presence
 * matters (no mock server round-trip). */
export async function connectTestCoros(db: Db, userId: string): Promise<void> {
  await db.insert(schema.providerConnections).values({
    id: newId(),
    userId,
    provider: "coros",
    status: "connected",
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
    meta: { email: "runner@example.com", region: "us" },
    externalAccountId: "98765",
  });
}
```

In `sync-status.test.ts` add: presence false with no coros row; true with `connectTestCoros`; `computeSyncStatus` never returns `"waiting_for_mac"` (queued job + no cloud → `"not_synced"`, queued job + cloud → `"syncing"`). Run: `pnpm vitest run test/sync-status.test.ts` → FAIL (helper/state missing).

- [ ] **Step 2: Rework `sync-status.ts`.** Replace the `desktop_devices` query inside `devicePresence` with a coros-connection lookup; rename to `cloudPresence` (keep a `devicePresence` alias export until Task 4 deletes the last legacy caller, then remove the alias):

```ts
export interface CloudPresence { online: boolean; writeCapable: boolean }
export async function cloudPresence(db: Db, userId: string): Promise<CloudPresence> {
  const [row] = await db.select({ status: providerConnections.status })
    .from(providerConnections)
    .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, "coros")))
    .limit(1);
  const online = row?.status === "connected";
  return { online, writeCapable: online };
}
```

Remove `waiting_for_mac` from `SyncStatusState` and its branch in `computeSyncStatus` (queued-with-no-executor now maps to `"not_synced"`). `DEVICE_ONLINE_WINDOW_MS` moves out only when Task 4 removes its last consumer.

- [ ] **Step 3: Sweep the consumers.** jobs.ts `deviceOnline`/`writeCapable` call `cloudPresence`; plan.ts/misc.ts DTO fields `deviceOnline` → cloud online, `deviceRegistered` → cloud connected (keep field names in this task; renaming DTOs happens nowhere — the UI stops reading them in Step 4); sync.ts drops the `desktopDevices` lastSeen block (the `cloud` block already exists).
- [ ] **Step 4: UI.** components.tsx SyncStatusLine: delete the `waiting_for_mac` branch and the "COROS not connected — connect in Settings" fallback duplication for registered-device users; the cloud block + `not_synced` copy remain. api-client: drop fields the server no longer sends.
- [ ] **Step 5: Green + commit.** `pnpm typecheck && pnpm vitest run` → all green. `git commit -m "refactor(worker,ui): presence is the cloud COROS connection — waiting_for_mac retired"`

### Task 2: Studio goes cloud-only

**Files:**
- Modify: `apps/worker/src/routes/studio.ts:127–159` (bridgeStatusDto), `:295–325` (catalogNotSynced)
- Modify: `packages/ui/src/screens/studio.tsx` (BridgeStatusLine, studioErrorCopy `bridge_outdated`)
- Test: `apps/worker/test/studio-routes.test.ts`

**Interfaces:**
- Consumes: `corosConnectionStatus` (already imported in studio.ts).
- Produces: `bridge` DTO shape unchanged (`{online, pendingJobs, inFlight}`) but `online` = cloud connected only; `catalog_not_synced` reasons shrink to `"syncing" | "not_connected"`.

- [ ] **Step 1: Failing tests.** studio-routes.test.ts: catalog empty + cloud connected → 412 `{reason:"syncing"}`; catalog empty + no cloud → 412 `{reason:"not_connected"}`; status DTO `bridge.online` true iff cloud connected. Run → FAIL.
- [ ] **Step 2: Worker.** bridgeStatusDto: drop `devicePresence`, `online: cloud.connected`. catalogNotSynced: drop the `desktopDevices` query and `bridge_outdated`/`bridge_offline`; not connected → `"not_connected"`.
- [ ] **Step 3: UI.** studioErrorCopy: delete `bridge_outdated` case; `"not_connected"` → "Connect COROS in Settings so the exercise catalog can sync, then try again." BridgeStatusLine queued-with-no-executor banner copy: "…connect COROS in Settings so they push from the cloud." (already true) — remove any leftover Mac wording.
- [ ] **Step 4: Green + commit.** Full gates. `git commit -m "refactor(studio): cloud connection is the only executor the studio knows"`

### Task 3: Backfill goes cloud-only

**Files:**
- Modify: `apps/worker/src/services/backfill.ts` (drop bridge claim path, `bridge_never_claimed`/`bridge_stalled_mid_walk` categories, `bridgePaused`/`bridgeOnline`/`bridgeLastSeenAt` status fields)
- Modify: `apps/worker/src/routes/sync.ts` (backfill-status DTO)
- Modify: `packages/api-client/src/index.ts` (BackfillStatusResponse), `packages/ui/src/screens/settings.tsx` (BackfillRow branches referencing bridge fields)
- Test: `apps/worker/test/backfill*.test.ts`

**Interfaces:**
- Produces: backfill status `{status, chunksCompleted, activitiesIngested, earliestDateReached, jobQueued, lastErrorCategory: "stalled" | "api_error" | null}`.

- [ ] **Step 1: Failing tests** for the slimmed status shape (no bridge fields; stalled walk → `"stalled"`). Run → FAIL.
- [ ] **Step 2: Implement** worker-side; collapse BackfillRow's non-cloud branches (the `cloud` query stays — copy differs only between connected/not-connected).
- [ ] **Step 3: Green + commit.** `git commit -m "refactor(backfill): one walker, in the cloud"`

### Task 4: Delete the device HTTP surface + auth + fixtures + test scaffolding

**Files:**
- Delete: `apps/worker/src/routes/devices.ts`
- Modify: `apps/worker/src/index.ts:16,56` (unmount), `apps/worker/src/auth/middleware.ts` (delete `requireDevice` + device signature verification; keep `withDb`/`requireUser`), `apps/worker/src/services/fixtures.ts` (drop device seeding), `apps/worker/src/routes/misc.ts:1215` (export omits devices; delete-all keeps clearing the table until Task 7)
- Modify: `packages/ui/src/screens/settings.tsx` (delete DevicesSection + "Desktop companion" card), `packages/api-client/src/index.ts` (devices/pause/revoke endpoints + types)
- Modify: `apps/web/e2e/smoke.spec.ts` (Settings test drops the "Desktop companion" assertion; assert "COROS connection" card instead)
- Modify: `apps/worker/test/helpers.ts` (delete `registerTestDevice`) + every suite that called it (`garden-timeline`, `import-reconcile`, `vertical-loop`, `heal-legacy-sync`, `studio-push`, `jobs-reconcile`, `sync-status`, `coros-write-cloud`, `insights-route`, `sync-routes`, `plan-routes`) — transformation rule: where the device satisfied write-capability gating, substitute `connectTestCoros(db, userId)`; where a test exercised the bridge claim/result HTTP protocol itself (parts of `vertical-loop`), rewrite that leg onto `executeCloudJobs` with `mockCorosServer` (the coros-write-cloud tests are the template); delete tests whose sole subject was pairing/handshakes.
- Also: remove `COROS_BRIDGE_CAPABILITIES` from `packages/coros/src/client.ts` (last consumers die with the bridge).

**Interfaces:**
- Consumes: `connectTestCoros` (Task 1), `executeCloudJobs` (existing).
- Produces: no `/api/devices/*` routes; no device auth.

- [ ] **Step 1:** Delete routes + middleware pieces + unmount; typecheck to enumerate fallout; fix the worker-side list above.
- [ ] **Step 2:** UI card + api-client + smoke spec.
- [ ] **Step 3:** Test sweep per the transformation rule; run full suite until green.
- [ ] **Step 4:** Commit. `git commit -m "feat(worker,ui)!: the device/bridge HTTP surface is gone"`

### Task 5: Delete the repos' bridge era; port census

**Files:**
- Delete: `services/coros-bridge/` (entire), `apps/desktop/` (entire), `.github/workflows/release.yml`
- Create: `packages/coros/scripts/census.ts` (port of `services/coros-bridge/src/census.ts` — copy `prompt.ts` + `sanitize.ts`'s `redactUserId` + `coros-login.ts`'s `loginWithPassword` inline into the script or as `scripts/` siblings; imports become `../src/index.js`)
- Modify: `packages/coros/package.json` (script `"census": "tsx scripts/census.ts"`, devDep `tsx`), root `package.json:32–37` (`coros:census` → `pnpm --filter @rg/coros census`; delete the four `coros:spike*` + `coros:probe` scripts), `docs/TESTING.md` (bridge rows), `README`/docs mentions found by `grep -rn "coros-bridge\|desktop app" docs/ README.md`
- Test: `packages/coros` suite still green (bridge tests die with the package; anything generic they covered already lives in `packages/coros/test`)

- [ ] **Step 1:** `git rm -r services/coros-bridge apps/desktop .github/workflows/release.yml`; port census; update scripts + docs.
- [ ] **Step 2:** `pnpm install` (lockfile), full gates, `pnpm --filter @rg/coros census --help`-style smoke (prompt appears, Ctrl-C).
- [ ] **Step 3:** Commit. `git commit -m "feat!: delete services/coros-bridge and apps/desktop — census lives on @rg/coros"`

### Task 6: Onboarding tells the cloud story

**Files:**
- Modify: `packages/ui/src/screens/onboarding.tsx:44,160–210` (the "companion app on your Mac" narrative + "Connect COROS from the desktop app" step → connect-in-app: embed `CorosConnectSection` (exported from settings.tsx) or link to Settings; password-privacy copy becomes "hashed in your browser before it's sent — only the hash is stored, encrypted")
- Test: Playwright smoke (onboarding renders), 390px overflow probe

- [ ] **Step 1:** Rewrite the step; keep the tone and the privacy explanation pattern already used in `CorosConnectSection`.
- [ ] **Step 2:** Gates + screenshots + commit. `git commit -m "fix(ui): onboarding connects COROS in the app — no Mac chapter"`
- [ ] **Step 3: Deploy checkpoint.** Push Tasks 1–6, watch CI + Deploy green, then load the prod app once (pill states + settings render).

### Task 7: Drop the tables (separate deploy, LAST)

**Files:**
- Modify: `packages/database/src/schema/identity.ts:58–90` (delete `desktopDevices`, `deviceHandshakes` + inferred types), `apps/worker/src/routes/misc.ts:1430` (delete-all list drops both tables)
- Create: `packages/database/migrations/0014_drop_desktop_tables.sql` via `pnpm db:generate`:

```sql
DROP TABLE `device_handshakes`;
--> statement-breakpoint
DROP TABLE `desktop_devices`;
```

- [ ] **Step 1:** Confirm the Task 1–6 deploy is live and clean (prior checkpoint). Edit schema, run `pnpm db:generate`, verify the migration contains exactly the two DROPs.
- [ ] **Step 2:** `pnpm typecheck && pnpm vitest run` (helpers/tests already device-free) + local `wrangler d1 migrations apply run-garden-db --local -c wrangler.dev.toml` + fixture reseed + smoke.
- [ ] **Step 3:** Commit, push, watch Deploy (runs remote migration). `git commit -m "feat(db)!: drop desktop_devices and device_handshakes"`
- [ ] **Step 4:** Tell the user: quit + uninstall the desktop app; its API calls now 404 by design.

## Self-Review

- **Spec coverage:** bridge service (T5), desktop app (T5), device routes/handshakes (T4), tables (T7), release workflow (T5), pairing settings surface (T4), census CLI (T5) — all covered; presence/status rework (T1–T3) is the enabling work the spec's one-liner implies.
- **Placeholders:** none — every step names exact files/lines or a concrete transformation rule with an existing template (`coros-write-cloud.test.ts`).
- **Type consistency:** `cloudPresence` (T1) is what T2/T4 consumers import; `connectTestCoros` signature consistent across T1/T4.
- **Deploy safety:** DROP migration isolated in T7 after a verified deploy of code that no longer reads the tables; delete-all guard keeps clearing them until the same commit that drops them.
