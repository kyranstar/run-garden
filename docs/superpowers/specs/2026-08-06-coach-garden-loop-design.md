# The Coach × The Garden — Fair Incentives (phase 3 of 3)

*2026-08-06 · Completes the coach design suite (`2026-08-06-coach-ux-design.md`, `2026-08-06-coach-intelligence-design.md`). Locked decisions: sanctioned rest bounded at **1 per rolling 7 days**, **actual work counts**, coach **speaks the garden's language**, and completing a coached block **earns a species**.*

## Principle

The garden reflects the **agreed** plan, honestly. When you and the coach agree to rest, resting is keeping the plan — not breaking it. But the ledger never lies: easy work earns easy credit, skipped work earns no growth, and mercy is bounded so adaptation can't become a loophole. Canon holds: the garden asks, never accuses; same inputs always replay the same garden.

## 1. Sanctioned rest (approved `skip` proposals)

When a coach `skip` proposal is approved, the workout resolves as `coach_sanctioned` (a new resolution flavor on the existing skip path — recorded on the workout row, so it flows into `gardenDayInputs` and replays deterministically).

The day-input builder (worker-side; **engine unchanged, no version bump for this part**) then decides:

- **First sanctioned skip in any rolling 7 days** → the day becomes `restObserved` (gentle sun, soil +0.01, run clock paused — identical to a planned rest day honored). The garden log line: *"A rest day, on your coach's advice."*
- **Further sanctioned skips inside the same rolling week** → **neutral**: the workout is simply absent from `missedRuns` (no −0.06 moisture debt, no per-plant hydration hit), but the day is an ordinary no-run day — normal decay applies, the clock advances. No debt, no gain.
- **Unsanctioned skips are untouched** — manual skips still resolve `missed_run` with today's dryness debt.

The cap is computed from resolution rows (pure SQL over a 7-day window), so replay is exact. The coach's dossier shows sanctioned-rest usage ("1 of 1 mercy day used this week") so it never proposes a skip whose garden treatment would surprise anyone — and the proposal card's reason states the treatment plainly ("counts as a rest day" / "the garden will simply pause").

## 2. Eased and moved work: the honest ledger

- **Actual work counts.** An eased tempo completed as an easy 40 advances easy-run counters; species gates keep their meaning. No synthetic quality credit, and symmetrically **no penalty**: the consistency chain counts completions, so a coached easing never breaks a week; a coached `move` changes `effectiveDate` through the existing machinery (the unresolved-reset + garden-input paths already handle moves).
- Nothing here touches the engine: the garden already scores what actually happened.

## 3. The coach speaks garden

- Dossier §Milestones expands to a compact **garden line**: condition word, weather, days-since-rain, consistency chain, and the single nearest unlock nudge (the same `nextUnlocksByDiscipline` data the garden screen uses).
- Prompt guidance: diegetic references are welcome and **sparing** — at most one garden reference per briefing, always tied to a concrete action ("an easy 30 tomorrow brings the rain back"), never guilt-toned, never during rest mode or taper (the one-loss-voice rule extends to the coach: if the garden screen is already speaking a loss line, the coach doesn't pile on — the dossier carries the current forecast stage so it can tell).

## 4. Coached-block species

- New engine gate kind `{ kind: "coached_blocks"; count: n }` over a new counter `coachedBlockCount`, fed by a new day-input field `coachedBlockCompleted?: boolean` — set by the worker on the day a coached plan reaches `completed` with **≥85% adherence** across its firm weeks (adherence per the existing weekly computation, averaged over the block).
- One species at launch: **Keystone pine** (tree, rare, `coached_blocks: 1`) — "a block seen through, roots and all" — planted like any unlock, celebrated by the Bundle-1 ceremony machinery. A second tier (`coached_blocks: 3`) is listed in the codex from day one so the ladder is visible.
- This is the phase's only engine change → **`SIMULATION_VERSION` 4 → 5** (lazy resimulation as always; historical gardens are unaffected since no coached blocks exist in history).

## 5. Failure and edge honesty

- Coach unavailable ≠ garden changes: the garden never depends on a wake. All treatments derive from resolution rows.
- A sanctioned skip later un-skipped (existing unskip route) restores the workout and removes the sanction — day inputs rebuild, garden resimulates that day accordingly (the existing resimulate-from machinery).
- Declining a skip proposal changes nothing — declining is not sanctioning.
- Writes-OFF mode: sanctioning is app-side state; garden treatment works regardless of watch mirroring.

## Testing

- Day-input builder: sanctioned-first vs sanctioned-second-in-week vs unsanctioned matrix; rolling-window boundary (day 8 resets); unskip reversal resim.
- Engine: `coached_blocks` gate + counter + v5 replay determinism.
- Dossier: garden line fixture; mercy-usage line fixture.
- Prompt regression: briefing fixture with garden reference present/sparing (fixture-mode assertion on structure, not prose).

## Out of scope

Garden visuals for the coach itself (no coach sprite); notifications; any auto-easing without approval.
