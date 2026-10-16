/**
 * read_objectives — objectives and key results with progress (Stage 3 spec §4, §11; principles §5.2): active first,
 * then paused and done (never dropped), each key result measured from logged data by the Stage 1 measures
 * (`measureKeyResults`, one read per source for all of them) with how good the evidence is — measured, sparse,
 * capped (no set reached a max: the timer or the prescription stopped it) or none — its current value in the key
 * result's unit, its last three points, and when it was last measured. The athlete's words marked. A legend in the
 * answer says what each evidence flag means and how a test counts (`EVIDENCE_LEGEND`).
 *
 * BUDGET: one statement for the athlete, the objectives and their key results, then `measureKeyResults`, whose worst
 * case is eight (four for strength sets and their prescriptions, the runs, the threshold days, the matched runs'
 * documents, the race days). Nine in all — above the read tools' eight, because the measures are reused, not
 * rewritten; a counting test pins it.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { keyResults, objectives } from "@rg/database";
import { KEY_RESULT_UNITS, keyResultMeasureSchema, type KeyResultEvidence, type KeyResultMeasure, type KeyResultUnit } from "@rg/domain";
import { measureKeyResults } from "../key-result-measures.js";
import type { DesignTool } from "./types.js";
import {
  CURSOR_SCHEMA,
  cursorField,
  encodeCursor,
  isErr,
  limitField,
  limitSchema,
  offsetCursor,
  pagedAnswer,
  parsedArray,
  parsedJson,
  parseInput,
  plural,
  READ_ROLES,
  readAthlete,
  untrusted,
  untrustedOrNull,
} from "./read-common.js";

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 12;
const RECENT_POINTS = 3;
const STATUS_ORDER: Record<string, number> = { active: 0, paused: 1, done: 2 };

/**
 * What the evidence flags mean (audit I11), in the answer itself — the domain's own definitions (profile.ts
 * `KEY_RESULT_EVIDENCE`, key-result-measures.ts) — and how a test counts: a set done to max is capacity, so it is
 * measured, once it is logged.
 */
export const EVIDENCE_LEGEND = {
  evidence: {
    measured: "three or more points that show capacity",
    sparse: "one or two points",
    capped: "the best came from a set its prescription stopped (a hold timed out, a set done exactly as written): at least this much — a test would measure it",
    none: "nothing measured yet (missing says why)",
  } satisfies Record<KeyResultEvidence, string>,
  capped: "a point whose best set was stopped by its prescription, not a max",
  test: "To measure a key result, schedule a test: a move to max (dose.max) naming it (test.keyResultId). It counts only once the athlete does it and it is logged.",
} as const;

const input = z.object({ limit: limitField(MAX_LIMIT).optional(), cursor: cursorField.optional() }).strict();

export function measureWords(m: KeyResultMeasure): string {
  const over = "windowDays" in m ? ` over ${m.windowDays} d` : "";
  switch (m.kind) {
    case "hold_max":
      return `longest hold of ${m.libraryIds.join(", ")}${over}`;
    case "best_set":
      return m.metric === "e1rm"
        ? `estimated max of ${m.libraryIds.join(", ")}${over}`
        : m.metric === "load_at_reps"
          ? `heaviest for ${m.reps} reps of ${m.libraryIds.join(", ")}${over}`
          : `most reps at ${m.loadKg} kg of ${m.libraryIds.join(", ")}${over}`;
    case "run_best":
      return `fastest ${m.distanceM} m${over}`;
    case "pace_at_hr":
      return `pace at heart rate ${m.hrLow}–${m.hrHigh}${over}`;
    case "threshold_pace":
      return `watch threshold pace${over}`;
    case "predicted_time":
      return `predicted ${m.distanceM} m from threshold pace${over}`;
    case "checkin":
      return `check-in answer ${m.questionId}`;
    case "test":
      return `test ${m.testId}`;
  }
}

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
const nOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const readObjectives: DesignTool = {
  name: "read_objectives",
  description:
    "Objectives (active first) and their key results, each measured from logged data: current value, target, recent points and how good the evidence is. Pages by position.",
  inputSchema: {
    type: "object",
    properties: { limit: limitSchema(DEFAULT_LIMIT, MAX_LIMIT), cursor: CURSOR_SCHEMA },
    additionalProperties: false,
  },
  statementCost: 9,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(input, raw, "optionally limit and cursor");
    if (isErr(p)) return p;
    const offset = offsetCursor(p.cursor);
    if (isErr(offset)) return offset;
    const o = objectives;
    const k = keyResults;
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      objectives: sql`(select json_group_array(json_object('id', ${o.id}, 'title', ${o.title}, 'why', ${o.why}, 'status', ${o.status},
          'goals', ${o.goalIds}, 'sort', ${o.sort}, 'createdAt', ${o.createdAt}))
          from ${o} where ${o.userId} = ${ctx.userId} and ${o.status} != 'dropped')`,
      keyResults: sql`(select json_group_array(json_object('id', ${k.id}, 'objectiveId', ${k.objectiveId}, 'label', ${k.label}, 'measure', ${k.measure},
          'direction', ${k.direction}, 'baseline', ${k.baseline}, 'target', ${k.target}, 'unit', ${k.unit}, 'due', ${k.dueDate},
          'position', ${k.position}, 'createdAt', ${k.createdAt}))
          from ${k} where ${k.userId} = ${ctx.userId})`,
    });
    const all = (parsedArray(extra.objectives) as Row[]).sort(
      (a, b) =>
        (STATUS_ORDER[s(a.status) ?? ""] ?? 3) - (STATUS_ORDER[s(b.status) ?? ""] ?? 3) ||
        (nOrNull(a.sort) ?? 0) - (nOrNull(b.sort) ?? 0) ||
        String(a.createdAt).localeCompare(String(b.createdAt)) ||
        String(a.id).localeCompare(String(b.id)),
    );
    const limit = p.limit ?? DEFAULT_LIMIT;
    // Paged by position: a run never writes objectives, so nothing shifts between pages.
    const candidates = all.slice(offset, offset + limit + 1);
    const onPage = new Set(candidates.slice(0, limit).map((x) => s(x.id)));
    const krs = (parsedArray(extra.keyResults) as Row[])
      .filter((x) => onPage.has(s(x.objectiveId)))
      .sort((a, b) => (nOrNull(a.position) ?? 0) - (nOrNull(b.position) ?? 0) || String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)))
      .map((x) => {
        const parsed = keyResultMeasureSchema.safeParse(parsedJson(x.measure));
        const unit = (KEY_RESULT_UNITS as readonly string[]).includes(s(x.unit) ?? "") ? (x.unit as KeyResultUnit) : undefined;
        return { row: x, measure: parsed.success ? parsed.data : null, unit };
      });
    const measurable = krs.filter((x): x is typeof x & { measure: KeyResultMeasure } => x.measure !== null);
    const progress = measurable.length
      ? await measureKeyResults(ctx.db, ctx.userId, measurable.map((x) => ({ measure: x.measure, unit: x.unit })), { today: athlete.today, raceDate: athlete.prefs.raceDate })
      : [];
    const byKr = new Map(measurable.map((x, i) => [x.row, progress[i]!]));

    const missing: string[] = [...athlete.missing];
    if (all.length === 0) missing.push("no objectives recorded");
    const render = (obj: Row) => {
      const goals = parsedArray(parsedJson(obj.goals)).filter((g): g is string => typeof g === "string");
      const why = untrustedOrNull(obj.why);
      return {
        id: obj.id,
        status: obj.status,
        goals,
        title: untrusted(s(obj.title) ?? ""),
        ...(why ? { why } : {}),
        keyResults: krs
          .filter((x) => x.row.objectiveId === obj.id)
          .map(({ row, measure, unit }) => {
            const pr = byKr.get(row);
            return {
              id: row.id,
              measure: measure ? measureWords(measure) : "a measure that no longer reads",
              unit: unit ?? pr?.unit ?? null,
              direction: row.direction,
              baseline: nOrNull(row.baseline),
              target: nOrNull(row.target),
              ...(s(row.due) ? { due: row.due } : {}),
              current: pr?.display.current ?? null,
              evidence: pr?.evidence ?? "none",
              points: pr?.sampleSize ?? 0,
              lastMeasured: pr?.lastMeasuredAt ?? null,
              recent: (pr?.series ?? []).slice(-RECENT_POINTS).map((pt) => ({ date: pt.date, value: pt.display, ...(pt.capped ? { capped: true } : {}) })),
              ...(pr?.missing ? { missing: pr.missing } : !measure ? { missing: "The stored measure no longer reads." } : {}),
              label: untrusted(s(row.label) ?? ""),
            };
          }),
      };
    };
    return pagedAnswer({
      source: "the athlete's objectives and key results, measured from logged sessions, runs and the watch's threshold pace",
      now: ctx.now,
      missing,
      rows: candidates,
      limit,
      render,
      cursorOf: (_obj, i) => encodeCursor([offset + i]),
      data: (objectives) => ({ legend: EVIDENCE_LEGEND, objectives }),
      summary: (shown) => (all.length ? `Read ${plural(shown, "objective")} and their progress` : "No objectives recorded"),
    });
  },
};
