/**
 * `/api/import` — bringing history in from elsewhere (Phase 2 spec §2c; services/standalone-import.ts).
 *
 *   POST /standalone            the standalone tool's backup file as the body → the import's summary
 *   POST /standalone?dryRun=1   the same summary, nothing written (the summary sheet before Import)
 *   POST /provenance            a saved-post links file (built locally by scripts/build-provenance.mjs) → counts
 *   POST /provenance?dryRun=1   the same counts, nothing written
 *
 * 422 `invalid_backup` for a body that is not JSON or not a backup (with `reason: "newer_version"` for a backup the
 * tool wrote in a newer format); 423 while a restore is replacing the account; 503 `busy` while another import of the
 * account is writing. Only a first import into an account with no adaptive program makes one (ruling 2d-R5): its
 * slots are placed here, after the import, through the one rule the hourly pass uses, and the calendar books them. A
 * block adopted into the athlete's own program places nothing and books nothing.
 *
 * Not reachable from the app until the garden gate (Phase 2d) keeps imported history out of the garden — and refused
 * on the server too (404 `not_found`, nothing written) unless the Worker var IMPORT_ENABLED is "1": hiding the screen
 * is not enough, since a hand-made call would credit the garden with the imported sessions (Audit 2c-A IMPORTANT-1).
 * The dry run, which writes nothing, always answers.
 */
import { Hono } from "hono";
import { nowInstant, todayInZone } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { loadPreferences, syncCalendar } from "../services/calendar-sync.js";
import { placeSlots } from "../services/program-slots.js";
import { RestoreInProgressError } from "../services/programs.js";
import { importedProgramId, ImportBusyError, importStandalone, InvalidBackupError } from "../services/standalone-import.js";
import { importProvenance, InvalidProvenanceError } from "../services/provenance-import.js";
import { waitUntilSafe } from "../services/wait-until.js";

export const importRoutes = new Hono<AppContext>();
importRoutes.use("*", requireUser);

importRoutes.post("/standalone", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  let body: unknown;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    return c.json({ error: "invalid_backup", issues: [{ path: [], message: "not JSON" }] }, 422);
  }
  const dryRun = ["1", "true"].includes(c.req.query("dryRun") ?? "");
  if (!dryRun && c.env.IMPORT_ENABLED !== "1") return c.json({ error: "not_found" }, 404);
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const now = nowInstant();
  try {
    const summary = await importStandalone(db, userId, body, { today, now, timezone: prefs.timezone, dryRun });
    if (!dryRun && summary.written.program === 1) {
      const programId = await importedProgramId(db, userId);
      if (programId) {
        await placeSlots(db, userId, programId, today, await loadPreferences(db, userId), now);
        waitUntilSafe(c, syncCalendar(db, c.env, userId));
      }
    }
    return c.json(summary);
  } catch (e) {
    if (e instanceof InvalidBackupError) {
      return c.json({ error: "invalid_backup", ...(e.reason ? { reason: e.reason } : {}), issues: e.issues.slice(0, 20) }, 422);
    }
    if (e instanceof RestoreInProgressError) return c.json({ error: "restore_in_progress" }, 423);
    if (e instanceof ImportBusyError) return c.json({ error: "busy" }, 503);
    throw e;
  }
});

/** The largest provenance file the route reads (a real one is a few dozen kilobytes). */
export const MAX_PROVENANCE_BYTES = 1_000_000;

/**
 * Saved-post links (services/provenance-import.ts): 422 `invalid_provenance` (with `reason: "newer_version"` for a
 * newer file) — its issues name paths, never values; 413 `too_large` past `MAX_PROVENANCE_BYTES`; 423 while a restore
 * is replacing the account (the dry run too: it is a POST, and nothing about it needs to answer mid-restore). It never
 * touches the garden, so it needs no IMPORT_ENABLED gate. The answer is counts only.
 */
importRoutes.post("/provenance", async (c) => {
  if (Number(c.req.header("content-length") ?? 0) > MAX_PROVENANCE_BYTES) return c.json({ error: "too_large" }, 413);
  const text = await c.req.text();
  if (text.length > MAX_PROVENANCE_BYTES) return c.json({ error: "too_large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json({ error: "invalid_provenance", issues: [{ path: [], message: "not JSON" }] }, 422);
  }
  const dryRun = ["1", "true"].includes(c.req.query("dryRun") ?? "");
  try {
    return c.json(await importProvenance(c.get("db"), c.get("userId"), body, { now: nowInstant(), dryRun }));
  } catch (e) {
    if (e instanceof InvalidProvenanceError) {
      return c.json({ error: "invalid_provenance", ...(e.reason ? { reason: e.reason } : {}), issues: e.issues.slice(0, 20) }, 422);
    }
    if (e instanceof RestoreInProgressError) return c.json({ error: "restore_in_progress" }, 423);
    throw e;
  }
});
