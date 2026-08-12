# Run-Garden Production Audit — Final Report

**Date:** 2026-08-12 · **Scope:** COROS cloud-direct ingest, sync/polling, coaching pipeline, Plan page, UX honesty · All findings verified against prod data and code; refuted claims dropped, adjusted corrections applied.

---

## 1. All recent durations stored 100× too small — every seen-activity refresh re-corrupts them

**Severity: CRITICAL** (time-sensitive: partially unrepairable after rows age out of the 14-day pull window)

**What the user sees:** Every activity since Jul 29 shows "0 min" and "0:04/km" (a real 49-min run stored as 29.35 s; a 4.5 h hike as 164.55 s). Insights shows a false "7-day ramp −74 min (−98%)" crash-taper alarm. The coach's effort packages say "moving 0:00:29" and the dossier says "did 0min 7.9km" — every LLM prompt gets internally impossible data. The workout sheet's matched-activity line reads "Completed with … · 0 min · 7.9 km" beside a lap chart showing the true times.

**Root cause:** `packages/providers/src/coros/normalize.ts:334` divides ALL COROS time fields by 100, but only the DETAIL summary is centiseconds — the LIST endpoint reports plain seconds (proven: prod row 40.38 s = list wire 4038 s ÷ 100; every corrupted row is exactly lap_sum/100). The cloud read's `detailFilter` (`apps/worker/src/services/coros-read.ts:116`) skips already-seen labelIds, so seen activities are re-normalized from list fields only (`packages/coros/src/snapshot.ts:135-143`); the 100×-smaller value changes the fingerprint, and `completion.ts:382-396` overwrites the previously-correct row. Even today's run was ingested correctly at 16:27:02, then corrupted by the 16:29:19 pull. Existing guards (`completion.ts:101-117, 228-242`) only catch the inverse bug (pace > 1800 s/km). Note: a blanket "remove the /100" would re-corrupt detail ingests the other way (the Aug-1 bug, commit 0b49730) — the fix must be per-source.

**Fix:**
1. Per-source units in `normalizeCorosActivity`: `durationSeconds = summary?.workoutTime != null ? summary.workoutTime/100 : (item.workoutTime ?? item.totalTime ?? 0)`; same for `elapsedSeconds`. Laps/pauses stay ÷100.
2. Data repair is exact arithmetic: one-shot UPDATE ×100 on `duration_seconds`/`elapsed_seconds` (and recompute `avg_pace_sec_per_km`) for coros-linked rows updated in the 2026-08-12T16:27–16:30Z window with `duration_seconds < 900`.
3. Fix the test fixtures that encode the inverted contract (see finding 12) in the same PR, or this regresses.

Downstream self-corrects after repair (ramp, coach numbers, "0 min" display) — **except** the two items in finding 3's note, and the tainted coach reads (finding 8).

---

## 2. Same list-only refresh DESTROYED telemetry on all 12 recent activities

**Severity: HIGH** (same deadline: must re-pull detail before rows leave the 14-day window)

**What the user sees:** Nothing directly — but coach effort packages have lost their HR/pace zone lines, and `max_heart_rate` was nulled on every corrupted row (feeds the Insights hrMax/easy-ceiling estimate).

**Root cause:** A list item can only yield `{deviceTempC}` (`normalize.ts:279-281`); zones/cadence/power/effects/pauses all require detail (`normalize.ts:267-314`). `apps/worker/src/services/completion.ts:271` replaces the telemetry column unconditionally on the seen-row refresh path, so detail-derived telemetry stored earlier was clobbered — every row since 07-29 is now exactly `{"deviceTempC":N}`. Laps survived only via the `laps.length > 0` guard (`completion.ts:461`). **Unlike durations, this is not recoverable by arithmetic.**

**Fix:** (1) Make seen-row refreshes non-destructive — COALESCE telemetry or re-fetch detail when the fingerprint changed. (2) Repair: force one detail re-pull for the 12 affected labelIds (clear their `content_fingerprint` AND bypass the detailFilter for them) — this restores durations, telemetry, and laps in one pass. Run it promptly or widen `ACTIVITY_WINDOW_DAYS` (`coros-read.ts:27`) so 07-29/08-01 rows don't age out unrepaired.

---

## 3. Stuck backfill job head-of-line-blocks EVERY future COROS write

**Severity: CRITICAL**

**What the user sees:** The History card shows a dead error ("It stalled — press Run again") despite COROS being connected; from now on any workout move, studio push, or coach-applied change will sit "syncing" forever and never reach the watch. Proven live: the cloud executor claimed the stuck backfill job at 17:16:09Z, re-queued it, and executed zero jobs.

**Root cause:** The user pressed Backfill at 03:24Z before any cloud COROS connection existed; the 12 h watchdog flipped `backfill_state` to `error` but left the job queued. The walker refuses to serve chunks when `state.status === 'error'` (`apps/worker/src/services/backfill.ts:320`), and nothing re-arms the state except the user's "Run again" button (`backfill.ts:145-160`). Meanwhile `claimNextJob` always takes the oldest queued job with no kind filter (`apps/worker/src/services/jobs.ts:295-300`), and `executeCloudJobs` — the ONLY executor for all writes (`routes/plan.ts:698`, `routes/studio.ts:481/630/682`, `routes/coach.ts:211`, hourly cron `index.ts:144`) — re-queues a backfill job and `break`s (`coros-write-cloud.ts:69-75`). The permanently-queued backfill job is the queue head forever.

**Secondary copy bug (fold in):** the stored legacy error category `bridge_never_claimed` matches no current UI branch (`settings.tsx:188-192` knows only `never_started`/`stalled`), so the copy claims mid-walk progress ("resumes where it left off") for a walk with 0 chunks.

**Fix:** (a) Give `claimNextJob` an `excludeKinds` option so `executeCloudJobs` claims the next non-backfill job (a `continue` would spin on the same head — must be claim-side). (b) Let the walker serve a queued chunk when state is `error` (recordChunk already revives it to `running`), or re-arm in `connectCoros`. Either unblocks writes; do both. (c) Migrate/alias the legacy error category.

---

## 4. Google Calendar mirror dead for 4 days while Settings says "Connected · mirroring workouts"

**Severity: HIGH** (recurs every 7 days until OAuth app is published)

**What the user sees:** No planned workout created/moved/deleted since Aug 8 is reflected in Google Calendar; zero indication anywhere. 187+ consecutive `calendar_sync` errors every 30 min.

**Root cause:** Google OAuth "Testing" publishing status expires refresh tokens after 7 days — the timeline fits to the minute (connection created 08-01T19:48:58Z; last ok sync 08-08T19:30 on a cached token; first failure 20:00). `refreshGoogleToken` throws (`apps/worker/src/auth/google.ts:131`), `ensureToken` never marks the connection (`google-calendar.ts:52-68`; the `markError` pattern exists only for COROS), and the halfHourly cron's bare catch swallows everything (`index.ts:102-103`). Nothing anywhere writes google `last_sync_at` — even the 293 prior successes left it NULL. Settings copy derives purely from `status === 'connected'` (`packages/ui/src/screens/settings.tsx:252-257`).

**Fix:** Catch refresh failure in `ensureToken` → set connection `status='error'`, `lastErrorCategory='token_expired'`, surface a "Reconnect Google" CTA in Settings; record the error category in the cron catch; stamp `last_sync_at` on successful syncs (success path too — it has never been written). Operationally: publish the OAuth consent screen to Production, or this recurs weekly.

---

## 5. Installed PWA never checks for updates — deploys don't reach the user

**Severity: HIGH** (blocks every other fix from landing)

**What the user sees:** A weeks-old bundle until a hard reload. Today this masked a shipped fix and burned a debugging session.

**Root cause:** `apps/web/dist/registerSW.js` is a bare `register('/sw.js')` — no `registration.update()`, no interval, no visibilitychange hook, no controllerchange reload (VitePWA `registerType: 'autoUpdate'` with default injectRegister, zero use of `virtual:pwa-register` in `apps/web/src`). The precached shell serves cache-first; an installed PWA resumed from the app switcher performs no navigation, so the browser never re-fetches sw.js; even after a cold start installs a new SW, the in-memory page keeps the old bundle.

**Fix:** `import { registerSW } from 'virtual:pwa-register'; registerSW({ immediate: true, onRegisteredSW: (url, r) => setInterval(() => r?.update(), 60*60*1000) })` plus `update()` on visibilitychange; optionally poll a build hash from `/api/health` and reload on mismatch.

---

## 6. Plan page denies the user's active COROS run plan and renders a triply-wrong lift card

**Severity: HIGH**

**What the user sees:** (a) "+ Plan running with your coach" placeholder while the same page displays 35+ future workouts from their ACTIVE COROS 10K plan — following the CTA would draft a plan on top of the imported one. (b) The lift card reads "16-Week Posterior Chain… — wk 1/1 — ends Aug 3" with a 100% progress bar and "active" status, for a plan that actually starts Aug 17 and ends Dec 6 (its own detail modal shows the correct span, contradicting the card behind it). (c) "Jump to week" contains exactly one entry — a past week (Aug 3–9) unrelated to either real plan. (d) No "week n of m" context anywhere.

**Root cause:** `/api/coach/plans` (`apps/worker/src/routes/coach.ts:302-346`) queries only `coachPlans` (empty in prod) plus the newest `studioPlans` row — `trainingPlans` (where the 4 active COROS plans live) is never touched, so `PlanCards` computes run as "missing" (`plan-cards.tsx:75-76, 110-114`). The studio entry hardcodes `startDate` AND `endDate` to `createdAt.slice(0,10)` (`coach.ts:337-338`) instead of reading `brief.startDate`/`durationWeeks` from the plan JSON it already selected; `plan-cards.tsx:17-23` date math on equal dates yields wk 1/1 / 100% / "ends Aug 3". The degenerate span also caps the jump menu at one stale week (`plan.tsx:548-566`).

**Fix:** Derive studio dates from the plan JSON (`start = brief.startDate`, `end = startOfIsoWeek(start) + durationWeeks*7 − 1`); in `weekLabel`, show "starts <date>" with an empty track when the plan hasn't started. Merge active `trainingPlans` rows owning unarchived workouts into `/plans` as read-only `source:'coros'` entries (humanize "S4557" — `looksLikeCodeTitle` exists), and extend `/week`'s covering-plan lookup to `trainingPlans` for weekIndex/weekTotal.

---

## 7. Coach reads a different calendar than the Plan page: archived workouts leak into the dossier

**Severity: HIGH**

**What the user sees:** The live focus line — the most prominent guidance on the Plan page — says "Sunday's 5K trial is the anchor…" about an Aug 16 race the page shows as an empty Sunday (it was archived Aug 1, reason `absence_confirmed`). The 03:25Z briefing wastes space explaining "Today's calendar shows three runs but that's import noise" — phantom archived duplicates the user can't see.

**Root cause:** All three dossier queries in `apps/worker/src/services/coach-context.ts` (UPCOMING :146-156, LAST 14 DAYS :170-174, block adherence :102-111) lack `isNull(archivedAt)`; every Plan-page query filters it (`plan.ts:311, :382, :442`).

**Fix:** Add the archived filter to the three dossier queries. Separately verify whether the absence-sweep archive of the 8/16 race (and the 8/13–8/26 duplicates) was itself correct — COROS may still hold that race.

---

## 8. Coach LLM prompts are poisoned by the corrupted data — queued reads will persist wrong conclusions

**Severity: HIGH** (consequence of findings 1–2; needs its own remediation step)

**What the user sees:** Any coach read drained after 16:29Z today reasons from 29-second runs with no HR-zone telemetry, under a system prompt that says "never invent data." Briefings have survived so far only by leaning on the still-correct laps and trainingLoad.

**Root cause:** `coach-effort.ts:101/:232`, `coach-context.ts:190/:201`, `coach-reads.ts:243` all consume `durationSeconds` verbatim; the queue of reads created 16:27Z is draining at 2/hour into this data.

**Fix:** After the finding-1/2 repair, delete and re-enqueue the coach_reads created 16:27Z (and discard the done ones' outputs) so the coach never persists conclusions from corrupted effort packages. Defensively, `buildEffortPackage` should cross-check duration against distance×pace and lap totals and emit "moving unknown" when inconsistent.

**Note on two symptoms that will NOT self-correct after repair:** the "Low-intensity share: 1%" warning is not corruption-caused — it's driven by a thin hrMax estimate (2–3 readings → easy ceiling ~137-138 bpm) against an athlete averaging 145–159 bpm, and recomputes to ~1.2% even with repaired data. Likewise the Insights load-basis flip to minutes persists (legacy no-load runs keep coverage below the 0.9 threshold, `misc.ts:341`). Treat those as separate product questions (sparse-HR ceiling estimation; coverage threshold), not corruption fallout.

---

## 9. Coach questions never close on free-text answers — the question feature has been disabled for 6 days

**Severity: MEDIUM**

**What the user sees:** "Roughly how far out is race day?" pinned with chips above the composer since Aug 6 — despite answering in prose 45 seconds after it was asked ("around oct 23", acknowledged and stored in coach memory). Every chip is now wrong (10 weeks matches neither "6–8 weeks" nor "3+ months"); tapping one would insert a contradicting memory fact and burn a paid wake. Meanwhile the `hasOpen` guard blocks the coach from ever asking anything new.

**Root cause:** Only the chip endpoint sets `answeredAt` (`routes/coach.ts:234-266`); the wake pipeline can insert questions but never resolve them (`coach-wake.ts:474-493`), and `hasOpen` (`:481-483`) suppresses all future questions while one is open.

**Fix:** Let a wake resolve open questions (include the open question id in the dossier; add a questionOp or deterministically close on a message-cause wake), auto-expire open questions after ~72 h with a receipt, and add a dismiss affordance in `CoachComposer`.

---

## 10. Duplicate coach messages sit permanently in the thread, and a twice-analyzed hike is queued for a third paid read

**Severity: MEDIUM**

**What the user sees:** Two near-identical "Welcome back" briefings (Aug 10 17:12, 1.2 s apart) and two readings of the same hike (22:37, 9 s apart) — all four inside the rendered 30-message window. The coach visibly repeats itself, twice, twice.

**Root cause:** Pre-fix races: the wake single-flight lock landed Aug 11 (commit b1cec9b) and the exactly-once `coach_reads` ledger landed after the duplicates — both events were unserialized double LLM calls in the old pipeline. Current code closes both races, but nothing cleaned the residue, and legacy `refs.kind='analysis'` messages were never migrated into the ledger — so hike 0131dd87 (analyzed twice) sits QUEUED for a third read. Client dedupe covers only wake-failure receipts (`coach-panel.tsx:244-252`).

**Fix:** One-time delete of one message per pair; migrate legacy analysis messages into `coach_reads` as `done` (dequeues the hike before the cron pays for read #3); optionally extend the thread collapse to coach messages sharing `refs.activityId`.

---

## 11. Sync plumbing rot after Phase C: frozen `coros_read` bookkeeping, dead read-now route, no pull on the default garden route

**Severity: MEDIUM** (three related gaps, one theme: cloud-direct shipped without repointing consumers)

- **Frozen sync runs:** commit 844aa0e deleted the only writer of `sync_runs kind='coros_read'`; `corosReadNow` writes none. `lastCorosReadAt` is permanently frozen at the bridge's last read (Aug 10 23:23Z) — Settings shows a stale "Last successful COROS read" that never advances, Diagnostics' limit-10 window shows "COROS: last read never" (`misc.ts:1225-1228`) two lines from a healthy provider row, and the garden auto-refresh (`shouldInvalidateGarden`) never fires because the value never changes. *Fix:* derive from `providerConnections.lastSyncAt` (already maintained) in `sync-status.ts`, `routes/sync.ts`, and diagnostics.
- **Dead read-now machinery:** `POST /api/sync/read-now` (`routes/sync.ts:322-370`) queues a job only the hourly cron executes — observed 33.7 h latency, and currently ∞ behind the stuck backfill job (finding 3). It's called on every Today mount, from Garden, and by the Settings "Sync now" button, while the genuinely immediate `POST /api/coros/read-now` exists. *Fix:* rewire callers to the coros route (server already single-flights with 90 s freshness); delete or thin-wrap the job route.
- **No pull on the default route:** `useCorosReadNow`/`CorosCheck` are mounted only in runs.tsx and plan.tsx — not garden (the `/` route), today, or the shell — so opening the PWA to the garden triggers no pull and no credential-failure chip. Also, after 3 "busy" polls the hook returns silent `ok` (`use-coros-read.ts:69-70`), violating its own "silence is only allowed for success" contract. *Fix:* hoist the hook to the authenticated shell; map exhausted-busy to a neutral "still syncing" state.

---

## 12. The test suite encodes the inverted COROS unit contract — CI stays green while prod corrupts

**Severity: MEDIUM**

**Root cause:** `packages/coros/test/mock-coros-server.ts:188-189` gives the LIST item seconds (correct) but `:240-242` gives the DETAIL summary the same seconds values (real detail is centiseconds), while mock laps ARE centiseconds — internally inconsistent and inconsistent with the wire. `coros-normalize.test.ts:200-201` annotates a list item's `totalTime 180_000` as "centiseconds → 1800s", asserting the bug as the contract. No test asserts a realistic end-to-end duration.

**Fix:** Ship with finding 1: mock detail times ×100; fix the list fixture to seconds asserting `durationSeconds 1800` without division; add a contract test normalizing the same activity list-only and with detail, asserting equal `durationSeconds` — that single test would have caught findings 1 AND 2.

---

## 13. Weekly brief adherence breaks its own promise: coach-sanctioned skips count against the 36%

**Severity: MEDIUM**

**What the user sees:** The coach approved "Clear Friday and Saturday for backpacking" and said the trip "counts as the aerobic work" — then the brief docks adherence for the skipped 8/8 Long Run (4/11 = 36%), frames the month as "sessions were light," and drives the "rebuilding" headline. The explainer sheet's claim that adventure days "pause the plan rather than count against it" is false for this number, and the gentler adventure context line needs ≥3 adventure days (the trip produced 2).

**Root cause:** Two adherence implementations with different fairness rules: `/plan/week` uses `computeConsistency` (`packages/analytics/src/consistency.ts:122-138` — no `sanctionedBy` concept), while `coachBlockAdherence` implements "mercy never tanks the block" (`coach-plans.ts:35-41`) but only runs for the empty `coach_plans`. Bonus mixed message: chips show load 7d/28d 2.33 (a spike) beside "sessions were light" (`deriveHeadline`, `plan.ts:341-354`, ignores loadRatio below the 95% branch).

**Fix:** Exclude `skipped + sanctionedBy='coach'` rows from the /week adherence denominator, matching coach-plans semantics; lower the adventure-context threshold to ≥2 days or key it on skip-date/adventure-date coincidence.

---

## 14. Coach-read backlog drains at a hard 2/hour, and interrupted claims recover last

**Severity: MEDIUM**

**What the user sees:** Right after the marquee moment of connecting COROS, 12 reads were enqueued at 16:27Z; they drain at exactly 2 per hourly cron tick (~6 hours to clear — slow by design, not wedged; budget is not the gate at $1.22 of the $12 reserve). One read died mid-Opus-call in an HTTP `waitUntil` (~30 s ceiling vs 40–60 s LLM latency) and sits "running"; it recovers LAST because the candidate index scan groups by status ("running" sorts after "queued") — a fragile accident of the query plan. A user tapping that activity inside the 10-min reclaim window watches an unbounded 4 s "a minute or two" poll. A 192 m, ~4-min hike fragment is also queued for a full Opus read.

**Root cause:** Every non-cron drain is gated on `if (result.ingested)` (`routes/coros.ts:69-72`, `coros-read.ts:182-186`); cron cap defaults to 2 (`coach-reads.ts:326`). Only `failRead` enforces `READ_MAX_ATTEMPTS` — attempts can grow unboundedly through claims alone.

**Fix:** Drop the `ingested>0` gate (empty-queue drain is one SELECT); `cap = min(6, queued)` when deep; prefer stale-running rows in candidate selection explicitly (don't rely on index order); treat claim-count > max as failed inside `claimRead`; skip sub-5-minute fragments in `enqueueCoachReads`; cap the UI "working" poll and fall to the error state.

---

## 15. Honesty debt in copy: Phase-C leftovers, the AI toggle's false scope, and a no-op onboarding CTA

**Severity: MEDIUM (grouped)**

- **"Waiting for Mac":** `move-sheet.tsx:51` maps a still-reachable state to a machine deleted today; "(no Mac needed)" survives at `settings.tsx:196/:203`; the COROS-waiting pill uses `<IconLaptop />` (`components.tsx:135`). *Fix:* reword to "Waiting for COROS — connect in Settings", delete the clauses, swap the glyph.
- **AI settings card:** claims "Weekly review narration — The only AI feature" (`settings.tsx:475-479`) while coach chat, effort reads, and studio generation are all LLM-driven. Corrected twist: `prefs.aiEnabled` actually gates ONLY effort reads and weekly narration — coach wake and studio never read it — so the toggle also under-delivers its own off switch. *Fix:* rewrite the card to enumerate real scope, and decide whether the gate should widen to match.
- **Onboarding "Add N workouts to Calendar":** the button only advances the wizard (`onboarding.tsx:241, :112-114`); the step is a pure preview SELECT. *Fix:* wire the mutation or relabel honestly.

---

## 16. Smaller confirmed issues (low severity)

- **Silent chunk-error swallowing in backfill:** `backfill.ts:361-363` bare catch — a failing walk looks healthy for 12 h. Log + stamp `lastErrorCategory`, add a consecutive-failure counter.
- **16 stranded `sync_runs` rows in 'running' forever** after deploy/isolate death; no sweeper exists. Add an own-kind close-out sweep (>2 h → error, `{interrupted:true}`) in the cron entry.
- **Message-wake lock loss silently drops the reply** (`coach-wake.ts:313-314` returns `skipped` AFTER persisting the message; client treats 200 as success; 20 h freshness gate suppresses the catch-up). Latent — needs two surfaces — but this user documented uses two. Poll for the lock ~60 s or return a `busy` status the client retries.
- **`corosReadNow` seen-set has no user scoping** (`coros-read.ts:100-107`) — full-table read per pull; note `activity_source_links` has NO userId column, so the fix is a join through `activities` or a migration (and the provider+providerActivityId unique index is a deeper multi-user collision risk).
- **Latent matching degradation:** corrupted durations zero the duration weight in workout matching/orphan adoption (`matching.ts:52-55`, `merge.ts:60-63`); no mis-match yet (COROS plan-link carries current matches). Finding 1's repair removes it; optionally clamp implausible durations to neutral.
- **Briefing cited stale wellness** ("HRV 75 / RHR 44" vs latest 68/44) — root cause was bridge-decay data staleness at wake time (the daily_health rows were rewritten 13 h AFTER the briefing by the first cloud pull), not model cherry-picking; largely mooted by cloud-direct. Optionally label the latest wellness row "latest" in the dossier.

---

## Not bugs (investigated and cleared)

- **"Aug 11 vs Aug 12" run date:** the run genuinely started Aug 11 18:12 Pacific (start_time 2026-08-12T01:12:26Z, −7 h offset correct; offsets track the user's real NYC→Pacific travel; the run matched its Aug 11 planned workout). "Tuesday, August 11" is the faithful local date; "Aug 12" is just the UTC date the audit tooling read. Minor hygiene: populate `activities.timezone` (always NULL) and cross-check COROS's own `item.date` at ingest.
- **"Coach-read queue wedged":** refuted — it drains at exactly the designed 2/hour (see finding 14 for the real, slower-by-design problem).
- **"Low-intensity 1% is corruption fallout":** refuted — recomputes to ~1.2% with repaired data (see finding 8's note).

---

## Suggested fix order

1. **Ship together, today:** normalize per-source units + fixture/contract-test fixes (findings 1, 12) + the forced detail re-pull repair (finding 2) + the duration ×100 UPDATE. **Deadline-driven:** corrupted rows age out of the 14-day pull window within days, after which telemetry is gone for good and durations need manual SQL forever.
2. **Same deploy:** PWA update loop (finding 5) — otherwise the single real user won't receive fix #1 or anything after it without a hard reload.
3. **Unblock the write queue** (finding 3): `claimNextJob` excludeKinds + error-state resume. Every watch write is dead until this lands.
4. **Purge tainted coach state** (findings 8, 10): re-enqueue the 16:27Z reads post-repair, migrate legacy analyses into the ledger (stops the third paid hike read), delete the duplicate messages.
5. **Google Calendar** (finding 4): error surfacing + reconnect CTA + publish the OAuth app (the only recurring failure in the list).
6. **Plan page truth** (findings 6, 7): studio card dates, COROS plan card, archived filter in the dossier — highest-visibility trust repairs, all small.
7. **Then:** question lifecycle (9), adherence fairness (13), read-drain tuning (14), copy sweep (15), and the low-severity hygiene items (16).

## Working well

- **Timezone/local-date handling is genuinely correct** — offsets tracked real cross-country travel to the quarter-hour; the Activity list's local-day policy is right.
- **Distance, trainingLoad, and the garden are untouched by the corruption** — garden sync consumes distance/category only, adventures qualify on load, and the hikes qualified correctly.
- **The coach's guardrails hold:** tone/restraint rules verified across all messages, budget accounting exact to the micro ($1.22 of $12 reserve; pricing math reconciles precisely), and load-based claims ("7d/28d 2.3×", "20 min above 164 bpm") were accurate even amid corrupted durations.
- **The Aug-11 race fixes worked:** the wake single-flight lock and the exactly-once coach_reads ledger close both duplicate-message races — only residue remains.
- **Lap ingestion, the plan detail endpoint's date math, and the focus-line wiring (persist → serve → render with 72 h staleness cap) are all correct end-to-end.**