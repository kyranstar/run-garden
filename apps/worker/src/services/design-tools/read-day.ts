/**
 * read_day(date?) — one day (Stage 3 spec §4): its condition readings (the day's checks and the checks around its
 * sessions, with their times), its plan, what was done, and for today the time left. Today's reading, plan line and
 * time left are already in the opening message; on today this is mostly for what is already done, the rest for
 * completeness. Two statements: the athlete, then everything of the day in one read (five terms).
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { conditionChecks, performedSessions, plannedWorkouts } from "@rg/database";
import { isProfileId, profileById } from "@rg/exercise-library";
import type { DesignTool } from "./types.js";
import { answer, dateField, isErr, localTimeOf, parseInput, READ_ROLES, readAthlete, readTagged, weekdayOf } from "./read-common.js";
import { planItem, planTerm } from "./read-plan.js";
import { activitiesAround, checkRows, doneEntries, doneTerms, sessionsWhere } from "./read-sessions.js";

const input = z.object({ date: dateField.optional() }).strict();

export const readDay: DesignTool = {
  name: "read_day",
  description:
    "One day: its condition readings, its plan and what was done (today by default; for today it adds the time left). Today's reading and plan line are already in the opening message.",
  inputSchema: {
    type: "object",
    properties: { date: { type: "string", description: "A local date, YYYY-MM-DD. Default: today." } },
    additionalProperties: false,
  },
  statementCost: 2,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(input, raw, "an optional date (YYYY-MM-DD)");
    if (isErr(p)) return p;
    const { athlete } = await readAthlete(ctx.db, ctx.userId, ctx.now);
    const date = p.date ?? athlete.today;
    const scope = sessionsWhere(ctx.userId, sql`${performedSessions.localDate} = ${date}`);
    const rows = await readTagged(ctx.db, [
      ...doneTerms(ctx.userId, scope, { activitiesWhere: activitiesAround(date, date), moreChecks: sql`${conditionChecks.localDate} = ${date}` }),
      planTerm(ctx.userId, sql`${plannedWorkouts.effectiveDate} = ${date}`),
    ]);
    const done = doneEntries(
      { sessions: rows.get("s"), sets: rows.get("x"), checks: rows.get("c"), activities: rows.get("a") },
      { tz: athlete.tz, units: athlete.prefs.units, weightUnit: athlete.prefs.weightUnit },
      { from: date, to: date },
    );
    const readings = checkRows(rows.get("c"))
      .filter((c) => c.localDate === date && isProfileId(c.profileId) && (c.value !== null || c.feelingOff))
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
      .map((c) => ({ profile: profileById(c.profileId).label, kind: c.kind, value: c.value, feelingOff: c.feelingOff, time: localTimeOf(athlete.tz, c.at) }));
    const plan = (rows.get("p") ?? []).sort((a, b) => `${a.time} ${a.id}`.localeCompare(`${b.time} ${b.id}`)).map(planItem);

    const isToday = date === athlete.today;
    const data: Record<string, unknown> = { date, weekday: weekdayOf(date), today: isToday };
    if (isToday) {
      const [hh, mm] = (localTimeOf(athlete.tz, ctx.now.toISOString()) ?? "00:00").split(":").map(Number);
      const left = 24 * 60 - (hh! * 60 + mm!);
      data.timeLeft = `${Math.floor(left / 60)} h ${String(left % 60).padStart(2, "0")} min`;
    }
    Object.assign(data, { readings, plan, done: done.map((d) => d.entry) });

    // A day still to come has no checks and nothing done yet: that is not missing, it is the future.
    const missing: string[] = [...athlete.missing];
    if (date <= athlete.today && athlete.profiles.length > 0 && readings.length === 0) missing.push(isToday ? "no condition check yet today" : "no condition check that day");
    if (date <= athlete.today && done.length === 0) missing.push(isToday ? "nothing logged yet today" : "nothing logged that day");
    return answer({
      source: "the day's condition checks, the plan, logged sessions and the watch's activities",
      now: ctx.now,
      missing,
      data,
      summary: `Read ${isToday ? "today" : date} — ${plan.length} planned, ${done.length} done`,
    });
  },
};
