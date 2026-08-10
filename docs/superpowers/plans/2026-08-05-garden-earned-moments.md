# Garden Earned Moments (Bundle 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface three finished-but-invisible features per `docs/superpowers/specs/2026-08-05-garden-earned-moments-design.md`: record recency, weekly-review discovery, and the sanctioned weekly chain (replacing the canon-violating daily streak).

**Architecture:** Pure client rules (`isRecentRecord`, `reviewUnseen`) + three small render additions; the only data plumbing is Insights reading the already-cached `["garden"]` query for the chain.

**Tech Stack:** React + TanStack Query, vitest (Node 21).

## Global Constraints

- Node 21 for tests; `git add` specific paths only (SIGKILL); no engine changes; canon copy rules (quiet, never render a zero).

---

### Task 1: pure helpers + tests

**Files:**
- Modify: `packages/ui/src/charts-math.ts` (add `isRecentRecord`, `reviewUnseen`; delete `currentStreak` if insights is its only consumer)
- Test: `packages/ui/test/charts-math.test.ts`

**Interfaces (produces):**
```ts
export function isRecentRecord(dateIso: string, todayIso: string): boolean; // true when 0 ≤ today − date ≤ 7 days
export function reviewUnseen(latestWeekStart: string | null, stored: string | null): boolean; // true when latest exists and stored is null or older
```

- [ ] **Step 1: failing tests** — boundary at exactly 7 days (true), 8 days (false), future-dated (false), malformed date (false); reviewUnseen with null latest (false), null stored (true), equal (false), older stored (true).
- [ ] **Step 2: implement** — `Date.parse` based, `Number.isNaN` guards; `reviewUnseen = (l, s) => !!l && (!s || s < l)`.
- [ ] **Step 3: grep `currentStreak` consumers**; if only insights.tsx, delete fn + its tests in the same commit as Task 3 (not here — insights still calls it until then).
- [ ] **Step 4: run ui suite, commit** `feat(ui): record-recency and review-unseen helpers`.

### Task 2: ReviewPull + record pills

**Files:**
- Modify: `packages/ui/src/screens/today.tsx` (add `ReviewPull` beside `EvidenceCard`, export it; render inside garden's plumbing via today.tsx exports)
- Modify: `packages/ui/src/screens/garden.tsx` (mount `<ReviewPull />` in `plumbing` after `<EvidenceCard />`)
- Modify: `packages/ui/src/screens/insights.tsx` (record rows: "New" pill via `isRecentRecord`; latest review header pill via `reviewUnseen`; store `rg-review-seen` when the review card is opened/rendered-open)
- Modify: `packages/ui/src/styles.css` (a `.new-ring` shared pill if codex's isn't reusable as-is)

**Interfaces:** `ReviewPull()` — no props; reads `useQuery({queryKey: ["insights"], queryFn: () => api.insights()})` (same key as EvidenceCard), renders `null` unless `reviewUnseen(latest.weekStart, localStorage["rg-review-seen"])` and `latest.narrative`; click = `localStorage.setItem` + `<Link to="/insights">`.

- [ ] **Step 1:** implement `ReviewPull` (Link-based; storage in try/catch), mount in garden plumbing.
- [ ] **Step 2:** insights record pill: `{isRecentRecord(r.date, today) ? <span className="new-ring">New</span> : null}`; today from the existing screen date source (`new Date().toISOString().slice(0,10)`).
- [ ] **Step 3:** insights review card: pill on the latest week when unseen; `useEffect` stores `rg-review-seen = latest.weekStart` once the card has rendered open (the latest `<details>` is open by default per `insights.tsx:481-498` — storing on mount of the Insights screen with a review present is the honest "seen").
- [ ] **Step 4:** run ui suite + typecheck, commit `feat(garden): weekly-review pull line + record recency pills`.

### Task 3: the sanctioned streak

**Files:**
- Modify: `packages/ui/src/screens/insights.tsx` (delete daily `streak-note`; add chain line from `["garden"]` cache)
- Modify: `packages/ui/src/charts-math.ts` + `packages/ui/test/charts-math.test.ts` (delete `currentStreak` + tests if unconsumed)

- [ ] **Step 1:** in InsightsScreen add `const garden = useQuery({ queryKey: ["garden"], queryFn: api.garden, staleTime: 5 * 60_000 });` and `const chain = (garden.data?.snapshot as GardenSnapshot | undefined)?.state.consecutiveConsistentWeeks ?? 0;`
- [ ] **Step 2:** replace the `streak-note` block with `{chain >= 1 ? <p className="streak-note">{chain} consistent week{chain === 1 ? "" : "s"} — the vines climb with it.</p> : null}`.
- [ ] **Step 3:** remove `currentStreak` import/usage; delete the helper + its tests if no other consumer (verified in Task 1 Step 3).
- [ ] **Step 4:** full ui suite + typecheck, commit `feat(insights): weekly chain replaces the daily streak (canon §1.3)`.

### Task 4: verify + ship

- [ ] `pnpm test` (Node 21) all green; `pnpm typecheck` clean; push; `gh run watch` both workflows to success.
