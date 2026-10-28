# The watch mirrors the plan — design

Date: 2026-10-28. Status: **approved by the owner** (§10). Follows `2026-10-27-workout-editability-design.md` (adoption, `watch_copy_name`) and `2026-09-30-phase-3-watch-design.md` (the sent-session lane, its stamps and invariants). Builder check: `.superpowers/sdd/2026-10-27-workout-editability/mirror-builder-check.md` (its corrections are folded in below as A1–A9; its calls as M1–M7).

## 1. Intent

The owner: "can't we make it so coros watch is just always synced by default?", "we should be able to change any session if we want", and (10-28) "the watch should always be replaced. if I skip it it should remove it. the watch should have parity." The app is the source of truth; the watch mirrors it, without being asked.

**The rule — parity.** Every scheduled session of a kind the watch can hold is on the watch in its current version. When a session appears, changes, moves, is skipped or goes, its watch copy follows. Nothing waits for a Send; on the day, every change replaces the copy. The athlete can keep a session off the watch, and that choice is honoured. Nothing is ever deleted on a maybe: every write keeps the stamp-and-address proof the lane has today.

## 2. Today, and why it is two rules

Two lanes with different rules (recon 2026-10-28):
- The coach's structured lane pushes its own `cw-` sessions ahead of the day (`coach_create_workout`), converges rewrites, moves copies.
- The document lane pushes a Studio/template/adopted workout only on its day, only by the athlete's Send, from the day's locked build (`program_session_push`), because the day's reading can close a move and swap an alternate. A preview for a day ahead is version 0, overwritten in place, never sent. App-authored rows are never re-dated on the watch. Send/Keep decides older copies; `cant_rewrite` for app-authored rows.

Those rules were right for a feature behind a switch awaiting the first real push. The switch is on, the push works, and the owner wants one rule.

## 3. Decisions

### 3.1 What is mirrored
- **Document workouts** (`studio`, `template`, adopted): ahead of the day, a **provisional copy** built from the document as the sheet's preview is (no day reading); on the day, the day's build replaces it when it differs, and every later change on the day replaces it again (§3.3).
- **The coach's own sessions** (`cw-`, origin NULL) and **designed runs**: unchanged — their lane already mirrors ahead of the day. When one is adopted it joins the document rule (§3.5).
- **Engine slots** (`program`, `on_demand`): outlines until the day; on the day, once built and checked, pushed without asking (§3.3). Nothing ahead of the day.
- **Not mirrored:** rest days, races, done/completed/missed sessions (a done session's copy stays), Start-now and played-offline rows (M5), sessions the watch cannot hold (the lane's existing refusals, shown as the row's watch state), and sessions kept off (§3.6).

### 3.2 The provisional copy (ahead of the day)
- Made for a document workout that is created, revised (incl. adoption), moved to another day, un-skipped, or found by the sweep (§3.7), within the mirror window **today … today + 28 days**.
- Content: the document materialised as the preview is (`materializeDocBuild`, checks `{}`), turned into watch steps by `watchStepsFromBuild`; stamp by `programStamp` (title — day, " (2)" on collision).
- **The record (A1).** A provisional copy is a `session_builds` row with a **negative version** (−1, −2 … per workout) and `kind: "provisional"` in its payload, carrying `fromDoc.rev`. It is **never locked**: `locked_at` means "started or sent on the day" to the sheet, Start, the body check, Today and the save, and a locked provisional record would hide Move/Skip/Start and stop the day's build. A negative version passes `(workoutId, version)` uniqueness, sorts below every day build, is invisible to every `version === 0` / `version > 0` reader, and `pruneBuilds` spares it. Only the readers that mean "on the watch" learn the marker: `sentBuildIdOf` (made deterministic: the day's build wins over a provisional record when both are live), `sessionsOnWatch`, the quick review, key-result measures, the owed-unpush write/read, `unlockSentBuild` (which clears the marker instead for a provisional record). Play, Start and check readers stay as they are. A provisional record is never mutated once its push is queued; a newer document revision or day makes a new record.
- **The job:** `program_session_push`, `happenDay` = the session's day, `provisional: true` in the payload. **Claim (A2):** keep malformed/archived/moved/`sent !== buildId`/resolved/writes-off/switch-off/catalog/`already_present` checks; change `happenDay !== today` to `happenDay < today` for a provisional push; skip `gatedAtClaim` for it (a preview was never gated); a row kept off (`watch_off`) supersedes at claim.
- **One copy per session:** a new provisional push is preceded by the previous copy's delete (`unpush:<old>`, or `<id>-unpush-copy` for an adopted row's held copy). Either order of landing is safe (A6): the old copy's stamp stays claimed by its `verified` push until its delete verifies, so the import neither moves the row back nor inserts a duplicate.
- **Where the record is made (M2):** the request that changes a session does only the cheap writes — supersede queued jobs, queue the old copy's delete, mark the row **mirror-owed** — and the drain or the sweep makes the record and its payload when it claims the work. Approve, Studio save, calendar drags and switch-on keep their budgets.
- **Today's provisional push (M1):** a session for today whose check is already answered pushes the day's gated build instead; with no answer yet, the provisional copy.

### 3.3 On the day — replace on every change (owner, T1)
- When the day's build is made (Today, the sheet, Start — as today) and its pre-check answered, the app compares its watch steps (`session.steps` of the would-be payload — never `pushDigest`, which hashes the build id, day and stamp; never COROS's observed fingerprints, which are COROS's encoding) with the copy's steps:
  - **same (A3)** → a **D1 hand-over, no COROS write**: lock the day's build; insert `push:<dayBuildId>` as `verified` carrying the provisional push's stamp, `happenDay`, `observed` and `renamed`; clear the provisional record's marker and settle its push. That order keeps one stamp claimed throughout.
  - **different** → the old copy's delete and the day build's push are queued (two jobs), the day build locked as Send locks it today.
  - **blocked** (the day's reading closes a move with no alternate) → the copy stays; the row's watch state says the day's check closed it.
- **Every later change on the day** (a new reading swapping a move, another length, place or mode, a revision) replaces the copy again: delete + push, two jobs. The sent lock moves to the newest pushed build; Start plays the day's current build (A9).
- Engine slots: the day's build, once made and checked, is pushed the same way (no provisional copy, so no delete).
- No build yet on the day: the provisional copy stays.

### 3.4 Changes, moves, skips, removals
- **Revise / adopt:** the old copy's delete + a new provisional push — replaces Send/Keep for app-authored rows (`cant_rewrite` goes).
- **Move to another day (A4):** through the shared `applyMove` (every source: Plan, calendar drag, sync-note undo, the coach's applier): the old copy's delete (for an adopted row, `adoptedCopyUnpush`) + a provisional push for the new day. The row's `content_state` still becomes an outline (that only means "no build for this day"; the document and title are kept, as today). A time-only change writes nothing. "Updating your watch…" is derived from the queued job, not from `coros_sync_state` (which `applyMove` sets to `calendar_only`). Engine slots keep today's rule. *(Correction to editability §4: a Plan move of an adopted row never moved its old copy; now it deletes it.)*
- **Skip (owner, T2):** the copy comes off (`unpush`), even ahead of the day. **Un-skip / restore:** a provisional push again if its day is today or ahead. The hooks live in the shared skip/unskip services so the coach lane's code stays untouched.
- **Remove / Stop this plan / a week re-plan:** unpush, as today.

### 3.5 Ownership of COROS-plan sessions
A session imported from a COROS plan is COROS's until the athlete or the coach changes it in the app (adoption). On adoption the held copy's delete (by `watch_copy_name`) and the new provisional push are queued at once. `cannot_unpush_imported` stays for rows never adopted.

### 3.6 The athlete's say
- **"Keep off my watch"** (A8, M4) replaces "Take off watch" on app-built sessions: it takes the copy off AND sets `planned_workouts.watch_off = 1` (migration 0033), which the mirror honours (sweep, drain, claim); "Put on my watch" clears it. Not offered on a done session. It is a third thing beside the existing marks: **Leave** (`watchVersionLeft`, app rows) means nothing under the mirror and its marks are dropped; **Keep** (`keepWatchVersion`, the coach's rows) stays on the Plan's coach-row sheet. An app row's open content claims resolve when its new copy verifies, so "Older on watch" cannot linger.
- **The switch.** `prefs.corosWritesEnabled` gates every mirror write. Its Settings row becomes "Keep my watch in sync with the plan" with one line: "Sessions go to your watch as the plan changes; COROS's own sessions stay yours." Off: nothing is queued; owed unpushes recorded as today; the sweep catches up when it comes back on. `WATCH_PUSH_ENABLED` stays the global kill switch.

### 3.7 The sweep and throughput (A5)
- **One watch job per invocation** is the Workers Free limit (a push drain measures 22 D1 + 9 COROS ≈ 31–34 of 45; an unpush 29). The hourly cron drains **one** watch job, as today; the **mirror sweep** is the cron's one heavy step (competing with the drain), and it makes **one** record per run (≈10 statements), soonest day first. A replacement is two jobs, so N changes take 2N drains or hours.
- **Drains.** Every app action that queues a watch job drains one at once, and while the sheet or Today is open the client **chains** drains (one job per request) until nothing is pending — "Updating your watch…" meanwhile. The sheet's targeted drain takes provisional pushes and both delete kinds.
- **A current copy (A7):** a push exists for this revision **and this day** that is in flight, or verified with the row still holding its address; a copy moved in the COROS app (the row followed it) counts. Otherwise the sweep pushes: that covers a move, and §3.8's re-push after the copy went missing. A push that failed for good is re-queued by the sweep with a backoff and a cap (M3).
- `push-absent` keeps its role for the coach's lane. Budget pins: ≤45 statements per request; the lane's per-run fetch pin.

### 3.8 Import
- A provisional copy is a stamped app push: the import claims it by stamp (`pushByStamp`/`verifiedPushOf`), records renames, follows moves made in the COROS app, and clears the address after two reads without it — after which the sweep re-pushes (the "Removed from your watch" note is skipped for a row the sweep will push).
- "Changed in COROS" → the app keeps its version and the sweep replaces the copy on its next pass; one sync note.
- **M7:** the import's generic job-verify (`pendingJobByWorkout` → `reconcileWorkout` verifying a job when COROS shows the copy on its destination day) excludes a programme row's push and unpush jobs, so a COROS-side move can never mark a queued mirror push verified.

### 3.9 The UI
- The session sheet's watch line is a **status, not buttons**: "On your watch" · "Updating your watch…" · "Sending to your watch…" · "Couldn't reach COROS — retrying" (the sweep's retry; a Retry button re-queues without a digest, M6) · "Not on your watch: <the lane's reason, incl. 'Too long for the watch'>" · "Kept off your watch" (Put on my watch) · the day's "closed by today's check". Send, Keep, Leave, the adopted-copy wording and `watchHoldsOldCopy` go. The watch preview stays as a read-only "what's on your watch" view behind the line (M6). Today's "On your watch" shows for a provisional copy too (A9).
- The Plan's sync pill follows the same states. The account line becomes "N sessions updating on your watch" while jobs are queued, else nothing.
- The Settings row wording (§3.6).

## 4. Invariants kept
No write without a stamp; deletes triple-addressed and re-proven at claim; one copy per session (the delete precedes the push); writes off → nothing queued, cleanup still runs; the import never rewrites an app-authored row's content; done sessions keep their copy; the Workers budgets (one watch job per invocation); no personal data in fixtures; tests pin the clock; the thread coach's own code untouched (hooks in the shared `applyMove`, skip/unskip, `removeFromPlan`, the sweep).

## 5. Non-goals
Pushing programme slots ahead of the day; re-dating a copy in place on COROS; pushing with writes off; syncing performed sessions; the thread coach lane's own code; a COROS-plan session never adopted.

## 6. Rollout
Lazy and bounded: the sweep pushes at most one session an hour, soonest first; drains while the app is open go faster. On the owner's account today: zero Studio rows ahead, the coach's `cw-` rows already on the watch, the COROS-plan rows untouched until adopted — the first provisional pushes come from the next revise/adoption or Studio add. The Settings row's new wording ships with it; the switch keeps its value. Live verification: a Studio workout added for a day ahead appears on the watch after the drain; revised → replaced; moved → moved; skipped → gone, un-skipped → back; "Keep off my watch" → gone and stays gone; a day's gating → replaced on the day; a same-day change → replaced again.

## 7. Tests (what pins it)
The provisional record (negative version, marker, never locked, spared by prune, invisible to day readers; `sentBuildIdOf` prefers the day build); the claim (provisional allowed ahead, `< today` superseded, `gatedAtClaim` skipped, `watch_off` supersedes); the day comparison on steps (same → D1 hand-over with one stamp, no COROS fetch; different → delete+push; blocked → stays); every later change on the day replaces; move via `applyMove` from each source (delete + new-day push, document kept, pill from the job); skip → unpush, un-skip → push; adoption → held-copy delete + push; Keep off honoured by sweep/drain/claim, Leave marks dropped, Keep kept on coach rows; the sweep's current-copy test (move, absence, failed push backoff), its window and one-per-run, nothing with writes off; the import's claim by stamp through the delete/push window, re-push after absence without the note, M7's exclusion; the drains and the client chaining; budgets (statements per request, fetches per run); the old pins rewritten (`not_today` stays for a non-provisional push; "a push for another day is superseded" → "a day gone, or not provisional"; "a day ahead: no Start" stays plus the status line); UI states; Settings wording.

## 8. Left to the builder
The negative-version numbering; the exact steps comparison (normalise what `watchStepsFromBuild` emits); the sweep's backoff schedule and cap; wording of the status line's refusals; the client's chaining stop rule (nothing pending, or an error).

## 9. Corrections to earlier docs
Editability design §4: a Plan move of an adopted row did not move its old copy (no move job is made for app-authored rows); this design makes the move delete it.

## 10. Owner answers (2026-10-28)
1. On the day, after the session is on the watch, a change in the app replaces the copy every time ("the watch should always be replaced").
2. A skip takes the copy off; un-skip puts it back ("if I skip it it should remove it. the watch should have parity").
