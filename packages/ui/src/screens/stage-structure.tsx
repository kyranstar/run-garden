import type { ReactNode, Ref } from "react";
import { formatStageDuration } from "@rg/domain";
import { formatDistance, formatPace, type Units } from "../components.js";

/**
 * A structured workout's "Full structure" — the interval tree, not a flat
 * list.
 *
 * The list used to be flat: every row from `planned_workout_stages` in `ord`
 * order, so a repeat printed as its own sibling line ("repeat × 6") between
 * the stages before it and the stages after it. Nothing said which side it
 * governed, and prod says that ambiguity is the normal case, not the corner
 * one: of 370 repeat groups, 319 hold exactly ONE stage, so a real strength
 * session alternated `repeat × 3` / `Push-ups` / `repeat × 3` / `Jumping
 * Jacks` down the page — nine multipliers, each equally readable as belonging
 * to the line above or the line below. This is an interval prescription; a
 * reader who binds the multiplier to the wrong side runs the wrong workout.
 *
 * So the multiplier is attached to what it multiplies, and the attachment is
 * in the DOM, not only in the styling:
 *
 *   - a group of SEVERAL stages becomes a nested `<ul>` inside its own `<li>`,
 *     introduced by the multiplier — a screen reader hears "Repeat 3 times, 2
 *     steps" and then enters a 2-item list, so the group's bounds are audible.
 *     A left rule and the badge make the same bounds visible.
 *   - a group of ONE stage (prod's 86% case) needs no box: the multiplier goes
 *     on that stage's own line, "3 × Push-ups", where it cannot float.
 *   - `repeat × 1` carries no information at all, so the wrapper is dropped
 *     and its stages render as themselves.
 *
 * Nesting recurses (prod has no repeat-inside-a-repeat today — measured — but
 * `flattenStages` has always allowed six levels, and the estimator's own tests
 * exercise two).
 */

/** The stage rows as the workout-detail route serves them (untyped JSON). */
export type StageRow = Record<string, unknown>;

export interface StageNode {
  stage: StageRow;
  /** Present for a repeat container; empty for a leaf. */
  children: StageNode[];
  /** A repeat's count, floored at 1; 1 for a leaf. */
  count: number;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Flat rows → tree, by `parent_stage_id`, each sibling group in `ord` order.
 *
 * Two safeties, because this list is the prescription and may not lose a step:
 * a row whose parent id is missing from the set is promoted to the root rather
 * than dropped, and a parent cycle stops descending instead of hanging.
 */
export function buildStageTree(rows: StageRow[]): StageNode[] {
  const ids = new Set(rows.map((r) => String(r.id)));
  const byParent = new Map<string | null, StageRow[]>();
  for (const r of rows) {
    const parent = str(r.parentStageId) ?? str(r.parent_stage_id);
    const key = parent !== null && ids.has(parent) ? parent : null;
    const list = byParent.get(key) ?? [];
    list.push(r);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => (num(a.ord) ?? 0) - (num(b.ord) ?? 0));
  }
  const seen = new Set<string>();
  const build = (parent: string | null, depth: number): StageNode[] =>
    (byParent.get(parent) ?? []).map((stage) => {
      const id = String(stage.id);
      const repeat = stage.kind === "repeat";
      const cycle = seen.has(id) || depth > 8;
      if (!cycle) seen.add(id);
      return {
        stage,
        children: repeat && !cycle ? build(id, depth + 1) : [],
        count: Math.max(1, num(stage.repeatCount) ?? num(stage.repeat_count) ?? 1),
      };
    });
  return build(null, 0);
}

/** COROS names every repeat container "Group" — a label that says nothing the
 * multiplier does not already say. Anything the athlete named survives. */
function repeatLabel(stage: StageRow): string | null {
  const label = str(stage.label);
  return label !== null && label.toLowerCase() !== "group" ? label : null;
}

/** One leaf stage's line: kind, amount, target band, label — unchanged from
 * the flat list it replaces, so nothing a reader relied on moved.
 *
 * The amount is `formatStageDuration` (@rg/domain), shared with the stored
 * `stage_summary` line a few pixels above this list. Before that, both rounded
 * to whole minutes independently, and prod's own strides session — 15s on, 45s
 * off — read "work — 0 min" here and "0 min Training / 1 min Rest" there. */
function describeStage(stage: StageRow, units: Units): string {
  // Pace targets arrive either way round — COROS writes recovery blocks
  // slow-first — so order by value, not by column.
  const lo = num(stage.targetLow);
  const hi = num(stage.targetHigh);
  const band =
    stage.targetType === "pace" && lo !== null && hi !== null
      ? { fast: Math.min(lo, hi), slow: Math.max(lo, hi) }
      : null;
  const seconds = num(stage.durationSeconds);
  const metres = num(stage.distanceMeters);
  const label = str(stage.label);
  return [
    String(stage.kind ?? ""),
    seconds ? ` — ${formatStageDuration(seconds)}` : "",
    metres ? ` — ${formatDistance(metres, units, 2)}` : "",
    band
      ? ` @ ${formatPace(band.fast, units).replace(` /${units}`, "")}–${formatPace(band.slow, units)}`
      : "",
    label ? ` (${label})` : "",
  ].join("");
}

/** The multiplier, said twice: once for the eye, once for the ear. */
function Multiplier({ count, steps }: { count: number; steps: number }) {
  return (
    <>
      <b className="stage-mult num" aria-hidden>
        {count} ×
      </b>
      <span className="visually-hidden">
        Repeat {count} times, {steps} {steps === 1 ? "step" : "steps"}:{" "}
      </span>
    </>
  );
}

/** Every row is [multiplier slot][content], so a multiplier always sits in the
 * same column as the group rules — there is one left edge, not two. */
function Step({ mult, children }: { mult?: ReactNode; children: ReactNode }) {
  return (
    <li className="stage-step">
      <span className="stage-mult-slot">{mult}</span>
      <span className="stage-step-text">{children}</span>
    </li>
  );
}

function StageItems({ nodes, units }: { nodes: StageNode[]; units: Units }) {
  return (
    <>
      {nodes.map((node) => {
        const id = String(node.stage.id);
        const isRepeat = node.stage.kind === "repeat";
        if (!isRepeat) {
          return <Step key={id}>{describeStage(node.stage, units)}</Step>;
        }
        // A repeat that repeats once is a wrapper around nothing: its stages
        // are simply the workout's stages.
        if (node.count === 1 && node.children.length > 0) {
          return <StageItems key={id} nodes={node.children} units={units} />;
        }
        // A container the import left empty still gets a line — losing a row
        // silently is worse than printing a bare multiplier.
        if (node.children.length === 0) {
          return (
            <Step key={id} mult={<Multiplier count={node.count} steps={0} />}>
              {repeatLabel(node.stage) ?? "repeat"}
            </Step>
          );
        }
        const only = node.children.length === 1 ? node.children[0]! : null;
        if (only && only.stage.kind !== "repeat") {
          // One stage, so the multiplier belongs on its line — there is no
          // "before or after" to get wrong.
          return (
            <Step key={id} mult={<Multiplier count={node.count} steps={1} />}>
              {describeStage(only.stage, units)}
            </Step>
          );
        }
        const label = repeatLabel(node.stage);
        return (
          <li key={id} className="stage-group">
            <span className="stage-mult-slot">
              <Multiplier count={node.count} steps={node.children.length} />
              {label ? <span className="stage-group-name">{label}</span> : null}
            </span>
            <ul className="stage-group-list">
              <StageItems nodes={node.children} units={units} />
            </ul>
          </li>
        );
      })}
    </>
  );
}

/** How many stages a reader will actually perform, counting a group once —
 * the same number the flat list reported. */
export function leafStageCount(rows: StageRow[]): number {
  return rows.filter((s) => s.kind !== "repeat").length;
}

export function StageStructure({
  stages,
  units,
  listRef,
}: {
  stages: StageRow[];
  units: Units;
  listRef?: Ref<HTMLUListElement>;
}) {
  const tree = buildStageTree(stages);
  return (
    <ul ref={listRef} className="stage-tree muted">
      <StageItems nodes={tree} units={units} />
    </ul>
  );
}
