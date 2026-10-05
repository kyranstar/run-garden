/**
 * Features that ship dark until the slice that completes them lands.
 *
 * `player` — the session player (`/session/:id`, Phase 2b). Until it exists nothing may offer to start a session:
 * Start and Continue stay hidden on the Today card and in the session sheet, and so does "New program…" (ruling
 * 2a-R5: no program is created before a session can be played and saved). Flipped to true by 2b.
 *
 * A plain object (not `as const`) so a test can switch a feature on for the length of one case.
 */
export const features: { player: boolean } = { player: false };
