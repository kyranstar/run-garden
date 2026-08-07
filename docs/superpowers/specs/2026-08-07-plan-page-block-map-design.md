# Plan page: this-week hero + block map

**Date:** 2026-08-07
**Status:** Draft for review
**Mockups:** `.superpowers/brainstorm/*/content/block-map-v2.html` (current: floating coach window + mobile); earlier iterations in `block-map-refined.html`, `layout-variants.html`

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

Desktop ≥1024px — the plan **always owns the full width**; the coach never takes layout space:

```
┌────────┬────────────────────────────────────────────────────────┐
│ side   │ Plan                     Fall Half · Manage plans ▾     │
│ nav    │ [sync banner — only when unhealthy]      ┌─────────────┤
│        │ THIS WEEK · hero (7 cells, full detail)  │ Coach       │
│        │ week summary line                        │ (floating   │
│        │ THE BLOCK · one row per week             │  window,    │
│        │   … click a row → expands in place …     │  overlays,  │
│        │ [+ extend plan]   [legend]               │  full       │
│        │ Studio card (existing section)           │  height)  — │
│        │                                          └─────────────┤
│        │                                    [Coach · 1] ← pill  │
└────────┴────────────────────────────────────────────────────────┘
```

- The `/plan` route escapes the 880px reading column the way `/garden` already does: `AppShell` gives it a `shell-main--wide` modifier — `max-width: 1440px`, same padding. (Garden's `--immersive` stays as-is; this is a second, milder modifier.)
- The main column is a single `minmax(0, 1fr)` — no reserved rail. The coach floats above it (next section).
- `.plan-split` and its 0.85fr/1.15fr split are deleted.
- The header keeps the plan name and **Manage plans** (unchanged behavior). The **Today** scroll button is removed — the current week is always at the top.

### Mobile (<1024px)

Interaction patterns are untouched: bottom nav, floating coach pill + bottom-sheet coach, studio card, sync placement. The calendar body is the one deliberate change — hero + map replace the month grid at every width, so there is **one calendar implementation, not two**:

- **Hero** (<640px): a vertical day list for the current week — one row per day: `dow/dom · category bar · full title · duration · status`. Rest days muted; coach proposals as dashed amber rows. (This is the day-list style the current mobile week rows already use, so per-workout readability is unchanged or better.)
- **Map rows** keep the horizontal form — `W# label + 7 chips + total` fits a 360px viewport with 11px chips.
- **Expanding a week** on mobile opens the same vertical day list the hero uses.
- The desktop coach *window* never renders below 1024px; the pill + `Sheet` continue exactly as today. (The desktop minimized pill is styled as the same object as the mobile pill — one visual language.)

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

**Empty state:** when the fetched window has no workouts, hero + map are replaced by the existing `EmptyState` ("No active COROS training plan…"); the coach window/pill and studio card still render.

## Coach window (floating, minimizable)

The coach is **not part of the page layout**. A new `coach-window.tsx` renders the existing `CoachPanel` (tray, thread, composer, Check in, "what I know →" all unchanged) inside a floating window so it never squishes the plan.

Two states:

- **Open:** a window pinned to the right side of the plan content area — full height of the viewport (small top/bottom insets), **width `min(440px, 38vw)`** so the thread finally has room. Elevated (border + shadow), no scrim, non-modal: the plan behind it stays fully interactive and keeps its full width — nothing reflows. The window header adds a **minimize (—) control** next to "Check in". It sits above page content and below the modal sheets (workout detail etc.). On ultrawide screens it pins to the content area's right edge, not the raw viewport, so it stays adjacent to the plan.
- **Minimized:** a floating **`Coach · n` pill** at the bottom-right (the desktop twin of the existing mobile pill), `n` = pending proposals + open question. Nothing else on screen.

Open/minimize rules:

- The window opens on: pill click; a ghost tap (hero card or map chip — also fires the existing `focusProposal` flash); or **new coach activity** since the last-seen watermark (new proposal, open question, or coach message).
- The watermark advances **only when the user minimizes** — minimizing marks everything seen, so an activity-triggered open stays open until dismissed (never auto-closes under you), and later coach activity re-opens it.
- State persists in `localStorage` (`rg.coachWindow.open`, `rg.coachWindow.seen`). `Esc` minimizes when focus is inside the window and no inner sheet is open.
- The window (and its `CoachPanel`) stays mounted while on the plan route regardless of state, so queries and optimistic sends behave exactly as today.
- <1024px: the window doesn't render; the existing floating coach pill + `Sheet` continue unchanged.

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
| `packages/ui/src/screens/coach-window.tsx` | **New**: floating window + minimized pill around `CoachPanel`; open/seen persistence |
| `packages/ui/src/shell.tsx` | `/plan` gets `shell-main--wide` |
| `packages/ui/src/styles.css` | New hero/map/window/pill styles; delete `.plan-split`; `shell-main--wide`; extend `.coach-pill` to desktop-minimized use |
| `packages/ui/src/screens/today.tsx` | `SyncPanel` `quietWhenHealthy` prop |
| `packages/ui/src/screens/studio.tsx` | No changes (mount point moves in plan.tsx) |

## Testing

- Unit: `buildWeeks` (grouping, totals, current/past flags, month boundaries, multi-workout days, empty window) in `packages/ui/test` (vitest, Node 21).
- Component: map row states (done/missed/ghost/collapsed past), coach-window open/minimize/watermark triggers, deep-link auto-expand, hero summary line with and without an active plan, mobile hero day-list — static render tests in the existing style.
- Visual: refresh `scripts/screenshots.mjs` set; check 1440/1280 desktop (window open and minimized), 768 tablet, 390/360 phone, dark mode.
- Manual: ghost tap → window opens + proposal flash; workout sheet round-trip from an expanded far week; studio expand under the map; sync banner appearing on induced failure; Esc-minimize.

## Out of scope (explicitly)

- Workout detail in a side pane (variant D's idea) — the sheet stays.
- Drag-to-move workouts on the map, week-level bulk actions, volume sparklines — natural follow-ons, not this change.
- Any coach prompt/behavior changes.
