# Plan page: this-week hero + block map

**Date:** 2026-08-07
**Status:** Draft for review
**Mockups:** `.superpowers/brainstorm/89243-1786086302/content/block-map-refined.html` (variant C of `layout-variants.html`)

## Problem

The desktop Plan page squeezes three surfaces into a reading column:

- `.shell-main` caps the page at **880px** even on a 1440px display (~350px of screen sits empty).
- The coach panel takes `minmax(340px, 0.85fr)` of that — **~40% of the page** — even when it has no proposals, no question, and no messages, which is its most common state.
- The 7-column month grid gets the remaining **~510px** (~70px per day cell): titles truncate ("Thre…", "Easy Ru…"), cards go tall and narrow, and one month consumes most of a screen of vertical scroll.
- The Studio section sits **below the entire multi-month calendar** — its "Needs attention" state is effectively invisible.
- Reading the whole plan means scrolling through ~26 weeks of month grid; there is no compressed overview.

User's stated reading pattern: *mostly this week; step back to the whole plan occasionally, especially to change it.*

## Goals

1. This week readable at a glance, always at the top — no scrolling, no truncation.
2. The whole block visible on one screen, compressed to structure (what kind of work, which days, how much per week).
3. Space follows relevance: coach and studio get pixels when they need attention, almost none when quiet.
4. No behavior changes to workouts, proposals, sync, or studio — this is a layout redesign; every existing action keeps working.

## Non-goals

- No API or data-model changes. Everything renders from the existing `plan`, `coach-state`, `coach-plans`, `sync-status`/`sync-notes`, and `studio` queries.
- No change to the workout detail sheet, move/match sheets, Manage plans sheet, or any mutation.
- No change to mobile interaction patterns (coach pill + sheet stay; studio card stays; bottom nav stays).
- No changes to Garden, Today, Activity, Insights, Settings.

## Layout

Desktop ≥1024px:

```
┌────────┬──────────────────────────────────────────────┬──────────┐
│ side   │ Plan          Fall Half · Manage plans ▾      │          │
│ nav    │ [sync banner — only when unhealthy]           │  coach   │
│        │ THIS WEEK · hero (7 cells, full detail)       │  rail    │
│        │ week summary line                             │ (elastic)│
│        │ THE BLOCK · one row per week (chips + total)  │          │
│        │   … click a row → expands in place …          │          │
│        │ [+ extend plan]   [legend]                    │          │
│        │ Studio card (existing collapsible section)    │          │
└────────┴──────────────────────────────────────────────┴──────────┘
```

- The `/plan` route escapes the 880px reading column the way `/garden` already does: `AppShell` gives it a `shell-main--wide` modifier — `max-width: 1440px`, same padding. (Garden's `--immersive` stays as-is; this is a second, milder modifier.)
- Main column and rail: `grid-template-columns: minmax(0, 1fr) auto`. The rail is 340px expanded, 48px collapsed, `position: sticky; top: 0.8rem`.
- `.plan-split` and its 0.85fr/1.15fr split are deleted.
- The header keeps the plan name and **Manage plans** (unchanged behavior). The **Today** scroll button is removed — the current week is always at the top.

Below 1024px nothing about the shell changes (bottom nav, coach pill + sheet). Below 640px the hero renders as a vertical day list (the same stacking the current mobile week rows use); the map rows stay horizontal — label + 7 chips + total fit a 360px viewport.

**Mobile calendar note (the one deliberate mobile change):** the month-grid body is replaced by hero + map at every width — one calendar implementation, not two. Coach/studio/sync placement on mobile is untouched.

## This-week hero

- Always the current ISO week (`startOfIsoWeek(today)`), rendered as 7 side-by-side cells: weekday label, day-of-month, then the day's workout cards.
- Cards show the **full title** (no truncation at ≥1024px), duration, and status: ✓ done, "did it happen?" (askable), skipped/missed note, COROS-attention glyph — same states the current `WorkoutCell` renders, with room to breathe.
- Rest days render the quiet italic "Rest". Days with no entry render as empty cells (dashed outline, like today's `cal-day:not(.has-items)`).
- Coach proposals for this week appear as the existing ghost cards (`cal-ghost` treatment) inside the day cells.
- Today's cell gets the ring highlight (current `is-today` treatment, scaled up).
- Clicking a workout opens the existing detail sheet (`?workout=id`, unchanged).
- **Summary line** under the hero: `Week {n} of {m} · {planned time} · {done} of {count} done`. `n`/`m` come from the active coached plan covering today (same arithmetic as `ManagePlans.weekOf`); when no active plan covers today, the `Week n of m` fragment is omitted and the line is just totals. Planned time = sum of `workoutSeconds` over non-rest items; done = items with `completionState === "completed"`.

## The block map

One row per ISO week, spanning the same fetched window the calendar shows today (8 weeks back to 18 ahead, clamped to weeks that have any workout, plus the current week).

**Row anatomy:** `W{n} · {Mon date}` label → 7 day slots → weekly total.

- `W{n}` numbers weeks against the same reference as the hero summary (active plan start = W1). With no active plan, rows show just the date (`Jul 20`).
- **Day slots** are 14px rounded chips colored by workout category — the existing `.cat-*` palette (`quality`, `easy`, `long`, `recovery`, `race`, `strength`, `cross_training`, `yoga`; `rest` renders as a pale outline chip; an empty day is a barely-there track square).
  - Completed → white ✓ overlay. Missed → desaturated/rose treatment (distinct from completed and pending at a glance). Skipped → 40% opacity.
  - A pending coach proposal on that day → dashed amber chip (from the existing `pendingByDate` ghosts; `outgoing` ghosts dash the existing chip's border instead of adding one).
  - Two workouts on one day → two stacked mini-chips; three or more → one chip with a small count.
- **Weekly total:** summed `workoutSeconds` (`4 h 47`), plus a state suffix: `· ✓` when every item completed, `· {k} missed` when any missed, `· now` on the current week.
- **Months** appear as serif separators (`July`, `August`) between rows, replacing month-grid headers.
- **Past weeks** render at reduced opacity. Runs of weeks strictly before the current one collapse behind a single toggle row — `▸ 6 earlier weeks (all ✓)` — expanded on click. (If any past week has an unresolved "did it happen?" item, it stays out of the collapsed group.)
- **Current week** row is highlighted (soft green fill). It exists in the map as an index entry even though the hero shows the same week above.
- **Extend row:** the existing `+ extend {plan} — the coach drafts the next weeks` button moves to the end of the map (same `cannedSend` behavior).
- **Legend:** a one-line legend under the map (category colors, proposal, missed).

**Expansion:** clicking a week row expands it in place into the same 7-cell grid the hero uses (one shared `WeekGrid` component). One week open at a time; clicking another row closes the first. The expanded grid is fully interactive — workout sheets, ghosts, everything. `prefers-reduced-motion` skips the height animation.

**Deep links:** opening `/plan?workout=id` where the workout lives outside the hero auto-expands its containing week (and un-collapses the past group if needed) before the sheet opens, so closing the sheet leaves you looking at the right week.

**Empty state:** when the fetched window has no workouts, hero + map are replaced by the existing `EmptyState` ("No active COROS training plan…"); the coach rail and studio card still render.

## Coach rail (elastic)

A new `coach-rail.tsx` wraps the existing `CoachPanel` (rendered verbatim — tray, thread, composer, Check in, "what I know →" all unchanged).

Two states:

- **Expanded (340px):** whenever the coach *needs you or is talking*: `pendingProposals.length > 0`, an `openQuestion` exists, a wake/send is in flight, there are coach messages newer than the last-seen watermark, or the user pinned it open.
- **Collapsed (48px strip):** otherwise. The strip shows the coach glyph and a count badge (proposals + open question). Clicking expands and pins.

Rules:

- Pinned state and the last-seen coach message id persist in `localStorage` (`rg.coachRail.pinned`, `rg.coachRail.seen`). The watermark advances **only when the user collapses the rail** — collapsing clears the pin and marks everything seen, so an unread-triggered expansion stays open until the user dismisses it (never auto-collapses out from under them), and a later coach message re-expands it.
- Tapping a calendar ghost (hero or map chip) expands the rail (without pinning) and flashes the proposal — the existing `focusProposal` scroll/flash.
- The rail never unmounts on desktop, so `CoachPanel`'s queries and optimistic sends behave exactly as today.
- <1024px: the rail doesn't render; the existing floating coach pill + `Sheet` continue unchanged.

## Studio and sync

- **Studio:** `StudioSection` is untouched internally; its mount point moves from "after six months of calendar" to directly under the block map — one screen from the top. Collapsed header + status pill behavior unchanged.
- **Sync:** `SyncPanel` gains a `quietWhenHealthy` prop (default false, so Today/Garden are unchanged). On the Plan page it renders in the banner slot above the hero and, with the prop set, returns nothing when the status is healthy and there are no notes — the banner only exists when something needs attention or an undoable note is pending.

## Data & derivations (all client-side)

- `buildMonths` in `plan.tsx` is replaced by `buildWeeks(workouts, today): BlockWeek[]` in the new `plan-map.tsx`:
  `{ weekStart, days: [{ date, items }×7], plannedSeconds, doneCount, missedCount, isCurrent, isPast, monthBoundary }`.
- Ghost chips reuse the existing `ghostsByDate` map (`pendingByDate` from `coach-panel.tsx`) — no new proposal parsing.
- Week numbering + `weekOf`-style arithmetic derive from `coachPlans` (already fetched on this screen).
- No new endpoints, no query-key changes, no server work.

## File changes

| File | Change |
| --- | --- |
| `packages/ui/src/screens/plan.tsx` | Replace month-grid render with hero + map + relocated studio; drop Today button; keep queries, sheets, `WorkoutDetail`, `usePlanCoach` as-is |
| `packages/ui/src/screens/plan-map.tsx` | **New**: `buildWeeks`, `WeekGrid` (shared hero/expanded), `BlockMap`, chip components |
| `packages/ui/src/screens/coach-rail.tsx` | **New**: elastic rail wrapper + collapsed strip around `CoachPanel` |
| `packages/ui/src/shell.tsx` | `/plan` gets `shell-main--wide` |
| `packages/ui/src/styles.css` | New hero/map/rail styles; delete `.plan-split`; `shell-main--wide`; keep `.coach-pill` mobile rules |
| `packages/ui/src/screens/today.tsx` | `SyncPanel` `quietWhenHealthy` prop |
| `packages/ui/src/screens/studio.tsx` | No changes (mount point moves in plan.tsx) |

## Testing

- Unit: `buildWeeks` (grouping, totals, current/past flags, month boundaries, multi-workout days, empty window) in `packages/ui/test` (vitest, Node 21).
- Component: map row states (done/missed/ghost/collapsed past), rail expand/collapse triggers, deep-link auto-expand, hero summary line with and without an active plan — static render tests in the existing style.
- Visual: refresh `scripts/screenshots.mjs` set; check 1440/1280 desktop, 768 tablet, 390/360 phone, dark mode.
- Manual: ghost tap → rail flash; workout sheet round-trip from an expanded far week; studio expand under the map; sync banner appearing on induced failure.

## Out of scope (explicitly)

- Workout detail in a side pane (variant D's idea) — the sheet stays.
- Drag-to-move workouts on the map, week-level bulk actions, volume sparklines — natural follow-ons, not this change.
- Any coach prompt/behavior changes.
