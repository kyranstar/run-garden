# Full-surface audit — garden, plan, coach, activity, settings

**Date:** 2026-08-10 · **Method:** 7 parallel finder agents (3 screenshot auditors over 28 captures at 1440px + true 390px viewports, 4 code auditors) → cross-finder dedupe → adversarial verification agents (top 10). 17 agents, 55 raw findings. Fixture stack at current `main` (adventures × coach × telemetry merge).

**Caveats:** fixture data (plan Jun–Oct with deliberate missed weeks; coach LLM unavailable locally — only its *handling* was judged). Findings below the verified tier are labeled.


## Found live during setup (already fixed on the branch, uncommitted at audit time)

- **[critical] Lap ingest fails for any run with ≥8 laps since migration 0012** — `completion.ts` batched the `activity_laps` insert with a hardcoded 8-column count; the lap-telemetry migration widened the table to 13 columns, pushing batches past the ~100-bound-variable cap. Every affected ingest 500s (seen live: fixture seed). Production impact: runs with 8+ laps have failed lap ingestion since the telemetry deploy; the queued backfill would hit it too. Fix (in this branch): derive the column count from the row object.

- The Plan **Today** button appearing to do nothing during manual capture is explained by confirmed finding 3 below (scroll hijack re-yanks after the click).


## Confirmed (adversarially verified) (10)


### C1. [important · visual] The default-open Next Workout dock panel covers the garden's most-established plants, so a 62-day 'Well watered' garden with 8 plants renders as a nearly empty lawn.

**Surface:** Garden desktop stage (hero scene + next-workout dock) · **Finder:** shots-garden · **Verdict:** confirmed

**Evidence:** garden-balance-popover-desktop-wide.jpg: even at a 1556px viewport the paper birch (the garden's only living tree) at x≈625, y≈430-640 is bisected by the dock panel's right edge — half its canopy is behind the card — and a second field poppy sprout at x≈659 is tucked under the card's corner. garden-desktop.png (1440px): the card spans x≈258-672 CSS and the birch (at ~32% of scene width ≈ x604) is completely hidden; the visible scene shows only one red poppy sprout (orig x≈2110), 2-3 grass tufts, and bare meadow, directly under the HUD text claiming '8 plants, 9 species'. wide-right crop of the same shot confirms the right third of the stage (x≈1100-1556) contains zero plants — all 8 plants cluster in the 32-65% band that the dock overlaps. Cause: packages/ui/src/styles.css:1123-1156 (.hud-dock bottom-left + .dock-panel width min(26rem,38vw), opaque blurred surface) layered over the scene, and packages/ui/src/screens/garden.tsx:1262 (preserveAspectRatio="xMidYMax slice") — the scene composition never accounts for the overlay. Dock defaults open (garden.tsx:668-670).

**Repro:** Open the Garden page on a ~1440px-wide desktop window with the next-workout dock in its default expanded state; compare the visible scene with the '8 plants, 9 species' HUD claim.

**Suggested fix:** Bias the scene composition (viewBox pan or plant x-placement) away from the dock's footprint, or auto-minimize the dock to its pill after a few seconds / make the panel semi-transparent, so the tallest plants are never permanently occluded.

**Verifier note:** Verified against both screenshots and code. garden-balance-popover-desktop-wide.jpg shows the paper birch trunk bisected by the dock panel's right edge (x~625-635, y~500-640; panel spans ~238-615) plus a red sprout at (659,737) under the card corner; garden-desktop.png (1440px) shows only one poppy and grass tufts visible with no birch, under page copy claiming '8 plants, 9 species'. Code confirms the mechanism: dock defaults open (garden.tsx:668-670), .dock-panel is a ~opaque min(26rem,38vw) card absolutely positioned over the scene (styles.css:1123-1156), scene is 1000x560 with preserveAspectRatio='xMidYMax slice' (GardenScene.tsx:662, garden.tsx:1262) so at 1440x900 the card covers scene fractions ~0.15-0.40 — and layout.ts:13-19 deterministically places the early garden's plants in bands [0.32,0.68] then [0.14,0.34], exactly the covered zone (right-side bands unlock later, so the visible right half is empty by design at this garden stage). Hand-projected coordinates match: birch at fraction 0.32 -> ~x540 CSS (fully behind the 258-672 card); visible poppy at 0.645 -> ~x1058, matching the screenshot. No renderer/layout code accounts for the overlay. Severity 'important' is correct: not a blocked flow, but the default view renders the flagship garden as nearly empty while claiming 8 plants; the Minimize button (state persisted in localStorage) mitigates for users who find it but does not change the default experience. Minor nit: the '8 plants, 9 species' text is in the summary line below the stage, not the on-stage HUD.


### C2. [important · functional] HUD shows 'Run 1 d ago' while the garden log's newest watering is the Sat Aug 8 hike (2 days ago), the last actual run is Thu Aug 6 (4 days ago), and the Sat Aug 8 long run is still flagged as having no matching activity.

**Surface:** Garden HUD balance chips (Run recency) vs Garden log · **Finder:** shots-garden · **Verdict:** confirmed

**Evidence:** garden-desktop.png top-right chip reads 'Run / 1 d ago' and the condition is 'Well watered'; garden-mobile.png garden log (gm-03/gm-04 crops) lists, newest first: 'Sat Aug 8 — A hike fed the garden', 'Fri Aug 7 — A rest day', 'Thu Aug 6 — A quality run watered the garden' — no Aug 9 entry exists, so nothing watered the garden 1 day before Mon Aug 10; simultaneously the 'DID THIS RUN HAPPEN?' card says the Sat Aug 8 Long Run has 'No matching activity'. Rendered via daysCaption at packages/ui/src/screens/garden.tsx:208-211 and :254 from balance data at garden.tsx:921 (garden.data.balance) — the recency computation (likely counting the adventure hike with an off-by-one, or a planned session) contradicts the log the user reads on the same page.

**Repro:** Load the Garden page on the fixture stack (today Mon Aug 10) and compare the Run chip caption against the Garden log card and the 'Did this run happen?' card.

**Suggested fix:** Make balance.run.days derive from the same completed-activity set that produces garden-log waterings (adventures either count consistently everywhere with correct day math, or not at all).

**Verifier note:** Verified both screenshots and hand-traced the code. garden-desktop.png HUD chip reads "Run / 1 d ago" while the same page's garden log (garden-mobile.png crop) shows the last run watering on Thu Aug 6 (4 days before Mon Aug 10), the newest log entry is the Sat Aug 8 hike, and the Sat Aug 8 Long Run card says no matching activity — so "1 d ago" matches no real event. Root cause differs from the finding's hypothesis (not an off-by-one on the hike): the chip renders the engine's decay clock daysSinceCompletedRun (balance.ts:84,:133 via projectedBalance at garden.tsx:1021-1027) as recency copy via daysCaption (garden.tsx:208-211, :254; aria-label at :262 literally says "last run 1 d ago"). That clock deliberately freezes on rest-observed days (simulate.ts:327-333, Fri Aug 7) and adventure/grace days (simulate.ts:330 + adventure.ts:29-76, Sat Aug 8 4h hike; Sun Aug 9 ticked it to 1 since COROS recovery 60 is not <60). Decay-freezing is intended mechanics, but presenting the sheltered clock as "N d ago" recency is a genuine semantic mismatch a user would notice and distrust. Severity "important" is correctly stated: misleading primary-HUD copy contradicted by the log on the same screen, no data loss or blocked flow. Fix direction: caption should either show true days-since-last-run or reword to decay-oriented copy ("clock paused — sheltered by your hike").


### C3. [important · functional] On load the user lands at the top of the plan (June, a wall of missed weeks) instead of today, because the coach thread's autoscroll hijacks window scroll after the coach state resolves.

**Surface:** Plan page (desktop + mobile) · **Finder:** shots-plan-coach · **Verdict:** confirmed

**Evidence:** plan-desktop.png and plan-mobile.png: viewport rests at document top showing 'June 2026'; today (Aug 10) is ~3 months of calendar below the fold. Code: plan.tsx:509-514 scrolls todayRef to center once when plan data arrives, but coach-panel.tsx:212-215 (CoachThread) runs endRef.current.scrollIntoView({block:'end'}) on every messages.length change. scrollIntoView scrolls ALL scrollable ancestors including the window; the coach panel sits at the top of the document (plan.tsx:572-573), so when the slower ['coach-state'] query — and later the auto-wake's failure receipt (plan.tsx:393-399 → new message row) — land after the plan query, the window is scrolled back up and clamps to scrollY≈0. Last scroll wins, so the deliberate land-on-today feature is defeated every load; the same yank recurs if a coach reply/receipt arrives while the user is reading the calendar (including right after pressing Today).

**Repro:** Open /plan with the fixture stack (coach backend slow or failing). Page briefly positions on the current week, then jumps to the very top once coach messages render; user must find and click the Today button.

**Suggested fix:** In CoachThread, scroll only the overflow container (e.g. threadEl.scrollTop = threadEl.scrollHeight, or scrollIntoView on the container ref) instead of element.scrollIntoView which propagates to the window; alternatively guard the first plan scroll to run after coach-state settles.

**Verifier note:** Verified end-to-end. plan.tsx:509-514 does a one-shot scroll to todayRef when plan data lands; coach-panel.tsx:211-215 (CoachThread) calls endRef.scrollIntoView({block:'end'}) on mount and on every messages.length change. scrollIntoView scrolls all scrollable ancestors including the window (the .coach-thread overflow:auto container, styles.css:3408, does not absorb it), and the panel sits at document top on both breakpoints — plan.tsx:572-573 wraps it in .plan-split-coach, which also means the desktop sticky rule `.plan-split > .coach-panel` (styles.css:3362) never matches, so the panel is statically at the top and the window clamps to scrollY≈0. On the fixture stack the auto-wake (plan.tsx:393-399) fails against the live LLM backend and appends failure receipts, re-firing the scroll: plan-desktop.png shows 3 such receipts and plan-mobile.png shows 5, both resting at 'June 2026' with today ~3 months below; plan-after-today-desktop.png proves the Today target works when clicked, so the auto-land is being defeated, not broken. Timing nuance: if coach-state resolves in the same commit as plan, the parent's today-scroll runs last and briefly wins, but the wake receipt seconds later yanks to top anyway — every path ends at the top. Severity 'important' is correctly stated (recoverable via Today button, but defeats the land-on-today feature every load and can yank mid-reading).


### C4. [important · functional] Every failed coach wake permanently appends an identical 'The coach couldn't think just now' row to the thread — page opens and Check-in retries stack duplicates forever with no other feedback.

**Surface:** Coach panel / coach thread (worker + plan page) · **Finder:** shots-plan-coach · **Verdict:** confirmed

**Evidence:** plan-desktop.png shows 3 identical 'The coach couldn't think just now — try again in a moment.' lines; plan-coach-checkin-desktop.png shows 4 (one added by the Check in click); plan-mobile.png shows 5 and plan-coach-checkin-mobile.png 6. Code: apps/worker/src/services/coach-wake.ts:261 and :396 persistMessage(...'receipt', "The coach couldn't think just now — try again in a moment.") — the failure notice is written to the coachMessages table, so it is permanent thread history, not a transient toast. plan.tsx:393-399 auto-fires a wake on every plan open when wakeAdvised; and because a failed wake never writes a coach-role message, the freshness skip rule (coach-wake.ts:194-204) never suppresses the next open's wake — so while the LLM backend is down, every single visit to /plan silently adds another permanent duplicate error row, and they remain in the thread even after the coach recovers.

**Repro:** With the coach LLM unreachable (local fixture mode), open /plan several times and press Check in — each action adds one more identical error line that never goes away.

**Suggested fix:** Surface wake failures as transient client-side state (banner/toast in CoachPanel keyed to the failed mutation) instead of persisting a receipt row; if persisted, dedupe consecutive identical failure receipts and/or prune them on the next successful wake.

**Verifier note:** Confirmed via both code trace and screenshots; severity "important" is accurate. Code: apps/worker/src/services/coach-wake.ts:260-262 and :395-397 persist the failure notice as a role="receipt" row in the coachMessages table (persistMessage, :76-86), so it is permanent thread history — and on a gateway failure attemptParse returns {out:null, raw:""} (:224-227), which skips the repair branch (guarded by `!out && raw` at :250) and lands directly on the :261 persist. The retry-loop mechanics also check out: GET /coach/state computes wakeAdvised = triggers.length>0 || staleBriefing where staleBriefing looks only at the last role="coach" message (apps/worker/src/routes/coach.ts:103-119); a failed wake writes no coach-role message, so wakeAdvised stays true, and packages/ui/src/screens/plan.tsx:392-399 auto-fires wakeMut.mutate(false) once per mount whenever wakeAdvised — i.e., one new permanent duplicate per /plan visit while the LLM is down. The server-side skip rule (coach-wake.ts:194-203) is likewise keyed on role="coach" so it never suppresses these, and "Check in" (plan.tsx:436, force=true → cause "manual") bypasses the skip rule entirely, adding one more row per press. The client ignores WakeResult.status ("error"): wakeMut has only onSettled: invalidate (plan.tsx:391), so the appended row is the sole feedback. CoachThread renders every receipt verbatim with no dedupe/collapse (packages/ui/src/screens/coach-panel.tsx:218-222), and there is no delete endpoint for coachMessages (only DELETE /memory/:id exists, routes/coach.ts:258) — no cleanup path even after the coach recovers. Screenshots match the claimed counts exactly: plan-desktop.png shows 3 identical "The coach couldn't think just now — try again in a moment." rows, plan-coach-checkin-desktop.png 4, plan-mobile.png 5, plan-coach-checkin-mobile.png 6 — monotonic growth across the audit session, exactly one per open/check-in. Minor addendum: the budget-cutoff path (coach-wake.ts:188-191) has the same accumulate-forever shape with its "coach is resting" receipt. Not critical (plan page remains usable; no data loss), but permanent, unbounded, user-visible junk in the coach thread with zero other error feedback — squarely "important".


### C5. [important · visual] The coach panel's sticky positioning is dead (selector targets a direct child that no longer exists), so scrolling to today leaves the entire left half of the desktop plan page blank.

**Surface:** Plan page desktop layout · **Finder:** shots-plan-coach · **Verdict:** confirmed

**Evidence:** plan-after-today-desktop.png: after clicking Today, the August calendar sits in the right column while the whole left column (~50% of the content area) is empty — the coach panel scrolled away. Code: styles.css:3362 '.plan-split > .coach-panel { position: sticky; top: 0.8rem; }' requires the panel to be a direct grid child, but plan.tsx:572-573 renders <div className="plan-split"><div className="plan-split-coach">{coachPanelEl}</div>…, and no '.plan-split-coach' rule exists anywhere in styles.css (grep confirms), so the sticky rule never matches and the 340px+ column is wasted whitespace for the entire scroll depth of a 4-month plan.

**Repro:** On a ≥1024px viewport, open /plan and click Today (or scroll to August).

**Suggested fix:** Change the selector to '.plan-split-coach { position: sticky; top: 0.8rem; }' (or '.plan-split > div > .coach-panel'), or drop the wrapper div.

**Verifier note:** Verified in code and screenshots. packages/ui/src/styles.css:3362 has '.plan-split > .coach-panel { position: sticky; top: 0.8rem; }' but packages/ui/src/screens/plan.tsx:572-573 wraps the panel in <div className="plan-split-coach">, making .coach-panel (root of CoachPanel, coach-panel.tsx:332, and of the fallback, plan.tsx:540) a grandchild — the direct-child selector never matches. Grep of the whole worktree confirms 'plan-split-coach' has no CSS rule in either stylesheet (packages/ui/src/styles.css, apps/desktop/src/desktop.css) and no other rule makes the panel sticky. Screenshots corroborate: plan-desktop.png shows the coach panel in the left grid column at page top; plan-after-today-desktop.png shows the August calendar in the right column with the entire left column blank — the panel scrolled away. Severity 'important' is correct: clicking Today (the natural first action on a Jun–Oct plan) hides the coach panel and wastes ~half the desktop viewport for the remaining scroll depth, but the flow isn't blocked (scrolling up recovers it). Only nit: the finding's paths omitted the packages/ui/src prefix; line numbers were exact.


### C6. [important · visual] Mobile renders two full coach UIs — the inline panel is never hidden below 1024px, so it fills the entire first viewport pushing the plan below the fold, while the floating Coach pill opens a Sheet containing a duplicate of the same panel.

**Surface:** Plan page mobile layout · **Finder:** shots-plan-coach · **Verdict:** confirmed

**Evidence:** plan-mobile.png: the inline Coach panel (with 5 stacked error lines) occupies the whole first screen — the first calendar entry (TUE 16 June) only appears ~1.5 viewports down — and the green 'Coach' pill floats bottom-right, which opens a second CoachPanel in a Sheet (plan.tsx:647-667). Code: styles.css:3354 '.plan-split { display: block; }' keeps the inline panel (plan.tsx:572-573) in flow on mobile; there is no 'display:none' for '.plan-split-coach' under 1024px (the class has no CSS at all), while '.coach-pill' at styles.css:3516-3530 is mobile-only and the comment at styles.css:3515 ('Mobile: the Coach pill + sheet') shows the sheet was meant to BE the mobile coach surface. Result: duplicated thread/composer mounted twice, and the plan content a user came for starts below the fold behind a wall of coach errors.

**Repro:** Open /plan on a <1024px viewport: full coach panel at top plus Coach pill; tapping the pill overlays an identical panel.

**Suggested fix:** Hide the inline column on mobile: '@media (max-width:1023px){ .plan-split-coach { display:none; } }' so the pill+sheet is the single mobile coach surface.

**Verifier note:** Verified in code and screenshot. plan.tsx:572-573 renders a full inline CoachPanel inside .plan-split-coach, and that class has zero CSS rules anywhere in packages/ui/src (grep confirms), so nothing hides it below 1024px; styles.css:3354 keeps .plan-split as display:block on mobile. Meanwhile .coach-pill (styles.css:3516-3530, under the comment 'Mobile: the Coach pill + sheet') is mobile-only and opens a Sheet mounting a second identical CoachPanel (plan.tsx:647-667) — two coach threads/composers on mobile. plan-mobile.png confirms the consequence: the inline panel with five stacked coach-error lines fills the entire first viewport, the first calendar entry (TUE 16 June) is far below the fold, and the green Coach pill floats bottom-right. Corroborating regression evidence: the desktop sticky rule at styles.css:3362 targets .plan-split > .coach-panel, which the new .plan-split-coach wrapper breaks (panel is now a grandchild), suggesting the wrapper was added without its matching CSS including the mobile display:none. Severity 'important' is correct: broken mobile layout burying primary content plus duplicated interactive UI, but no data loss or blocked flow.


### C7. [important · visual] Every workout title in the desktop calendar is hard-clipped mid-word with no ellipsis ('Thres…' for 'Threshold 5x5', 'Easy Ru…', 'Easy +…'), making the plan grid unreadable at a glance.

**Surface:** Plan calendar cards (desktop grid) · **Finder:** shots-plan-coach · **Verdict:** confirmed

**Evidence:** plan-desktop.png / plan-full-desktop.png: every Tuesday card reads 'Thres|5x5', Wednesdays 'Easy|Ru...', Thursdays 'Easy|+...' across all four months — the first line of each title is clipped mid-word without an ellipsis. Cause: .shell-main caps content at 880px (styles.css:283-286) and .plan-split gives the coach column minmax(340px,0.85fr) (styles.css:3356-3361), leaving ~440px for a 7-column month grid → ~58px-wide day cells; .cal-card-title (styles.css:757-765) uses -webkit-line-clamp:2 + overflow:hidden but no overflow-wrap/hyphens, so an unbreakable word like 'Threshold' overflows line 1 horizontally and is hard-clipped (line-clamp only ellipsizes the final line). The only recourse is the hover title tooltip (plan.tsx:354).

**Repro:** Open /plan at any ≥1024px width; every non-rest card title is clipped.

**Suggested fix:** Add overflow-wrap:anywhere (or hyphens:auto) to .cal-card-title, and widen the calendar column (raise .shell-main max-width for the plan screen or shrink the coach column) so day cells get readable width.

**Verifier note:** Verified in code and screenshot. CSS cites are accurate (in packages/ui/src/styles.css): .shell-main max-width:880px inside @media(min-width:1024px) (283-286) plus .plan-split minmax(340px,.85fr)/1.15fr (3354-3362) leave ~444px for the 7-column month grid (~58px cells); .cal-card-title (757-765) uses -webkit-line-clamp:2 + overflow:hidden and the stylesheet contains no overflow-wrap/word-break/hyphens rules anywhere, so unbreakable words overflow line 1 and are hard-clipped (line-clamp ellipsis only appears at end of line 2). Magnified crops of plan-desktop.png confirm: Tuesday 'Threshold 5x5' renders as 'Thre' + a vertically sliced half-'s' glyph with no ellipsis, then '5x5'; pattern repeats June and July. Wider windows can't help since content is capped at 880px, matching the ≥1024px repro claim; plan.tsx:354 title tooltip is the only in-grid recourse. Minor overstatement only: Wed/Thu titles ('Easy / Ru…', 'Easy / +…') do get a line-clamp ellipsis though still truncated to meaninglessness, and 'Long Run'/'Reco Run' wrap cleanly and are readable — so not literally 'every' title is ellipsis-less. Severity 'important' is correct: not blocking (tooltip/click-through exist) but the grid is unreadable at a glance and the mid-glyph clip looks visually broken on every Tuesday card.


### C8. [important · visual] On mobile, every activity row's metadata (duration/distance) is hard-clipped under the 'Coach's read' button, hiding distance and pace with no ellipsis.

**Surface:** Activity list (mobile, 390px) · **Finder:** shots-rest · **Verdict:** confirmed

**Evidence:** Screenshots: activity-adventures-mobile.png — Ridgeline Loop row reads 'Saturday, August 8  240 min  15.8' with the km/mi text cut mid-number at the button's left edge; Evening Walk row cut at '1.5'; activity-mobile.png shows the same on all ~40 rows; activity-coach-read-mobile.png shows it persists in the 'Hide read' state. Cause: packages/ui/src/styles.css:607-614 — `.workout-row .meta` has `white-space: nowrap` with no overflow handling, and `.workout-row .body` (styles.css:596-599) is `flex: 1 1 130px`, so the ~330px-wide meta line overflows its box and paints beneath the adjacent button rendered by packages/ui/src/screens/runs.tsx:258-266.

**Repro:** Open /runs at 390px viewport width with any activities present; look at any row's second line.

**Suggested fix:** Let the meta line wrap (`flex-wrap: wrap; white-space: normal` on `.workout-row .meta`) or give the body `min-width: 0` plus `overflow: hidden; text-overflow: ellipsis` per span; alternatively stack the action buttons below the body under a narrow-width media query.

**Verifier note:** Confirmed visually and in code. All three cited screenshots show every activity row's meta line hard-cut at the Coach's read button edge with no ellipsis (e.g. Ridgeline Loop '…240 min 15.8', runs losing pace entirely); activity-coach-read-mobile.png proves it persists in the 'Hide read' state ('15.8 km · 9.' still cut), confirming occlusion rather than truncation. Code mechanism verified: packages/ui/src/styles.css:607-614 (.workout-row .meta: display:flex + white-space:nowrap, no overflow handling) plus :596-599 (.body flex:1 1 130px, no clipping) lets the ~330px meta line overflow; the button rendered at packages/ui/src/screens/runs.tsx:258-266 is a later flex item with opaque background (styles.css:342) that paints atomically over the overflowing text. Severity 'important' is accurate — misleading/hidden data on every mobile row, but no crash or blocked flow.


### C9. [important · functional] The device row presents the pairing-time app version ('app 0.1.0') as current fact — appVersion is written once at handshake claim and never updated afterward.

**Surface:** Settings › Desktop companion · **Finder:** shots-rest · **Verdict:** confirmed

**Evidence:** Screenshot settings-desktop.png / settings-mobile.png: 'Fixture MacBook (Offline) — Last seen 8/10/2026, 10:09:11 AM · app 0.1.0 · COROS schedule updates supported'. Code: apps/worker/src/routes/devices.ts:75-84 sets `appVersion` only when the handshake is claimed; the bridge's later self-report update at devices.ts:190-194 sets only `capabilities` and `bridgeVersion`, never `appVersion`; packages/ui/src/screens/settings.tsx:335 renders `app {d.appVersion}` with no 'as of pairing' qualifier. After any desktop-app update the row shows the old version forever — misleading exactly when the user is debugging sync ('your desktop app is older than this feature', settings.tsx:189, tells them to check it).

**Repro:** Pair the desktop app, then update it to a newer version; Settings keeps showing the version from pairing day.

**Suggested fix:** Have the bridge's capability/heartbeat update also refresh `appVersion` (devices.ts:190-194), or label the value honestly ('app 0.1.0 at pairing').

**Verifier note:** Verified all three code claims: devices.ts:75-84 writes appVersion only at the single-use handshake claim; devices.ts:188-196 bridge self-report updates only capabilities+bridgeVersion (repo-wide grep shows no other appVersion write path; re-pairing creates a new device row, never refreshing the old one); settings.tsx:335 renders 'app {d.appVersion}' unqualified while ignoring the fresher bridgeVersion the API already returns (devices.ts:109). Screenshot settings-desktop.png matches ('app 0.1.0' row). The misleading-while-debugging angle is real: settings.tsx:189 tells users their desktop app may be 'older than this feature — update it'. Severity caveat: currently vestigial in practice — the desktop hardcodes appVersion "0.1.0" (lib.rs:358) and CloudSync is built without bridgeVersion (protocol.ts:257-263, defaults "0.1.0"), so the mismatch only appears once a release ships a bumped version string; important is defensible but this sits at the important/minor boundary.


### C10. [important · copy] Signal-tile explanation text is clamped to 2 lines and cut mid-word, and on non-drillable tiles (7-day ramp, Load variety, Hard-day stacking) there is no way to ever read the rest.

**Surface:** Insights › Signals tiles · **Finder:** shots-rest · **Verdict:** confirmed

**Evidence:** Screenshot insights-desktop.png: Load variety card ends 'It rises when every day carries th…' with no chevron; Hard-day stacking ends '…or yesterday, if today…'; 7-day ramp ends '…versus your avera…'. Same on insights-mobile.png. Cause: packages/ui/src/styles.css:2181-2186 (`.signal-meaning` `-webkit-line-clamp: 2; overflow: hidden`) applied at packages/ui/src/signal-tiles.tsx:367; `hasDrilldown` (signal-tiles.tsx:72-78) returns false for these metrics (no `detail`, no `baseline`), so the drilldown sheet that would show the full `meaning` (packages/ui/src/screens/insights.tsx:93) never opens for them — the clipped sentence is permanently unreadable.

**Repro:** Open /insights on the Running tab; read the Load variety or Hard-day stacking tile; there is nothing to click or hover to reveal the full sentence.

**Suggested fix:** Don't clamp `.signal-meaning` on tiles without a drilldown (e.g. only apply the clamp inside `.metric-drillable`), or add a `title` attribute / expandable state carrying the full text.

**Verifier note:** Verified in both screenshot and code. insights-desktop.png shows all three cited tiles clipped mid-word with ellipsis and no chevron (Load variety: "…every day carries th…"; Hard-day stacking: "…or yesterday, if today…"; 7-day ramp: "…versus your avera…"), while drillable neighbors (Load vs norm, Resting HR, HRV) do show chevrons. Code confirms the mechanism exactly as claimed: packages/ui/src/styles.css:2181-2186 clamps .signal-meaning to 2 lines with overflow:hidden (unconditional, all viewports), applied at packages/ui/src/signal-tiles.tsx:367 with no title attribute and no hover/expand rule anywhere (only 2 occurrences of the class in the package). hasDrilldown (signal-tiles.tsx:72-78) requires detail or baseline+series; apps/worker/src/routes/misc.ts shows ramp (808-822) and monotony (823-841) ship neither, hardStack (922-940) ships only strip, and detailByMetric (1072-1087) covers only easyDiscipline/pacing — so the drilldown sheet that renders full meaning (packages/ui/src/screens/insights.tsx:93) can never open for these three tiles. Severity "important" is justified, and arguably under-sold: monotony's clipped meaning (misc.ts:830-832) embeds computed data ("This week totalled ${weeklyLoad}, for a strain of ${strain}") that is generated but unreadable anywhere in the UI.


## Unverified — found by one agent, not yet adversarially checked (23)

Verification was capped at 10; several entries here independently corroborate confirmed findings (the plan scroll hijack, dead sticky selector, mobile double coach UI, dock coverage) — treat those as effectively confirmed. The rest need a verification pass before fixing.


### U1. [important · functional] Adventure shield caption is computed from pre-preview durable state, so whenever the preview fold spans more than just today it contradicts the garden actually rendered (falsely claims shelter, or omits it entirely).

**Surface:** Garden page — adventure shield caption / forecast line · **Finder:** code-garden

**Evidence:** apps/worker/src/services/garden-sync.ts:648-652 captures shieldState from the durable snapshot before previewToday, and :737-754 computes frozenToday/graceDay from that stale state; but previewToday (garden-sync.ts:590-633) can fold MULTIPLE days (any yesterday with an unresolved workout stays out of the durable sim per advanceGarden's grace rule at :396-397), and simulateDay decrements the banked grace day on each intermediate grace day (packages/garden-engine/src/simulate.ts:266-268). Direction (a): big hike Sat, Sunday unresolved, no recovery rows → Monday's engine fold is UNSHIELDED (bank consumed by preview-Sunday) and the rendered snapshot decays, while the caption path sees bank=1 → graceDay=true → ForecastLine says "Saturday's hike is still keeping the beds shaded" (packages/ui/src/screens/garden.tsx:474-482) and `sheltered` suppresses every loss voice (garden.tsx:1033-1039). Direction (b): the hike day itself still un-durable (user skipped Saturday's planned run to hike — it sits unresolved) → shieldState.lastAdventureDate is stale/null → graceDay=false → Sunday shows a dryness countdown with zero shield acknowledgment even though the engine froze the day, while BalanceDetail simultaneously shows "Adventure ✓" from the previewed snapshot (garden.tsx:400-401).

**Repro:** Fixture-shaped: 4h hike Sat Aug 8 (big adventure, banks 1 grace day), a planned workout on Sat or Sun still unresolved (normal COROS sync lag), no dailyHealth recovery rows. Open the garden Sun or Mon and compare the forecast caption with the balance clocks/weather of the rendered snapshot.

**Suggested fix:** Have previewToday return the shield status of the today fold itself (simulateDay already computes adventureFrozen/graceDay for each day) and drive the caption from that, instead of re-deriving it in buildGardenView from pre-preview durable state.


### U2. [important · functional] Dismissing the overnight-beat block (X) while species/ground ceremonies are still queued strands the queue and blocks the mark-seen post, so every already-dismissed celebration replays on the next visit.

**Surface:** Garden page (desktop HUD) — arrival block / ceremony queue · **Finder:** code-garden

**Evidence:** packages/ui/src/screens/garden.tsx:989-990 gates the ceremony card on `!blockDismissed`, so the X at garden.tsx:1306-1313 hides pending ceremonies with no way to advance ceremonyIndex; the mark-seen effect then early-returns forever at garden.tsx:888 (`if (ceremonyIndex < plan.ceremonies.length) return;`) even though blockDismissed=true, so api.gardenSeen is never posted (garden.tsx:872-895). The unused `ceremoniesDone` at garden.tsx:991 suggests intended gating was dropped. A run that unlocks a species always yields both a ceremony AND plant_added beat lines (arrival.ts:191-207), so the X is on screen next to a queued ceremony routinely.

**Repro:** Desktop: land a run that unlocks a species (ceremony queued, beat lines present). Click the X on the "Since …" beat paragraph before dismissing the ceremony card. Ceremony vanishes mid-queue; reload the page — the same ceremony and the dismissed beat lines re-present.

**Suggested fix:** Either let the beat X only clear the text lines (drop `!blockDismissed` from currentCeremony), or treat block dismissal as dismissing the whole presentation: skip the ceremony-pending early return when blockDismissed and post nextSeen.


### U3. [important · functional] Garden events rebuilt by resimulateFrom for past dates land strictly behind the seen watermark, so a species unlocked by a late-synced activity (or a match/unmatch edit) is never announced — no ceremony, no beat line.

**Surface:** Garden page — arrival/seen watermark vs resimulation · **Finder:** code-garden

**Evidence:** packages/ui/src/screens/arrival.ts:137-138 admits events only when `date > lastSeenDate` (or same-date higher seq), assuming append-only history; but resimulateFrom deletes and rewrites events on their ORIGINAL past dates (apps/worker/src/services/garden-sync.ts:504-513) and is invoked exactly when history changes late — device sync of old activities (apps/worker/src/routes/devices.ts:238), activity match edits (routes/plan.ts:579, :672). A user who visits daily has lastSeenDate ≈ yesterday, so events for a 3-day-late weekend run (dated 3 days ago) are filtered out of ceremonies and beat lines entirely; the species silently appears "New" in the codex with no arrival celebration, and gardenSeen has no server-side writer that could compensate (only the client POST, routes/garden.ts:55-85).

**Repro:** Visit the garden daily. Let an activity for a date older than the 2-day grace window sync late (or re-match a past workout) such that the resim emits species_unlocked/plant_added on that past date. Reload the garden: no ceremony, no beat line; the unlock only shows buried in the codex/log.

**Suggested fix:** Track seen-ness by event identity or a monotonic insertion cursor (e.g. createdAt) rather than (date,seq), or have resimulateFrom rewind gardenSeen to just before the earliest rewritten date.


### U4. [important · visual] The desktop coach panel's sticky rule targets a selector that matches nothing, so the panel scrolls off-screen and the auto-scroll-to-today leaves desktop users with no visible or reachable coach UI.

**Surface:** Plan screen (desktop, >=1024px) · **Finder:** code-plan-coach

**Evidence:** packages/ui/src/styles.css:3362 declares `.plan-split > .coach-panel { position: sticky; top: 0.8rem; }` but plan.tsx:572-573 nests the panel as `.plan-split > .plan-split-coach > .coach-panel`, so the direct-child selector never matches and sticky is dead. plan.tsx:509-514 then scrolls the window to today's week (about 10 weeks into the fixture's Jun-Oct calendar), putting the panel far above the viewport, and the only re-entry affordance, `.coach-pill`, is `display: none` at >=1024px (styles.css:3530).

**Repro:** Open /plan on a >=1024px window with the fixture plan; after the initial scroll to the current week, the coach panel (including the Needs-you tray) is entirely off-screen and there is no button to reach it.

**Suggested fix:** Change the selector to `.plan-split-coach > .coach-panel` (or make `.plan-split-coach` the sticky element).


### U5. [important · visual] No CSS ever hides `.plan-split-coach` on mobile, so the full coach panel (up to 84vh) renders above the calendar while the Coach pill opens a second duplicate copy in a sheet.

**Surface:** Plan screen (mobile, <1024px) · **Finder:** code-plan-coach

**Evidence:** styles.css:3354 gives `.plan-split { display: block }` below 1024px and there is no `.plan-split-coach` rule anywhere in styles.css (grep finds only the plan.tsx:573 usage); `.coach-panel` has `max-height: 84vh` (styles.css:3371), so the panel fills the first screen and buries the calendar. plan.tsx:647-667 simultaneously renders the mobile `.coach-pill` plus a Sheet containing a second `CoachPanel`, and the comment at plan.tsx:502 ('no-op visually on desktop (panel always mounted)') shows the inline panel was meant to be desktop-only. Both mounted copies also emit duplicate DOM ids `proposal-<id>` (coach-panel.tsx:137), so `focusProposal` (plan.tsx:444-453) via `getElementById` flashes the inline copy hidden behind the sheet backdrop, not the sheet's copy.

**Repro:** Open /plan at <1024px: the page leads with a near-full-screen coach panel before any calendar, plus a floating Coach pill that opens the same panel again; tap a calendar ghost and the flash animation runs on the background copy.

**Suggested fix:** Add `.plan-split-coach { display: none }` below 1024px (keeping the pill+sheet as the mobile surface), which also removes the duplicate-id problem.


### U6. [important · functional] CoachThread's scrollIntoView scrolls the window, so the plan page's initial scroll-to-today is raced and then yanked back to the coach panel whenever a message lands (which in fixture mode is every visit, when the failed auto-wake's receipt arrives).

**Surface:** Plan screen calendar + coach thread · **Finder:** code-plan-coach

**Evidence:** coach-panel.tsx:212-215 calls `endRef.current?.scrollIntoView({ block: "end" })` on every `messages.length` change; scrollIntoView scrolls every scrollable ancestor including the document, not just the `.coach-thread` overflow container. plan.tsx:509-514 scrolls the window to today's week when the plan query resolves. The two queries (`plan`, `coach-state`) resolve in nondeterministic order, and plan.tsx:392-399 fires an auto-wake whose settlement appends a receipt (coach-wake.ts:396) that re-triggers the thread scroll seconds after load, pulling the viewport off the calendar back to the (non-sticky, see prior finding) panel.

**Repro:** Open /plan with a stale briefing (fixture default, LLM failing): page lands on today's week, then a few seconds later jumps up to the coach panel when the 'couldn't think' receipt arrives.

**Suggested fix:** Scroll the thread container directly (`el.scrollTop = el.scrollHeight`) or pass a container-scoped scroll instead of scrollIntoView; only auto-scroll when the thread itself is user-visible.


### U7. [important · functional] Failure and budget receipts stack without bound: every Plan visit auto-wakes (wakeAdvised never clears on failure), appending another identical 'The coach couldn't think just now' or 'The coach is resting' receipt and burning an LLM call each time.

**Surface:** Coach thread / check-in (worker wake path) · **Finder:** code-plan-coach

**Evidence:** apps/worker/src/routes/coach.ts:110-119 sets `wakeAdvised = triggers.length > 0 || staleBriefing`, where staleBriefing needs a role='coach' message under 20h old; failed wakes only write role='receipt' rows (coach-wake.ts:260-262, 396-397) and `consumeTriggers` runs only on success (coach-wake.ts:393), so wakeAdvised stays true forever while the LLM errors or the budget is cut off (budget receipt written unconditionally per wake at coach-wake.ts:187-191, before the open-cause skip rule). plan.tsx:392-399 fires the wake once per PlanScreen mount. The thread window is the latest 30 messages (coach.ts:88), so the duplicates push real coaching content out of view; manual 'Check in' taps while resting each add another copy with no other feedback (the WakeResult status is discarded, plan.tsx:391).

**Repro:** With the fixture stack's unreachable LLM, navigate to /plan five times: the thread shows five identical 'The coach couldn't think just now — try again in a moment.' receipts (one per visit).

**Suggested fix:** Dedupe consecutive identical receipts (or return the failure in the wake response and render it as transient UI state instead of a persisted message), make wakeAdvised consider recent failed attempts, and surface the 'resting' status directly on the Check in button.


### U8. [important · functional] The 'N changes couldn't sync — Retry' button is a no-op: it enqueues a COROS read (which usually short-circuits as fresh) and never retries the failed write jobs that the count is made of, so the banner can never clear via its own Retry.

**Surface:** Sync status line (Today/Plan/Garden/Studio SyncPanel) · **Finder:** code-plan-coach

**Evidence:** components.tsx:169-179 renders Retry for state 'sync_issue'; today.tsx:64-67,102 wires it to `api.readNow`. apps/worker/src/routes/sync.ts:214-262 shows read-now only inserts a `kind: "read_now"` job and returns `{enqueued:false}` whenever a successful read is <5 minutes old (nearly always, since TodayScreen fires readNow on every mount at today.tsx:350-352). issueCount comes from `status='failed'` write jobs plus failed studio pushes (sync-status.ts:81-101), which a read job does not touch; the real retry path is the per-workout retry-coros route, which supersedes the failed job and re-runs applyMove (apps/worker/src/routes/plan.ts:683-712). The Retry button also has no pending/disabled state, so pressing it produces zero visible change.

**Repro:** Put any workout's write job into status 'failed' (issueCount>0), then press Retry on the '2 changes couldn't sync' line: the request returns enqueued:false, issueCount is unchanged, and the banner persists indefinitely.

**Suggested fix:** Point the account-level Retry at a route that supersedes each failed job and re-emits its write (loop of the retry-coros logic over failed jobs/studio pushes), and disable the button while pending.


### U9. [important · functional] A network-failed send silently swallows the athlete's message: the draft is cleared on submit, the optimistic echo is removed by the settle-time refetch, and there is no onError, so the text vanishes with no feedback.

**Surface:** Coach composer (Plan screen) · **Finder:** code-plan-coach

**Evidence:** coach-panel.tsx:259-266 clears the draft (`setDraft("")`) before invoking onSend; plan.tsx:401-418 adds an optimistic user message in onMutate and only invalidates in onSettled — no onError handler. If the POST /api/coach/message request never reaches the server (offline, DNS, or the 320s AbortSignal timeout in api-client index.ts:565), the server-side persistence at coach-wake.ts:185 never happens, so the refetch replaces the cache without the message and the thread shows nothing — no error, no retained draft.

**Repro:** Go offline (or kill the worker), type a message in the coach composer and press Send: the message appears briefly, then disappears entirely once the failed mutation settles.

**Suggested fix:** On error, restore the optimistic message with a 'failed to send — tap to retry' state (or restore the draft into the input) instead of only invalidating.


### U10. [important · functional] Approve/decline failures are indistinguishable from success: a 409 not_pending (proposal expired while the page sat open) makes the card vanish with no error even though nothing was applied, and the computed `acting` in-flight state is never wired to the buttons.

**Surface:** Proposal tray (Make it so / Leave it) · **Finder:** code-plan-coach

**Evidence:** plan.tsx:419-426 approve/decline mutations have no onError — onSettled just invalidates, so after a 409 from coach.ts:170/192 the now-expired proposal drops out of pendingProposals and the card disappears exactly as it would on success; the only trace is a low-key 'Expired — the moment passed' receipt written by the sweep (coach.ts:65). plan.tsx:434 computes `acting: approve.isPending || decline.isPending` but it is passed nowhere (grep shows a single occurrence), so 'Make it so' shows no pending state during multi-second applies (busy in ProposalCard covers only wake/send, plan.tsx:433, coach-panel.tsx:158-172).

**Repro:** Leave /plan open past midnight so a pending proposal crosses its expiresAt, then tap 'Make it so': the request 409s, the card vanishes like a success, and the plan is unchanged.

**Suggested fix:** Add onError handling that shows why the action failed (e.g. 'this proposal expired before you approved it — nothing was changed') and pass `acting` into ProposalCard as the busy/disabled state.


### U11. [important · functional] Retire is a one-tap destructive action with no confirmation and no undo: it immediately archives every future scheduled session of the plan.

**Surface:** Manage plans sheet · **Finder:** code-plan-coach

**Evidence:** coach-panel.tsx:445-447 renders a plain 'Retire' button that calls onRetire directly; plan.tsx:487-492 fires the mutation with no confirm step; apps/worker/src/routes/coach.ts:288-297 applies `retirePlan`, and coach-apply.ts:306-331 archives all scheduled future workouts (`archiveReason: "user_removed"`) and flips the plan to retired — there is no un-retire route. Contrast with the workout-level 'Remove from plan', which requires a two-step confirm (plan.tsx:246-256).

**Repro:** Open Manage plans and tap Retire (it sits directly beside Rename/Wind down): all remaining sessions of the plan disappear from the calendar instantly with only a receipt as feedback.

**Suggested fix:** Add the same two-step confirm used by Remove-from-plan (or an undo window) before applying retirePlan.


### U12. [important · functional] A dangling else left by the Strava-removal commit makes affectedDates.add(workout.effectiveDate) dead code, so a run matched to a workout on an adjacent day can be permanently missing from the garden.

**Surface:** Garden ↔ activity-sync seam (completion pipeline) · **Finder:** code-worker

**Evidence:** apps/worker/src/services/completion.ts:577-580 — `if (newState === "completed") stats.completions += 1; else\n affectedDates.add(workout.effectiveDate);` where `newState` is the constant "completed" (line 568), so the add never executes. The orphaned unused `const hasCoros` at completion.ts:551 sits beside it. `git log -L545,590` shows commit f45f8fb ("remove Strava entirely") deleted `else stats.provisionalCompletions += 1;` and left the bare `else` to capture the previously unconditional `affectedDates.add(...)`. Downstream, resimulateFrom is driven only by stats.affectedDates[0] (apps/worker/src/routes/devices.ts:236-238, services/backfill.ts:230-233); garden checkpoints are written on Mondays (garden-sync.ts:449-461) and resimulateFrom restarts from the latest checkpoint ≤ affectedDate-1 (garden-sync.ts:487-498).

**Repro:** Plan a run for a Monday; the Monday passes unresolved and is durably simulated (its Monday checkpoint is written). The activity is recorded early Tuesday (or the run happened Tuesday) and syncs later; the matcher's ±1-day window matches it to Monday's workout. affectedDates contains only Tuesday, resimulateFrom(Tuesday) restarts from the Monday checkpoint, so Monday is never re-simulated: the plan page shows the workout completed, but the garden, event feed, and timeline never show that day's run_completed/rain/plant — permanently, because the stale Monday gardenDayInputs row is what every future replay consumes.

**Suggested fix:** Delete the stray `else` (restore the unconditional `affectedDates.add(workout.effectiveDate);`) and remove the unused `hasCoros`; add a test asserting a cross-day match puts the workout's effectiveDate into stats.affectedDates.


### U13. [important · functional] deleteAllUserData misses 13 tables — every coach table, the garden visitor ledger, gardenSeen, gardenSceneLayouts, backfillState, syncIntents, and syncNotes survive "delete everything".

**Surface:** Settings → Delete all data (POST /api/settings/delete-all) · **Finder:** code-worker

**Evidence:** apps/worker/src/routes/misc.ts:1265-1370: the childTables/userTables lists omit coachPlans, coachPlanWeeks, coachMemory, coachMessages, coachProposals, coachQuestions, coachTriggers (packages/database/src/schema/coach.ts — all carry user_id), gardenVisitors, gardenSeen, gardenSceneLayouts (schema/garden.ts:123-159, 96-101), backfillState, syncIntents, syncNotes. The route's own doc comment (misc.ts:1259-1264) declares that a forgotten table 'leaves the user's data behind after they asked for it to be gone'; the only guard test (apps/worker/test/studio-push.test.ts:1890-1896) asserts just the three studio tables. Coach tables, gardenVisitors, and backfillState all arrived with the three freshly merged features — a cross-feature seam the delete list was never updated for.

**Repro:** POST /api/settings/delete-all with confirm="delete everything", then inspect D1: the user's entire coach conversation history (coach_messages), coaching memory/notes (coach_memory), coach plans/proposals, visitor sightings, backfill progress, and sync intents/notes all remain.

**Suggested fix:** Add the 13 missing tables to the appropriate lists in deleteAllUserData, and replace the spot-check test with one that enumerates every exported sqliteTable in @rg/database and asserts each is either deleted or on an explicit global-table allowlist (gardenSpecies, corosExercises, schemaVersions).


### U14. [important · functional] resimulateFrom deletes the garden's entire durable history and persists a genesis snapshot before a full-history replay with no transaction, and every failure is swallowed — a mid-replay failure silently regresses the garden to a newborn state that repeated loads may never heal.

**Surface:** Garden resimulation (SIMULATION_VERSION 6 upgrade + deep-backfill chunks) · **Finder:** code-worker

**Evidence:** apps/worker/src/services/garden-sync.ts:385-386 (version<6 → resimulateFrom(createdDate)); :487-501 (no checkpoint before affectedDate → initialSnapshot, restartAfter=createdDate-1); :504-515 (deletes ALL gardenEvents/gardenDayInputs/gardenSnapshots then persistSnapshot(genesis) BEFORE replaying); :466 (advanceGarden persists the advanced snapshot only after a COMPLETE pass — no mid-loop durability); :640 (buildGardenView swallows any advanceGarden failure with .catch(() => undefined)); backfill.ts:230-233 (every backfill chunk calls resimulateFrom(stats.affectedDates[0]) — for the deep 5-year walk that date predates genesis, so every chunk with activities triggers the full genesis replay, ~8-12 sequential D1 queries per garden day via buildDayInput, even though simulate.ts:179 ignores pre-genesis days entirely, also .catch(() => undefined)). The v6 bump ships in this merge, so every existing garden takes this path on first load after deploy.

**Repro:** Production-scale only (local fixture: 62 days replayed fine in ~0.6s; miniflare has no subrequest cap). A garden with >~100 simulated days (the real garden's genesis is 2026-05-25 — it crosses that in September) exceeds Workers' ~1000-subrequest budget mid-replay after the deletes have committed: the request's resim dies, the error is swallowed, garden_state holds the genesis snapshot stamped version 6, and every subsequent load re-attempts the full replay from genesis and dies at the same limit — the user's garden, event feed, and timeline silently show a newborn garden indefinitely.

**Suggested fix:** Short-circuit resimulateFrom when affectedDate < snapshot.state.createdDate (backfill chunks then cost nothing); for the version-upgrade path, replay in bounded slices that persist intermediate snapshots (advanceGarden already writes Monday checkpoints — also persist gardenState per slice so progress is durable), and only delete events/inputs for the range about to be rebuilt rather than everything up front.


### U15. [important · functional] Opening the Plan page never lands on the current week — the coach thread's auto-scroll drags the page back to the top, leaving the user on June's wall of 'missed' workouts.

**Surface:** Plan screen (desktop + mobile) · **Finder:** code-css

**Evidence:** coach-panel.tsx:212-215 (`endRef.current?.scrollIntoView({ block: "end" })` on every messages change — scrollIntoView scrolls ALL ancestors including the document) races plan.tsx:509-514 (scroll today's week to center, once). Verified live on the fixture stack: after load, window.scrollY = 0 while `.cal-week.current` top = 1526px (desktop 1710px) and 4437px (536px width). Screenshot ss_7597hjyeh shows the landing view stuck at June 2026.

**Repro:** Open /plan and wait for both queries to settle; the page rests at the top (coach panel + June), not today's week.

**Suggested fix:** Scroll the thread container directly (`el.parentElement.scrollTop = el.parentElement.scrollHeight` or scrollIntoView on the container with overflow anchoring) instead of document-level scrollIntoView; or only autoscroll the thread when it's already in view.


### U16. [important · visual] The desktop coach panel renders inline at the top of the mobile Plan page, filling the first viewport before the calendar, while the floating Coach pill + sheet duplicate the exact same surface.

**Surface:** Plan screen (mobile <1024px) · **Finder:** code-css

**Evidence:** plan.tsx:572-573 renders `<div className="plan-split-coach">{coachPanelEl}</div>` unconditionally; styles.css has no rule hiding `.plan-split-coach` below 1024px (only `.coach-pill` is display:none ABOVE 1024, styles.css:3530). Verified at 536px: panel rect {top:120, h:384} above the calendar plus visible Coach pill — screenshot ss_9832987a3. Duplicate mounted CoachPanels also duplicate DOM ids `proposal-<id>` (coach-panel.tsx:137), so focusProposal (plan.tsx:444-453) flashes the hidden inline copy, not the open sheet.

**Repro:** Open /plan at any width under 1024px.

**Suggested fix:** Hide `.plan-split-coach` under 1024px (the pill+sheet is the designed mobile surface), or drop the pill/sheet and keep one instance; ensure only one CoachPanel with `proposal-*` ids is mounted at a time.


### U17. [important · functional] A coach proposal that adds a session to an empty day is completely invisible on the mobile calendar — the agenda view hides the entire day cell, ghost included.

**Surface:** Plan calendar (mobile <=640px) x coach ghosts · **Finder:** code-css

**Evidence:** styles.css:830-832 (`@media (max-width:640px) .cal-day:not(.has-items):not(.is-today) { display:none }`) — `has-items` comes only from real workouts (plan.tsx:603 `day.items.length > 0`), while pending-proposal ghosts render inside that same `.cal-day` (plan.tsx:612-623). Verified live at 536px: an empty `.cal-day`'s computed display is `none`. Any `add` / `firmUp` / `createPlan` ghost dated on a workout-free day (styles.css:3506 `.cal-ghost-incoming`) is inside a hidden cell.

**Repro:** On a phone, have the coach propose adding a session to a day with no planned workout; the calendar shows no trace of it (approve/decline only findable in the sheet tray).

**Suggested fix:** Include ghost-bearing dates when computing the day's `has-items` class (e.g. `day.items.length > 0 || ghostsByDate.has(day.date)`).


### U18. [important · visual] The Next Workout dock panel has no height cap and covers the entire top-left HUD — condition word, weather, forecast, and the arrival beat lines with their dismiss/'See all' buttons are hidden and unclickable at common laptop viewport heights.

**Surface:** Garden desktop stage (>=1024px, short viewports) · **Finder:** code-css

**Evidence:** styles.css:1123-1156 (.hud-dock bottom-anchored, .dock-panel with no max-height/overflow) vs styles.css:1017-1026 (.hud-topleft). Measured at 1024x591 viewport: dock-panel rect {x:243,y:63,w:389,h:531} fully covers hud-topleft {x:243,y:75,w:321,h:87} — overlap confirmed true. Screenshot ss_3155cur9k: no condition word or forecast visible anywhere; the card also butts past the viewport bottom.

**Repro:** Open the garden in a >=1024px-wide window with ~700px or less of viewport height (1024x768 window, or a half-height window on any laptop) with the dock expanded (its default state).

**Suggested fix:** Give .dock-panel a max-height (e.g. calc(100dvh - 12rem)) with internal overflow-y auto, or auto-collapse the dock when the stage is short.


### U19. [important · visual] The coach panel's sticky positioning is dead code — the selector targets a child that doesn't exist, so scrolling the calendar leaves a giant empty left column.

**Surface:** Plan screen (desktop >=1024px) · **Finder:** code-css

**Evidence:** styles.css:3362 `.plan-split > .coach-panel { position: sticky; top: 0.8rem; }` never matches: the panel is wrapped in `<div className="plan-split-coach">` (plan.tsx:573), which has no CSS anywhere. Verified live: getComputedStyle(.coach-panel).position === 'static'. Screenshot after scrolling to August: the whole left grid column (~390px wide) is blank while browsing the calendar.

**Repro:** Open /plan on desktop and scroll to today's week; the coach panel scrolls away and dead space remains.

**Suggested fix:** Change the selector to `.plan-split > .plan-split-coach` (and put the sticky on the wrapper), or drop the wrapper div.


### U20. [important · visual] In dark mode the 'Needs you' proposal tray keeps its hardcoded cream background, making its amber heading (~2.2:1) and the pale-green 'and N more…' link (~1.8:1) unreadable, with dark proposal cards floating on a cream slab.

**Surface:** Coach proposal tray (dark mode) · **Finder:** code-css

**Evidence:** styles.css:3382-3386 `.coach-tray { background: #fffdf6 }` has no dark override. Verified computed styles under data-theme="dark": tray background stays rgb(255,253,246); `.coach-tray-head` color rgb(208,160,90) (--warn dark) and `.linklike` rgb(156,199,168) (--green-ink dark) — both far below 4.5:1 on cream; `.coach-prop` cards inside are dark --bg-raised rgb(33,36,34).

**Repro:** Enable dark theme, open /plan with any pending coach proposal.

**Suggested fix:** Replace #fffdf6 with a token (e.g. color-mix of --warn-soft and --bg-raised) that themes both ways.


### U21. [important · visual] The floating Coach pill ignores the safe-area inset, so on phones with a home indicator the bottom nav (z-index 40) covers ~25px of the 35px-tall pill (z-index 30), leaving a sliver to tap.

**Surface:** Plan screen (mobile, iPhone-class devices) · **Finder:** code-css

**Evidence:** styles.css:3516-3529 `.coach-pill { bottom: 4.2rem; z-index: 30 }` (no env() term) vs styles.css:198-209 `.bottom-nav { height: calc(58px + env(safe-area-inset-bottom)); z-index: 40 }`. Measured live with zero inset: pill h=35px, gap to nav top = 9px — any safe-area inset over 9px (iPhone portrait is ~34px) pushes the nav's top edge over the pill; the nav paints above it.

**Repro:** Open /plan in Safari on any Face-ID iPhone (or emulate safe-area-inset-bottom: 34px); the Coach pill is mostly behind the tab bar.

**Suggested fix:** bottom: calc(4.2rem + env(safe-area-inset-bottom, 0px)) on .coach-pill.


### U22. [important · visual] Opening the Timeline drops its panel directly on top of the open dock panel, covering the week ribbon and 'Minimize' at common laptop widths.

**Surface:** Garden desktop stage — timeline vs dock · **Finder:** code-css

**Evidence:** styles.css:1250-1255 (.stage-timeline centered, bottom ~4.6-6.5rem, width min(640px,58vw)) vs styles.css:1123-1156 (bottom-left dock, panel min(26rem,38vw)). Measured at 1024px width: timeline rect {x:320,y:484,w:594,h:86} overlaps dock-panel {x:243,y:63,w:389,h:531} (overlap=true); screenshot ss_7521o1qo7 shows the timeline slab sitting across the dock's week-ribbon dots and quest line. Geometry overlaps at all stage widths below ~1900px.

**Repro:** On the desktop garden with the dock open (default), click Timeline in the bottom-right rail.

**Suggested fix:** Auto-collapse the dock while the timeline is open, or offset the timeline to clear `min(26rem,38vw)` from the left.


### U23. [important · functional] Clicking a calendar ghost on desktop opens the mobile coach Sheet as a duplicate modal over the calendar — the code comments it as a visual no-op, but Sheet renders at every width — while the scroll-and-flash lands on the inline panel hidden behind the backdrop.

**Surface:** Plan calendar ghost tap (desktop >=1024px) · **Finder:** code-css

**Evidence:** plan.tsx:502-505 (`setCoachOpen(true); // no-op visually on desktop`) + components.tsx:406 (Sheet returns markup whenever open, no width guard) + plan.tsx:650 mounts the coach Sheet unconditionally; focusProposal (plan.tsx:444-453) uses getElementById on `proposal-<id>`, which resolves to the first (inline-panel) copy in DOM order, behind the sheet-backdrop (z-index 60, styles.css:2442).

**Repro:** With any pending proposal on desktop, click its green dashed ghost in a calendar cell: a centered 'Coach' dialog covers the calendar instead of highlighting the proposal in the always-visible panel.

**Suggested fix:** Only setCoachOpen on <1024px viewports (share the garden's useIsDesktop hook); scope focusProposal to the visible panel.


## Minors (polish) (22)


### M1. [minor · copy] '8 plants, 9 species.' pairs the living-plant count with the lifetime-unlocked species count, an impossible-sounding stat since only 4 species are currently living.

**Surface:** Garden readout copy (desktop below-stage line and mobile headline) · **Finder:** shots-garden

**Evidence:** garden-desktop.png ('Recent runs are keeping the soil moist and growing. 8 plants, 9 species.') and gm-00 crop of garden-mobile.png show the line; the collection itself (gm-05..gm-10 crops) shows living species are only Paper birch, Field poppy, Meadow grass, White clover (4), while 9 is the all-time unlocked codex count (5 species have 0 living plants). Cause: conditionStory at packages/ui/src/screens/garden.tsx:638-655 concatenates livingPlantsCount with species.length (call sites garden.tsx:1458/:1585-1590).

**Repro:** Read the garden condition line on either layout and count living species in the collection below it.

**Suggested fix:** Say '8 plants across 4 species' (living species) or '8 plants · 9 species collected all-time' to separate the two counts.


### M2. [minor · visual] Because the stage is height:100dvh but sits below an in-flow top banner, the bottom HUD rail (COLLECTION · 9/57, LOG, TIMELINE and '1 workout needs attention ↓') lands below the fold on initial load whenever any banner renders above it.

**Surface:** Garden desktop stage bottom HUD rail · **Finder:** shots-garden

**Evidence:** packages/ui/src/styles.css:978-982 (.garden-stage { height: 100dvh }) with the fixture banner (~46 CSS px tall) in normal flow above it (garden-desktop.png: banner spans y 0-53 CSS, stage extends to y≈993 CSS), so the stage's bottom ~46px — where .hud-corner/.hud-dock anchor 21-35px from the stage bottom (styles.css:1123-1126, 1203-1206) — is pushed past the viewport bottom until the user scrolls; garden-scrolled-desktop-wide.jpg shows the rail only after scrolling. In this stack the trigger is the fixture-mode banner, but any top-of-shell banner (sync/calendar warnings) reproduces it.

**Repro:** Load the Garden page on desktop with any banner rendered above the stage; the COLLECTION/LOG/TIMELINE rail and attention link are cut off at the viewport bottom.

**Suggested fix:** Size the stage as 100dvh minus the height of content above it (e.g. flex column with min-height:0, or height: calc(100dvh - banner height)), or overlay banners on the stage instead of stacking above it.


### M3. [minor · copy] Workout duration renders twice when the workout title already embeds it ('Easy Run 50 min' card shows a second '50 min' meta line).

**Surface:** Plan calendar workout cards · **Finder:** shots-plan-coach

**Evidence:** plan-mobile.png / plan-after-today-mobile.png WED 12: card title 'Easy Run 50 min' with meta line '50 min' directly beneath. Code: plan.tsx:357-359 renders w.title and then formatMinutes(w.workoutSeconds) unconditionally, so COROS-style titles that include the duration double it.

**Repro:** Any plan whose imported workout titles embed the duration (as the fixture's COROS plan does).

**Suggested fix:** Strip a trailing duration token from the title when it matches workoutSeconds, or omit the meta duration when the title already contains it.


### M4. [minor · visual] The coach-read loading state is a bare spinner with no visible text, for a wait the code itself says can run 'up to a couple of minutes'.

**Surface:** Activity › Coach's read · **Finder:** shots-rest

**Evidence:** Screenshots activity-coach-read-desktop.png / activity-coach-read-mobile.png: the read panel between the two adventure cards is an empty grey box with a small unlabeled spinner. packages/ui/src/screens/coach-read.tsx:24-30 renders `<Spinner label="The coach is reading this effort…" />`, but Spinner (packages/ui/src/components.tsx:336-343) puts the label in a `.visually-hidden` span — sighted users get zero indication of what is happening or that a first read is slow (the comment at coach-read.tsx:9-10 says first reads take up to a couple of minutes).

**Repro:** Click '✨ Coach's read' on any activity whose read is not yet cached.

**Suggested fix:** Show the label text visibly in the coach-read panel during the pending state (e.g. 'The coach is reading this effort — first reads can take a minute or two').


### M5. [minor · copy] Multi-hour adventures show raw minute counts ('240 min') instead of an hours format, a seam of the new adventures feature feeding long durations into a runs-era formatter.

**Surface:** Activity list (adventures) · **Finder:** shots-rest

**Evidence:** Screenshot activity-adventures-desktop.png: Ridgeline Loop (4h hike) reads '240 min  15.8 km · 9.8 mi'. Cause: packages/ui/src/components.tsx:24-27 `formatMinutes` always returns `${Math.round(seconds/60)} min`, used at packages/ui/src/screens/runs.tsx:252; runs rarely exceed ~113 min so this never mattered before adventures.

**Repro:** View any adventure over ~2 hours on /runs.

**Suggested fix:** In formatMinutes, switch to 'Xh Ym' at >= 90 or 120 minutes (Insights already has formatHours in charts-math.ts to mirror).


### M6. [minor · functional] A failed or still-loading /today query makes the garden assert "No active training plan" and "plan paused" (and silences the dryness forecast) with no loading or error signal.

**Surface:** Garden page — dock pill / run balance bar when /today is slow or failed · **Finder:** code-garden

**Evidence:** packages/ui/src/screens/garden.tsx:1400-1406 renders the dock pill "No active training plan" whenever `d?.nextWorkout` is falsy — including today.isLoading/isError, which are never checked anywhere; garden.tsx:1020 sets planActive=false, freezing the run clock caption to "plan paused" (garden.tsx:254) and freezing its projected decay (garden.tsx:1023-1027), and ForecastLine returns null on `!nextWorkout` (garden.tsx:499). Mobile additionally drops the whole workout section silently (garden.tsx:1613-1619 requires `d`). Only garden.isLoading gates the screen (garden.tsx:912).

**Repro:** Load the garden with /api/plan/today failing (network blip; the route is DB-only so this is transient) or resolving after /api/garden: the pill claims no plan exists while the fixture plan runs through October.

**Suggested fix:** Gate the pill/caption on today.isSuccess and show a neutral loading/error state ("Plan unavailable — retrying") instead of the definitive no-plan copy.


### M7. [minor · functional] The week ribbon marks any adventure-sport activity day, including efforts below the engine's threshold that earn the garden nothing (e.g. a 20-min walk), contradicting the weekly "Adventure ✓" which counts only qualifying adventures.

**Surface:** Garden page — week ribbon adventure marks · **Finder:** code-garden

**Evidence:** packages/ui/src/screens/garden.tsx:574-582 builds adventureDates with `isAdventureSport(a.sport)` alone and applies the `week-day-adventure` class at garden.tsx:613, while the engine requires load ≥ 40 or duration ≥ 45min (packages/garden-engine/src/adventure.ts:29-32; simulate.ts:252) — the fixture's 20-min Wed Aug 5 walk gets a ribbon mark on its week but emits no adventure_logged, no shield, and no weekDisciplines.adventure, so BalanceDetail's week line (garden.tsx:400-401) shows no "Adventure ✓" for the same week.

**Repro:** Log a 20-minute walk on any day of the current week and open the garden: the day carries the adventure mark, but the balance detail week line and the garden log show no adventure credit.

**Suggested fix:** Filter adventureDates by the same qualifiesAsAdventure threshold (duration is available on ActivityDto; export the check from the engine or domain).


### M8. [minor · functional] A region expansion is celebrated twice: as a "Today" text line on the day it happens (preview), then again as a full ground ceremony the next day when the durable row lands — grounds have no celebrated-dedupe like species do.

**Surface:** Garden page — region expansion celebration · **Finder:** code-garden

**Evidence:** packages/ui/src/screens/arrival.ts:188-191 builds ground ceremonies from durable `fresh` events only, while the preview region_unlocked event passes notConsumed (arrival.ts:196-201, groundCeremonies is empty that day) and flows into todayLines as "Long runs carved the stream — new ground, new water."; species avoid this via celebratedSpeciesIds (arrival.ts:180, 214-224) but nextSeen records nothing for grounds, so the next day's durable region_unlocked row (now after the watermark) fires the CeremonyCard for the same expansion.

**Repro:** Complete a run that pushes living plants past 75% capacity (region unlock) and view the garden the same day, then again the next day.

**Suggested fix:** Emit ground ceremonies from preview events too (fromPreview like species) and record celebrated grounds in the seen state, or suppress the preview today-line for region_unlocked.


### M9. [minor · copy] ForecastLine's RUN_CATEGORIES omits cross_training, so it can warn "Rain needed by Friday" when Friday's planned cross-training session would in fact reset the rain clock.

**Surface:** Garden page — forecast line vs planned cross-training · **Finder:** code-garden

**Evidence:** packages/ui/src/screens/garden.tsx:428 defines RUN_CATEGORIES without cross_training and garden.tsx:500-501 uses it for runComing; but the engine classifies a planned cross_training workout as discipline "run" (packages/analytics/src/discipline.ts:54-58 falls through to "run"; garden-sync.ts:194) and completing it lands in plannedRuns, zeroing daysSinceCompletedRun and turning the weather to rain (simulate.ts:247-249, 318-322, 402-409).

**Repro:** Have daysSinceCompletedRun near drynessStartDays with the next scheduled workout a cross-training day inside the threshold: the forecast shows the dryness countdown as if nothing planned averts it.

**Suggested fix:** Add cross_training (and keep the set in sync with the engine's disciplineOf) or derive runComing from the shared discipline helper instead of a local category set.


### M10. [minor · copy] The rare-visitor (and anniversary) lead sentence is duplicated verbatim in two adjacent paragraphs whenever overnight beat lines exist — it is prepended to BOTH the "Since …" and the "Today" line.

**Surface:** Garden page — arrival beat / today lines · **Finder:** code-garden

**Evidence:** packages/ui/src/screens/garden.tsx:1004-1008: `beatLinesAll = [...leads, ...beatLines]` when beatLines is non-empty, and `todayLinesAll = [...leads, ...todayLines]` whenever leads is non-empty — so with a visitor plus any overnight beat, both paragraphs render the identical visitor sentence back-to-back (desktop garden.tsx:1293-1330; mobile garden.tsx:1571-1583). With beat lines present and NO today lines, the "Today" paragraph renders solely to repeat the lead already shown one line above. The comment at garden.tsx:1001-1002 says the lead should head "whichever arrival line is showing", i.e. one of them.

**Repro:** Any day where selectArrival yields fresh overnight beat lines and the payload carries a visitor (or anniversary): both the "since" and "today" paragraphs open with the same sentence.

**Suggested fix:** Prepend leads to exactly one target: the today line if it will render, else the beat line (or vice versa).


### M11. [minor · functional] Ghost tap opens a redundant modal Coach sheet on desktop (the code comments claim it is a visual no-op there), and a ghost belonging to the 5th+ pending proposal never scrolls or flashes because the tray caps at 4 cards.

**Surface:** Plan calendar ghosts · **Finder:** code-plan-coach

**Evidence:** plan.tsx:502-506 `onGhostTap` always calls `setCoachOpen(true)`, and the Sheet at plan.tsx:650 renders at all viewport widths (Sheet is a centered dialog on desktop, components.tsx:390-433; styles.css:2479-2488), so desktop ghost taps pop a modal over the calendar instead of flashing the panel card. `focusProposal` (plan.tsx:444-453) finds nothing when the target proposal is beyond TRAY_CAP=4 with showAll=false (coach-panel.tsx:17,193-207), so those ghosts neither scroll nor flash anything.

**Repro:** With 5+ pending proposals, click a calendar ghost tied to the 5th proposal: on desktop an unexpected Coach modal opens showing only the first 4 cards and no highlight; nothing indicates which proposal the ghost referred to.

**Suggested fix:** Skip setCoachOpen on >=1024px, and have focusProposal first expand the tray (lift showAll) before looking up the card.


### M12. [minor · functional] When the coach-state query fails, the mobile Coach pill still shows and opens a completely empty sheet with no fallback message.

**Surface:** Coach pill / sheet (mobile) · **Finder:** code-plan-coach

**Evidence:** plan.tsx:647-666: the pill renders unconditionally and the Sheet body is `{coach.state.data ? <CoachPanel .../> : null}`, so a failed ['coach-state'] query yields a blank dialog; the desktop column at least renders the 'The coach is unreachable — manual controls all work.' fallback (plan.tsx:539-548).

**Repro:** Block /api/coach/state, open /plan at <1024px, tap the Coach pill: an empty sheet titled 'Coach' opens.

**Suggested fix:** Reuse the desktop fallback copy inside the sheet when state.data is missing.


### M13. [minor · functional] Auto-scroll stops working once the thread reaches the server's 30-message window, because the scroll effect keys on messages.length which pins at 30.

**Surface:** Coach thread · **Finder:** code-plan-coach

**Evidence:** coach-panel.tsx:212-215 depends on `[messages.length]`; apps/worker/src/routes/coach.ts:83-88 caps the state response at the latest 30 messages, so after 30 exist a refetch that brings a new coach reply replaces the array at the same length and the effect never fires — the reply renders below the fold of the thread container. The receipt-stacking bug above makes hitting 30 quick. There is also no way to page older messages from the UI even though the route supports `?before=` (coach.ts:78, api-client index.ts:562).

**Repro:** Accumulate 30 messages, press Check in, and wait for the briefing: it arrives off-screen at the bottom of the thread without the view moving.

**Suggested fix:** Key the effect on the last message id (e.g. `messages[messages.length-1]?.id`) instead of length.


### M14. [minor · visual] The 'Needs you' tray and pending-day tints use hardcoded light-only colors, rendering as bright cream blocks in dark mode.

**Surface:** Proposal tray / calendar ghosts (dark theme) · **Finder:** code-plan-coach

**Evidence:** styles.css:3385 `.coach-tray { background: #fffdf6 }`, styles.css:3351 `.pill-lift { background: #f4e6da; color: #b5652f }`, styles.css:3493 `.cal-pending { background: #fbf9ef }` — all fixed light values while the app fully themes dark via variables (styles.css:58-100), so in dark mode the tray is a near-white band containing dark `--bg-raised` proposal cards.

**Repro:** Enable dark mode and open /plan with a pending proposal: the Needs-you tray shows as a bright cream panel inside the dark coach panel.

**Suggested fix:** Replace the hardcoded values with theme variables (e.g. a `--warn-soft`-derived tray background) or add dark-mode overrides.


### M15. [minor · functional] previewToday folds unresolved days as plain no-run decay days, contradicting its own "unresolved days neutral" spec — a lagging COROS sync briefly shows the garden drier than the durable sim will ever record.

**Surface:** Garden page — same-day preview fold · **Finder:** code-worker

**Evidence:** apps/worker/src/services/garden-sync.ts:654-657 states the fold treats "resolved days as recorded, unresolved days neutral"; the code (garden-sync.ts:603-627) calls buildDayInput for every gap day regardless of resolution, and an unresolved-workout day yields empty completedRuns/missedRuns, which simulateDay treats as an ordinary missed-nothing day: daysSinceCompletedRun += 1 plus applyDailyDecay (packages/garden-engine/src/simulate.ts:330-333). The neutral fallback only applies when buildDayInput throws (garden-sync.ts:611-620). The durable sim's grace rule (garden-sync.ts:395-397) deliberately waits for resolution to avoid exactly this misread.

**Repro:** Run yesterday with the bridge offline; open the garden today before it syncs. The preview snapshot has advanced the drought clock 2 days (weather flips to dry_spell/light_clouds once the streak crosses drynessStartDays=4) — then the sync lands and the same days replay as rain. Bounded at ~2 days normally, up to 14 after a durable-sim outage.

**Suggested fix:** In previewToday, check dayFullyResolved for each gap day before today and fold unresolved ones with a truly neutral input (planGap-style: no decay, no credit), matching the documented contract.


### M16. [minor · functional] The adventure-shield caption is computed from pre-preview state, so when an intermediate preview day consumes the last banked grace day the caption claims today is sheltered while the rendered scene took decay.

**Surface:** Garden page — adventure shield caption · **Finder:** code-worker

**Evidence:** apps/worker/src/services/garden-sync.ts:648-652 captures shieldState (adventureGraceDays, lastAdventureDate) before the preview fold, and :737-754 computes `graceDay` for today from that stale bank; but the preview fold itself decrements the bank on an intermediate shielded day (packages/garden-engine/src/simulate.ts:266-268), so the post-preview snapshot the page renders applied decay today (bank exhausted) while `adventure.graceDay` reads true from the pre-preview bank of 1.

**Repro:** Big adventure Saturday (banks 1 grace day), no dailyHealth rows for Sunday/Monday (the recovery-score branch must be absent), Sunday's workout unresolved so the durable sim stops at Saturday. Monday's GET /api/garden: the preview folds Sunday (grace day, bank 1→0) then Monday (bank 0 → decay), but adventure.graceDay=true — the caption says today is sheltered by Saturday's hike over a scene that just dried. Not reachable in the current fixture (recovery scores exist daily: Aug 9=42, Aug 10=60, verified live on port 8899), but reachable whenever health data is missing for the gap days.

**Suggested fix:** Compute the caption's graceDay from the preview cursor's state as of the start of today (e.g. have previewToday also return the pre-today cursor state), instead of the pre-fold durable state.


### M17. [minor · functional] One Escape press closes both stacked dialogs at once (species sheet AND the Collection drawer beneath it), dumping the user's browsing context.

**Surface:** Garden desktop stage — stacked dialogs · **Finder:** code-css

**Evidence:** components.tsx:353-363 — every mounted useDialogFocus instance registers its own document keydown and closes on any Escape with no topmost-only guard. Reproduced live: Collection drawer + codex-card sheet open, one Escape keydown → both `.drawer` and `.sheet` unmounted. The unconditional cleanup `document.body.style.overflow = ""` (components.tsx:384) also unlocks page scroll if only the inner dialog closes.

**Repro:** Desktop garden: open Collection, click any species, press Escape.

**Suggested fix:** Keep a module-level dialog stack; only the top-of-stack instance handles Escape, and restore body overflow only when the stack empties.


### M18. [minor · visual] Several new tap controls are 20-27px tall on mobile, well under the 40px floor: coach answer chips 24px, calendar ghost buttons 20px, ceremony dismiss 21px, activity filter chips 27px, Coach pill 35px.

**Surface:** Mobile touch targets (coach + adventures + ceremony) · **Finder:** code-css

**Evidence:** Measured rendered heights on the fixture stack: .chipbtn 24px (styles.css:3475-3482, padding 0.22rem), .cal-ghost 20px (styles.css:3494-3505, padding 0.1rem, font 0.7rem), .ceremony-close 21px (styles.css:1416-1425, padding 0.25rem around a 13px icon), .chip/.chip-adventure 27px (styles.css:451-463), .coach-pill 35px (styles.css:3516). All are primary mobile actions (answering the coach, reviewing a proposal, dismissing a ceremony).

**Repro:** Any phone: tap the coach question chips or a calendar ghost.

**Suggested fix:** min-height: 40px (or expanded ::after hit areas) on chipbtn, cal-ghost, ceremony-close, and the discipline chips.


### M19. [minor · visual] The adventure ring on a week-ribbon day is a 33%-alpha gold shadow that is nearly invisible in dark mode, and it also reshapes the day dot into a circle so it collides with the today outline instead of reading as a distinct marker.

**Surface:** Week ribbon adventure marker (garden dock / This week card) · **Finder:** code-css

**Evidence:** styles.css:1479-1482 `.week-day-adventure { box-shadow: 0 0 0 2px var(--adventure-ring, #b8a06a55); border-radius: 50%; }` — `--adventure-ring` is defined nowhere (grep: only this line), so the #b8a06a55 fallback always applies; at 33% alpha over dark --bg-raised (#212422) the ring is ~1.2:1 against its background. `.week-day-today .week-day-dot` (styles.css:1475-1478) adds a green outline at 1.5px offset that lands in the same 2px band on an adventure+today day.

**Repro:** Log a hike during the current week and view the week ribbon in dark mode — the shield marker for the adventure is effectively invisible.

**Suggested fix:** Define --adventure-ring per theme at full alpha (light gold on dark, deep gold on light) and drop the border-radius override or apply it to a dedicated halo element.


### M20. [minor · visual] Two more coach-merge hardcodes ignore dark mode: the '+ extend plan' row keeps light-beige candy stripes with 2.8:1 grey text, and the Lift pill stays a cream chip on dark cards.

**Surface:** Plan calendar extend row + Lift pills (dark mode) · **Finder:** code-css

**Evidence:** styles.css:3550 `.cal-extend-row` background stripes hardcode #f3f0e7 (verified computed under data-theme=dark: stripes stay rgb(243,240,231) with text rgb(125,129,123) — the --ink-faint dark value against a light stripe); styles.css:3351 `.pill-lift { background:#f4e6da; color:#b5652f }` has no dark variant (verified unchanged in dark).

**Repro:** Dark theme, /plan with an active coached plan (extend row under the calendar) or any Lift proposal/plan pill.

**Suggested fix:** Swap both to tokens (e.g. stripes from --bg-sunken/--border, pill from a color-mix on #b5652f like .studio-card does).


### M21. [minor · visual] Coach message bubbles have no overflow-wrap, so a long unbroken token (a URL or workout ID from the LLM) forces the whole thread into horizontal scrolling.

**Surface:** Coach thread bubbles · **Finder:** code-css

**Evidence:** styles.css:3417-3424 (.coach-msg — no overflow-wrap/word-break; verified computed overflowWrap:'normal') inside .coach-thread { overflow:auto } (styles.css:3408). The body span is white-space:pre-wrap (coach-panel.tsx:230), which wraps only at whitespace.

**Repro:** Have the coach (or the user) send a message containing a long URL on a 390px phone; the bubble widens past 92% and the thread pans sideways.

**Suggested fix:** Add overflow-wrap: anywhere (or break-word) to .coach-msg.


### M22. [minor · visual] At 1024-1200px stage widths the centered ceremony card (z-index 2) overlaps the balance-bar detail popover that opens under the top-right instrument cluster, covering its close button region.

**Surface:** Garden desktop stage — ceremony vs balance detail · **Finder:** code-css

**Evidence:** styles.css:1433-1439 (.hud-ceremony left 54%, translateX(-50%), max-width 24rem from :1296, z-index 2) vs styles.css:1180-1190 (.balance-detail-hud width 320px anchored right under .hud-topright, no z-index). At a 1024px stage the ceremony spans x~361-745 and the detail x~678-998 from y~175 — a ~67px interactive overlap where the ceremony paints on top (its z-index 2 beats the detail's auto).

**Repro:** Arrive with a fresh species unlock (ceremony showing), then click a balance bar top-right at a ~1024-1200px window.

**Suggested fix:** Give .balance-detail-hud a higher z-index than .hud-ceremony, or cap the ceremony's left position so it clears right-side panels.
