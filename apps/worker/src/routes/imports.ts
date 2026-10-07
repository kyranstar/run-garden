/**
 * `/api/import` — bringing history in from elsewhere (Phase 2 spec §2c; services/standalone-import.ts).
 *
 *   POST /standalone            the standalone tool's backup file as the body → the import's summary
 *   POST /standalone?dryRun=1   the same summary, nothing written (the summary sheet before Import)
 *
 * 422 `invalid_backup` for a body that is not JSON or not a backup; 423 while a restore is replacing the account;
 * 503 `busy` while another import of the account is writing. A first import makes the adaptive program: its slots
 * are placed here, after the import, through the one rule the hourly pass uses, and the calendar books them.
 *
 * Not reachable from the app until the garden gate (Phase 2d) keeps imported history out of the garden.
 */
import { Hono } from "hono";
import { nowInstant, todayInZone } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { loadPreferences, syncCalendar } from "../services/calendar-sync.js";
import { placeSlots } from "../services/program-slots.js";
import { RestoreInProgressError } from "../services/programs.js";
import { importedProgramId, ImportBusyError, importStandalone, InvalidBackupError } from "../services/standalone-import.js";
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
    if (e instanceof InvalidBackupError) return c.json({ error: "invalid_backup", issues: e.issues.slice(0, 20) }, 422);
    if (e instanceof RestoreInProgressError) return c.json({ error: "restore_in_progress" }, 423);
    if (e instanceof ImportBusyError) return c.json({ error: "busy" }, 503);
    throw e;
  }
});
