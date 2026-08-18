# Plan: Mobile System 1 home rework

Spec: ../specs/2026-08-18-mobile-system1-home-design.md. Single implementer,
sequential slices, commit per slice on worktree-garden-ux-audit.

1. **Server consistency** — `homeConsistency()` helper in
   apps/worker/src/routes/plan.ts (computeConsistency over 12 ISO weeks,
   sanctioned-skip mercy, band mapping) + wire into /today Promise.all wave
   (needs 12wk workout rows + garden snapshot already loaded). Types in
   packages/api-client. Worker route test: bands/adherence/streak incl.
   sanctioned skip, empty plan, current-week edge (Monday).
2. **Loop line + lately caption helpers** — pure functions + tests in
   packages/ui (loopLine keyed by weather state w/ day counts; latelyVoice
   picking forecast-loss > weakest-axis > healthy-collapse).
3. **Garden restructure** — new parts (scene/condition/streak/beat/ceremony/
   today/lately/timeline/below/overlays), GardenBody placement, styles.css
   (streak band, chip row, unboxed lately, today-card innards; lg overlay
   mapping; tap pads via existing --tap-clear patterns). Delete dead
   components/CSS (DockVerdict, nudges, rail, conditionStory, Readiness card
   usage here, EvidenceCard usage here). ReadinessSheet in today.tsx.
4. **/plan?coach=1** — open coach sheet (mobile) on param; harmless at lg.
5. **Tests + gates** — update garden part/dock tests, run full vitest
   (default node), extend plan-shots-style matrix to garden with overflow
   gate, hit-test chips.
6. **Verify + present** — independent subagent live check against spec;
   before/after captures; user sign-off gate before any merge/deploy.
