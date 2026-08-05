# Garden Earned Moments — Bundle 2 "Nothing earned goes unseen" — Design

*2026-08-05 · Second of three bundles fixing `docs/reports/2026-08-05-garden-ux-audit-2.md` (items B1, B2, and the canon-violating daily streak). Autonomous scope rulings (session directive "ship without stopping"): B7 tray/notifications is deferred into the pending desktop-shell follow-up project (spec 4c in project memory) — it needs a desktop release + manual install, which can't ship-and-verify in this session. The canon's "longest chain" needs a new engine counter → deferred to Bundle 3's version bump.*

## Goal

Three finished features are currently invisible: personal records render with no newness, the Monday LLM review is stranded at the bottom of Insights, and the weekly consistency chain — the product's one sanctioned streak — is shown nowhere while a canon-violating *daily* streak is. Surface all three, quietly.

**Non-goals:** notifications/tray (desktop-shell project); a generic moments feed; any engine change; nav-level badges (the garden pull line covers discovery from the landing screen).

## §1 Records recency (audit B1)

- `Records` card rows (`packages/ui/src/screens/insights.tsx:467-479`) get a "New" pill when the record's `date` is within the last 7 days — the same recency treatment as the codex's `isNewUnlock` (`codex.tsx:329`). Pure client rule: `isRecentRecord(dateIso, todayIso)` in `charts-math.ts` (where insights' pure helpers live), reusing the `.codex-newring`-style pill (a shared `.new-ring` class or reuse of the existing one).
- No server change: the row's achievement `date` is already served. (The discarded server diff at `misc.ts:743` stays as-is — the audit's UX half is what users feel.)

## §2 Weekly-review pull (audit B2)

- **Garden pull line**: a one-liner near the `EvidenceCard` in the garden's `plumbing` block (`garden.tsx`): *"The week's story is written — read it →"*, linking to `/insights`. Shown when: the latest review (from the `["insights"]` query the `EvidenceCard` already shares) has `weekStart` newer than `localStorage["rg-review-seen"]` AND a non-null narrative. Clicking stores the `weekStart` and navigates. Component `ReviewPull` in `today.tsx` beside `EvidenceCard` (same query, same mount points).
- **Review-card highlight**: on Insights, the latest review's `<summary>`/header shows the same "New" pill under the same unseen condition; opening the Insights review card also stores `rg-review-seen`.
- localStorage is acceptable here (stakes: a dot; worst case the pill shows again on another device — unlike the ceremony, repetition is harmless).

## §3 The sanctioned streak (audit B5 / canon §1.3)

- Delete the daily `streak-note` (`insights.tsx:322-325`, `currentStreak` usage) — the 08-04 canon explicitly killed daily streaks as dishonest (the engine forgives days).
- Replace with the weekly chain, in the same quiet spot: *"{N} consistent weeks — the vines climb with it."* from `snapshot.state.consecutiveConsistentWeeks`, read via a `useQuery(["garden"], api.garden, staleTime: 5m)` that shares the landing screen's cache. Hidden when 0 or unavailable (canon: never render a zero — "a new chain starts with this week" phrasing is reserved for a future surface that can carry it).
- `currentStreak` in `charts-math.ts` stays (exported, tested) only if other callers exist; if insights was its only consumer, delete it and its tests.

## Error handling

- Missing/unavailable garden data on Insights → chain line hidden (no fetch spinner, no error).
- localStorage unavailable → pulls simply repeat; never a crash (try/catch as the dock-state setter does).

## Testing

- `isRecentRecord` unit tests (boundary: exactly 7 days, future-dated, malformed).
- `reviewUnseen(latestWeekStart, stored)` pure helper + tests (null stored, older, equal, newer).
- Chain-line rendering: static-markup smoke (chain 3 → text present; chain 0 → absent).
- Full suite + typecheck under Node 21.

## Rollout

No migrations, no engine change, no API change. Commits to `main`, push (deploy) when green.
