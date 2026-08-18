/**
 * THE THIRD VERB: change what a workout IS, in place, on the watch.
 *
 * The write path could create a workout, move it to another day and delete it.
 * It could not change one. So the moment the coach eased a session that had
 * already been pushed, the app and the watch diverged permanently: the app said
 * "Easy first run back, 35min easy" and COROS held 6×643m at 10K pace, and
 * nothing in the system could ever bring them back together. Deleting and
 * re-creating was the only shape available, and it changes the workout's COROS
 * identity (a new `idInPlan`) for what the athlete experiences as an edit.
 *
 * The wire has always supported it. `status: 2` at a recorded address means
 * "this workout is now what I am sending"; the move path used it to change
 * `happenDay` while resending the program byte-for-byte, and this module is the
 * other half — the day resent as read, the program rebuilt from the new intent.
 *
 * EVERY GUARD OF THE SAFETY CORE APPLIES, and for a sharper reason than a
 * delete: an update WRITES OVER whatever is at the address. A stale
 * `planId:idInPlan` is a CLAIM, never an identity — COROS recycles `idInPlan`
 * slots, so the number the app recorded in March can be a workout the athlete
 * built by hand in August. Ownership is therefore re-proven from a fresh
 * plan-wide read by program-name stamp, exactly as `deleteWorkout` proves it,
 * and the write is addressed at the placement that proof found rather than at
 * the number the caller remembered. Every "can't tell" is a refusal:
 *
 *   - the address holds something not provably ours  → `stamp_mismatch`
 *   - the address holds nothing and the stamp is gone → `not_found`
 *   - our stamp sits on a different day               → `moved`
 *   - the stamp resolves to two placements, or the write address is shared
 *     with another entity of the plan                 → `ambiguous`
 *
 * and none of those sends a byte. The one destructive fallback (`fallback:
 * "recreate"`) is delete-then-create through the two already-proven executors,
 * and it only ever runs when ownership WAS proven (or the workout is provably
 * absent) — never on a maybe.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SECOND PROOF, and why the first one could not reach most of the plan.
 *
 * The stamp proves AUTHORSHIP: only this app emits that exact program name, so
 * a program carrying it is one we wrote. Sound, and useless for the sessions
 * that matter most — the athlete's plan is mostly IMPORTED. COROS authored those
 * workouts; the coach only EASES them. They carry no stamp because we never
 * created them, so `enqueueContentConvergence` refused every one of them with
 * `no_recorded_stamp` and the majority of the plan stayed permanently diverged.
 * That was the athlete's actual complaint, and the stamp could never fix it.
 *
 * A stamp is not the only way to answer "is the thing at this address still the
 * thing I think it is". For an imported row the app already recorded what it
 * SAW, and two of those records are durable identities rather than guesses. So
 * the second proof is a RE-READ, and it has three parts, all required:
 *
 *   1. ADDRESS — the plan holds a placement at the recorded `idInPlan`;
 *   2. IDENTITY — its program carries the recorded COROS `program.id`;
 *   3. CONTENT — its `corosProgramFingerprint` equals the recorded one;
 *   and (4) the placement is on the recorded DAY, checked by the caller.
 *
 * WHY THAT IS AS SAFE AS THE STAMP. The danger the stamp exists to stop is
 * `idInPlan` RECYCLING: COROS frees a slot after a delete and re-uses it, so the
 * number recorded in March can name a workout the athlete built by hand in
 * August. Part 2 is what stops it, and it stops it more directly than a stamp
 * does. `program.id` is issued by COROS, globally unique, and belongs to the
 * program OBJECT: a recycled slot is a different object and carries a different
 * id. Nothing the athlete can do in the COROS app forges one. Compare the stamp,
 * which is a NAME WE CHOSE and whose uniqueness we have to maintain ourselves —
 * and which a rename in COROS silently destroys, where an id survives it. On
 * every axis the stamp guards, the id guards at least as well.
 *
 * Part 3 then adds what the stamp cannot: a stamp match says nothing about
 * content, so the stamp path knowingly overwrites a workout whose body changed
 * on the wire after we wrote it. Here the fingerprint is the optimistic-
 * concurrency claim — "the wire still holds what the app last observed at this
 * address" — and a mismatch refuses rather than clobbers.
 *
 * NEITHER PART IS USED ALONE. Fingerprints are not unique inside a plan (a week
 * with two identical easy runs has two identical fingerprints), so content can
 * confirm but never locate. And an id without a content check would happily
 * overwrite a change made between the app's last read and this write. The
 * address plus the day locates; the id proves the object; the fingerprint proves
 * the moment. All four, or nothing is written.
 *
 * `planProgramId` IS NOT ONE OF THE PARTS, deliberately — see `isOursImported`
 * for the reason: `planned_workouts.source_program_id` answers two different
 * questions depending on whether the row was imported or created, and the write
 * is addressed at the placement this proof LOCATED rather than at any remembered
 * number anyway.
 *
 * WHAT THE SECOND PROOF DOES NOT BUY. It never authorizes a `recreate` fallback.
 * The stamp path may re-create a workout it wrote and lost; an imported workout
 * that has vanished from a COROS-authored plan vanished for a reason we do not
 * own, and putting it back would overrule the athlete inside their own plan at a
 * brand-new `idInPlan`. `not_found` is terminal here, always.
 */

import type { CoachSession, StudioSession } from "@rg/domain";
import {
  corosDayToLocalDate,
  corosProgramFingerprint,
  describeProgramDelta,
  type RawCorosEntity,
  type RawCorosProgram,
} from "@rg/providers";
import type { CorosClient } from "./client.js";
import {
  applyCalculated,
  buildProgramFor,
  createWorkout,
  deleteWorkout,
  describeForeignForConsole,
  describeForeignForReport,
  errText,
  isRunSession,
  missingPaceTargets,
  observationSpan,
  ownedPlacements,
  ownershipAmbiguities,
  planView,
  programsFor,
  readFullSpan,
  stampedPlacements,
  writeAddressClash,
  type CreateResult,
  type Located,
  type PlacementPredicate,
} from "./create-executor.js";

/** The three numbers that address a workout, plus the day it sits on. Every one
 *  of them is a CLAIM the executor re-reads and re-proves before writing. */
interface AddressedTarget {
  /** COROS calendar day, YYYYMMDD (the wire format, not yyyy-mm-dd). */
  happenDay: string;
  /** The idInPlan the server stored it under. A claim, not an identity. */
  idInPlan: string;
  /** The recorded `planProgramId` — third element of the write address. */
  programId: string;
  /** The container plan. Nothing outside it is ever read or written. */
  planId: string;
}

/**
 * A workout THIS APP CREATED, proven by the program-name stamp it left.
 * Identical in shape to `DeleteWorkoutTarget`, deliberately — a content update
 * is addressed by the same triple a delete is, and a caller that can address
 * one can address the other.
 */
export interface StampProvenTarget extends AddressedTarget {
  /** The exact program-name stamp recorded at push time. */
  name: string;
  importedFingerprint?: undefined;
}

/**
 * A workout COROS AUTHORED and this app imported, proven by re-reading it —
 * see THE SECOND PROOF at the top of this file. There is no `name`, because
 * there is no stamp: we did not write this program and never claimed to.
 */
export interface ImportProvenTarget extends AddressedTarget {
  name?: undefined;
  /**
   * COROS'S OWN ID FOR THE PROGRAM — `planned_workouts.source_program_id` as an
   * IMPORT wrote it (`normalize.ts` stores `program.id`, an 18-digit
   * server-issued identifier). This is the identity anchor: a recycled slot
   * holds a different program OBJECT, so it carries a different id, and no
   * amount of content coincidence can forge one.
   */
  importedProgramId: string;
  /**
   * `corosProgramFingerprint` of the program AS THE APP LAST OBSERVED IT —
   * `planned_workouts.source_content_fingerprint`. The identity above says it is
   * the same program; this says nothing has changed on the wire since the app
   * last looked, which is the optimistic-concurrency half.
   */
  importedFingerprint: string;
}

/**
 * Where the caller believes the workout is, and how it can prove the thing
 * there is the thing it means. Exactly one proof, chosen by which field is set.
 */
export type UpdateContentTarget = StampProvenTarget | ImportProvenTarget;

export interface UpdateWorkoutContentSpec {
  /** Where the caller believes our workout is, and under what stamp. */
  target: UpdateContentTarget;
  /**
   * The workout's NEW intent — a coach run/lift/mobility session, or a studio
   * lift session. Built through `buildProgramFor`, the same dispatch
   * `createWorkout` uses, so the wire ends up carrying exactly the program a
   * fresh create of this session would have carried.
   */
  session: StudioSession | CoachSession;
  /**
   * The name the rewritten program carries.
   *
   * STAMP-PROVEN target: defaults to `target.name` — a pure content change keeps
   * the workout's identity. Pass it only for a deliberate RENAME (the coach's
   * stamp is `${title} — ${date}`, so an eased session whose title changed has a
   * new one). A rename is refused if anything in the plan already carries the
   * new stamp: two placements under one stamp make every later delete ambiguous.
   *
   * IMPORT-PROVEN target: REQUIRED, and it is a title, not a stamp — see
   * `updateWorkoutContent`'s rename section for why we do not stamp a session
   * COROS authored.
   */
  name?: string;
  /** Threshold pace (sec/km) anchoring the new session's pace targets. */
  thresholdPaceSecPerKm?: number;
}

/**
 * Why a content update ended where it did. `already_current` is the only one
 * that comes back with `ok: true`.
 */
export type UpdateContentReason =
  /** The wire already carried this exact intent: idempotent no-op, `ok` true. */
  | "already_current"
  /** Nothing in the plan carries the stamp and the address is free — the
   * workout is gone from COROS (the athlete deleted it, or it never landed).
   * Nothing was written. */
  | "not_found"
  /** The recorded address is occupied, but not by a workout provably ours on
   * the recorded day. Drift: never overwritten. Under the IMPORTED proof this
   * is also how "the address holds different content than we imported" refuses
   * — the athlete edited it in COROS, or the slot was recycled. */
  | "stamp_mismatch"
  /** The workout is in the plan, on another day — the athlete moved it in
   * COROS. `serverHappenDay` says where. Nothing was written. */
  | "moved"
  /** Two placements carry the stamp, the link key resolves to both our program
   * and one we did not write, or the write address is shared with another
   * entity of the plan. Nothing was written. */
  | "ambiguous"
  /** No plan scope — cannot act safely. */
  | "no_target_plan"
  /** The day lies outside the span the plan-wide sweep can see. */
  | "out_of_span"
  /** The server rejected the write (`code` carries its result). */
  | "rejected"
  /** Accepted (or the request died), but the read-back found nothing carrying
   * either stamp on the day. */
  | "not_visible"
  /** The read-back found the workout and the wire is NOT the new intent.
   * `observedFingerprint` is what is actually there. */
  | "verification_failed"
  /** `fallback: "recreate"` only: the re-create derived a slot that was taken. */
  | "slot_occupied"
  /** `fallback: "recreate"` only: the re-create landed on another day. */
  | "wrong_date"
  /** A local failure (bad session, bad catalog, network) — see `error`. */
  | "error";

export interface UpdateContentResult {
  ok: boolean;
  /** COROS envelope result code of the write, when one was sent. */
  code?: string;
  /** Set on every outcome except a plain verified in-place rewrite. */
  reason?: UpdateContentReason;
  /** How the desired state was reached, when it was reached. */
  pathUsed?: "in_place_update" | "delete_and_create";
  /**
   * The address the workout is at NOW, re-read after the write. Unchanged by an
   * in-place rewrite (that is the point of one) and NEW after a
   * `delete_and_create`, where the caller must re-record all four fields.
   */
  serverIdInPlan?: string;
  serverProgramId?: string;
  serverEntityId?: string;
  serverPlanId?: string;
  /** The day the workout is actually on (yyyy-mm-dd), whenever one was located. */
  serverHappenDay?: string;
  /**
   * `corosProgramFingerprint` of the program this call PUT ON THE WIRE, after
   * `/training/program/calculate` spliced its duration and load in — the
   * version the server stores and the next read returns.
   *
   * The caller must stamp this on its own row (as the create path already
   * stamps `CreateResult.wireFingerprint`): the app-side fingerprint of an
   * eased session describes a program that was never written, and a later
   * move's content guard would read that as `content_changed`.
   */
  wireFingerprint?: string;
  /**
   * What the fingerprint at the address actually IS. Equal to
   * `wireFingerprint` on success; on `verification_failed` / `stamp_mismatch`
   * it is the evidence. Never contains a title, so it is safe to persist.
   */
  observedFingerprint?: string;
  /** Run sessions: blocks that went to the watch as bare timers (no pace band). */
  paceTargetsOwed?: number;
  error?: string;
}

export interface UpdateWorkoutContentOptions {
  /**
   * Exercise catalog, originId → display name. Required for lift and mobility
   * sessions (every step must resolve here); a run session never reads it, so
   * an empty map is correct for one.
   */
  catalog: Map<string, string>;
  /** yyyy-mm-dd anchor for the plan-wide sweep. Defaults to the system date. */
  today?: string;
  /**
   * What to do when an in-place rewrite is impossible:
   *   - `"refuse"` (default): return the category and write nothing.
   *   - `"recreate"`: converge anyway, via delete-then-create — the pair the
   *     move fallback already proves. Only ever taken when the server CLEANLY
   *     REJECTED the in-place write (nothing changed) or the workout is
   *     provably absent (`not_found`); never on drift, never on ambiguity, and
   *     never after a write whose outcome is unknown.
   *
   * The default is `"refuse"` because a missing workout usually means the
   * athlete deleted it in COROS, and re-creating it would overrule them. A
   * caller that KNOWS the session belongs on the watch (a converge/repair job)
   * passes `"recreate"` and must re-record the new address from the result.
   */
  fallback?: "refuse" | "recreate";
  /**
   * Diagnostic sink. SENSITIVITY: lines written here never contain a workout
   * title the caller did not author unless `verbose` is set.
   */
  log?: (line: string) => void;
  /** Allow foreign workout TITLES into `log` (interactive tools only). */
  verbose?: boolean;
}

function describeForLog(found: Located, verbose: boolean): string {
  return verbose ? describeForeignForConsole(found) : describeForeignForReport(found);
}

/** The server's own address for a located placement — never a remembered one. */
function addressOf(
  found: Located,
  fallbackPlanId: string,
): Pick<
  UpdateContentResult,
  "serverIdInPlan" | "serverProgramId" | "serverEntityId" | "serverPlanId" | "serverHappenDay"
> {
  return {
    serverIdInPlan: String(found.entity.idInPlan),
    serverProgramId: String(found.entity.planProgramId ?? found.entity.idInPlan),
    serverEntityId: found.entity.id != null ? String(found.entity.id) : undefined,
    serverPlanId: String(found.entity.planId ?? fallbackPlanId),
    serverHappenDay: found.date,
  };
}

/**
 * The program to PUT at an existing address: the new content wearing the old
 * program's identity.
 *
 * A content rewrite is not a create. `id`, `idInPlan`, `planId` and `version`
 * are what make the payload be ABOUT the program at that address — the
 * builders emit `idInPlan: 0`, `planId: ""`, `version: 0` because a create's
 * caller splices the derived values in, and sending those to a `status: 2`
 * update would address nothing (or reset a version the server counts on).
 * Everything else comes from the freshly built program, so the content that
 * lands is byte-for-byte what a create of the same session would have written.
 */
export function rewriteProgramContent(
  existing: RawCorosProgram,
  built: RawCorosProgram,
  fallbackPlanId: string,
): RawCorosProgram {
  const out: RawCorosProgram = {
    ...existing,
    ...built,
    idInPlan: existing.idInPlan,
    planId: String(existing.planId ?? fallbackPlanId),
  };
  if (existing.id !== undefined) out.id = existing.id;
  else delete out.id;
  if (existing.version !== undefined) out.version = existing.version;
  if (existing.pbVersion !== undefined) out.pbVersion = existing.pbVersion;
  return out;
}

/**
 * Rewrite one already-pushed workout's program in place, and prove the wire
 * now carries the new intent.
 *
 * Sequence — the create/delete invariants, applied to an overwrite:
 *   1. build the new program FIRST (schema + catalog validation before any wire
 *      call, so a bad session can never reach the account);
 *   2. plan-wide sweep → re-prove ownership on the recorded day, by whichever
 *      proof the target carries (stamp, or the imported re-read), and refuse
 *      every ambiguity (two matches, mixed link key, shared write address);
 *   3. calculate-then-write, and if the post-calculate program is already what
 *      the address holds, send NOTHING (`already_current`);
 *   4. `status: 2` update, addressed at the placement the proof found;
 *   5. read-after-write: the placement must still be on the same day AND its
 *      fingerprint must equal what we put on the wire;
 *   6. return the server's own address plus the wire fingerprint the caller
 *      must stamp.
 *
 * Never throws: every failure is an `UpdateContentResult` the caller can record.
 */
export async function updateWorkoutContent(
  client: CorosClient,
  spec: UpdateWorkoutContentSpec,
  opts: UpdateWorkoutContentOptions,
): Promise<UpdateContentResult> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const log = opts.log ?? ((): void => undefined);
  const verbose = opts.verbose === true;
  const target = spec.target;
  const date = corosDayToLocalDate(Number(target.happenDay));
  /** Which of the two proofs this target carries — see THE SECOND PROOF above. */
  const imported = target.importedFingerprint !== undefined;
  const newName: string | undefined = spec.name ?? target.name;
  /**
   * Does this placement carry the recorded content, at the recorded address?
   * The imported proof, as one predicate: `idInPlan` locates and the fingerprint
   * confirms, and BOTH have to hold. Never used alone — the caller of
   * `ownedPlacements` still requires the recorded DAY as well.
   *
   * `target.programId` IS DELIBERATELY NOT PART OF THIS TEST, and that is not a
   * relaxation. Two reasons, and the first is a bug in the column:
   *
   *  1. `planned_workouts.source_program_id` answers two different questions
   *     depending on where the row came from. An import stores COROS's own
   *     `program.id` (`normalize.ts`: `program?.id`) — an 18-digit server id. A
   *     create stores `planProgramId ?? idInPlan` (the delete triple's third
   *     element), which on the athlete's live account is the literal string
   *     "42". Gating on it would compare an 18-digit program id against a
   *     two-digit slot number and refuse every imported row as `not_found`.
   *  2. It was never load-bearing for identity anyway. The STAMP proof is name
   *     plus day and ignores the address entirely — `stampedPlacements` sweeps
   *     the whole plan — so `idInPlan` + fingerprint + day is strictly MORE
   *     address discrimination than the shipped proof uses, not less. And the
   *     write is addressed at `addressOf(found)`, the server's own ids from the
   *     placement this proof located, never at the remembered claim; the danger
   *     a shared address poses is caught by `writeAddressClash` below, which
   *     reads the located entity rather than the caller's memory.
   */
  const importClaim = target.importedFingerprint !== undefined ? target : undefined;
  const isOursImported: PlacementPredicate = (program, entity) =>
    importClaim !== undefined &&
    String(entity.idInPlan) === importClaim.idInPlan &&
    String(program.id ?? "") === importClaim.importedProgramId &&
    corosProgramFingerprint(program) === importClaim.importedFingerprint;
  /** Ownership: the stamp recorded at push time, or the imported re-read. */
  const isOurs: PlacementPredicate = imported
    ? isOursImported
    : (program): boolean => program.name === target.name;
  /**
   * Where the workout is expected to be AFTER the write.
   *
   * Stamp-proven: the NEW stamp identifies it (an ease can rename it).
   * Import-proven: the address does — the fingerprint that identified it before
   * the write is precisely the thing the write replaced, so re-proving with it
   * would look for the workout we just deliberately changed. The address is
   * unmoved by a `status: 2` in-place rewrite, which is what makes it the right
   * anchor, and the fingerprint comparison below is what actually verifies.
   */
  const isOursAfter: PlacementPredicate = imported
    ? (_program, entity): boolean => String(entity.idInPlan) === target.idInPlan
    : (program): boolean => program.name === newName;

  if (newName === undefined) {
    // Only reachable for an import-proven target: a stamp-proven rewrite can
    // default its name to the stamp it is replacing, an imported one has no
    // stamp to default to, and silently keeping COROS's old title would leave
    // the watch naming a session the app has renamed.
    return {
      ok: false,
      reason: "error",
      error: "an import-proven rewrite must be given the name to write; there is no stamp to reuse",
    };
  }
  if (imported && opts.fallback === "recreate") {
    // Not a caller mistake to route around — a refusal, at the safety core.
    // Re-creating an imported workout puts a session back into a plan this app
    // does not own, at a brand-new idInPlan, after the athlete (or COROS) took
    // it out. See THE SECOND PROOF: `not_found` is terminal for these.
    return {
      ok: false,
      reason: "error",
      error:
        "refusing `fallback: recreate` for an import-proven rewrite — this app did not create this" +
        " workout and must not re-create it inside a COROS-authored plan",
    };
  }

  if (target.planId === "") {
    return {
      ok: false,
      reason: "no_target_plan",
      error: "no target plan id — refusing to rewrite a workout without a plan scope",
    };
  }
  const observable = observationSpan(today);
  if (date < observable.start || date > observable.end) {
    return {
      ok: false,
      reason: "out_of_span",
      error:
        `happenDay ${date} is outside the observed span ${observable.start}…${observable.end};` +
        " refusing to rewrite on a partial view",
    };
  }

  // 1. The new content, built and validated before any wire call.
  let built: RawCorosProgram;
  let paceTargetsOwed = 0;
  try {
    built = buildProgramFor(
      {
        happenDay: target.happenDay,
        name: newName,
        session: spec.session,
        thresholdPaceSecPerKm: spec.thresholdPaceSecPerKm,
      },
      opts.catalog,
    );
    if (isRunSession(spec.session)) {
      const session = spec.session as CoachSession;
      paceTargetsOwed = missingPaceTargets(session, spec.thresholdPaceSecPerKm);
      if (paceTargetsOwed > 0) {
        log(
          `  no pace band for ${paceTargetsOwed}/${session.run?.blocks.length ?? 0} block(s)` +
            ` — they rewrite as bare timers (threshold=${spec.thresholdPaceSecPerKm ?? "none"})`,
        );
      }
    }
  } catch (e) {
    return { ok: false, reason: "error", error: errText(e) };
  }
  /** Every return past this point carries the pace debt, success or not. */
  const owed = paceTargetsOwed > 0 ? { paceTargetsOwed } : {};

  const recreate = (): Promise<UpdateContentResult> =>
    deleteThenCreate(client, spec, opts, { today, log, verbose, newName, owed });

  try {
    // 2. Ownership, re-proven plan-wide. A `status: 2` write reaches whatever
    //    the address holds, so this is the only thing standing between a stale
    //    remembered id and someone else's workout.
    const before = planView(await readFullSpan(client, today), target.planId);
    /** What the proof is called in a refusal the operator has to act on. */
    const proofName = imported ? "recorded content" : "recorded stamp";

    if (ownershipAmbiguities(before, isOurs).some((a) => a.date === date)) {
      return {
        ok: false,
        reason: "ambiguous",
        error:
          `idInPlan ${target.idInPlan} on ${date} resolves to both this workout's program and one` +
          " it did not create — not rewritten; fix it by hand in the COROS app",
        ...owed,
      };
    }

    const ours = ownedPlacements(before, isOurs);
    if (ours.length > 1) {
      // The proof is what makes ownership decidable; two matches make it
      // undecidable. For a stamp: `createWorkout` refuses to ever produce this
      // state, so it means something outside this app duplicated the workout.
      // For an import: two entities share one address AND one content, and
      // nothing observable separates them.
      return {
        ok: false,
        reason: "ambiguous",
        error:
          `${ours.length} workouts in plan ${target.planId} match the ${proofName}` +
          ` (${ours.map((f) => f.date).join(", ")}) — refusing to guess which one to rewrite`,
        ...owed,
      };
    }

    const found = ours.find((f) => f.date === date);
    if (!found) {
      const elsewhere = ours[0];
      if (elsewhere) {
        // Provably ours, on a day the caller did not ask about. Rewriting it
        // would edit a workout the athlete deliberately moved, and the caller
        // cannot even record the change against the right date.
        return {
          ok: false,
          reason: "moved",
          serverHappenDay: elsewhere.date,
          error:
            `the workout matching the ${proofName} is on ${elsewhere.date}, not ${date} — it was` +
            " moved in COROS; re-address the update (or move it back) rather than rewriting blind",
          ...owed,
        };
      }
      // Nothing of ours on the day. Is the recorded address occupied?
      // Keyed the same way the ownership predicate above is keyed, so a refusal
      // and a proof never disagree about what "the recorded address" means.
      const atAddress = before.entities.find(
        (e) =>
          String(e.idInPlan) === target.idInPlan &&
          (imported || String(e.planProgramId ?? e.idInPlan) === target.programId),
      );
      if (atAddress) {
        const occupant: Located = {
          entity: atAddress,
          program: programsFor(before, atAddress)[0],
          date: corosDayToLocalDate(atAddress.happenDay),
        };
        log(`  address occupied by ${describeForLog(occupant, verbose)} — NOT rewritten`);
        return {
          ok: false,
          reason: "stamp_mismatch",
          serverHappenDay: occupant.date,
          // The observed fingerprint is the EVIDENCE for an imported refusal —
          // "the address holds something other than what we imported" is only
          // actionable if the operator can see what it holds. It never contains
          // a title, so it is safe to persist and to report.
          ...(imported && occupant.program
            ? { observedFingerprint: corosProgramFingerprint(occupant.program) }
            : {}),
          error: imported
            ? `idInPlan ${target.idInPlan} in plan ${target.planId} does not hold what this app` +
              ` imported on ${date}, so it is not ours to overwrite. Expected program` +
              ` ${importClaim?.importedProgramId ?? "?"} content` +
              ` ${importClaim?.importedFingerprint ?? "?"}; found program` +
              ` ${String(occupant.program?.id ?? "none")} content` +
              ` ${occupant.program ? corosProgramFingerprint(occupant.program) : "none"}` +
              ` (entity idInPlan ${String(atAddress.idInPlan)}, planProgramId` +
              ` ${String(atAddress.planProgramId ?? "absent")}).` +
              " Either COROS holds something else now, or the two sides disagree about which" +
              " program this placement links to. The address is a claim and not an identity"
            : `idInPlan ${target.idInPlan} in plan ${target.planId} no longer carries the recorded` +
              ` stamp on ${date} — ${describeForeignForReport(occupant)}; COROS recycles idInPlan` +
              " slots, so this address is a claim and not an identity. Refusing to overwrite it",
          ...owed,
        };
      }
      if (opts.fallback === "recreate") {
        log(`  nothing at the recorded address and no stamp in the plan — creating instead`);
        return await recreate();
      }
      return { ok: false, reason: "not_found", ...owed };
    }

    // The write address comes from the placement we PROVED, never from the
    // recorded claim — the server was observed renumbering on create, and the
    // stamp is the authority the recorded id is not.
    const entity = found.entity;
    const program = found.program;
    if (!program) {
      // `stampedPlacements` cannot return a placement without a program; kept
      // as an explicit refusal rather than a `!` so the invariant is stated.
      return { ok: false, reason: "stamp_mismatch", error: "the placement carries no program" };
    }
    const planId = String(entity.planId ?? target.planId);
    if (String(entity.idInPlan) !== target.idInPlan) {
      log(
        `  stamp found at idInPlan ${String(entity.idInPlan)}, not the recorded ${target.idInPlan}` +
          " — writing to the proven address",
      );
    }

    // A `status: 2` update is addressed by (planId, idInPlan, planProgramId) —
    // the delete triple exactly — so a shared address is as dangerous here as
    // it is for a delete: the server cannot tell our workout from the other one.
    const clash = writeAddressClash(before, found, isOurs);
    if (clash) {
      log(
        `  !! write address idInPlan=${String(entity.idInPlan)} is shared with` +
          ` ${describeForLog(clash, verbose)} — NOT rewritten`,
      );
      return {
        ok: false,
        reason: "ambiguous",
        error:
          "NOT rewritten — its write address (planId/idInPlan/planProgramId) is shared with" +
          ` ${describeForeignForReport(clash)}; fix it by hand in the COROS app`,
        ...addressOf(found, planId),
        ...owed,
      };
    }

    // THE NAME AN IMPORTED REWRITE LEAVES IS A TITLE, NOT A STAMP — and the
    // stamp-uniqueness guard below is deliberately not applied to it.
    //
    // We do not stamp a session COROS authored. The stamp is an authorship
    // claim ("only this app emits this exact name"), and putting one on a
    // workout inside the athlete's own COROS plan would assert a fact that is
    // not true, rename the session in the COROS app and on the watch face, and
    // make the next import strip a name it should never have had to see. What
    // goes on the wire is the app's plain session title, which is exactly what
    // convergence means: the watch says what the app says.
    //
    // Uniqueness is not needed for it, because nothing's ownership keys on it —
    // the imported proof reads the address and the fingerprint, never the name.
    // Requiring it would refuse the ordinary COROS plan, which repeats "Easy
    // Run" all week. The one collision that could matter is a title that is
    // character-for-character a coach STAMP (`${title} — ${date}`); that would
    // make the coach row's own next write refuse `ambiguous`, which is the
    // fail-safe direction, not a wrong write.
    //
    // A rename must not produce two placements under one stamp: that is the
    // state `createWorkout` refuses to create and `deleteWorkout` cannot act on.
    if (!imported && newName !== target.name) {
      const takers = stampedPlacements(before, (name) => name === newName);
      if (takers.length > 0) {
        return {
          ok: false,
          reason: "ambiguous",
          error:
            `a workout in plan ${planId} already carries the new stamp (on ${takers[0]!.date})` +
            " — refusing to create a second workout under one stamp",
          ...addressOf(found, planId),
          ...owed,
        };
      }
    }

    // 3. Calculate-then-write, and the idempotency gate.
    let rewritten = rewriteProgramContent(program, built, planId);
    try {
      rewritten = applyCalculated(rewritten, await client.calculateProgramMetrics(rewritten));
    } catch (e) {
      log(`  program/calculate failed (${errText(e)}) — proceeding without estimates`);
    }
    // Taken off the exact object about to be written: after calculate, before
    // the write, so it describes what the next read will return.
    const wireFingerprint = corosProgramFingerprint(rewritten);
    const preFingerprint = corosProgramFingerprint(program);
    const ids = addressOf(found, planId);
    if (wireFingerprint === preFingerprint) {
      // The wire already IS the new intent — a retried job, or a session eased
      // back to what it was. Sending the write would be harmless; not sending
      // it is what makes this callable on every apply.
      log(`  "${newName}" already matches the intent on ${date} — no write`);
      return {
        ok: true,
        reason: "already_current",
        ...ids,
        wireFingerprint,
        observedFingerprint: preFingerprint,
        ...owed,
      };
    }

    // The entity travels back as read, with the two fields the content owns:
    // its name, and its sport (a run program inside a strength-typed entity
    // lands mistyped on the real calendar — audit#2 finding 5).
    const edited: RawCorosEntity = { ...entity, name: newName };
    if (rewritten.sportType != null) edited.sportType = rewritten.sportType;

    // 4. The write.
    let code: string | undefined;
    let threw: string | undefined;
    try {
      const write = await client.updateScheduleProgram(edited, rewritten, planId);
      code = write.result;
      log(`  status:2 content rewrite at ${date} (idInPlan ${String(entity.idInPlan)}) → result=${code}`);
    } catch (e) {
      // Network failure mid-write: state unknown. The read below decides.
      threw = errText(e);
      log(`  status:2 content rewrite threw (${threw}) — reading back`);
    }

    // 5. Read-after-write: the same day, the new stamp, and the fingerprint of
    //    what we actually sent. A stamp match alone is not verification — the
    //    whole failure this module exists for was a workout whose name was
    //    right and whose content was months out of date.
    //
    //    PLAN-WIDE, like the delete's verification read and for the same reason:
    //    a write the server matched loosely could land anywhere in the plan, and
    //    a ±3-day window cannot see a workout 200 days out. The extra windows
    //    are four requests on a path that runs once per approved change.
    const after = planView(await readFullSpan(client, today), planId);
    const now =
      ownedPlacements(after, isOursAfter).find((f) => f.date === date) ??
      ownedPlacements(after, isOurs).find((f) => f.date === date);
    const observedFingerprint = now?.program ? corosProgramFingerprint(now.program) : undefined;
    const observedIds = now ? addressOf(now, planId) : ids;

    // AND NOTHING ELSE CHANGED — `deleteWorkout`'s "nothing was taken with it",
    // in the units an overwrite can damage. The write is addressed by a triple;
    // if the server ever matched one loosely (by `planProgramId` alone, say),
    // our program would land on a workout we did not target, and the read-back
    // above would happily verify OUR half of that. Every program visible in
    // both reads is compared, ours excepted.
    const ourProgramKey = String(program.idInPlan);
    const wasBefore = new Map<string, string>();
    for (const p of before.programs) {
      const key = String(p.idInPlan);
      if (key !== ourProgramKey) wasBefore.set(key, corosProgramFingerprint(p));
    }
    const collateral = after.programs.filter((p) => {
      const was = wasBefore.get(String(p.idInPlan));
      return was !== undefined && was !== corosProgramFingerprint(p);
    });
    if (collateral.length > 0) {
      return {
        ok: false,
        code,
        reason: "verification_failed",
        error:
          `THE REWRITE CHANGED ${collateral.length} PROGRAM(S) IT DID NOT TARGET in plan ${planId}` +
          ` (idInPlan ${collateral.map((p) => String(p.idInPlan)).join(", ")}) — check the COROS calendar`,
        ...observedIds,
        wireFingerprint,
        ...(observedFingerprint !== undefined ? { observedFingerprint } : {}),
        ...owed,
      };
    }

    if (observedFingerprint === wireFingerprint) {
      return {
        ok: true,
        code,
        pathUsed: "in_place_update",
        ...observedIds,
        wireFingerprint,
        observedFingerprint,
        ...owed,
      };
    }

    if (threw !== undefined) {
      if (observedFingerprint === preFingerprint) {
        // Nothing landed: a clean, retryable failure.
        return { ok: false, reason: "error", error: threw, ...observedIds, observedFingerprint, ...owed };
      }
      return {
        ok: false,
        reason: now ? "verification_failed" : "not_visible",
        error: `${threw} — and the read-back does not match the intent`,
        ...observedIds,
        ...(observedFingerprint !== undefined ? { observedFingerprint } : {}),
        ...owed,
      };
    }

    if (code !== "0000") {
      if (observedFingerprint === preFingerprint) {
        // Cleanly rejected, nothing changed. This is the one server-side "no"
        // that delete-then-create can honestly answer.
        if (opts.fallback === "recreate") {
          log(`  update rejected (${code ?? "-"}) — falling back to delete-then-create`);
          return await recreate();
        }
        return {
          ok: false,
          code,
          reason: "rejected",
          error:
            `server rejected the content rewrite (result ${code ?? "-"}) at idInPlan` +
            ` ${String(entity.idInPlan)}; the workout is untouched`,
          ...observedIds,
          observedFingerprint,
          ...owed,
        };
      }
      return {
        ok: false,
        code,
        reason: now ? "verification_failed" : "not_visible",
        error: `server returned ${code ?? "-"} and the wire is neither the old nor the new content`,
        ...observedIds,
        ...(observedFingerprint !== undefined ? { observedFingerprint } : {}),
        ...owed,
      };
    }

    if (!now) {
      return {
        ok: false,
        code,
        reason: "not_visible",
        error: `the rewrite returned 0000 but nothing carrying the stamp is on ${date} any more`,
        ...owed,
      };
    }
    return {
      ok: false,
      code,
      reason: "verification_failed",
      error:
        `the rewrite returned 0000 but the program on ${date} is not what was sent —` +
        ` ${now?.program ? describeProgramDelta(rewritten, now.program) : "nothing to compare"}`,
      ...observedIds,
      wireFingerprint,
      ...(observedFingerprint !== undefined ? { observedFingerprint } : {}),
      ...owed,
    };
  } catch (e) {
    // Any read that fails — including the verification read AFTER an accepted
    // write — lands here as a retryable `error`. That is sound precisely because
    // step 3 exists: a retry re-reads, finds the wire already carrying the
    // intent, and returns `already_current` without writing again.
    return { ok: false, reason: "error", error: errText(e), ...owed };
  }
}

/**
 * The `fallback: "recreate"` path: remove what is there through the guarded
 * delete, then create the new intent through the guarded create.
 *
 * Both halves are the already-live executors, so this function adds no
 * destructive code of its own — it cannot delete anything `deleteWorkout`
 * would refuse to delete, and it cannot create anything `createWorkout` would
 * refuse to create. The ORDER is delete-then-create rather than the move
 * fallback's insert-before-delete for one reason: the new workout carries the
 * same stamp as the old one whenever the title is unchanged, and
 * `createWorkout` (correctly) refuses to put a second workout on the calendar
 * under a stamp that already exists. A create that fails after the delete
 * leaves the workout OFF the watch, which is why this is opt-in and why the
 * result says which half ran.
 */
async function deleteThenCreate(
  client: CorosClient,
  spec: UpdateWorkoutContentSpec,
  opts: UpdateWorkoutContentOptions,
  ctx: {
    today: string;
    log: (line: string) => void;
    verbose: boolean;
    newName: string;
    owed: { paceTargetsOwed?: number };
  },
): Promise<UpdateContentResult> {
  const { target } = spec;
  const { today, log, verbose, newName, owed } = ctx;
  if (target.name === undefined) {
    // Structurally unreachable — `updateWorkoutContent` refuses `recreate` for
    // an import-proven target before it reads anything — and stated rather than
    // asserted, because `deleteWorkout` is authorized BY THE STAMP and there is
    // no honest value to pass it here.
    return {
      ok: false,
      reason: "error",
      error: "delete-then-create needs a stamp to authorize the delete; an imported target has none",
      ...owed,
    };
  }

  const del = await deleteWorkout(
    client,
    {
      happenDay: target.happenDay,
      name: target.name,
      idInPlan: target.idInPlan,
      programId: target.programId,
      planId: target.planId,
    },
    { today, log, verbose },
  );
  if (!del.ok && del.refused !== "not_found") {
    // The delete refused, so nothing was removed — report the refusal in the
    // update's own vocabulary rather than pretending the rewrite failed.
    return {
      ok: false,
      reason: del.refused === "ambiguous" ? "ambiguous" : del.refused === "stamp_mismatch" ? "stamp_mismatch" : "error",
      ...(del.code !== undefined ? { code: del.code } : {}),
      error: del.error ?? "the guarded delete refused; nothing was rewritten",
      ...owed,
    };
  }

  const created = await createWorkout(
    client,
    {
      happenDay: target.happenDay,
      name: newName,
      session: spec.session,
      thresholdPaceSecPerKm: spec.thresholdPaceSecPerKm,
    },
    { catalog: opts.catalog, today, log, verbose },
  );
  return fromCreateResult(created, newName);
}

/** A `CreateResult` in the update vocabulary. */
function fromCreateResult(created: CreateResult, newName: string): UpdateContentResult {
  const ids = {
    ...(created.serverIdInPlan !== undefined ? { serverIdInPlan: created.serverIdInPlan } : {}),
    ...(created.serverProgramId !== undefined ? { serverProgramId: created.serverProgramId } : {}),
    ...(created.serverEntityId !== undefined ? { serverEntityId: created.serverEntityId } : {}),
    ...(created.serverPlanId !== undefined ? { serverPlanId: created.serverPlanId } : {}),
    ...(created.serverHappenDay !== undefined ? { serverHappenDay: created.serverHappenDay } : {}),
  };
  const shared = {
    ...(created.code !== undefined ? { code: created.code } : {}),
    ...(created.wireFingerprint !== undefined
      ? { wireFingerprint: created.wireFingerprint, observedFingerprint: created.wireFingerprint }
      : {}),
    ...(created.paceTargetsOwed !== undefined ? { paceTargetsOwed: created.paceTargetsOwed } : {}),
    ...ids,
  };
  if (created.ok) {
    return { ok: true, pathUsed: "delete_and_create", ...shared };
  }
  const reason: UpdateContentReason =
    created.reason === "already_present"
      ? "moved" // the stamp exists on another day — the same drift `moved` names
      : created.reason === "slot_occupied"
        ? "slot_occupied"
        : created.reason === "wrong_date"
          ? "wrong_date"
          : created.reason === "rejected"
            ? "rejected"
            : created.reason === "not_visible"
              ? "not_visible"
              : created.reason === "no_target_plan"
                ? "no_target_plan"
                : created.reason === "out_of_span"
                  ? "out_of_span"
                  : "error";
  return {
    ok: false,
    reason,
    pathUsed: "delete_and_create",
    error:
      created.error ??
      `re-creating "${newName}" after the delete did not end in a verified workout`,
    ...shared,
  };
}
