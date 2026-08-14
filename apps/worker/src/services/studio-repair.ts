/**
 * ONE-SHOT EXERCISE-ID REPAIR for a stored studio plan.
 *
 * Why this exists: a plan can be generated against a catalog whose names were
 * still raw COROS i18n keys (`T1211`), and the model then picks `originId`s by
 * matching those keys rather than the movements they stand for. Every load,
 * set, rep and note is right; only the identity of each movement is wrong. The
 * fix is a curated id→id remap applied to the stored plan — not a regenerate,
 * which would throw away the prescription the user actually approved.
 *
 * THE REMAP IS A PERMUTATION, NOT A LIST OF ROW EDITS. Several targets are
 * already in use by a DIFFERENT exercise of the same plan (the DB-bench row
 * wants `T1004`, which the push-up row currently holds; the push-up row wants
 * `T1004`'s old home, and so on). Applying rules one at a time over a mutating
 * plan would let an exercise rewritten by rule A be re-read and rewritten again
 * by rule B — a silent, near-undetectable corruption of exactly the rows a
 * repair is supposed to fix.
 *
 * `applyExerciseRemap` is therefore a SINGLE traversal of the ORIGINAL plan
 * that builds a brand-new plan object. Every rule lookup is keyed on the
 * exercise's ORIGINAL `originId`, and nothing it writes is ever read back, so
 * a swap pair (A→B, B→A) resolves correctly by construction rather than by
 * ordering luck. It is pure — no db, no clock — so the permutation itself is
 * unit-testable without a route or a database.
 *
 * Collisions (two distinct sources landing on one target) are REPORTED, not
 * refused: a catalog with one generic "Glute Stretch" legitimately absorbs both
 * a pigeon stretch and a figure-4 stretch. The caller decides whether a
 * reported collision was intended.
 */

import type { LiftingPlan } from "@rg/domain";
import { resolveExerciseName } from "./exercise-catalog.js";

export interface RemapRule {
  /** The `originId` currently stored on the exercise. */
  from: string;
  /** The `originId` it should carry — must exist in `coros_exercises`. */
  to: string;
  /** The display name to store alongside it (the stored one is an i18n key). */
  toName: string;
}

export type RepairWarningCode =
  /** Two or more distinct sources map onto one target. */
  | "collision"
  /** A collision that lands INSIDE one session: that session will show the
   *  same exercise name twice on the watch, told apart only by position. Not
   *  an error (the program builder numbers steps independently), but the one
   *  collision consequence a human should see before agreeing to it. */
  | "duplicate_in_session"
  /** A rule whose `from` and `to` are the same id — a no-op. */
  | "identity_rule"
  /** A rule whose `from` never appears in the plan (the route rejects these
   *  before ever calling in; reported here for direct/pure callers). */
  | "unused_rule"
  /** An `originId` in the plan that no rule covers — deliberately left alone. */
  | "unmapped_exercise"
  /** `toName` is not what the catalog calls `to`. */
  | "name_not_catalog_name"
  /** The target is one of the catalog's generic Warm Up / Cool Down entries —
   *  the movement itself is lost and only the note carries the instruction. */
  | "placeholder_target"
  /** The target names an implement (barbell/dumbbell/cable/machine/…) but the
   *  prescription is bodyweight — one of the two shapes the original bug took. */
  | "bodyweight_on_implement_target"
  /** The target is a stretch/foam-roll/mobility entry but the prescription
   *  carries a real kg load — the other shape of the original bug. */
  | "kg_load_on_mobility_target"
  /** The exercise's own note marks it a warm-up or cool-down slot, and the
   *  target is a loaded implement movement (a "Barbell Pullover" in a
   *  pigeon-stretch slot is precisely what went wrong the first time). */
  | "recovery_slot_loaded_target";

export interface RepairWarning {
  code: RepairWarningCode;
  /** Source `originId`s involved. More than one only for `collision`. */
  from: string[];
  /** The mapping target, when the warning is about one. */
  to?: string;
  /** What the catalog calls the id this warning is about. */
  name?: string;
  /** The one session a `duplicate_in_session` warning is about. */
  where?: { week: number; sessionTitle: string };
  /** How many exercise instances the warning covers. */
  instances: number;
}

/** One distinct exercise's before/after, with its instance count. */
export interface ExerciseChange {
  from: string;
  /** The name as STORED on the plan today (typically a raw i18n key). */
  fromName: string;
  /** What the catalog calls `from` — the movement the plan wrongly identifies. */
  fromCatalogName: string;
  to: string;
  /** The name that will be stored (the caller's `toName`). */
  toName: string;
  /** What the catalog calls `to`. */
  toCatalogName: string;
  instances: number;
}

export interface UnmappedExercise {
  originId: string;
  name: string;
  catalogName: string;
  instances: number;
}

export interface RepairSummary {
  totals: {
    /** Every exercise instance in the plan, mapped or not. */
    exercises: number;
    /** Instances whose `originId` or `name` actually changes. */
    changed: number;
    /** Instances left byte-for-byte identical. */
    unchanged: number;
    distinctBefore: number;
    distinctAfter: number;
    rules: number;
    /** Rules that matched at least one exercise. */
    rulesApplied: number;
  };
  /** Per distinct exercise, most-used first. */
  changes: ExerciseChange[];
  unmapped: UnmappedExercise[];
  warnings: RepairWarning[];
}

/**
 * Name heuristics. These are deliberately narrow: they fire on IMPLEMENT words
 * (a name saying "barbell" cannot be a bodyweight movement) rather than on
 * movement words like "press"/"curl"/"row", every one of which has a genuine
 * bodyweight variant (a Nordic Hamstring Curl is bodyweight; a push-up is a
 * press). Word boundaries matter — an un-anchored /press/ matches "Positive
 * Pressure" and turns a neck drill into a false alarm.
 */
const IMPLEMENT_NAME = /\b(barbell|dumbbell|kettlebell|cable|machine|smith|sled|weighted)\b|\b(hex|t|trap)[-\s]bar\b/i;
const MOBILITY_NAME = /\b(stretch|foam[-\s]roll(?:ing)?|mobility|release|breathing)\b/i;
/** The plan's own slot convention: notes lead with "WARM-UP:" / "COOL-DOWN:". */
const RECOVERY_SLOT_NOTE = /^\s*(warm[-\s]?up|cool[-\s]?down)\b/i;
/** The catalog's two generic placeholders, matched by name so no id is baked in. */
const PLACEHOLDER_NAME = /^(warm[-\s]?up|cool[-\s]?down)$/i;

/**
 * Apply `rules` to `plan` and report exactly what happened.
 *
 * `catalogNames` is `coros_exercises` as `id → name` (the raw, possibly-i18n
 * name); every name this returns is run through `resolveExerciseName` so the
 * summary reads in human words rather than T-codes.
 */
export function applyExerciseRemap(
  plan: LiftingPlan,
  rules: RemapRule[],
  catalogNames: Map<string, string>,
): { plan: LiftingPlan; summary: RepairSummary } {
  const human = (id: string, storedName?: string): string =>
    resolveExerciseName(storedName ?? catalogNames.get(id) ?? id, id, catalogNames);

  const ruleByFrom = new Map<string, RemapRule>(rules.map((r) => [r.from, r]));
  // Resolved once, before the traversal: the per-instance detectors below run
  // for every exercise and must not re-resolve a name 235 times.
  const targetName = new Map<string, string>(rules.map((r) => [r.to, human(r.to)]));

  const before = new Map<string, { instances: number; storedName: string }>();
  const after = new Set<string>();
  const instanceWarnings = new Map<string, number>();
  const bump = (code: RepairWarningCode, from: string): void => {
    const key = `${code}|${from}`;
    instanceWarnings.set(key, (instanceWarnings.get(key) ?? 0) + 1);
  };

  let exercises = 0;
  let changed = 0;
  const sessionDuplicates: RepairWarning[] = [];

  // ── The single pass. Reads ONLY `plan`; writes only into fresh objects. ────
  const weeks = plan.weeks.map((week, weekIndex) => ({
    ...week,
    sessions: week.sessions.map((session) => {
      const nextExercises = session.exercises.map((ex) => {
        exercises++;
        const census = before.get(ex.originId);
        if (census) census.instances++;
        else before.set(ex.originId, { instances: 1, storedName: ex.name });

        // Keyed on the ORIGINAL id, always — this is what makes A→B / B→A
        // resolve correctly instead of chaining into A→B→A.
        const rule = ruleByFrom.get(ex.originId);
        if (!rule) {
          after.add(ex.originId);
          return ex;
        }

        const name = targetName.get(rule.to) ?? rule.to;
        if (ex.weight.type === "bodyweight" && IMPLEMENT_NAME.test(name)) {
          bump("bodyweight_on_implement_target", rule.from);
        }
        if (ex.weight.type === "kg" && ex.weight.value > 0 && MOBILITY_NAME.test(name)) {
          bump("kg_load_on_mobility_target", rule.from);
        }
        if (RECOVERY_SLOT_NOTE.test(ex.note ?? "") && IMPLEMENT_NAME.test(name)) {
          bump("recovery_slot_loaded_target", rule.from);
        }

        after.add(rule.to);
        if (rule.to !== ex.originId || rule.toName !== ex.name) changed++;
        // Spread first: `sets`, `reps`, `weight`, `restSeconds` and `note` are
        // carried through untouched (an absent optional `note` stays absent),
        // and `originId`/`name` are overwritten in the positions they already
        // occupy, so the serialized key order does not shift either.
        return { ...ex, originId: rule.to, name: rule.toName };
      });

      // Read off the RESULT of this session, not the source: a duplicate can
      // only be created by the mapping, and only shows up once it is applied.
      const perTarget = new Map<string, number>();
      for (const e of nextExercises) perTarget.set(e.originId, (perTarget.get(e.originId) ?? 0) + 1);
      for (const [originId, count] of perTarget) {
        if (count < 2) continue;
        const sources = [
          ...new Set(
            session.exercises
              .filter((e) => (ruleByFrom.get(e.originId)?.to ?? e.originId) === originId)
              .map((e) => e.originId),
          ),
        ];
        // One source id repeated in the session was ALREADY a repetition before
        // the repair (it just got renamed). Only a MERGE of distinct movements
        // is news.
        if (sources.length < 2) continue;
        sessionDuplicates.push({
          code: "duplicate_in_session",
          from: sources,
          to: originId,
          name: human(originId),
          where: { week: weekIndex + 1, sessionTitle: session.title },
          instances: count,
        });
      }

      return { ...session, exercises: nextExercises };
    }),
  }));

  // ── Reporting ─────────────────────────────────────────────────────────────
  const changes: ExerciseChange[] = [];
  for (const rule of rules) {
    const census = before.get(rule.from);
    if (!census) continue;
    changes.push({
      from: rule.from,
      fromName: census.storedName,
      fromCatalogName: human(rule.from, census.storedName),
      to: rule.to,
      toName: rule.toName,
      toCatalogName: targetName.get(rule.to) ?? human(rule.to),
      instances: census.instances,
    });
  }
  changes.sort((a, b) => b.instances - a.instances || a.from.localeCompare(b.from));

  const unmapped: UnmappedExercise[] = [];
  for (const [originId, census] of before) {
    if (ruleByFrom.has(originId)) continue;
    unmapped.push({
      originId,
      name: census.storedName,
      catalogName: human(originId, census.storedName),
      instances: census.instances,
    });
  }
  unmapped.sort((a, b) => b.instances - a.instances || a.originId.localeCompare(b.originId));

  const warnings: RepairWarning[] = [...sessionDuplicates];

  // An id the mapping says nothing about keeps whatever movement it currently
  // claims. On a repair that is a decision — "this one was already right" — so
  // it is stated rather than inferred from an empty diff.
  for (const item of unmapped) {
    warnings.push({
      code: "unmapped_exercise",
      from: [item.originId],
      name: item.catalogName,
      instances: item.instances,
    });
  }

  const byTarget = new Map<string, RemapRule[]>();
  for (const rule of rules) {
    const group = byTarget.get(rule.to);
    if (group) group.push(rule);
    else byTarget.set(rule.to, [rule]);
  }
  for (const [to, group] of byTarget) {
    if (group.length < 2) continue;
    warnings.push({
      code: "collision",
      from: group.map((r) => r.from),
      to,
      name: targetName.get(to),
      instances: group.reduce((n, r) => n + (before.get(r.from)?.instances ?? 0), 0),
    });
  }
  for (const rule of rules) {
    const instances = before.get(rule.from)?.instances ?? 0;
    const name = targetName.get(rule.to) ?? rule.to;
    if (rule.from === rule.to) {
      warnings.push({ code: "identity_rule", from: [rule.from], to: rule.to, name, instances });
    }
    if (instances === 0) {
      warnings.push({ code: "unused_rule", from: [rule.from], to: rule.to, name, instances: 0 });
      continue;
    }
    if (rule.toName !== name) {
      warnings.push({ code: "name_not_catalog_name", from: [rule.from], to: rule.to, name, instances });
    }
    if (PLACEHOLDER_NAME.test(name)) {
      warnings.push({ code: "placeholder_target", from: [rule.from], to: rule.to, name, instances });
    }
  }
  for (const [key, instances] of instanceWarnings) {
    const [code, from] = key.split("|") as [RepairWarningCode, string];
    const rule = ruleByFrom.get(from)!;
    warnings.push({
      code,
      from: [from],
      to: rule.to,
      name: targetName.get(rule.to),
      instances,
    });
  }
  warnings.sort((a, b) => a.code.localeCompare(b.code) || b.instances - a.instances || a.from[0]!.localeCompare(b.from[0]!));

  return {
    plan: { ...plan, weeks } as LiftingPlan,
    summary: {
      totals: {
        exercises,
        changed,
        unchanged: exercises - changed,
        distinctBefore: before.size,
        distinctAfter: after.size,
        rules: rules.length,
        rulesApplied: changes.length,
      },
      changes,
      unmapped,
      warnings,
    },
  };
}
