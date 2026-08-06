# The Coach — UX Design (phase 1 of 3)

*2026-08-06 · Direction chosen from four browser mocks (A briefing / B conversation / C living-plan / B2 hybrid — session scratchpad); user committed to **B2: coach panel beside an always-visible plan, proposals as self-expiring state**. This spec covers the UX layer only. Phase 2 (separate brainstorm): coach intelligence/backend. Phase 3: coach↔garden incentive loop. Decisions locked during brainstorm: **propose + one-tap approve** (nothing touches the watch without the user), **the coach authors both running and lifting plans** (app-authored programs pushed to COROS; existing COROS plan importable once as a starting template), **user-driven invocation with a ~$20/wk budget guard** (the coach thinks when the user shows up or when a cheap trigger fires — no constant background churn).*

## The one-paragraph idea

The Plan page stops being "a calendar with an add-a-lifting-plan button" and becomes **the coach's room**: a conversation panel on the left where a real coach briefs you, asks at most one good question, and pins the changes it wants to make; and your plan on the right, always visible, where every pending change is drawn as a ghost diff on the exact day it touches. Proposals are state, not chat bubbles — they exist in exactly one place (the pending tray), and the moment one is resolved or stale it collapses into an inert receipt line. Freetext in, structured plan changes out, memory accumulating visibly and editable in Settings.

## 1. Information architecture

- **Route:** `/plan` becomes the coach + plan split. The almanac calendar (today's `plan.tsx`) survives as the right pane. The studio's generate→draft→push flow is absorbed under **Manage plans** (§7); `StudioSection` as a separate embedded block disappears.
- **Desktop (≥1024px):** two-column grid — coach panel (~45%, sticky, own scroll) left, plan calendar right.
- **Mobile:** the calendar is the page; the coach panel is a full-height sheet summoned by a persistent **Coach pill** (bottom), which carries the pending-count badge ("Coach · 2"). The pending tray renders as the sheet's header section.
- **Settings** gains a **Coach memory** section (§6) and keeps the existing COROS-writes toggle, which the coach UX must respect (§9).

## 2. The coach panel

Top-to-bottom anatomy:

1. **Header:** "Coach" + `what I know →` link (opens memory, §6).
2. **Pending tray — "Needs you · N".** The ONLY place live proposals render (never inline in scrollback). Each proposal card:
   - discipline pill (Run/Lift) + a one-line **diff row** (`old → new`, same visual grammar as the studio's diff and the mock);
   - a one-line **reason** in muted text (the coach's evidence: "slept 5h avg · HRV −9% · tempo → Tue");
   - actions: **Make it so** (primary), a contextual decline (**Leave it** / **Skip it instead**), **Why?** (expands the coach's full reasoning inline — never a modal);
   - multi-day proposals (a travel-week reshape) render as one card with a stacked diff list and a single approve — one decision, not five.
   - Tray order: soonest-affected day first. Tray cap: if > 4, the rest collapse behind "and N more".
3. **Thread.** Message kinds, all visually distinct:
   - **coach prose** (left, sunken background) — briefings, reasoning, follow-ups;
   - **user messages** (right, green);
   - **memory chips** rendered inline the moment extraction happens (`memory: travel Aug 13–16`) — tapping one opens it in the memory editor;
   - **receipts** (centered, faint, one line): the inert historical record of resolved proposals and notable machine events — "Mon · ✓ approved — moved Sunday's recovery" / "Thu · expired — the day passed" / "✓ pushed 2 changes to the watch". Receipts are never interactive beyond a tap-to-expand showing the frozen detail.
4. **Composer:** freetext input ("Tell your coach anything…") + Send. Below it, the **open-question chips** (§5). While the coach is working the composer shows a lightweight "Coach is thinking…" state; the coach's reply streams into the thread.

## 3. Proposals: the state machine the UI shows

`draft → pending → approved | declined | superseded | expired`

- **pending** — in the tray, ghost on the calendar.
- **approved** — leaves the tray instantly; receipt appears; calendar ghost resolves into the real workout with a brief settle animation; the change enters the existing push/verify machinery (studio-style stamped write; sync state visible on the workout as today).
- **declined** — leaves the tray; receipt "left it as planned"; the coach may ask ONE follow-up in the thread, never re-propose the same change unchanged.
- **superseded** — the coach replaced it with a newer draft (new data arrived): old card vanishes, receipt notes "superseded", new card appears. At most one live proposal per (plan, day).
- **expired** — its first affected day passed, or a 72h TTL elapsed: silently leaves the tray, receipt "expired — the day passed". **Expired/resolved proposals are never clickable anywhere** (the user's explicit requirement).
- **Undo:** approving shows a 10s inline "Undo" on the receipt before the write dispatches (aligns with the existing sync-intent machinery rather than fighting it).

## 4. The calendar as proposal canvas

- Days touched by a pending proposal get a **pending glow** (warm background) and stack `old (struck, faded)` above `new (green, dashed outline)` with a tiny reason chip ("slept 5h — eased").
- Tapping a pending day **focuses its proposal card** in the panel (scroll + flash) — approval always happens in the tray, so there is exactly one approve surface.
- Approved changes settle into normal workout chips; the existing workout sheet (open workout → details/move/skip) is unchanged and remains the manual-control escape hatch.
- **Extend affordance:** after the plan's final week, a ghost week row — "+ extend Fall Half Block" — opens the extend flow (§7).
- Anchors the coach must respect (long runs on Saturdays etc.) are memory items (§6), and when one drives a decision the reason chip says so ("Saturday untouched — your rule").

## 5. Questions: never redundant, never a wall

- The coach asks **at most one question at a time**, rendered as chips above the composer (quick answers + "Something else…" free reply). A faint counter ("1 open question") when one is pending.
- Every answer writes to memory with provenance; the memory store is checked before asking — **a question whose answer is already in memory is a bug** by definition of phase 2's contract, and the UX reinforces it: each question card shows "asked once, remembered".
- Intake for a new plan reuses this: no wizard-of-twenty-fields; the coach asks only what memory can't answer, one chip-question at a time, in the thread.

## 6. Memory: observable, editable, everywhere it matters

- **Settings → Coach memory:** a flat, scannable list grouped by kind (About you · Rules & preferences · Health notes · Logistics). Each item: the fact, when learned, provenance ("from your message, Aug 6"), edit and delete. A master toggle pauses extraction entirely.
- Deleting an item is honored immediately (phase 2 contract: memory is the single knowledge store; no shadow copies).
- **In-panel surfaces:** extraction chips in the thread (the moment of learning is visible), `what I know →` in the header, and reason chips citing memory when a rule shaped a proposal.
- Memory kinds the UX distinguishes visually: durable facts ("left knee history"), standing rules ("quality on Tuesdays"), and time-boxed notes ("travel Aug 13–16" — auto-expires after the window, appearing in receipts when it lapses).

## 7. Plan lifecycle: Manage plans

**Manage plans ▾** (header) opens a sheet listing every plan (running + lifting, same card grammar):

- Per plan: name, discipline pill, week X/Y progress bar, status (active · draft · completed · retired), and actions: **Extend** (coach drafts the added weeks as a normal multi-day proposal), **Wind down** (coach drafts a taper/final week), **Retire** (archive; calendar suppression like today's remove — never touches completed history), **Rename**.
- **New plan** → starts a thread intake (§5). The coach drafts the full plan; it appears as a draft plan overlay on the calendar (whole-plan ghost) with one approve.
- **Import from COROS** (one-time per plan): pulls the current COROS-authored plan in as a coach-owned template — clearly labeled as a one-way adoption ("the coach takes it from here").
- Extending, easing, shifting, skipping: ALL travel the same proposal pipeline — there is exactly one way changes happen, so the UX has exactly one vocabulary.

## 8. Both disciplines, natively

- One coach, one thread, one tray — proposals carry discipline pills; no separate "lifting studio" and "running plan" worlds.
- The calendar keeps the existing category/color vocabulary (run green family, lift terracotta, yoga violet); coached workout chips are identical to today's, so nothing about completed-workout UX (matching, sync pills, garden feeding) changes.

## 9. States the UX must handle honestly

- **COROS writes OFF** (current reality): proposals still work app-side; the approve button reads "Apply (app only)" with a quiet banner "Changes stay in Run Garden until COROS writes are on" linking to Settings. No dead buttons.
- **Bridge offline:** approved changes queue exactly like studio pushes today; receipts show "queued — waiting for your Mac".
- **Coach unavailable / budget exhausted:** the panel degrades to the plan + manual tools with one honest line ("The coach is resting — manual controls all work"); never a spinner wall.
- **Empty states:** no active plan → the panel opens with the intake conversation; no proposals → tray hidden entirely (no empty "Needs you · 0" chrome).
- **First run:** a short one-time coach introduction message explaining the propose/approve contract and the memory link (three sentences, not a tour).

## 10. Out of scope here (later phases)

- How the coach decides anything (triggers, models, adaptation logic, data packaging) — phase 2.
- Garden integration and fair workout incentives (eased workouts counting fairly, etc.) — phase 3.
- Notifications/out-of-app reach (desktop-shell project).
- Multi-user concerns.

## Component inventory (for the eventual implementation plan)

`CoachPanel` (container) · `PendingTray` + `ProposalCard` (+ multi-day variant) · `CoachThread` + `Msg`/`Receipt`/`MemoryChip` · `Composer` + `QuestionChips` · calendar additions: `pending-day` styling + ghost stacking + tap-to-focus wiring + ghost extend row · `ManagePlansSheet` + `PlanCard` · Settings `CoachMemorySection` + `MemoryItemRow` · mobile `CoachSheet` + pill. Everything reuses the existing design tokens, Sheet/Drawer/Card primitives, and the studio's diff grammar.
