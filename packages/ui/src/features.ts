/**
 * Features that ship dark until the slice that completes them lands.
 *
 * `player` — the session player (`/session/:id`, Phase 2b). Off, nothing offers to start a session: Start and Continue
 * stay hidden on the Today card and in the session sheet, and so does "New program…" (ruling 2a-R5: no program is
 * created before a session can be played and saved). Built in 2b Task 7 (the player, the review and the outbox); held off in
 * production until the ship gate: a real build's CPU and D1 queries are measured on the owner's account first.
 *
 * `import` — Settings → Import, the standalone tool's backup (Phase 2c). Off, the Import card does not render and
 * nothing in the app reaches the importer: imported history must stay out of the garden, and the gate that keeps it
 * out lands in Phase 2d, which turns this on.
 *
 * A plain object (not `as const`) so a test can switch a feature on for the length of one case.
 */
export const features: { player: boolean; import: boolean } = { player: false, import: false };
