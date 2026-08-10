# Plan Page Block-Map Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Plan screen as "this-week hero + block map" with the coach in a floating minimizable window, per `docs/superpowers/specs/2026-08-07-plan-page-block-map-design.md`.

**Architecture:** Pure-presentational React components in `@rg/ui` (the `coach-panel.tsx` pattern: all callbacks injected, statically renderable). New `plan-map.tsx` owns week assembly + hero/map rendering; new `coach-window.tsx` owns the floating window + seen-watermark logic; `plan.tsx` wires queries to them. No API or server changes.

**Tech Stack:** React 18, TanStack Query (existing hooks only), react-router, vitest + `renderToStaticMarkup`, plain CSS in `packages/ui/src/styles.css`.

## Global Constraints

- **Node 21 for all tests** (`~/.nvm/versions/node/v21.7.3`, the machine default — Node 22 breaks `better-sqlite3` ABI in worker tests). Node 22 only for wrangler.
- Run tests from repo root: `pnpm vitest run <path>` or `pnpm test` for the full suite.
- **No new dependencies.**
- Components stay presentational — no `useQuery` inside new components; `plan.tsx` injects data + callbacks (see `coach-panel.tsx` header comment for the pattern).
- Tests use `renderToStaticMarkup` + `MemoryRouter` (see `packages/ui/test/coach-panel.test.tsx`) — no jsdom, no fireEvent.
- Reuse existing CSS classes where they already express the thing (`.cal-card`, `.cal-ghost`, `.cal-day`, `.cal-week`, `.cat-*` colors). New classes: `.wkgrid*`, `.map-*`, `.coach-window*`, `.shell-main--wide`.
- Copy voice: quiet, lowercase-friendly, "normal earns silence" (no badge/banner when healthy).
- `git commit` in this repo can SIGKILL when the working tree scan hits the Rust `target/` dir — always `git add <specific paths>` then commit; if commit still dies, use `git write-tree`/`git commit-tree`/`git update-ref`.
- The fixture stack for visual checks: web dev server on :5173, worker on :8787 (already running; if the worker is down: `cd apps/worker && PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx wrangler dev --port 8787`, and apply local D1 migrations if it 500s on missing tables: same PATH, `npx wrangler d1 migrations apply run-garden-db --local`).

---

### Task 1: Week assembly + plan-position helpers (`buildWeeks`, `weekPosition`, `formatHoursMinutes`)

**Files:**
- Create: `packages/ui/src/screens/plan-map.tsx`
- Modify: `packages/ui/src/components.tsx` (add `formatHoursMinutes` next to `formatMinutes`)
- Test: `packages/ui/test/plan-map.test.tsx` (new)

**Interfaces:**
- Consumes: `WorkoutDto`, `CoachPlanDto` from `@rg/api-client`; `addDays`, `startOfIsoWeek`, `daysBetween` from `@rg/domain`; `monthTitle`, `dayOfMonth` from `../components.js`.
- Produces (later tasks rely on these exact names):
  - `interface BlockDay { date: string; items: WorkoutDto[] }`
  - `interface BlockWeek { weekStart: string; days: BlockDay[]; plannedSeconds: number; itemCount: number; doneCount: number; missedCount: number; askableCount: number; isCurrent: boolean; isPast: boolean; monthLabel: string | null }`
  - `buildWeeks(workouts: WorkoutDto[], today: string | undefined): BlockWeek[]`
  - `activePlanFor(plans: CoachPlanDto[] | undefined, today: string | undefined): CoachPlanDto | null`
  - `weekPosition(weekStart: string, plan: CoachPlanDto | null): { n: number; m: number } | null`
  - `weekMetaLabel(weekStart: string, plan: CoachPlanDto | null): string`
  - `askable(w: WorkoutDto, today: string): boolean` and `displayCompletionState(w, today)` (moved here from `plan.tsx` in Task 2 — declare them here now so this file owns them)
  - `formatHoursMinutes(seconds: number): string` from `components.tsx`

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/test/plan-map.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import type { CoachPlanDto, WorkoutDto } from "@rg/api-client";
import { formatHoursMinutes } from "../src/components.js";
import {
  activePlanFor,
  buildWeeks,
  weekMetaLabel,
  weekPosition,
} from "../src/screens/plan-map.js";

export function wo(over: Partial<WorkoutDto>): WorkoutDto {
  return {
    id: "w1",
    title: "Easy Run 45 min",
    category: "easy",
    sport: "run",
    originalPlanDate: "2026-08-05",
    lastVerifiedCorosDate: "2026-08-05",
    effectiveDate: "2026-08-05",
    effectiveTime: "07:00",
    workoutSeconds: 2700,
    calendarSeconds: 3600,
    calendarSyncState: "synced",
    corosSyncState: "verified",
    completionState: "scheduled",
    archived: false,
    ...over,
  } as WorkoutDto;
}

const PLAN: CoachPlanDto = {
  id: "p1",
  discipline: "run",
  name: "Fall Half Marathon Build",
  status: "active",
  startDate: "2026-06-29", // a Monday
  endDate: "2026-10-04",
  raceDate: null,
};

describe("buildWeeks", () => {
  it("groups continuous ISO weeks, includes today's empty week, computes totals", () => {
    const weeks = buildWeeks(
      [
        wo({ id: "a", effectiveDate: "2026-07-28", completionState: "completed", workoutSeconds: 3240 }),
        wo({ id: "b", effectiveDate: "2026-07-29", completionState: "missed", workoutSeconds: 2700 }),
        wo({ id: "r", effectiveDate: "2026-07-27", category: "rest", workoutSeconds: null }),
        wo({ id: "c", effectiveDate: "2026-08-15", workoutSeconds: 7440 }),
      ],
      "2026-08-06",
    );
    // Jul 27 week, Aug 3 week (today, empty), Aug 10 week
    expect(weeks.map((w) => w.weekStart)).toEqual(["2026-07-27", "2026-08-03", "2026-08-10"]);
    const w0 = weeks[0]!;
    expect(w0.plannedSeconds).toBe(3240 + 2700); // rest excluded
    expect(w0.itemCount).toBe(2);
    expect(w0.doneCount).toBe(1);
    expect(w0.missedCount).toBe(1);
    expect(w0.isPast).toBe(true);
    expect(weeks[1]!.isCurrent).toBe(true);
    expect(weeks[1]!.itemCount).toBe(0);
  });

  it("stamps monthLabel only on the first week of each month-of-Monday", () => {
    const weeks = buildWeeks(
      [wo({ id: "a", effectiveDate: "2026-07-28" }), wo({ id: "b", effectiveDate: "2026-08-12" })],
      "2026-08-06",
    );
    expect(weeks.map((w) => w.monthLabel)).toEqual(["July", "August", null]);
  });

  it("counts unresolved past workouts as askable", () => {
    const weeks = buildWeeks(
      [wo({ id: "a", effectiveDate: "2026-07-28", completionState: "unresolved" })],
      "2026-08-06",
    );
    expect(weeks[0]!.askableCount).toBe(1);
  });

  it("returns [] for no workouts", () => {
    expect(buildWeeks([], "2026-08-06")).toEqual([]);
  });
});

describe("weekPosition / weekMetaLabel / activePlanFor", () => {
  it("numbers weeks from the active plan's start week", () => {
    expect(weekPosition("2026-06-29", PLAN)).toEqual({ n: 1, m: 14 });
    expect(weekPosition("2026-08-03", PLAN)).toEqual({ n: 6, m: 14 });
    expect(weekPosition("2026-06-22", PLAN)).toBeNull(); // before the plan
    expect(weekPosition("2026-10-12", PLAN)).toBeNull(); // after the plan
  });

  it("labels rows with W-number inside a plan, bare date outside", () => {
    expect(weekMetaLabel("2026-08-03", PLAN)).toBe("W6 · Aug 3");
    expect(weekMetaLabel("2026-08-03", null)).toBe("Aug 3");
  });

  it("activePlanFor picks the active plan covering today, preferring run", () => {
    const lift: CoachPlanDto = { ...PLAN, id: "p2", discipline: "lift", name: "Lift" };
    expect(activePlanFor([lift, PLAN], "2026-08-06")?.id).toBe("p1");
    expect(activePlanFor([{ ...PLAN, status: "retired" }], "2026-08-06")).toBeNull();
    expect(activePlanFor([PLAN], "2026-11-01")).toBeNull();
    expect(activePlanFor(undefined, "2026-08-06")).toBeNull();
  });
});

describe("formatHoursMinutes", () => {
  it("uses minutes under an hour, h mm above", () => {
    expect(formatHoursMinutes(2700)).toBe("45 min");
    expect(formatHoursMinutes(17220)).toBe("4 h 47");
    expect(formatHoursMinutes(3600)).toBe("1 h 00");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/ui/test/plan-map.test.tsx`
Expected: FAIL — module `../src/screens/plan-map.js` not found, `formatHoursMinutes` not exported.

- [ ] **Step 3: Implement**

In `packages/ui/src/components.tsx`, directly under `formatMinutes`:

```tsx
/** Weekly totals: "45 min" under an hour, "4 h 47" above. */
export function formatHoursMinutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}
```

Create `packages/ui/src/screens/plan-map.tsx`:

```tsx
import type { CoachPlanDto, WorkoutDto } from "@rg/api-client";
import { addDays, daysBetween, startOfIsoWeek } from "@rg/domain";
import { dayOfMonth, monthTitle } from "../components.js";

/**
 * The Plan screen's calendar body (block-map spec 2026-08-07): a hero week +
 * one row per week. Pure data + presentational components — plan.tsx injects
 * queries and callbacks (the coach-panel.tsx pattern).
 */

/** "Did this run happen?" only ever makes sense for a date that has passed.
 * (Moved verbatim from plan.tsx — it owns workout display states now.) */
export function askable(w: WorkoutDto, today: string): boolean {
  return w.completionState === "unresolved" && w.effectiveDate <= today;
}

export function displayCompletionState(
  w: WorkoutDto,
  today: string,
): WorkoutDto["completionState"] {
  return w.completionState === "unresolved" && !askable(w, today) ? "scheduled" : w.completionState;
}

export interface BlockDay {
  date: string;
  items: WorkoutDto[];
}

export interface BlockWeek {
  weekStart: string;
  days: BlockDay[];
  plannedSeconds: number;
  itemCount: number;
  doneCount: number;
  missedCount: number;
  askableCount: number;
  isCurrent: boolean;
  isPast: boolean;
  /** Month name when this row starts a new month-of-Monday ("August", with
   * year appended when it isn't the current week's year). */
  monthLabel: string | null;
}

/** Continuous ISO weeks spanning the plan (and today) — same walk as the old
 * buildMonths, but flat: one entry per week, with per-week aggregates. */
export function buildWeeks(workouts: WorkoutDto[], today: string | undefined): BlockWeek[] {
  const byDate = new Map<string, WorkoutDto[]>();
  for (const w of workouts) {
    const list = byDate.get(w.effectiveDate) ?? [];
    list.push(w);
    byDate.set(w.effectiveDate, list);
  }
  if (byDate.size === 0) return [];
  const dates = [...byDate.keys()].sort();
  let start = startOfIsoWeek(dates[0]!);
  let end = startOfIsoWeek(dates[dates.length - 1]!);
  const currentWeek = today ? startOfIsoWeek(today) : null;
  if (currentWeek) {
    if (currentWeek < start) start = currentWeek;
    if (currentWeek > end) end = currentWeek;
  }
  const todayYear = today ? Number(today.slice(0, 4)) : null;

  const weeks: BlockWeek[] = [];
  let prevMonthKey = "";
  for (let ws = start, guard = 0; ws <= end && guard < 80; ws = addDays(ws, 7), guard++) {
    const days: BlockDay[] = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(ws, i);
      return { date, items: byDate.get(date) ?? [] };
    });
    let plannedSeconds = 0;
    let itemCount = 0;
    let doneCount = 0;
    let missedCount = 0;
    let askableCount = 0;
    for (const d of days) {
      for (const w of d.items) {
        if (w.category === "rest") continue;
        itemCount++;
        plannedSeconds += w.workoutSeconds ?? 0;
        if (w.completionState === "completed") doneCount++;
        if (w.completionState === "missed") missedCount++;
        if (today && askable(w, today)) askableCount++;
      }
    }
    const { month, year } = monthTitle(ws);
    const monthKey = `${year}-${month}`;
    weeks.push({
      weekStart: ws,
      days,
      plannedSeconds,
      itemCount,
      doneCount,
      missedCount,
      askableCount,
      isCurrent: ws === currentWeek,
      isPast: currentWeek != null && ws < currentWeek,
      monthLabel:
        monthKey === prevMonthKey ? null : todayYear != null && year !== todayYear ? `${month} ${year}` : month,
    });
    prevMonthKey = monthKey;
  }
  return weeks;
}

/** The active coached plan whose dates cover today — run wins over lift when
 * both are live (the block map indexes the running block). */
export function activePlanFor(
  plans: CoachPlanDto[] | undefined,
  today: string | undefined,
): CoachPlanDto | null {
  if (!plans || !today) return null;
  const live = plans.filter(
    (p) => p.status === "active" && p.startDate <= today && today <= p.endDate,
  );
  return live.find((p) => p.discipline === "run") ?? live[0] ?? null;
}

export function weekPosition(
  weekStart: string,
  plan: CoachPlanDto | null,
): { n: number; m: number } | null {
  if (!plan) return null;
  const p0 = startOfIsoWeek(plan.startDate);
  const n = Math.floor(daysBetween(p0, weekStart) / 7) + 1;
  const m = Math.floor(daysBetween(p0, startOfIsoWeek(plan.endDate)) / 7) + 1;
  return n >= 1 && n <= m ? { n, m } : null;
}

function shortDate(date: string): string {
  return `${monthTitle(date).month.slice(0, 3)} ${dayOfMonth(date)}`;
}

/** Map-row label: "W6 · Aug 3" inside the active plan, "Aug 3" outside. */
export function weekMetaLabel(weekStart: string, plan: CoachPlanDto | null): string {
  const pos = weekPosition(weekStart, plan);
  return pos ? `W${pos.n} · ${shortDate(weekStart)}` : shortDate(weekStart);
}
```

Note: if `daysBetween(a, b)` in `@rg/domain` (packages/domain/src/time.ts:66) turns out to return `a - b` rather than `b - a`, flip the arguments in `weekPosition` — the test pins the correct behavior.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/ui/test/plan-map.test.tsx`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/screens/plan-map.tsx packages/ui/src/components.tsx packages/ui/test/plan-map.test.tsx
git commit -m "feat(ui): buildWeeks + plan-position helpers for the block map"
```

---

### Task 2: `WeekGrid` — the shared 7-day grid (hero + expanded weeks)

**Files:**
- Modify: `packages/ui/src/screens/plan-map.tsx` (add `WorkoutCell`, `WeekGrid`, `WeekSummaryLine`)
- Modify: `packages/ui/src/screens/plan.tsx` (import `askable`/`displayCompletionState` from `./plan-map.js`; delete its local copies — nothing else yet)
- Test: `packages/ui/test/plan-map.test.tsx` (extend)

**Interfaces:**
- Consumes: Task 1 types; `PendingGhost` from `./coach-panel.js`; `CategoryDot`, `CompletionPill` not needed — cells reuse the compact card markup from today's plan.tsx.
- Produces:
  - `WorkoutCell({ w, today, onOpen }: { w: WorkoutDto; today: string; onOpen: () => void })` — moved from plan.tsx verbatim (same class names).
  - `WeekGrid({ days, today, ghosts, onOpenWorkout, onGhostTap, hero }: { days: BlockDay[]; today: string; ghosts: Map<string, PendingGhost[]>; onOpenWorkout: (id: string) => void; onGhostTap: (proposalId: string) => void; hero?: boolean })`
  - `WeekSummaryLine({ week, position }: { week: BlockWeek; position: { n: number; m: number } | null })`

- [ ] **Step 1: Write the failing tests**

Append to `packages/ui/test/plan-map.test.tsx`:

```tsx
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { PendingGhost } from "../src/screens/coach-panel.js";
import { WeekGrid, WeekSummaryLine } from "../src/screens/plan-map.js";

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(createElement(MemoryRouter, null, el));
}
const noop = () => undefined;

describe("WeekGrid", () => {
  const days = buildWeeks(
    [
      wo({ id: "a", effectiveDate: "2026-08-04", title: "Threshold 5x5", category: "quality", completionState: "completed" }),
      wo({ id: "ask", effectiveDate: "2026-08-05", title: "Easy + Strides", completionState: "unresolved" }),
      wo({ id: "r", effectiveDate: "2026-08-03", category: "rest", title: "Rest" }),
    ],
    "2026-08-06",
  )[0]!.days;

  it("renders 7 day cells with full titles, today ring, rest, and empty days", () => {
    const html = render(
      createElement(WeekGrid, { days, today: "2026-08-06", ghosts: new Map(), onOpenWorkout: noop, onGhostTap: noop, hero: true }),
    );
    expect((html.match(/class="cal-day/g) ?? []).length).toBe(7);
    expect(html).toContain("Threshold 5x5");
    expect(html).toContain("is-today");
    expect(html).toContain("cal-rest");
    expect(html).toContain("wkgrid-hero");
  });

  it("drops ghost buttons on the right days", () => {
    const ghosts = new Map<string, PendingGhost[]>([
      ["2026-08-07", [{ kind: "incoming", label: "Easy 30", proposalId: "p9", title: "Add an easy 30" }]],
    ]);
    const html = render(
      createElement(WeekGrid, { days, today: "2026-08-06", ghosts, onOpenWorkout: noop, onGhostTap: noop }),
    );
    expect(html).toContain("cal-ghost-incoming");
    expect(html).toContain("Easy 30");
  });
});

describe("WeekSummaryLine", () => {
  it("renders position, planned time and done count; omits position without a plan", () => {
    const week = buildWeeks(
      [
        wo({ id: "a", effectiveDate: "2026-08-04", completionState: "completed", workoutSeconds: 3240 }),
        wo({ id: "b", effectiveDate: "2026-08-05", workoutSeconds: 14000 }),
      ],
      "2026-08-06",
    )[0]!;
    const withPlan = render(createElement(WeekSummaryLine, { week, position: { n: 6, m: 14 } }));
    expect(withPlan).toContain("Week 6 of 14");
    expect(withPlan).toContain("4 h 47");
    expect(withPlan).toContain("1 of 2 done");
    const without = render(createElement(WeekSummaryLine, { week, position: null }));
    expect(without).not.toContain("Week ");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/ui/test/plan-map.test.tsx`
Expected: FAIL — `WeekGrid`/`WeekSummaryLine` not exported.

- [ ] **Step 3: Implement**

In `plan-map.tsx`, add imports at top:

```tsx
import { IconAlert, IconCheck, IconClock } from "../icons.js";
import { formatHoursMinutes, formatMinutes } from "../components.js";
import type { PendingGhost } from "./coach-panel.js";
```

Move `WorkoutCell` from `plan.tsx` **verbatim** (the whole component, plan.tsx lines ~327–380) into `plan-map.tsx` and export it. Then add:

```tsx
const WEEKDAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** One week as 7 cells — the hero week and expanded map weeks are the same
 * component, so a week reads identically everywhere. */
export function WeekGrid({
  days,
  today,
  ghosts,
  onOpenWorkout,
  onGhostTap,
  hero,
}: {
  days: BlockDay[];
  today: string;
  ghosts: Map<string, PendingGhost[]>;
  onOpenWorkout: (id: string) => void;
  onGhostTap: (proposalId: string) => void;
  hero?: boolean;
}) {
  return (
    <div className={`cal-week wkgrid${hero ? " wkgrid-hero" : ""}`}>
      {days.map((day, i) => {
        const isToday = day.date === today;
        const isPast = day.date < today;
        return (
          <div
            key={day.date}
            className={`cal-day ${isToday ? "is-today" : ""} ${isPast ? "is-past" : ""} ${day.items.length > 0 ? "has-items" : ""}`}
          >
            <div className="cal-date">
              <span className="cal-dow">{WEEKDAY_HEADERS[i]}</span>
              <span className="cal-dom">{dayOfMonth(day.date)}</span>
            </div>
            {day.items.map((w) => (
              <WorkoutCell key={w.id} w={w} today={today} onOpen={() => onOpenWorkout(w.id)} />
            ))}
            {(ghosts.get(day.date) ?? []).map((g, gi) => (
              <button
                key={`${g.proposalId}-${gi}`}
                type="button"
                className={`cal-ghost cal-ghost-${g.kind}`}
                onClick={() => onGhostTap(g.proposalId)}
                title={g.title}
              >
                {g.label}
                <span className="cal-ghost-reason">{g.title} · pending</span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** "Week 6 of 14 · 4 h 47 planned · 2 of 5 done" under the hero. */
export function WeekSummaryLine({
  week,
  position,
}: {
  week: BlockWeek;
  position: { n: number; m: number } | null;
}) {
  return (
    <p className="hero-week-summary muted">
      {position ? (
        <>
          Week <strong>{position.n} of {position.m}</strong> ·{" "}
        </>
      ) : null}
      {formatHoursMinutes(week.plannedSeconds)} planned · {week.doneCount} of {week.itemCount} done
    </p>
  );
}
```

(`WeekGrid` day cells reuse the exact markup of today's plan.tsx week rendering — `cal-week`/`cal-day`/`cal-date`/`cal-ghost` classes — so existing desktop and <640px mobile day-list styles apply unchanged. `formatMinutes` stays used by the moved `WorkoutCell`.)

In `plan.tsx`: delete the local `askable`/`displayCompletionState`/`WorkoutCell` definitions and `import { askable, displayCompletionState, WorkoutCell } from "./plan-map.js";` — `WorkoutDetail` and the (soon-to-die) month rendering keep compiling.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run packages/ui/test/plan-map.test.tsx && pnpm --filter @rg/ui exec tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/screens/plan-map.tsx packages/ui/src/screens/plan.tsx packages/ui/test/plan-map.test.tsx
git commit -m "feat(ui): WeekGrid + WeekSummaryLine; workout cell moves to plan-map"
```

---

### Task 3: `BlockMap` — week rows, chips, month separators, collapsed past, expansion

**Files:**
- Modify: `packages/ui/src/screens/plan-map.tsx` (add `DayChips`, `MapRow`, `BlockMap`)
- Test: `packages/ui/test/plan-map.test.tsx` (extend)

**Interfaces:**
- Consumes: Task 1/2 exports.
- Produces:
  - `BlockMap({ weeks, today, plan, ghosts, expandedWeekStart, onToggleWeek, onOpenWorkout, onGhostTap, extendLabel, onExtend }: { weeks: BlockWeek[]; today: string; plan: CoachPlanDto | null; ghosts: Map<string, PendingGhost[]>; expandedWeekStart: string | null; onToggleWeek: (weekStart: string) => void; onOpenWorkout: (id: string) => void; onGhostTap: (proposalId: string) => void; extendLabel?: string | null; onExtend?: () => void })`
  - Expansion is **controlled** by the parent (`expandedWeekStart`/`onToggleWeek`) so plan.tsx can deep-link-expand.

- [ ] **Step 1: Write the failing tests**

Append to `packages/ui/test/plan-map.test.tsx`:

```tsx
import { BlockMap } from "../src/screens/plan-map.js";

function mapWeeks(today = "2026-08-20") {
  // W-2..W+1 around today; W-2 all done, W-1 has a miss, current, next.
  return buildWeeks(
    [
      wo({ id: "a", effectiveDate: "2026-08-04", completionState: "completed" }),
      wo({ id: "b", effectiveDate: "2026-08-11", completionState: "missed" }),
      wo({ id: "c", effectiveDate: "2026-08-19", category: "long", title: "Long Run" }),
      wo({ id: "d", effectiveDate: "2026-08-26", category: "quality" }),
    ],
    today,
  );
}
const mapProps = {
  today: "2026-08-20",
  plan: PLAN,
  ghosts: new Map<string, PendingGhost[]>(),
  expandedWeekStart: null as string | null,
  onToggleWeek: noop,
  onOpenWorkout: noop,
  onGhostTap: noop,
};

describe("BlockMap", () => {
  it("renders one row per week with chips, totals, month separators, current highlight", () => {
    const html = render(createElement(BlockMap, { ...mapProps, weeks: mapWeeks() }));
    expect((html.match(/map-row(?![\w-])/g) ?? []).length).toBe(4);
    expect(html).toContain("map-month"); // August separator
    expect(html).toContain("map-row-current");
    expect(html).toContain("cat-long"); // chip colored by category
    expect(html).toContain("is-done");
    expect(html).toContain("is-missed");
    expect(html).toContain("· now");
  });

  it("collapses the leading run of clean past weeks (including empty ones) behind a toggle", () => {
    const weeks = buildWeeks(
      [
        wo({ id: "a", effectiveDate: "2026-07-07", completionState: "completed" }),
        wo({ id: "b", effectiveDate: "2026-07-14", completionState: "completed" }),
        wo({ id: "c", effectiveDate: "2026-07-21", completionState: "completed" }),
        wo({ id: "d", effectiveDate: "2026-08-19" }),
      ],
      "2026-08-20",
    );
    // Past weeks Jul 6..Aug 10 (three with workouts + three empty) all collapse.
    const html = render(createElement(BlockMap, { ...mapProps, weeks }));
    expect(html).toContain("6 earlier weeks");
    expect(html).toContain("(all ✓)");
    // collapsed rows are not rendered
    expect((html.match(/map-row(?![\w-])/g) ?? []).length).toBeLessThan(weeks.length);
  });

  it("keeps past weeks with open questions out of the collapsed group", () => {
    const weeks = buildWeeks(
      [
        wo({ id: "a", effectiveDate: "2026-07-07", completionState: "completed" }),
        wo({ id: "b", effectiveDate: "2026-07-14", completionState: "unresolved" }),
        wo({ id: "c", effectiveDate: "2026-07-21", completionState: "completed" }),
        wo({ id: "d", effectiveDate: "2026-08-19" }),
      ],
      "2026-08-20",
    );
    const html = render(createElement(BlockMap, { ...mapProps, weeks }));
    // The unresolved week must be visible even though it is past. Jul 13 is
    // the plan's 3rd week (start week 2026-06-29 → W1), so: "W3 · Jul 13".
    expect(html).toContain("W3 · Jul 13");
    expect(html).not.toContain("earlier weeks"); // run stops at the open question
  });

  it("expands the controlled week in place with a full WeekGrid", () => {
    const weeks = mapWeeks();
    const html = render(
      createElement(BlockMap, { ...mapProps, weeks, expandedWeekStart: "2026-08-24" }),
    );
    expect(html).toContain("map-expanded");
    expect(html).toContain("cal-day"); // the expanded WeekGrid
    expect(html).toContain('aria-expanded="true"');
  });

  it("renders ghost chips and the extend row", () => {
    const ghosts = new Map<string, PendingGhost[]>([
      ["2026-08-28", [{ kind: "incoming", label: "Easy 30", proposalId: "p9", title: "Add an easy 30" }]],
    ]);
    const html = render(
      createElement(BlockMap, {
        ...mapProps,
        weeks: mapWeeks(),
        ghosts,
        extendLabel: "+ extend Fall Half Marathon Build — the coach drafts the next weeks",
        onExtend: noop,
      }),
    );
    expect(html).toContain("map-chip-ghost");
    expect(html).toContain("+ extend Fall Half Marathon Build");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/ui/test/plan-map.test.tsx`
Expected: FAIL — `BlockMap` not exported.

- [ ] **Step 3: Implement**

Add to `plan-map.tsx` (needs `useState` — add `import { useState } from "react";`):

```tsx
/** Up to two mini-chips per day; 3+ becomes one chip with a count. */
function DayChips({ day, today, ghosts }: { day: BlockDay; today: string; ghosts: PendingGhost[] }) {
  const real = day.items.filter((w) => w.category !== "rest");
  const rest = day.items.length > 0 && real.length === 0;
  const incoming = ghosts.filter((g) => g.kind === "incoming" || g.kind === "rewrite");
  const leaving = ghosts.some((g) => g.kind === "outgoing" || g.kind === "skip");
  const chipFor = (w: WorkoutDto) => {
    const state = displayCompletionState(w, today);
    const cls = [
      "map-chip",
      `cat-${w.category}`,
      state === "completed" ? "is-done" : "",
      state === "missed" ? "is-missed" : "",
      state === "skipped" ? "is-skipped" : "",
      leaving ? "is-leaving" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return <i key={w.id} className={cls} title={w.title} />;
  };
  return (
    <span className="map-day" aria-hidden>
      {real.length > 2 ? (
        <i className={`map-chip cat-${real[0]!.category}`} title={`${real.length} workouts`}>
          <u className="map-chip-count">{real.length}</u>
        </i>
      ) : (
        real.map(chipFor)
      )}
      {rest && real.length === 0 ? <i className="map-chip map-chip-rest" title="Rest" /> : null}
      {real.length === 0 && !rest && incoming.length === 0 ? <i className="map-chip map-chip-empty" /> : null}
      {incoming.map((g, i) => (
        <i key={`g${i}`} className="map-chip map-chip-ghost" title={`${g.title} · pending`} />
      ))}
    </span>
  );
}

function weekAria(week: BlockWeek): string {
  return `Week of ${shortDate(week.weekStart)} — ${week.itemCount} workouts, ${formatHoursMinutes(week.plannedSeconds)} planned`;
}

function MapRow({
  week,
  today,
  plan,
  ghosts,
  expanded,
  onToggle,
}: {
  week: BlockWeek;
  today: string;
  plan: CoachPlanDto | null;
  ghosts: Map<string, PendingGhost[]>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const suffix = week.isCurrent
    ? " · now"
    : week.missedCount > 0
      ? ` · ${week.missedCount} missed`
      : week.isPast && week.itemCount > 0 && week.doneCount === week.itemCount
        ? " · ✓"
        : "";
  return (
    <button
      type="button"
      className={`map-row ${week.isCurrent ? "map-row-current" : ""} ${week.isPast ? "map-row-past" : ""}`}
      aria-expanded={expanded}
      aria-label={weekAria(week)}
      onClick={onToggle}
    >
      <span className="map-week-label">{weekMetaLabel(week.weekStart, plan)}</span>
      <span className="map-chips">
        {week.days.map((d) => (
          <DayChips key={d.date} day={d} today={today} ghosts={ghosts.get(d.date) ?? []} />
        ))}
      </span>
      <span className="map-total">
        {week.itemCount > 0 || week.isCurrent ? formatHoursMinutes(week.plannedSeconds) : ""}
        {suffix}
      </span>
    </button>
  );
}

const COLLAPSE_MIN = 3;

/** The whole block, one row per week; the controlled week expands in place. */
export function BlockMap({
  weeks,
  today,
  plan,
  ghosts,
  expandedWeekStart,
  onToggleWeek,
  onOpenWorkout,
  onGhostTap,
  extendLabel,
  onExtend,
}: {
  weeks: BlockWeek[];
  today: string;
  plan: CoachPlanDto | null;
  ghosts: Map<string, PendingGhost[]>;
  expandedWeekStart: string | null;
  onToggleWeek: (weekStart: string) => void;
  onOpenWorkout: (id: string) => void;
  onGhostTap: (proposalId: string) => void;
  extendLabel?: string | null;
  onExtend?: () => void;
}) {
  const [pastRevealed, setPastRevealed] = useState(false);
  // Leading run of past weeks with nothing unresolved is collapsible.
  let collapsibleEnd = 0;
  while (collapsibleEnd < weeks.length && weeks[collapsibleEnd]!.isPast && weeks[collapsibleEnd]!.askableCount === 0) {
    collapsibleEnd++;
  }
  const expandedInPast =
    expandedWeekStart != null && weeks.slice(0, collapsibleEnd).some((w) => w.weekStart === expandedWeekStart);
  const collapse = collapsibleEnd >= COLLAPSE_MIN && !pastRevealed && !expandedInPast;
  const visible = collapse ? weeks.slice(collapsibleEnd) : weeks;
  const hidden = collapse ? weeks.slice(0, collapsibleEnd) : [];
  const allDone = hidden.every((w) => w.itemCount === 0 || w.doneCount === w.itemCount);

  return (
    <div className="map">
      {collapse ? (
        <button type="button" className="map-past-toggle linklike" onClick={() => setPastRevealed(true)}>
          ▸ {hidden.length} earlier weeks{allDone ? " (all ✓)" : ""}
        </button>
      ) : null}
      {visible.map((week) => {
        const expanded = week.weekStart === expandedWeekStart;
        return (
          <div key={week.weekStart}>
            {week.monthLabel && !(collapse && week === visible[0] && hidden.length > 0 && hidden[hidden.length - 1]!.monthLabel === null) ? (
              <h3 className="map-month">{week.monthLabel}</h3>
            ) : null}
            <MapRow
              week={week}
              today={today}
              plan={plan}
              ghosts={ghosts}
              expanded={expanded}
              onToggle={() => onToggleWeek(week.weekStart)}
            />
            {expanded ? (
              <div className="map-expanded">
                <WeekGrid
                  days={week.days}
                  today={today}
                  ghosts={ghosts}
                  onOpenWorkout={onOpenWorkout}
                  onGhostTap={onGhostTap}
                />
              </div>
            ) : null}
          </div>
        );
      })}
      {extendLabel && onExtend ? (
        <button type="button" className="cal-extend-row" onClick={onExtend}>
          {extendLabel}
        </button>
      ) : null}
      <p className="map-legend faint" aria-hidden>
        <i className="map-chip cat-quality" /> quality <i className="map-chip cat-easy" /> easy{" "}
        <i className="map-chip cat-long" /> long <i className="map-chip cat-recovery" /> recovery{" "}
        <i className="map-chip map-chip-ghost" /> coach proposal <i className="map-chip is-missed cat-easy" /> missed
      </p>
    </div>
  );
}
```

Simplification note: that month-separator condition only needs to suppress a duplicate label right after the collapse toggle when the first visible week starts mid-month; if it reads muddy in review, replace with the plain `week.monthLabel ? <h3 …/> : null` — an occasionally-redundant month label is acceptable, a wrong one is not. Keep whichever passes the tests.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/ui/test/plan-map.test.tsx`
Expected: PASS. If a week-label assertion is off by one, recompute it by hand from `PLAN.startDate` (2026-06-29 = W1) and fix the **test**, not the code — `weekPosition` is pinned by its own test in Task 1.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/screens/plan-map.tsx packages/ui/test/plan-map.test.tsx
git commit -m "feat(ui): BlockMap — week rows, category chips, collapsed past, in-place expansion"
```

---

### Task 4: Coach window — seen-watermark logic + floating window/pill components

**Files:**
- Create: `packages/ui/src/screens/coach-window.tsx`
- Test: `packages/ui/test/coach-window.test.tsx` (new)

**Interfaces:**
- Consumes: `CoachStateResponse` from `@rg/api-client`; `IconChevron` not needed; renders `children` (plan.tsx passes `<CoachPanel …/>`).
- Produces:
  - `interface CoachSeenMark { at: string | null; proposalIds: string[]; questionId: string | null }`
  - `currentMark(state: Pick<CoachStateResponse, "messages" | "pendingProposals" | "openQuestion">): CoachSeenMark`
  - `hasNewActivity(seen: CoachSeenMark | null, cur: CoachSeenMark): boolean`
  - `loadCoachWindowPrefs(): { open: boolean; seen: CoachSeenMark | null }` / `storeCoachWindowPrefs(p: { open: boolean; seen: CoachSeenMark | null }): void` (localStorage `rg.coachWindow`; try/catch — storage may be unavailable)
  - `CoachWindow({ open, badge, onMinimize, onOpen, children }: { open: boolean; badge: number; onMinimize: () => void; onOpen: () => void; children: ReactNode })` — renders the window when `open`, else the `Coach · n` pill; `Esc` keydown on the window calls `onMinimize`.

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/test/coach-window.test.tsx`:

```tsx
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { CoachWindow, currentMark, hasNewActivity } from "../src/screens/coach-window.js";

const noop = () => undefined;
function render(el: React.ReactElement): string {
  return renderToStaticMarkup(createElement(MemoryRouter, null, el));
}

const msg = (id: string, role: string, at: string) => ({ id, role, body: "x", refs: {}, at }) as never;

describe("currentMark / hasNewActivity", () => {
  const state = {
    messages: [msg("1", "coach", "2026-08-06T10:00:00Z"), msg("2", "user", "2026-08-07T09:00:00Z")],
    pendingProposals: [{ id: "p1" }, { id: "p2" }] as never[],
    openQuestion: { id: "q1" } as never,
  };

  it("marks newest non-user message time, sorted proposal ids, question id", () => {
    expect(currentMark(state)).toEqual({
      at: "2026-08-06T10:00:00Z", // the user's own message never counts
      proposalIds: ["p1", "p2"],
      questionId: "q1",
    });
  });

  it("fires on first sight, new message, new proposal, or new question — not on removals", () => {
    const cur = currentMark(state);
    expect(hasNewActivity(null, cur)).toBe(true);
    expect(hasNewActivity(cur, cur)).toBe(false);
    expect(hasNewActivity(cur, { ...cur, at: "2026-08-07T11:00:00Z" })).toBe(true);
    expect(hasNewActivity(cur, { ...cur, proposalIds: ["p1", "p2", "p3"] })).toBe(true);
    expect(hasNewActivity(cur, { ...cur, proposalIds: ["p1"] })).toBe(false); // approved one away
    expect(hasNewActivity(cur, { ...cur, questionId: "q2" })).toBe(true);
    expect(hasNewActivity(cur, { ...cur, questionId: null })).toBe(false);
  });
});

describe("CoachWindow", () => {
  it("renders the window with a minimize control when open", () => {
    const html = render(
      createElement(CoachWindow, { open: true, badge: 2, onMinimize: noop, onOpen: noop }, "PANEL"),
    );
    expect(html).toContain("coach-window");
    expect(html).toContain("PANEL");
    expect(html).toContain("aria-label=\"Minimize coach\"");
    expect(html).not.toContain("coach-fab");
  });

  it("renders the badge pill when minimized", () => {
    const html = render(
      createElement(CoachWindow, { open: false, badge: 2, onMinimize: noop, onOpen: noop }, "PANEL"),
    );
    expect(html).toContain("coach-fab");
    expect(html).toContain("Coach");
    expect(html).toContain("2");
    expect(html).not.toContain("PANEL");
  });

  it("hides the badge count at zero", () => {
    const html = render(
      createElement(CoachWindow, { open: false, badge: 0, onMinimize: noop, onOpen: noop }, null),
    );
    expect(html).not.toContain("coach-fab-badge");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/ui/test/coach-window.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/ui/src/screens/coach-window.tsx`:

```tsx
import type { KeyboardEvent, ReactNode } from "react";
import type { CoachStateResponse } from "@rg/api-client";

/**
 * The desktop coach window (block-map spec 2026-08-07): the coach never takes
 * layout space. Open = a floating panel pinned to the right side; minimized =
 * a "Coach · n" pill. plan.tsx owns the open/seen state; this file owns the
 * watermark arithmetic and the chrome.
 */

export interface CoachSeenMark {
  at: string | null;
  proposalIds: string[];
  questionId: string | null;
}

/** What the athlete would be looking at right now — the user's own messages
 * never count as coach activity. */
export function currentMark(
  state: Pick<CoachStateResponse, "messages" | "pendingProposals" | "openQuestion">,
): CoachSeenMark {
  let at: string | null = null;
  for (const m of state.messages) {
    if (m.role === "user") continue;
    if (at === null || m.at > at) at = m.at;
  }
  return {
    at,
    proposalIds: state.pendingProposals.map((p) => p.id).sort(),
    questionId: state.openQuestion?.id ?? null,
  };
}

/** New coach activity since the watermark: a newer coach message, a proposal
 * we haven't seen, or a different open question. Removals never count, so
 * approving/declining doesn't reopen the window. */
export function hasNewActivity(seen: CoachSeenMark | null, cur: CoachSeenMark): boolean {
  if (!seen) return true;
  if (cur.at !== null && (seen.at === null || cur.at > seen.at)) return true;
  const known = new Set(seen.proposalIds);
  if (cur.proposalIds.some((id) => !known.has(id))) return true;
  if (cur.questionId !== null && cur.questionId !== seen.questionId) return true;
  return false;
}

const STORE_KEY = "rg.coachWindow";

export function loadCoachWindowPrefs(): { open: boolean; seen: CoachSeenMark | null } {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { open: false, seen: null };
    const parsed = JSON.parse(raw) as { open?: boolean; seen?: CoachSeenMark | null };
    return { open: parsed.open === true, seen: parsed.seen ?? null };
  } catch {
    return { open: false, seen: null };
  }
}

export function storeCoachWindowPrefs(p: { open: boolean; seen: CoachSeenMark | null }): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p));
  } catch {
    // Storage unavailable (private mode) — the window just won't remember.
  }
}

export function CoachWindow({
  open,
  badge,
  onMinimize,
  onOpen,
  children,
}: {
  open: boolean;
  badge: number;
  onMinimize: () => void;
  onOpen: () => void;
  children: ReactNode;
}) {
  if (!open) {
    return (
      <button type="button" className="coach-fab" onClick={onOpen}>
        Coach
        {badge > 0 ? <span className="coach-fab-badge">{badge}</span> : null}
      </button>
    );
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") onMinimize();
  };
  return (
    <section className="coach-window" aria-label="Coach" onKeyDown={onKeyDown}>
      <button
        type="button"
        className="coach-window-min btn btn-small"
        aria-label="Minimize coach"
        onClick={onMinimize}
      >
        —
      </button>
      {children}
    </section>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/ui/test/coach-window.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/screens/coach-window.tsx packages/ui/test/coach-window.test.tsx
git commit -m "feat(ui): coach window chrome + seen-watermark logic"
```

---

### Task 5: `SyncPanel quietWhenHealthy`

**Files:**
- Modify: `packages/ui/src/screens/today.tsx` (SyncPanel, ~line 35)
- Test: `packages/ui/test/plan-map.test.tsx` (extend — pure helper test)

**Interfaces:**
- Produces: `SyncPanel({ quietWhenHealthy }: { quietWhenHealthy?: boolean })` — unchanged default; and exported pure helper `syncIsQuiet(state: SyncStatusDto["state"], noteCount: number): boolean`.

- [ ] **Step 1: Write the failing test**

Append to `packages/ui/test/plan-map.test.tsx`:

```tsx
import { syncIsQuiet } from "../src/screens/today.js";

describe("syncIsQuiet", () => {
  it("is quiet when in sync or updates are off, loud when moving/broken or notes exist", () => {
    expect(syncIsQuiet("in_sync", 0)).toBe(true);
    expect(syncIsQuiet("not_synced", 0)).toBe(true); // Settings owns that message
    expect(syncIsQuiet("syncing", 0)).toBe(false);
    expect(syncIsQuiet("waiting_for_mac", 0)).toBe(false);
    expect(syncIsQuiet("sync_issue", 0)).toBe(false);
    expect(syncIsQuiet("in_sync", 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/ui/test/plan-map.test.tsx`
Expected: FAIL — `syncIsQuiet` not exported.

- [ ] **Step 3: Implement**

In `today.tsx`, above `SyncPanel`:

```tsx
/** The Plan page's banner slot goes silent when there's nothing to act on
 * ("normal earns silence"). `not_synced` is quiet too — Settings owns that
 * message; a permanent banner on Plan would just be nagging. */
export function syncIsQuiet(state: SyncStatusDto["state"], noteCount: number): boolean {
  return (state === "in_sync" || state === "not_synced") && noteCount === 0;
}
```

(Import `SyncStatusDto` type from `@rg/api-client` if not already imported.) Then change the signature and the early return of `SyncPanel`:

```tsx
export function SyncPanel({ quietWhenHealthy = false }: { quietWhenHealthy?: boolean } = {}) {
```

and replace `if (!status.data) return null;` with:

```tsx
  if (!status.data) return null;
  const noteCount = (notes.data?.notes ?? []).length;
  if (quietWhenHealthy && syncIsQuiet(status.data.state, noteCount)) return null;
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run packages/ui/test/plan-map.test.tsx && pnpm --filter @rg/ui exec tsc --noEmit`
Expected: PASS, no type errors (Today/Garden call sites pass no props — default keeps them unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/screens/today.tsx packages/ui/test/plan-map.test.tsx
git commit -m "feat(ui): SyncPanel quietWhenHealthy — the Plan banner earns silence"
```

---

### Task 6: Styles + wide shell route

**Files:**
- Modify: `packages/ui/src/shell.tsx`
- Modify: `packages/ui/src/styles.css` (append a new section; delete nothing yet)

**Interfaces:**
- Produces: `.shell-main--wide` on the `/plan` route; CSS for `.wkgrid*`, `.hero-week-summary`, `.map*`, `.coach-window*`, `.coach-fab*`. Class names must match Tasks 2–4 exactly.

- [ ] **Step 1: Shell change**

In `shell.tsx`, extend the route-class logic:

```tsx
  const immersive = pathname === "/" || pathname === "/garden";
  const wide = pathname === "/plan";
  // …
  <main className={`shell-main${immersive ? " shell-main--immersive" : ""}${wide ? " shell-main--wide" : ""}`}>
```

(Note: `/` currently maps to Garden in `app.tsx`; do not touch `immersive`.)

- [ ] **Step 2: Append CSS**

Append to `styles.css` under a new banner comment `/* ── Plan block map (2026-08-07-plan-page-block-map-design.md) ─────────── */`:

```css
@media (min-width: 1024px) {
  .shell-main--wide { max-width: 1440px; }
}

/* This-week hero */
.hero-week-head {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--green-ink);
  margin: 0 0 0.4rem;
}
.hero-week-summary { font-size: 0.85rem; margin: 0.45rem 0 1.1rem; }
.hero-week-summary strong { color: var(--green-ink); }
/* WeekGrid cells reuse .cal-week/.cal-day wholesale; the grid just always
 * shows the in-cell weekday (there is no separate header row any more). */
.wkgrid .cal-dow { display: inline; }
.wkgrid-hero .cal-day { min-height: 92px; }

/* The block map */
.map { display: flex; flex-direction: column; gap: 2px; }
.map-month {
  font-family: var(--font-display);
  font-size: 1rem;
  font-weight: 600;
  color: var(--ink-soft);
  margin: 0.7rem 0 0.2rem 0.3rem;
}
.map-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.3rem 0.45rem;
  border: 0;
  background: transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  width: 100%;
}
.map-row:hover { background: var(--bg-sunken, #f1ecdf); }
.map-row-current { background: var(--green-soft); }
.map-row-current:hover { background: var(--green-soft); }
.map-row-past { opacity: 0.62; }
.map-week-label { flex: none; width: 5.2rem; font-size: 0.72rem; color: var(--ink-faint); }
.map-chips { display: flex; gap: 0.3rem; flex: 1; min-width: 0; }
.map-day { display: inline-flex; gap: 2px; }
.map-chip {
  width: 15px;
  height: 15px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-style: normal;
  position: relative;
  flex: none;
}
.map-chip.is-done::after { content: "✓"; color: #fff; font-size: 9px; line-height: 1; }
.map-chip.is-missed { opacity: 0.45; box-shadow: inset 0 0 0 1.5px var(--warn, #b3593a); }
.map-chip.is-skipped { opacity: 0.35; }
.map-chip.is-leaving { border: 1.5px dashed var(--warn, #b3593a); }
.map-chip-rest { background: transparent; border: 1px solid var(--border); }
.map-chip-empty { background: var(--bg-sunken, #efeadb); opacity: 0.6; }
.map-chip-ghost { background: #fdf3df; border: 1.5px dashed #d9a648; }
.map-chip-count { font-size: 9px; color: #fff; text-decoration: none; font-weight: 700; }
.map-total { flex: none; min-width: 5.5rem; text-align: right; font-size: 0.72rem; color: var(--ink-faint); }
.map-past-toggle { align-self: flex-start; font-size: 0.78rem; padding: 0.25rem 0.45rem; }
.map-expanded {
  border: 1px solid var(--border-strong, var(--border));
  border-radius: var(--radius);
  background: var(--bg-raised);
  padding: 0.5rem 0.55rem;
  margin: 0.2rem 0 0.45rem;
}
.map-legend { display: flex; align-items: center; gap: 0.45rem; flex-wrap: wrap; margin-top: 0.6rem; font-size: 0.72rem; }
.map-legend .map-chip { width: 11px; height: 11px; }

/* Coach window + pill (desktop only; mobile keeps .coach-pill + Sheet) */
.coach-window { display: none; }
.coach-fab { display: none; }
@media (min-width: 1024px) {
  .coach-window {
    display: flex;
    flex-direction: column;
    position: fixed;
    top: 0.9rem;
    bottom: 0.9rem;
    right: max(0.9rem, calc((100vw - 1650px) / 2 + 0.9rem));
    width: min(440px, 38vw);
    z-index: 45; /* above content, below sheets (60) */
    background: var(--bg-raised);
    border: 1px solid var(--border-strong, var(--border));
    border-radius: var(--radius);
    box-shadow: -14px 10px 40px rgba(60, 50, 20, 0.16);
  }
  .coach-window > .coach-panel { border: 0; max-height: none; flex: 1; min-height: 0; }
  .coach-window-min { position: absolute; top: 0.55rem; right: 0.6rem; z-index: 2; }
  .coach-fab {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    position: fixed;
    bottom: 1.1rem;
    right: max(1.1rem, calc((100vw - 1650px) / 2 + 1.1rem));
    z-index: 45;
    background: var(--green, #3c6b4f);
    color: #fff;
    border: 0;
    border-radius: 999px;
    padding: 0.55rem 1rem;
    font-weight: 600;
    font-size: 0.9rem;
    cursor: pointer;
    box-shadow: 0 6px 20px rgba(40, 60, 40, 0.3);
  }
  .coach-fab-badge {
    background: #e5b96d;
    color: #4a3a10;
    border-radius: 999px;
    padding: 0 0.4rem;
    font-size: 0.75rem;
  }
}
@media (prefers-reduced-motion: no-preference) {
  .map-expanded { animation: mapExpand 160ms ease-out; }
  @keyframes mapExpand {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: none; }
  }
}
```

Adjustment rule: where a `var(--x, fallback)` above guesses a token (`--bg-sunken`, `--border-strong`, `--warn`, `--green`), check `:root` at the top of styles.css — if the token exists, drop the fallback; if not, keep the literal. The `1650px` in the window/fab pinning = side-nav 210px + `--wide` max 1440px, so the window hugs the content edge on ultrawides.

`.coach-window` header: the existing `CoachPanel` header row renders inside it; the absolute-positioned minimize button overlays its top-right corner next to "Check in" (adjust `right` so they don't overlap — "Check in" sits ~5rem in; use `right: 0.6rem` and give `.coach-window > .coach-panel .coach-panel-head` an extra `padding-right: 2.6rem`):

```css
  .coach-window > .coach-panel .coach-panel-head { padding-right: 2.6rem; }
```

- [ ] **Step 3: Verify no regressions**

Run: `pnpm vitest run packages/ui/test && pnpm --filter @rg/ui exec tsc --noEmit`
Expected: all green (CSS is inert until Task 7 mounts the classes; shell change only adds a class).

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/shell.tsx packages/ui/src/styles.css
git commit -m "feat(ui): wide shell route for /plan + block-map/coach-window styles"
```

---

### Task 7: Rewire `PlanScreen` — hero + map + coach window; retire the month grid

**Files:**
- Modify: `packages/ui/src/screens/plan.tsx`
- Test: `packages/ui/test/plan-map.test.tsx` (extend with a screen-level static render is NOT possible — PlanScreen uses queries; coverage comes from the component tests above + the visual pass in Task 8)

**Interfaces:**
- Consumes everything produced in Tasks 1–6. No new exports.

- [ ] **Step 1: Rewrite the render**

In `plan.tsx`:

1. **Imports:** add
   ```tsx
   import {
     activePlanFor,
     askable,
     BlockMap,
     buildWeeks,
     displayCompletionState,
     weekPosition,
     WeekGrid,
     WeekSummaryLine,
     WorkoutCell,
   } from "./plan-map.js";
   import {
     CoachWindow,
     currentMark,
     hasNewActivity,
     loadCoachWindowPrefs,
     storeCoachWindowPrefs,
     type CoachSeenMark,
   } from "./coach-window.js";
   ```
   (Keep existing imports; `startOfIsoWeek`/`addDays` stay.)

2. **Delete** the `buildMonths` function, the `CalMonth`/`CalWeek` interfaces (keep `CalDay` only if still referenced — it isn't; `BlockDay` replaces it), the `WEEKDAY_HEADERS` const, and the `todayRef`/`scrolled` scroll-to-today effect. Keep `usePlanCoach`, `focusProposal`, `WorkoutDetail`, `pendingByDate` usage as-is.

3. **Coach window state** — add inside `PlanScreen`, after `const coach = usePlanCoach();`:

   ```tsx
   const [winPrefs, setWinPrefs] = useState(loadCoachWindowPrefs);
   const coachCur = coach.state.data ? currentMark(coach.state.data) : null;
   const windowOpen = winPrefs.open || (coachCur != null && hasNewActivity(winPrefs.seen, coachCur));
   const openWindow = () => {
     const next = { ...winPrefs, open: true };
     setWinPrefs(next);
     storeCoachWindowPrefs(next);
   };
   const minimizeWindow = () => {
     const next: { open: boolean; seen: CoachSeenMark | null } = { open: false, seen: coachCur ?? winPrefs.seen };
     setWinPrefs(next);
     storeCoachWindowPrefs(next);
   };
   const badge = (coach.state.data?.pendingProposals.length ?? 0) + (coach.state.data?.openQuestion ? 1 : 0);
   ```

4. **Week assembly** — replace the `months` memo:

   ```tsx
   const weeks = useMemo(
     () => buildWeeks(plan.data?.workouts ?? [], plan.data?.today),
     [plan.data],
   );
   const activePlan = activePlanFor(coachPlans.data?.plans, plan.data?.today);
   const currentWeek = weeks.find((w) => w.isCurrent) ?? null;
   const [expandedWeek, setExpandedWeek] = useState<string | null>(null);
   ```

5. **Deep-link auto-expand** — after `const selected = …`:

   ```tsx
   // A workout opened by URL may live in a week the map has folded away —
   // expand its week so closing the sheet leaves you looking at the right place.
   useEffect(() => {
     if (!selected || !today) return;
     const ws = startOfIsoWeek(selected.effectiveDate);
     if (ws !== startOfIsoWeek(today)) setExpandedWeek(ws);
     // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [selectedId, plan.data]);
   ```

6. **Ghost tap** — replace `onGhostTap`:

   ```tsx
   const onGhostTap = (proposalId: string) => {
     if (window.matchMedia("(min-width: 1024px)").matches) openWindow();
     else setCoachOpen(true);
     focusProposal(proposalId);
   };
   ```

7. **Render** — replace everything inside the outer `<div>` of the return with:

   ```tsx
   <div className="row-between screen-title">
     <h1>Plan</h1>
     <div className="row">
       {plan.data.plan ? <span className="muted">{plan.data.plan.name}</span> : null}
       <button className="btn btn-small" onClick={() => setManageOpen(true)}>
         Manage plans ▾
       </button>
     </div>
   </div>
   <SyncPanel quietWhenHealthy />
   {plan.data.workouts.length === 0 ? (
     <EmptyState art="🗓" title="No active COROS training plan was found">
       Start a plan in COROS, then refresh from the desktop app.
     </EmptyState>
   ) : (
     <>
       {currentWeek && today ? (
         <section aria-label="This week">
           <h2 className="hero-week-head">
             This week · {monthTitle(currentWeek.weekStart).month.slice(0, 3)} {dayOfMonth(currentWeek.weekStart)}–{dayOfMonth(addDays(currentWeek.weekStart, 6))}
           </h2>
           <WeekGrid
             hero
             days={currentWeek.days}
             today={today}
             ghosts={ghostsByDate}
             onOpenWorkout={openWorkout}
             onGhostTap={onGhostTap}
           />
           <WeekSummaryLine week={currentWeek} position={weekPosition(currentWeek.weekStart, activePlan)} />
         </section>
       ) : null}
       <section aria-label="The block">
         <h2 className="hero-week-head" style={{ color: "var(--ink-faint)" }}>The block</h2>
         <BlockMap
           weeks={weeks}
           today={today!}
           plan={activePlan}
           ghosts={ghostsByDate}
           expandedWeekStart={expandedWeek}
           onToggleWeek={(ws) => setExpandedWeek((cur) => (cur === ws ? null : ws))}
           onOpenWorkout={openWorkout}
           onGhostTap={onGhostTap}
           extendLabel={
             activeCoachPlans.length > 0
               ? `+ extend ${activeCoachPlans[0]!.name} — the coach drafts the next weeks`
               : null
           }
           onExtend={() =>
             cannedSend(`Extend "${activeCoachPlans[0]!.name}" — draft the next weeks in the same shape.`)
           }
         />
       </section>
     </>
   )}
   <StudioSection />

   <CoachWindow open={windowOpen} badge={badge} onMinimize={minimizeWindow} onOpen={openWindow}>
     {coachPanelEl}
   </CoachWindow>

   <button type="button" className="coach-pill" onClick={() => setCoachOpen(true)}>
     Coach{pendingCount > 0 ? ` · ${pendingCount}` : ""}
   </button>
   <Sheet open={coachOpen} onClose={() => setCoachOpen(false)} title="Coach">
     …(unchanged mobile sheet body)…
   </Sheet>
   <Sheet open={manageOpen} …>…(unchanged)…</Sheet>
   {selected && today ? <WorkoutDetail …(unchanged)… /> : null}
   ```

   Details that matter:
   - `monthTitle`/`dayOfMonth`/`addDays` are already imported; add `monthTitle` to the components import if missing.
   - `coachPanelEl` (the existing fallback-aware CoachPanel element) moves INSIDE `CoachWindow` — delete the old `plan-split` wrapper divs entirely.
   - The old `.coach-pill` button + mobile `Sheet` stay byte-identical (CSS keeps them mobile-only).
   - `SyncPanel` moves above the hero with `quietWhenHealthy`.
   - `StudioSection` now renders right after the map (before the coach window markup).
   - Keep the `Today`-button deletion: no `todayRef` anywhere.

- [ ] **Step 2: Typecheck + full UI tests**

Run: `pnpm --filter @rg/ui exec tsc --noEmit && pnpm vitest run packages/ui/test`
Expected: green. Fix any dangling references (`buildMonths`, `todayRef`, `months`) the compiler finds.

- [ ] **Step 3: Visual smoke against the fixture stack**

With :5173/:8787 up (see Global Constraints), write `apps/web/scripts/tmp-verify.mjs`:

```js
import { chromium } from "@playwright/test";
const BASE = "http://localhost:5173";
const browser = await chromium.launch();
for (const [name, vp] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
  await ctx.request.post(`${BASE}/api/dev/fixture-login`);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/plan`, { waitUntil: "networkidle" });
  await page.waitForSelector(".map-row, .empty-state", { timeout: 30000 });
  await page.screenshot({ path: `/tmp/plan-verify-${name}.png`, fullPage: true });
  await ctx.close();
}
await browser.close();
console.log("ok");
```

Run: `cd apps/web && node scripts/tmp-verify.mjs && rm scripts/tmp-verify.mjs`, then **Read both PNGs** and check against the mockups (`.superpowers/brainstorm/*/content/block-map-v2.html`): hero week with full titles; map rows with chips/totals/month separators; studio card after the map; coach window or fab on desktop; pill + one-column layout on phone; no horizontal scrollbar.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/screens/plan.tsx
git commit -m "feat(ui): Plan screen becomes this-week hero + block map with floating coach window"
```

---

### Task 8: Cleanup, full suite, screenshots

**Files:**
- Modify: `packages/ui/src/styles.css` (delete dead rules)
- Modify: `screenshots/` (regenerate)

- [ ] **Step 1: Delete dead CSS**

Remove from `styles.css` (verify each is truly unreferenced first with `grep -rn "<class>" packages/ui/src apps`):
- `.plan-split` block (~line 3345) and `.plan-split > .coach-panel`
- `.cal-month`, `.cal-month-title`, `.cal-year`, `.cal-weekdays` rules (the month chrome; **keep** `.cal-week`, `.cal-day`, `.cal-date`, `.cal-dow`, `.cal-dom`, `.cal-card*`, `.cal-ghost*`, `.cal-rest`, `.cal-extend-row` — WeekGrid uses them)
- The `.cal-week.current` highlight rule if it only served the old today-scroll (grep first; WeekGrid never sets `current`)

- [ ] **Step 2: Full test suite + typecheck (Node 21)**

Run from repo root: `pnpm test`
Expected: all green (216+ tests). Also `pnpm --filter @rg/ui exec tsc --noEmit`.

- [ ] **Step 3: Regenerate the screenshot set**

With :5173/:8787 up: `cd apps/web && node scripts/screenshots.mjs`
Then Read `screenshots/plan__1440x900__light.png`, `plan__390x844__light.png`, `plan__1280x800__dark.png` — dark mode must not produce unreadable chips (chips use `.cat-*` backgrounds which already have dark-mode handling if any; if chips vanish in dark, add a dark-scheme override for `.map-chip-empty`/`.map-chip-rest` borders).

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/styles.css screenshots/
git commit -m "chore(ui): retire month-grid styles; refresh screenshots for the block map"
```

(If `screenshots/` is gitignored, commit only styles.css.)

---

## Self-review notes (already applied)

- Spec §hero "ghost cards in day cells" → WeekGrid ghosts (Task 2). §map ghost chips → DayChips (Task 3). §window watermark → Task 4 `hasNewActivity` with removal-immunity. §sync quiet → Task 5. §wide route → Task 6. §deep-link expand, §studio relocation, §Today-button removal, §extend row → Task 7. §cleanup → Task 8.
- Not covered anywhere on purpose (spec's out-of-scope): detail-in-pane, drag-to-move, sparklines.
- Type consistency: `BlockWeek`/`BlockDay`/`CoachSeenMark` names match across Tasks 1–7; `WeekGrid` prop `ghosts` is always `Map<string, PendingGhost[]>`.
