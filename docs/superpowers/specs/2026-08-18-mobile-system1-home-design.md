# Mobile System 1 — the opening page (v2, approved 2026-08-18)

User-approved via mock artifact fa1e9767 (v2, "ok looks good. go for it").
Mock source: session scratchpad `mock-system1.html`. This spec is the mock,
written down.

## Goal

The mobile home page must pass a first-glance test for someone who has never
seen the app: (1) how the garden/exercise loop works, (2) what the coach/app
is for, (3) one celebrated consistency metric — with as few visual objects as
possible. Desktop already reads well and must not regress.

## Page structure (one tree, all widths — System 3 constraint holds)

Below lg, in DOM/stack order:

1. **Hero** — the scene, with:
   - condition word + ONE cause→effect loop sentence on the bottom scrim
     ("Clear sun — every workout you finish waters it" / loss direction:
     "Dry spell — N days without a run drain it"). Replaces the weather line,
     the WHY sentence, and the on-page forecast line.
   - quiet chips top-right: Collection ❀ n/N, Log, Timeline, fullscreen
     (fullscreen below lg only, as today). Replaces the `.hud-rail` section.
2. **Streak band** — full-bleed white band fused under the scene (NOT a card):
   "8 weeks consistent · 82% of plan" + 12 week-squares + caption
   "One square per week, last 12 weeks." The page's only large number.
3. **Beat line** — ONE dismissible line: "Since Friday — …" (leads + beat +
   today lines merged; See-all → log drawer when overflowing). Conditional.
4. **Plumbing slot** — conditional banners only (TimezoneNudge, calendar
   paused, SyncPanel quietWhenHealthy). Empty and invisible on a healthy day.
5. **Today card — the ONLY card**:
   - head: eyebrow "Today · Tue Aug 18" + readiness chip "● Recovery low ›"
     (chip opens the Readiness sheet; DockVerdict + Readiness card die)
   - workout: serif title, "7:00 AM · 54 min · quality run", one structure
     strip (exercises/stageSummary as today)
   - **coach line inside the card**, under a hairline: "Coach — <focus text>"
     + "Ask me ›" → /plan?coach=1. Source: existing `focus` (72h-gated) +
     readiness-derived clause; no new LLM calls.
   - grows line: "Finishing it grows the Century rose — 18 to go" (existing
     dock-grows logic, reworded; nudge buttons die — collection drawer keeps
     DisciplineNudges)
   - week ribbon (existing WeekRibbon + arrival caption)
   - attention row (conditional): "⚠ 2 past runs need an answer ›" — one
     amber row; count===1 links /plan?workout=<id>, else /plan. The two
     UnresolvedCards leave the garden (Plan keeps the actions).
   - actions: View workout (primary) · Move
   - no-plan state: the existing EmptyState copy takes the card body instead.
6. **Lately (unboxed)** — eyebrow "Lately", then:
   - three thin balance meters (Run/Lift/Yoga, "N d ago"), tappable →
     existing BalanceDetail
   - caption = the ONE loss voice: forecastVoice line when loss, else
     weakest-axis line; when everything is healthy the meters collapse to a
     single green sentence.
   - one insight line (top "high" else "watch" interpreted metric's meaning,
     from the shared ["insights"] query, staleTime 5 min — same pattern
     EvidenceCard already uses) + evidence line when present (cap 2 lines)
   - ReviewPull line stays as a Lately line
   - "All insights ›"
7. **Foot**: "How the garden works" toggle (existing banner content), quiet.
8. Timeline panel, drawers, sheets, ceremony: unchanged behavior.

At lg the same parts place onto the stage: topleft = condition + loop +
compact streak + beat; bottom-left dock = Today card (collapse/Minimize kept
at lg ONLY — below lg the card is the page and never collapses); topright =
Lately; chips top-right. Timeline/ceremony as today.

## Deleted from the page (destinations)

- Readiness pill + verdict card + Readiness card → chip + Readiness sheet
  (verdict, RHR/HRV/recovery vitals with "usually N" phrasing, one advice
  line, provenance paragraph).
- Weather-why + forecast lines + conditionStory prose → loop sentence +
  Lately caption.
- 3 nudge buttons + rail section → grows line + scene chips.
- Attention section + mismatch banner + 2 UnresolvedCards → one amber row.
- EvidenceCard ("Worth knowing") → Lately line 2.
- "The garden runs on" label (v1) → "Lately".

## Server

`GET /api/today` adds:

```
consistency: {
  weeks: Array<{ weekStart: LocalDate, band: "full" | "partial" | "quiet" | "current" }>,  // 12, oldest first
  adherencePct: number | null,   // 12-week, denominator planned − still-ahead − unresolved; null when 0
  streakWeeks: number,           // snapshot.state.consecutiveConsistentWeeks
}
```

Rules: all disciplines; coach-sanctioned skips leave the denominator (same
mercy as /week); current ISO week = "current"; adherence ≥ 0.8 → "full",
> 0 → "partial", else "quiet" (a nothing-planned week is also "quiet" — the
garden asks, never accuses). Computed via `computeConsistency` over the last
12 ISO weeks.

## Language rules

One voice per fact; depth is one tap down, never one scroll down. Every
garden effect names its cause. Plain labels ("Today", "Coach", "Lately") —
no invented metaphor labels. Numbers without jargon ("usually 46", "82% of
plan").

## Out of scope

Nav stays 5 tabs (System 2 merges Activity+Insights). Plan/Runs/Insights/
Settings untouched except /plan?coach=1 support. Desktop stage geometry may
be tuned but its information set is already the target one.

## Verification gates

- vitest green on default node.
- Screenshot matrix 360/390/768/1280/1440, light+dark, zero horizontal
  overflow (hard gate).
- Tap-pad hit test on the new chips/rows (centre + 4px-inset corners).
- Independent live verify AFTER implementation lands (no concurrent
  measure/edit), then real before/after renders for user sign-off before
  merge/deploy.
