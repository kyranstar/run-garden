/**
 * A BUILT SESSION'S MOVES IN WORDS (Phase 2a). The session sheet's dose line under each move and the Today card's
 * lead both come from here, so they can never disagree. Shapes are structural — the slice of a session-engine
 * build these lines read — so this file depends on nothing outside the domain.
 */
import type { Weight } from "./weights.js";

/** One played step of a build (`Step`), as much as a dose line reads. */
export interface DoseStep {
  slotKey: string;
  kind: "timed" | "set" | "rest";
  seconds: number;
  side: "Left" | "Right" | null;
  setCount: number | null;
}

/** An exercise's target (`Target`), as much as a dose line reads. */
export interface DoseTarget {
  lo: number;
  hi: number;
  type: "reps" | "time" | "breaths" | "carry";
  w: Weight | null;
  reps: number | null;
  secs: number | null;
  action: string;
}

/** "45 s", "90 s", "2 min", "2 min 30 s". */
export function secondsText(s: number): string {
  const secs = Math.round(s);
  if (secs >= 60 && secs % 60 === 0) return `${secs / 60} min`;
  if (secs < 120) return `${secs} s`;
  return `${Math.floor(secs / 60)} min ${secs % 60} s`;
}

const weightText = (w: Weight | null): string => (w ? ` @ ${w.v} ${w.u}` : "");

/**
 * One move's dose: "3 × 6 @ 30 lb", "3 × 10 @ 12.5 kg each side", "3 × 30 s", "40 s each side", "2 × 40 s".
 * `steps` are the move's own (its slot's, rests excluded); `perSide` = a one-sided move.
 */
export function doseText(input: { sets: number; steps: readonly DoseStep[]; target: DoseTarget | null; perSide: boolean }): string {
  const { sets, steps, target, perSide } = input;
  const each = perSide ? " each side" : "";
  const isSet = steps.some((s) => s.kind === "set");
  if (isSet) {
    if (!target) return `${sets} sets`;
    if (target.type === "time" || target.type === "carry") {
      const secs = target.secs ?? target.lo;
      return `${sets > 1 ? `${sets} × ` : ""}${secondsText(secs)}${weightText(target.w)}${each}`;
    }
    const reps = target.reps ?? (target.hi > target.lo ? `${target.lo}–${target.hi}` : target.lo);
    const unit = target.type === "breaths" ? " breaths" : "";
    return `${sets} × ${reps}${unit}${weightText(target.w)}${each}`;
  }
  const timed = steps.filter((s) => s.kind === "timed");
  if (timed.length === 0) {
    if (target?.secs) return `${secondsText(target.secs)}${each}`;
    return `${sets} sets`;
  }
  const sided = timed.some((s) => s.side !== null);
  const rounds = sided ? Math.max(1, Math.round(timed.length / 2)) : timed.length;
  const seconds = timed[0]!.seconds;
  return `${rounds > 1 ? `${rounds} × ` : ""}${secondsText(seconds)}${sided || perSide ? " each side" : ""}`;
}

/** The slice of a build `sessionLead` reads. */
export interface LeadBuild {
  items: ReadonlyArray<{ slotKey: string; block: string; exerciseId: string; sets: number }>;
  steps: readonly DoseStep[];
  targets: Readonly<Record<string, DoseTarget | undefined>>;
  exercises: Readonly<Record<string, { name: string; laterality: string } | undefined>>;
}

export interface SessionLead {
  /** Up to two moves: the core lifts first, then the session's first moves. `up` = the move goes up today. */
  moves: Array<{ name: string; dose: string; up: boolean }>;
  /** Moves not shown. */
  more: number;
}

/** A built session in one line: "Goblet squat 3 × 6 @ 30 lb ↑ · KB deadlift 3 × 8 · 12 more". */
export function sessionLead(build: LeadBuild, max = 2): SessionLead {
  const ordered = [...build.items.filter((i) => i.block === "core"), ...build.items.filter((i) => i.block !== "core")];
  const moves: SessionLead["moves"] = [];
  for (const item of ordered) {
    if (moves.length >= max) break;
    const ex = build.exercises[item.exerciseId];
    if (!ex) continue;
    const target = build.targets[item.exerciseId] ?? null;
    moves.push({
      name: ex.name,
      dose: doseText({
        sets: item.sets,
        steps: build.steps.filter((s) => s.slotKey === item.slotKey && s.kind !== "rest"),
        target,
        perSide: ex.laterality === "unilateral",
      }),
      up: target?.action === "up",
    });
  }
  return { moves, more: Math.max(0, build.items.length - moves.length) };
}
