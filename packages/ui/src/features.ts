/**
 * Features that ship dark until the slice that completes them lands.
 *
 * `player` — the session player (`/session/:id`, Phase 2b). Off, nothing offers to start a session: Start and Continue
 * stay hidden on the Today card and in the session sheet, and so does "New program…" (ruling 2a-R5: no program is
 * created before a session can be played and saved). Built in 2b Task 7 (the player, the review and the outbox); on in
 * production since the ship gate of 2026-10-08 (a real build measured on the owner's account: outcome ok).
 *
 * `import` — Settings → Import, the standalone tool's backup (Phase 2c). Off, the Import card does not render and
 * nothing in the app reaches the importer: imported history must stay out of the garden, and the gate that keeps it
 * out lands in Phase 2d, which turns this on.
 *
 * `studio` — the Studio tab (Stage 2): the fifth nav entry and the `/studio` routes. It ships dark while it is being
 * built, because the app deploys from this branch before the Studio is finished. Unlike the two above it is decided by
 * the BUILD, not by a constant: on wherever Vite says DEV — the dev server, the fixture stack the e2e and screenshot
 * runs use, and vitest — and off in a production build unless that build sets `VITE_STUDIO=1`. Off, the nav is the
 * original four tabs and `/studio` (and everything under it) redirects home.
 *
 * A plain object (not `as const`) so a test can switch a feature on for the length of one case.
 */

/** What a Vite build tells the app about itself; absent outside one. */
export interface BuildEnv {
  DEV?: boolean;
  PROD?: boolean;
  VITE_STUDIO?: string;
}

/** The Studio is on in development builds, and in a production build only when it opts in with `VITE_STUDIO=1`. */
export function studioFlag(env: BuildEnv | undefined): boolean {
  return env?.DEV === true || env?.VITE_STUDIO === "1";
}

// Written as `import.meta.env` member reads so Vite replaces them at build time (a production bundle carries the
// literal answer). The package has no Vite client types of its own, hence the local shape.
const buildEnv = (import.meta as ImportMeta & { env?: BuildEnv }).env;

export const features: { player: boolean; import: boolean; studio: boolean } = {
  player: true,
  import: true,
  studio: studioFlag(buildEnv),
};
