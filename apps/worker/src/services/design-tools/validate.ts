/**
 * validate_workout(doc, date) — a draft judged for its day, free and as often as the designer likes (Stage 3 spec §4,
 * §5; principles §3.2, §6.4): `validateWorkoutDoc` with the day the Studio's own create path judges a workout for
 * (act-common.ts: the athlete's profiles and the day's reading, the moves done cleanly, the last week's sessions, the
 * moves set aside, the gear of the document's place or the default place), then `deriveDoc` for what the proposal card
 * computes — minutes, discipline, category, mode, the balance it adds. No AI cost, no write: the same call answers
 * the same. Errors must be fixed before propose_workout takes the draft; warnings are costs the designer may accept
 * with a reason. Six statements at most: the athlete (with the gear, the set-aside moves and the recent sessions'
 * ids), the moves done cleanly, and the recent sessions (four).
 */
import { z } from "zod";
import type { DesignTool } from "./types.js";
import {
  coachDoc,
  dayMissing,
  derivedSummary,
  docPlaceId,
  docValidateCtx,
  ERRORS_SHOWN,
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

const input = z.object({ doc: objectField, date: dateField }).strict();

export const validateWorkout: DesignTool = {
  name: "validate_workout",
  description:
    "Check a draft for its date, free: the errors to fix (a condition's refusal, an unknown move, a malformed part) and the advisory notes, with the minutes, balance and gear derived from it. Call it on every draft and after each change.",
  inputSchema: {
    type: "object",
    properties: { doc: WORKOUT_DOC_JSON_SCHEMA, date: { ...DATE_SCHEMA, description: "The day it is for, YYYY-MM-DD (today or later)." } },
    required: ["doc", "date"],
    additionalProperties: false,
  },
  statementCost: 6,
  roles: ["main", "designer", "reviewer"],
  async run(ctx, raw) {
    const p = parseAct(input, raw, "doc (a workout document) and date (YYYY-MM-DD)");
    if (isErr(p)) return p;
    const doc = coachDoc(p.doc, mainRunIdOf(ctx) ?? ctx.run.id);
    const a = await readDocAthlete(ctx, { placeId: docPlaceId(doc) });
    if (isErr(a)) return a;
    const today = a.athlete.today;
    if (p.date < today) {
      return refuse("past_date", `${p.date} is before today (${today}) where the athlete is.`, "Check it for today or a later day.");
    }
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
        place: a.place ? { id: a.place.id, default: a.place.default } : null,
      },
      summary:
        judged.errors.length === 0
          ? `Checked the draft — no errors${minutes !== undefined ? `, ${minutes} min` : ""}${notes}`
          : `Checked the draft — ${judged.errors.length} error${judged.errors.length === 1 ? "" : "s"} to fix${notes}`,
    };
  },
};
