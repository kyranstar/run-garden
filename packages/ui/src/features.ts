/**
 * Features that ship dark until the slice that completes them lands.
 *
 * `player` — the session player (`/session/:id`, Phase 2b). Off, nothing offers to start a session: Start and Continue
 * stay hidden on the Today card and in the session sheet, and so does "New program…" (ruling 2a-R5: no program is
 * created before a session can be played and saved). Built in 2b Task 7 (the player, the review and the outbox); on in
 * production since the ship gate of 2026-10-08 (a real build measured on the owner's account: outcome ok).
 *
 * (`import` — Settings → Import — shipped with Phase 2d and its gate went with the new shape: the Import card is in
 * Settings → Data & account in every build.)
 *
 * `studio` — the Studio (Stage 2). Unlike `player` it is decided by the BUILD, not by a constant: on wherever Vite says
 * DEV — the dev server, the fixture stack the e2e and screenshot runs use, and vitest — and off in a production build
 * unless that build sets `VITE_STUDIO=1` (production does). Since the new shape the Studio is no tab and its routes
 * answer whatever this says; the session sheet's Edit still reads it.
 *
 * `coach` — the coach designer in the Studio (Stage 3 Task 9): the composer, the run view and a designed workout's
 * suggestion card on the Studio home, and the Plan coach sheet's link to them. Decided by the build as `studio` is: on in
 * DEV (the dev server, the fixture stack, vitest), and in a production build only with `VITE_COACH_DESIGNER=1` — on in
 * production since the owner's go-live, 2026-10-16 (deploy.yml). It shows only where the Studio shows too (`coachOn`). Off, nothing in
 * the app shows the composer, the run view or a designed suggestion.
 *
 * A plain object (not `as const`) so a test can switch a feature on for the length of one case.
 */

/** What a Vite build tells the app about itself; absent outside one. */
export interface BuildEnv {
  DEV?: boolean;
  PROD?: boolean;
  VITE_STUDIO?: string;
  VITE_COACH_DESIGNER?: string;
}

/** The Studio is on in development builds, and in a production build only when it opts in with `VITE_STUDIO=1`. */
export function studioFlag(env: BuildEnv | undefined): boolean {
  return env?.DEV === true || env?.VITE_STUDIO === "1";
}

/** The coach designer is on in development builds, and in a production build only with `VITE_COACH_DESIGNER=1`. */
export function coachFlag(env: BuildEnv | undefined): boolean {
  return env?.DEV === true || env?.VITE_COACH_DESIGNER === "1";
}

// Written as `import.meta.env` member reads so Vite replaces them at build time (a production bundle carries the
// literal answer). The package has no Vite client types of its own, hence the local shape.
const buildEnv = (import.meta as ImportMeta & { env?: BuildEnv }).env;

export const features: { player: boolean; studio: boolean; coach: boolean } = {
  player: true,
  studio: studioFlag(buildEnv),
  coach: coachFlag(buildEnv),
};

/** The coach designer shows: its own switch, and only where the Studio is on. Read at render, so a test can flip either. */
export const coachOn = (): boolean => features.coach && features.studio;
