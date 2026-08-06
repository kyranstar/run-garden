# Coach Panel UX (Plan B of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The B2 direction made real per `docs/superpowers/specs/2026-08-06-coach-ux-design.md`: coach panel beside the always-visible plan, pinned self-expiring proposal tray, ghost diffs on the calendar, memory in Settings — on the Plan A backend that is already live.

**Architecture:** Presentational components in a new `packages/ui/src/screens/coach-panel.tsx` (static-markup testable, mirroring arrival-block.tsx's pattern); data wiring inside `plan.tsx` (coachState query + wake-if-advised + mutations); calendar ghosting derives purely from pending proposals' ops.

**Tech Stack:** React + TanStack Query, existing design tokens/Sheet/Card/Drawer primitives, vitest static-markup tests (Node 21).

## Global Constraints

Node 21 tests; specific-path `git add`; reuse the mock's visual grammar (coach-shared.css translated into styles.css tokens); proposals render ONLY from `pendingProposals` (never scrollback); all reduced-motion guards on new animations; commit per task; push when green.

---

### Task B1: presentational components + tests
**Files:** create `packages/ui/src/screens/coach-panel.tsx`; styles in `styles.css`; test `packages/ui/test/coach-panel.test.tsx`.
**Produces:** `ProposalCard({proposal, onApprove, onDecline, busy})` — discipline pill (derived from ops sessions), diff-style title row, evidence line, flags as warn chips, Make it so / contextual decline / Why? (expands rationale inline); `PendingTray({proposals, ...})` — "Needs you · N", cap 4 + "and N more"; `CoachThread({messages})` — coach/user bubbles, centered receipts, memory-chip rendering from refs.memoryIds (chips link to Settings); `CoachComposer({onSend, question, onAnswer, busy})` — input + Send, question chips row, "Coach is thinking…" state; `CoachPanel` — assembles header (`what I know →` → /settings#coach-memory), tray, thread (scroll), composer.
Tests (static markup): tray caps at 4; proposal shows flags + both actions; receipts render centered/inert (no buttons); question chips render; empty tray renders no "Needs you" chrome.

### Task B2: plan.tsx integration
**Files:** modify `packages/ui/src/screens/plan.tsx`; `styles.css` (split grid + mobile pill/sheet).
**Produces:** desktop ≥1024px: `.plan-split` two-column (panel ~44% sticky left, calendar right); mobile: calendar + fixed `Coach · N` pill opening a full-height `Sheet` containing the panel. Data: `useQuery(["coach-state"], api.coachState)`; on mount, if `wakeAdvised` → `api.coachWake()` then invalidate coach-state (spinner-free: panel renders cached state while the wake streams in); mutations approve/decline/message/answer each invalidate `["coach-state"]` (+ approve invalidates `["plan"]`, `["today"]`, `["garden"]`); optimistic busy states. "Manage plans ▾" button in the plan header (Task B4's sheet).

### Task B3: calendar ghosts
**Files:** modify `plan.tsx` (calendar cell rendering) + `styles.css`.
**Produces:** pure helper `pendingByDate(proposals)` in coach-panel.tsx (exported, tested): maps ops → per-date `{kind: 'rewrite'|'incoming'|'outgoing'|'skip', label, proposalId}` (ease→rewrite old/new stack; move→outgoing on from-date + incoming on to-date; add/firmUp/reshape→incoming; skip→struck). Calendar cells with entries get `.pending-day` glow + ghost chips (`wk-ghost-old`/`wk-ghost-new` grammar from the mock) + reason chip = proposal title; clicking a ghost focuses that proposal card (scroll+flash via element id `proposal-{id}`). After the last plan week of an active coached plan: the ghost "+ extend {name}" row → sends the canned message "Extend {name} — draft the next weeks" through the composer.

### Task B4: Manage plans + Settings memory
**Files:** `coach-panel.tsx` (+`ManagePlansSheet`), `settings.tsx` (+`CoachMemorySection`), `styles.css`.
**Produces:** ManagePlansSheet — plan cards (name, discipline pill, wk X/Y bar, status) with Extend/Wind down (canned coach messages), Retire (confirm → `coachPlanRetire`), Rename (inline input); "New plan" → canned intake message ("I want a new {run|lifting} plan — interview me"); "Import from COROS" hidden until a later lane (needs adoption tooling — out of scope note). Settings section: grouped memory list (About you / Rules / Notes) with edit (inline) + delete via api, provenance line, anchored `#coach-memory`.
Tests: memory section markup (groups, delete button per row); ManagePlansSheet statuses.

### Task B5: verify + ship
Full suite Node 21 + typecheck; visual pass via vite dev + Chrome screenshots (desktop split, mobile pill/sheet, ghost diffs with a seeded pending proposal in fixture mode if cheap — else static states); push; watch CI+Deploy.
