/**
 * THE OWNERSHIP STAMP — and why it is not the athlete's session name.
 *
 * Every workout this app writes to COROS carries a program NAME that doubles as
 * proof of authorship. `create-executor.ts` INVARIANT 3 is the reason: entity
 * names do not round-trip through the COROS API, program names do, so the
 * program name is the only durable mark we can leave. Ownership is then decided
 * by exact string equality — `const isOurs: StampPredicate = (name) => name ===
 * spec.name` — and a delete is authorized by nothing else. The stamp must also
 * be UNIQUE inside its container plan, or `stampedPlacements` resolves to
 * several placements, recovery-after-create cannot say which workout is ours,
 * and `deleteWorkout` correctly refuses as `ambiguous`. That is why both writers
 * append a discriminator to the title:
 *
 *   coach:  `${title} — ${date}`        (coach-apply.ts)
 *   studio: `${title} — wk ${n}`        (studio-push.ts `sessionStamp`)
 *
 * And that is the bug this module exists for. The stamp does not stay on the
 * wire. COROS serves the program name back, `providers/coros/normalize.ts`
 * reads it as the workout's `title`, and import rule 7 writes it into
 * `planned_workouts.title` — so three live sessions ended up named
 * "Legs-back jog — 2026-10-26", on the watch, in the app, and in Google
 * Calendar. The plumbing had become the athlete's session name.
 *
 * THE FIX IS ON THE WAY BACK IN, NOT ON THE WAY OUT, and deliberately so.
 * Nothing about the emitted name may be weakened: drop the discriminator and a
 * plan repeating "Long Run" six times emits one name six times, which refuses
 * every create after the first (audit#2 #7) and makes every later delete
 * ambiguous; change the shape and existing live programs stop matching the
 * stamp that authorizes their own removal. The name is a machine identifier
 * that happens to be human-readable, and the honest place to stop it becoming
 * a title is where it is read as one.
 *
 * The strip is PROVEN, not pattern-matched. We do not regex a trailing
 * " — <something>" off any title that looks stamped — a COROS workout the
 * athlete named "Long run — hilly" is not ours to rename. Instead we read back
 * the create jobs we ourselves enqueued: `payload.name` is the exact stamp we
 * wrote and `payload.session.title` is the exact title we meant. A wire title
 * is un-stamped only when it is character-for-character a name this account
 * emitted. Same proof `coach-apply.ts`'s `suppressAndUnpush` already relies on
 * to address a delete.
 */

import { and, eq, gte, inArray, lte, or } from "drizzle-orm";
import { corosWriteJobs } from "@rg/database";
import type { Db } from "./db.js";

/**
 * Separator between an athlete-facing title and its uniquifier. An em dash with
 * spaces, matching `studio-push.ts`'s `sessionStamp` — shared so the two
 * writers cannot drift into two stamp grammars.
 */
export const STAMP_SEPARATOR = " — ";

/**
 * The coach's program name for a session on a day. The date is the uniquifier:
 * one session per day per plan makes it unique inside the container plan, which
 * is exactly the guarantee the delete path needs.
 */
export function stampName(title: string, date: string): string {
  return `${title}${STAMP_SEPARATOR}${date}`;
}

/**
 * Job kinds whose payload holds a program name we wrote to COROS. Deletes are
 * excluded on purpose: they carry the same stamp but they remove a program,
 * they never name one, so they can teach us nothing a create hasn't already.
 */
const CREATE_KINDS = ["coach_create_workout", "create_scheduled_workout"];

/**
 * `stamp → the title we meant`, for every workout this account created on COROS
 * with a date in the window.
 *
 * `range` bounds the read by the snapshot window rather than by a `limit`,
 * because the rows an import can affect are exactly the rows in that window;
 * `originalDate` is checked as well as `destinationDate` so a workout moved
 * inside the window is still recognised as ours. Omit it — as the one-shot
 * repair does — for the whole history, which must be exhaustive rather than
 * cheap.
 *
 * Entries are only recorded when the stamp genuinely EXTENDS the title. A job
 * whose name equals its title has nothing to strip, and one whose name is not a
 * prefix-extension of its title is some other naming scheme we should not be
 * quietly rewriting titles from.
 */
export async function loadOwnProgramNames(
  db: Db,
  userId: string,
  range?: { start: string; end: string },
): Promise<Map<string, string>> {
  const inWindow = range
    ? or(
        and(
          gte(corosWriteJobs.destinationDate, range.start),
          lte(corosWriteJobs.destinationDate, range.end),
        ),
        and(
          gte(corosWriteJobs.originalDate, range.start),
          lte(corosWriteJobs.originalDate, range.end),
        ),
      )
    : undefined;
  const rows = await db
    .select({ payload: corosWriteJobs.payload })
    .from(corosWriteJobs)
    .where(and(eq(corosWriteJobs.userId, userId), inArray(corosWriteJobs.kind, CREATE_KINDS), inWindow));
  const out = new Map<string, string>();
  for (const row of rows) {
    const payload = row.payload as { name?: unknown; session?: { title?: unknown } } | null;
    const name = payload?.name;
    const title = payload?.session?.title;
    if (typeof name !== "string" || typeof title !== "string" || title.length === 0) continue;
    if (name === title) continue;
    if (!name.startsWith(`${title}${STAMP_SEPARATOR}`)) continue;
    out.set(name, title);
  }
  return out;
}

/**
 * The athlete-facing title for a name COROS served back: the title we meant when
 * the name is provably a stamp of ours, and the wire's own name otherwise.
 * Total and idempotent — an already-stripped title is not in the map, so it
 * passes through unchanged on every later import.
 */
export function unstampTitle(wireName: string, ownNames: Map<string, string>): string {
  return ownNames.get(wireName) ?? wireName;
}
