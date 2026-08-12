# Run Garden — Final Audit Report (2026-08-12)

Synthesized from four verified domain audits (garden, write-safety, scheduling, insights). All REFUTED sub-claims dropped, ADJUSTED corrections applied. Ranked by real impact on the one real user: a COROS runner racing a 10K on **Oct 23**.

---

## Critical

### 1. Coach-approved sessions will be silently archived within ~1–12 hours of approval
**Severity: Critical** — fires on the very first coach-plan approval, which is exactly what the pending Oct-23 rework will produce.

- **User experience:** Approves a coach proposal, sees the sessions on the calendar, and within hours they vanish from the app — with the Google Calendar event suppressed too. No notification, no error.
- **Root cause:** `coach-apply.ts:87` stamps `lastVerifiedCorosDate = date` on rows COROS has never seen (column is NOT NULL, `schedule.ts:51`). The importer's absence rule (`import-plan.ts:505-555`) archives any scheduled row whose `sourceWorkoutId` is absent from the COROS snapshot after 2 consecutive reads — no provenance guard, and coach rows (`cw-…` ids) can never appear in a snapshot. Exposure includes: lifts and distance-block runs (never pushable, `coach-apply.ts:58-64`), all `createPlan`/`windDown` sessions (insertSession called without `corosWritesEnabled` at `coach-apply.ts:310,335`), and any duration-run whose create job failed. Presence-healing (`import-plan.ts:372-386`) can never revive them. Reads run every 30 min (`coros-read.ts:26-30`) and the sweep is live in prod.
- **Fix:** Make `lastVerifiedCorosDate` honest — nullable (or sentinel), set only when a create verifies. In rule 8, skip rows never COROS-verified (e.g. `sourceWorkoutId === id` or `corosSyncState === 'calendar_only'`). Pass `{ corosWritesEnabled }` to insertSession in createPlan/windDown.

---

## High

### 2. The plan races Oct 3; the real race is Oct 23 — and the garden is scheduled to hit "drought" on race morning
**Severity: High** — the product's emotional centerpiece punishes a perfect taper.

- **User experience:** The COROS plan's "Race Day!" sits on Oct 3; after it, only strength workouts (through Oct 21). From Oct 4 the run clock increments daily: dryness Oct 7, mild drought Oct 17, "In drought" HUD on race morning Oct 23, plants thirsty (not yet wilted — health ~0.88), with loss-flavored forecast lines all through the taper. Even 100% plan adherence is punished; taper jogs done unplanned cannot reset the clock (`simulate.ts:318-321` resets only for planned runs). The unplanned Oct 23 race earns no `raceCount`, so the Victory laurel (`species.ts:159`) never unlocks.
- **Root cause:** Every shelter is unreachable dead code for this user. Three active `training_plans` rows have NULL start/end dates, so the coverage test (`garden-sync.ts:283-286`) is true forever → `planGap` never fires. Zero rest-category workouts have ever existed → `restObserved` (`garden-sync.ts:271-274`) and the UI taper line (`garden.tsx:527`) are dead. After Oct 21 the UI freezes its displayed clock (`garden.tsx:1104-1110`) while the durable sim keeps decaying — display and simulation openly contradict.
- **Fix:** (a) Derive null-dated plans' coverage from min/max workout `effective_date` (and deactivate the two stale empty "COROS plan" rows) so planGap arms after the last scheduled day; (b) use `prefs.raceDate` to shelter the taper (treat pre-race no-planned-run days as observed rest, like the adventure freeze); (c) let unplanned runs reset/cap `daysSinceCompletedRun` when no planned run exists that week. Flag the Oct 3 "Race Day!" to the coach rework.

### 3. Two conflicting race truths on the user's real calendar — and the intuitive correction is silently discarded
**Severity: High** — shares the root of #2; distinct surfaces.

- **User experience:** Today's reconnect sync pushed a "Race Day!" Google event for **Oct 3** (`planned_workouts` 64e2d6aa, link written 21:30:11Z), while the app header counts down to **Oct 23** (`prefs.raceDate`, `plan.ts:426-428`) and the strength plan tapers toward Oct 23. Three surfaces, two dates. If the user drags the Google event to Oct 23, the move is rejected and discarded: `accept_user_move` → `applyMove` throws `races_cannot_move` (`jobs.ts:112`), swallowed per-op (`calendar-sync.ts:321-336`). *(Adjusted: this is a single swallowed error per drag, not an infinite cron loop — the sync token advances so incremental syncs never re-see the event; it re-fires only on full windowed reads. Net effect: permanent silent divergence with the mirror claiming "synced".)*
- **Root cause:** No code cross-checks race-category rows against `prefs.raceDate`; race rows are frozen by every path (`jobs.ts:112`, `reschedule.ts:201-203`).
- **Fix:** Banner when an active race workout's date differs from `prefs.raceDate`, with explicit resolution. Treat `accept_user_move` on a race as terminal: patch the event back or post a sync note — never swallow. Consider user-confirmed race moves.

### 4. Six active future workouts — including both race-week taper sessions — permanently barred from Google Calendar by immortal suppressions
**Severity: High** — live in prod right now.

- **User experience:** Google Calendar shows an empty race week (Oct 19–25): W10 Taper (Oct 20) and Pre-Race Primer (Oct 21), plus W7/W8/W9 sessions (Sep 30, Oct 6/7/13), silently never appear. Three are already inside the 8-week mirror window and got no event at today's post-reconnect syncs. Invisible in-app: their `calendar_sync_state` is stuck `pending`, a state the UI renders nowhere (`plan.tsx:225` shows only `user_deleted`).
- **Root cause:** Stale `workout_removed` suppressions from the Aug 3 id-aliasing incident (fixed by 15465c5, but these rows were unarchived without deleting the suppression). `reconcile.ts:92` skips suppressed workoutIds forever; the only deleter (`import-plan.ts:376-383`) is gated on `archivedAt` being set — unreachable for now-active rows.
- **Fix:** Hourly sweep: delete `workout_removed` suppressions whose workout is active (archived_at NULL, scheduled) — presence in the plan proves the removal was wrong. Make import-plan's suppression deletion unconditional on archivedAt. Surface "calendar event pending >48h" as an anomaly.

### 5. Coach run creates ship a strength-typed (sportType 4) entity around a run program — deviating from the only live-verified wire shape
**Severity: High**

- **User experience:** The first coach run pushed to the watch lands mistyped on the real COROS calendar — at best it looks wrong in the COROS app, at worst the watch won't offer it as a guided run. Run Garden masks the mismatch (normalize derives sport from the program), so the app says "run" while COROS says otherwise.
- **Root cause:** `create-executor.ts:1188-1196` hardcodes `sportType: 4` in buildEntity for every create; buildRunProgram emits program sportType 1. The deleted spike (`git show 9084fdb^:services/coros-bridge/src/spike-create.ts`, TEST B) passed entity sportType 1 — the shipped path was never live-verified in this shape.
- **Fix:** `sportType: program.sportType ?? 4` at `create-executor.ts:1194`, plus a unit test asserting a coach run create emits entity sportType 1.

### 6. Coach watch-push failures are terminal, invisible in issue counts, and render as "synced"
**Severity: High**

- **User experience:** One network blip or slot race during the ~13-request create sequence and the workout silently never reaches the watch — while the UI flips from "syncing" to "synced" on failure (the opposite of the truth). No retry path exists, and issue counts stay at zero. Combined with #1, the failed session is then archived within hours.
- **Root cause:** `coros-write-cloud.ts:132-140` marks every non-ok result failed with no retry (studio retries the same categories via `mapCreateResult`, `studio-push.ts:515-523`). `deriveWorkoutSync` (`sync-status.ts:154`) returns "synced" when `effectiveDate === lastVerifiedCorosDate` — pre-stamped by `coach-apply.ts:87`, making the failure branch unreachable. Coach creates record no move intent, so `issueCount` (`sync-status.ts:83-86`) never counts them.
- **Fix:** Route coach results through a transition map (retry error/slot_occupied within the job's attempt budget); on terminal failure set `corosSyncState='sync_issue'` and stop pre-stamping `lastVerifiedCorosDate`; finalize the attempt row; count failed `coach_create_workout` jobs in issueCount.

### 7. Coach uses the raw session title as the COROS ownership stamp — recurring titles refuse every create after the first
**Severity: High**

- **User experience:** In any realistic plan (prod future window has "Aerobic Endurance Run" ×10 and "Long Run" ×6), only the first instance of each title ever reaches the watch; the rest fail terminally and invisibly (via #6). Worse: the stamp check scans the whole COROS plan, so a coach add titled like an existing plan session collides on the *first* add. Same-day duplicates get silently adopted onto one COROS workout.
- **Root cause:** `coach-apply.ts:117` sends `name: session.title` verbatim; `create-executor.ts:1099-1139` enforces plan-wide stamp uniqueness. Studio solved this with `"${title} — wk ${n}"` plus pre-enqueue duplicate validation (`studio-push.ts:97-105, 439`); the coach path has neither.
- **Fix:** Uniquify the coach stamp (`${title} — ${date}`) and validate against live coach+studio stamps at approve time, failing visibly.

### 8. Weekly review fires on SUNDAY (Cloudflare cron 1 = Sunday), so every review describes a week that ended 7–8 days earlier
**Severity: High**

- **User experience:** Every weekly review ever received covered the week before last. The Aug 3–9 peak week (three Olympic NP hikes, 7-day load 837) has no review on Aug 12 and won't get one until Sunday Aug 16 — arriving stale yet flagged "New this week."
- **Root cause:** `wrangler.toml:44` `"0 20 * * 1"` (commented "Mondays"); Cloudflare days run 1 = Sunday. Prod proves it: both weekly_review runs fired on Sundays. `weekStart = startOfIsoWeek(today) − 7` (`index.ts:161`) is correct *for a Monday fire* — on Sunday it selects the week before last. **Coupled trap:** `index.ts:264` switches on the literal cron string; fixing the toml alone routes the trigger to the default branch (hourly) and reviews silently stop forever.
- **Fix:** `"0 20 * * MON"` in wrangler.toml AND the identical literal at `index.ts:264`, same commit. Keep weekStart−7. Optionally backfill the 2026-08-03 week.

---

## Medium

### 9. Skips resolved on a different day than their effective date vanish from the garden; advance-sanctioned skips never get their mercy credit
- **Experience:** Cuts both ways — the Aug 3 skip (resolved Aug 5) produced no missed-run debit anywhere (the decay story the UI tells isn't the one the sim runs), while the coach-sanctioned Aug 8 skip (resolved Aug 6, *before* its effective date) never received its promised rest credit, and its resolutionDate now poisons the 7-day mercy lookback for the next sanctioned skip.
- **Root cause:** `garden-sync.ts:241-245` — `resolvedHere` intersects same-effective-date workouts with same-resolution-date, empty whenever they differ. The Aug 10 skip (resolved Aug 12, a day with no plan rows) will never debit either.
- **Fix:** Query resolvedHere by resolutionDate independently of effectiveDate; grant sanctioned mercy on `max(effectiveDate, resolutionDate)`.

### 10. Coach-sanctioned skips count as failures in weekAdherence, resetting the consistency chain the fairness spec promises they never cost
- **Experience:** A taper week of 2 completed + 1 coach-sanctioned skip = 0.67 < 0.75 → `consecutiveConsistentWeeks` zeroed (`simulate.ts:383-391`), wiping progress toward ivy/clematis/wisteria (4/6/8/10 weeks) through no fault of the runner. Prod already shows the unfiltered math (Aug 10 input: 0.25 vs honest 0.33).
- **Root cause:** `garden-sync.ts:322-343` has no `sanctionedBy` filter — contradicting the contract quoted at `garden-sync.ts:246`.
- **Fix:** Exclude `sanctionedBy === 'coach'` from the denominator (or count as completed).

### 11. Evening-run credit reads the planned slot, not the actual run time — Moonflower and fireflies are unreachable for this user
- **Experience:** Real evening runs (Aug 1 at 19:50, Aug 11 at 18:12) stored as "morning"; `eveningRunCount` = 0 and — since all plan slots are morning and unplanned runs return early before the counter (`simulate.ts:494-538`) — it stays 0 forever. Meanwhile `earlyRunCount` correctly uses the real `startHourLocal` (`simulate.ts:492`): two achievements, two clocks.
- **Root cause:** `garden-sync.ts:195` derives matched-run window from `w.effectiveTime`.
- **Fix:** Derive window from the matched activity's `startHourLocal` (≥17 → evening), falling back to effectiveTime only when unmatched.

### 12. Coach-created rows are unmovable until a snapshot heals their fingerprint; a move before the create runs cancels the watch push entirely
- **Experience:** *(Adjusted)* Dragging a coach workout right after approval typically burns 3 move attempts within seconds (inline execution, `plan.ts:711`), posts up to 3 duplicate "we kept your change" notes, then usually succeeds within ~an hour once rule-7 heals the fingerprint; terminal `sync_issue` needs a second trigger inside the pre-heal window. Fully confirmed: a move *before* the create executes supersedes the create forever (`jobs.ts:71-79`, no kind filter) — the workout never reaches the watch and (via #1) gets archived.
- **Root cause:** `coach-apply.ts:90` stores a `coach-` FNV fingerprint the verify branch never replaces; the move executor compares it to `corosProgramFingerprint` (`write-executor.ts:155`) — different vocabularies, guaranteed mismatch.
- **Fix:** Stamp the wire fingerprint on create-verify (or blank it); exclude `coach_create_workout` from applyMove's supersede (or re-enqueue the create at the new date).

### 13. Coach approve re-apply is not idempotent: the `-push` job insert has no conflict handling
- **Experience:** A flaky approve (crash, retry, double-tap) leaves the proposal permanently stuck — every retry 500s on a primary-key violation, half-applied.
- **Root cause:** `coach-apply.ts:108-122` inserts `${id}-push` without `.onConflictDoNothing()`, under a header explicitly promising re-apply idempotency (lines 19-25); no transaction around applyOps.
- **Fix:** Add `.onConflictDoNothing()` (the deterministic id makes that correct), or batch applyOps.

### 14. `corosWritesEnabled` does not gate Plan Studio writes
- **Experience:** With the toggle off, studio pushes/deletes/retire-on-replace/adoption-undo still mutate the real COROS calendar — while `computeSyncStatus` reports "not_synced," implying writes are off. Masked today (pref is on), but it's the only switch claiming to stop writes.
- **Root cause:** Zero pref references in `routes/studio.ts`/`studio-push.ts`; `executeCloudJobs` (`coros-write-cloud.ts:46-68`) executes whatever is queued. Gating exists only on moves and coach creates.
- **Fix:** Check the pref at the top of `pushStudioPlan`/`undoStudioAdoption` with a visible refusal, or have executeCloudJobs skip write kinds when off.

### 15. Coach-inserted sessions get no duration estimates and a hardcoded 07:00
- **Experience:** First coach add after today: a 20-min mobility session becomes a 70-min Google block whose own description contradicts itself ("estimate: 45 min / block: 20 min"); reschedule spacing computed on a fictitious 45 min; and it lands at 07:00 — 2h before every other session (prefs say 09:00) — triggering a 20:30 sleep reminder the night before for a time the user never chose.
- **Root cause:** `coach-apply.ts:76-101` sets only `calendarBlockDurationSeconds` and `effectiveTime '07:00'`; consumers fall back to 45 min (`calendar-sync.ts:176-177`, `plan.ts:672/683`).
- **Fix:** Call `estimateDuration` in insertSession and derive effectiveTime via the same `defaultTimeFor(prefs)` used by import-plan.

### 16. Reschedule candidates silently claim "open morning/evening" with zero busy data whenever Google is unreachable
- **Experience:** During any token outage (Aug 8–12 was real, and recurrence is likely within 7 days until the OAuth app is published), the user is offered "open" slots that may collide head-on with real meetings — the feature's core promise absent exactly when they're re-planning.
- **Root cause:** `plan.ts:645-662` swallows freeBusy failures to `busy = []` and skips the lookup on null client; the API has no degraded flag, so `reschedule.ts:193` produces identical confident copy either way.
- **Fix:** Return `busyChecked: boolean`; drop "open" wording when unchecked; one MoveSheet info line reusing the existing Reconnect CTA.

### 17. Records card displays "Most consistent four weeks: 0% adherence in the weakest week" as a personal record
- **Experience:** The warm, trustworthy corner of the page leads with a self-evidently absurd achievement (achievedOn 2026-06-07 — before any plan existed), shown in both disciplines the user can open (run and yoga).
- **Root cause:** `records.ts:86-112` has no notability floor; `computeConsistency` includes zero-plan weeks at adherence 0; `mergeRecords` persists it. Note: cleanup alone won't stick — the current window re-mints numeric 0, so the floor must land with or before the row cleanup.
- **Fix:** Require every window week to have resolvable planned workouts, return null when minAdherence ≤ 0 (floor ~0.25 defensible); one-time strip of the numeric-0 entries; store source activityIds on duration/pace records so heals can invalidate them (the corruption-vs-never-regress trap was one page-load from minting an unhealable 100× record this morning).

---

## Low

### 18. Codex shows a wrong, permanently uncorrectable unlock date for the Field poppy (Aug 1 shown; Aug 6 earned)
`garden-sync.ts:752-760` self-heal seeds any ledger-missing species at genesis; walkForward's correct-dated insert is `onConflictDoNothing`, so the wrong date survives every resim. **Fix:** seed only start-gated species at createdDate; `onConflictDoUpdate` unlockedOn from the replayed event on resim.

### 19. Per-workout calendar state is a local assertion never qualified by mirror health
58 links claimed "synced" throughout the 4-day dead-token outage (content happened to stay accurate — no moves after Aug 6), and "pending" rows render nowhere. **Fix:** degrade the label when `providerConnections.google_calendar` is unhealthy or lastSyncAt is stale (`plan.ts:604`; data already in the connections row).

### 20. Full-resync window uses UTC date bounds, so an evening workout on the window's last local day reads as user-deleted and gets suppressed
`calendar-sync.ts:216-223` staples `Z` instants to Vancouver dates, cutting up to ~8h off the last day. *(Adjusted: the 410 sync-token path does NOT arm this — the merge reconstructs missing events; only user-initiated full reads, `/calendar/choose` and `/sync?full=1`, are exposed.)* Un-armed today (all rows 09:00/10:00) but one accepted evening move arms it. **Fix:** build bounds with `zonedInstant` (`windows.ts:18`) or pad windowEnd by a day.

### 21. Forecast's dormancy filter doesn't mirror the sim's pick
`forecast.ts:34-36` omits the `state !== "dormant"` exclusion that `simulate.ts:741-745` applies, against its own explicit mirror contract (`forecast.ts:5-8`). *(Adjusted: the misnaming is unreachable in the UI today — the naming line renders only in a window where dormant plants can't exist — so this is latent contract hygiene, not a visible bug.)* **Fix:** add the one-line filter.

### 22. `garden_wildlife.since` records the walk-end date, not the arrival date
Rabbits: since Aug 9 vs arrival event Aug 1. `garden-sync.ts:132-152` stamps `lastSimulatedDate` on any presence flip. Invisible today (UI serves only kind/present/hint) — a latent honesty trap for the first "here since…" consumer. **Fix:** derive from `wildlife_arrived` events.

### 23. Weekly-training chart subtitle says "from completed, matched runs" but bars include every run, with HR-less runs painted as low intensity
`insights.tsx:383` vs `misc.ts:759` (no match filter) and `weeklyTraining.ts:87-99` (unmatched → low). **Fix:** correct the caption, or add an "unknown" segment for HR-less time.

---

## Resolved Product Questions (insights)

### (a) "Low-intensity 1–3%" — the metric measures the hrMax estimate, not the runner. **Recommended design: use COROS time-in-zone; retire the estimator to last-resort fallback.**

The red **3%** headline (vs the watch's own **66%**) is pure construction error: `estimateHrMax` takes the second-highest of 7 sparse readings (`hrZones.ts:45-49`) = 180, ceiling 144 (`hrZones.ts:54-56`), while the device's configured easy boundary is 155 — and this athlete's aerobic runs sit at 147–153, exactly inside the error band. Sensitivity: lowPct is 3% at hrMax 180, 63% at 186, 74% at 190. It also degrades further right before the race: the 186 reading exits the 26-week window ~Oct 12 → ceiling 141.

**Recommended design (in order):**
1. **Primary source:** every run since 07-23 carries `telemetry.hrZones` (typed at `domain/activity.ts:50`; zone seconds sum to healed durations within 1s). In `toIntensityInput`, low = zones[0]+zones[1], high = zones[2..]; fall back to lap/avgHR bucketing only when hrZones is absent.
2. **Easy ceiling:** take Z2-hi from the most recent hrZones-carrying activity (155 today) for easyDiscipline/hardStack/drilldowns; estimator as last resort only.
3. **Fix the fallback estimator:** use the top reading when the second corroborates within ~12 bpm (real glitches are 30+ bpm off); require ≥5 readings.
4. **Honest suppression:** recompute lowPct at ceiling ±5 bpm; if the band flips across that range, emit `band: undefined` with a note — an unconfident estimate must never headline the status strip (`signal-tiles.tsx:96-113` currently lets it win unconditionally; the <10-sample caveat at `misc.ts:624-629` doesn't gate the band).

Steps 1+2 alone fix this user permanently and kill the October drift.

### (b) "+19% load vs your norm" on a minutes basis — coverage is measured over the wrong window. **Recommended design: compute coverage over the trailing 28 days the metric actually weights.**

12-week coverage is 0.83 < 0.9 (`misc.ts:341, 587-592`) solely because of three pre-telemetry legacy runs (06-19/07-04/07-16), forcing the minutes basis where 143 min of yoga (true COROS load 3) counts like tempo → fabricated **+19%** (true load basis: −1%, though it would honestly gate as insufficient history until **Aug 19**). But the consumers barely touch those old runs: monotony reads only the last 7 days (100% covered) and EWMA(28) gives a 27-day-old day ~14% weight. Trailing-28-day coverage is **0.95**.

**Recommended design:** keep the single-basis invariant and the 0.9 threshold, but filter to `localDate >= today−27` before the coverage sums at `misc.ts:587-592`. Today: load basis, loadRatio honestly reports "needs ~4 weeks of load history — you have 21 days" (self-resolving Aug 19), monotony reports the true 1.21. Do **not** extend the flip to ramp/weekly bars (run-seconds are the honest unit there; legacy runs are real training). Update `loadBasisNote` to state the coverage window.

---

## Suggested fix order

1. **Gate the coach rollout (before any proposal is approved):** the coach-apply bundle — #1 (honest lastVerifiedCorosDate + rule-8 provenance guard), #13 (onConflictDoNothing), #7 (stamp uniquification), #5 (sportType passthrough), #6 (retry + visibility), #15 (estimates + effectiveTime), #12 (fingerprint on verify + supersede exclusion). These are one file cluster and one failure story; do not approve a coach plan until this ships.
2. **Live-now calendar damage:** #4 (suppression sweep — race week is already dark) and #3 (race-date mismatch banner + non-swallowed race moves).
3. **Two-line, high-yield:** #8 (cron `MON` + the coupled `index.ts:264` literal, same commit).
4. **Insights honesty:** product questions (a) and (b), plus #17 (records floor + cleanup).
5. **Garden fairness before October:** #2 (plan coverage / taper shelter — must land before Oct 4), #9, #10, #11.
6. **Consent backstop:** #14 (corosWritesEnabled gating).
7. **Polish batch:** #16, #18–#23.

## Working well

- **Garden replay determinism is real:** a full independent replay of the 11 stored day inputs reproduces the durable snapshot byte-for-byte (state, plants, wildlife, unlocks, all 28 events); counters, adventure grace, checkpoints, and the arrival watermark all verify by hand.
- **Today's duration heal fully propagated:** healed durations are what the garden, records, weekly bars, and zone sums all consume; no pre-heal residue anywhere; no corrupted-era records were ever minted.
- **Backfill is complete:** history ingested to 2025-05-05 (5 chunks, 25 activities); the 6 failed jobs were bridge-era capability reports plus one 16-hour transition gap — no data lost.
- **Studio exactly-once held:** the 32 superseded jobs were one 13-second double-push correctly superseded; zero double-writes reached COROS; drift adoption never had a fingerprint-churn vector.
- **Post-reconnect calendar sync converged** cleanly (no double-creates, no spurious deletions), and the 7-day ramp, weekly bars, and resting-HR/HRV cards are honest against healed data.