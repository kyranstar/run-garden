/**
 * validate_workout(doc, date, workoutId?) — a draft judged for its day, free and as often as the designer likes (Stage
 * 3 spec §4, §5; principles §3.2, §6.4): `validateWorkoutDoc` with the day the Studio's own create path judges a
 * workout for (act-common.ts: the athlete's profiles and the day's reading, the moves done cleanly, the last week's
 * sessions, the moves set aside, the gear of the document's place or the default place), then `deriveDoc` for what the
 * proposal card computes — minutes, discipline, category, mode, the balance it adds. No AI cost, no write: the same
 * call answers the same. Errors must be fixed before propose_workout takes the draft; warnings are costs the designer
 * may accept with a reason.
 *
 * A free-text move is refused, as propose_workout refuses it (act-common.ts `freeTextRefusal`); told which workout the
 * draft revises (`workoutId`), it allows the free-text moves that workout's document already holds, unchanged.
 * Six statements at most: the athlete (with the gear, the set-aside moves, the recent sessions' ids and the revised
 * workout's document), the moves done cleanly, and the recent sessions (four).
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { plannedWorkouts } from "@rg/database";
import { parseStoredWorkoutDoc } from "@rg/domain";
import type { DesignTool } from "./types.js";
import {
  coachDoc,
  dayMissing,
  derivedSummary,
  docPlaceId,
  docValidateCtx,
  ERRORS_SHOWN,
  freeTextRefusal,
  isErr,
  issueOut,
  judge,
  mainRunIdOf,
  objectField,
  parseAct,
  readDocAthlete,
  WARNINGS_SHOWN,
  WORKOUT_DOC_JSON_SCHEMA,
} from "./act-common.js";
import { dateField, DATE_SCHEMA, refuse } from "./read-common.js";

const input = z.object({ doc: objectField, date: dateField, workoutId: z.string().min(1).max(120).optional() }).strict();

export const validateWorkout: DesignTool = {
  name: "validate_workout",
  description:
    "Check a draft for its date, free: the errors to fix (a condition's refusal, an unknown move, a malformed part) and the advisory notes, with the minutes, balance and gear derived from it. Call it on every draft and after each change.",
  inputSchema: {
    type: "object",
    properties: {
      doc: WORKOUT_DOC_JSON_SCHEMA,
      date: { ...DATE_SCHEMA, description: "The day it is for, YYYY-MM-DD (today or later)." },
      workoutId: { type: "string", description: "When the draft revises a workout: its id (it is judged as propose_workout will judge it)." },
    },
    required: ["doc", "date"],
    additionalProperties: false,
  },
  statementCost: 6,
  roles: ["main", "designer", "reviewer"],
  async run(ctx, raw) {
    const p = parseAct(input, raw, "doc (a workout document), date (YYYY-MM-DD) and optionally workoutId");
    if (isErr(p)) return p;
    const doc = coachDoc(p.doc, mainRunIdOf(ctx) ?? ctx.run.id);
    const pw = plannedWorkouts;
    const a = await readDocAthlete(ctx, {
      placeId: docPlaceId(doc),
      ...(p.workoutId
        ? { extras: { baseDoc: sql`(select ${pw.workoutDoc} from ${pw} where ${and(eq(pw.id, p.workoutId), eq(pw.userId, ctx.userId))})` } }
        : {}),
    });
    if (isErr(a)) return a;
    const today = a.athlete.today;
    if (p.date < today) {
      return refuse("past_date", `${p.date} is before today (${today}) where the athlete is.`, "Check it for today or a later day.");
    }
    const free = freeTextRefusal(doc, p.workoutId ? parseStoredWorkoutDoc(a.extra.baseDoc) : null);
    if (free) return free;
    const judged = judge(doc, await docValidateCtx(ctx, a, p.date));
    const minutes = judged.derived?.estimatedMinutes;
    const notes = judged.warnings.length ? `, ${judged.warnings.length} note${judged.warnings.length === 1 ? "" : "s"}` : "";
    return {
      provenance: {
        source: "the validator, with the day's condition readings, the moves done cleanly, the last week's sessions, the moves set aside and the place's gear",
        asOf: ctx.now.toISOString(),
      },
      missing: dayMissing(a, p.date),
      data: {
        date: p.date,
        valid: judged.errors.length === 0,
        errors: judged.errors.slice(0, ERRORS_SHOWN).map(issueOut),
        ...(judged.errors.length > ERRORS_SHOWN ? { moreErrors: judged.errors.length - ERRORS_SHOWN } : {}),
        warnings: judged.warnings.slice(0, WARNINGS_SHOWN).map(issueOut),
        ...(judged.warnings.length > WARNINGS_SHOWN ? { moreWarnings: judged.warnings.length - WARNINGS_SHOWN } : {}),
        derived: judged.derived ? derivedSummary(judged.derived) : null,
        place: { id: a.place.id, default: a.place.default },
      },
      summary:
        judged.errors.length === 0
          ? `Checked the draft — no errors${minutes !== undefined ? `, ${minutes} min` : ""}${notes}`
          : `Checked the draft — ${judged.errors.length} error${judged.errors.length === 1 ? "" : "s"} to fix${notes}`,
    };
  },
};
