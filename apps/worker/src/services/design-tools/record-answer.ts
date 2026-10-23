/**
 * record_answer(answers) — what the athlete's request itself states, kept as check-in answers so the next design knows
 * it (Stage 3 spec §4; principles §5.3): soreness, tightness and pain by area, energy on its own — the check-ins'
 * question ids (`CHECKIN_QUESTIONS`, with how long an answer stays fresh), and their areas (a library region or
 * muscle, or one of the athlete's focus areas). Each answer QUOTES the request — whole words of it, compared without
 * case or punctuation — and a quote the request doesn't hold is refused: this keeps what was SAID; what the coach
 * concluded goes to `remember`, marked as inferred. A value is kept only when the athlete gave that number ("a 6",
 * "six"): "wrecked" is no 8. Rows are `athlete_answers` with `source 'request'` on the athlete's local today, the quote
 * as the athlete's words, fresh for the question's days. A bare "back" — the quote names the back with no upper, lower,
 * low, mid or middle before it — is kept as both the upper back and the low back, whichever back area the coach gave
 * (audit C4: "glutes, legs, and back are really sore" was kept as the low back alone, and the next draft loaded the
 * upper back). An area kept twice is kept once.
 *
 * A rehearsal run writes nothing: it answers as it would (`{ recorded, rehearsal: true }`, the same receipt).
 *
 * Answers to ask_athlete's check-in questions are kept by the same rules (`askedAnswerRows`, written by the answer
 * route), as `source 'ask_athlete'` — a tapped chip only.
 *
 * Undo: every row of one call shares the call's handle (`ra:<main run>:<tool-use id>` — `aa:` for an asked question's
 * — each row `<handle>:<n>`), which the call's receipt carries to the run view; `POST /api/coach/runs/:id/undo-answer
 * { handle }` takes them back (`undoRecordedAnswers`). A replayed call writes the same ids, so nothing doubles. Two
 * statements: the athlete (with the run's request and the focus areas), then one insert.
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { athleteAnswers, athleteProfiles, coachRuns } from "@rg/database";
import { addDays } from "@rg/domain";
import { MUSCLES, REGIONS } from "@rg/exercise-library";
import type { Db } from "../db.js";
import type { DesignTool } from "./types.js";
import { isErr, parseAct } from "./act-common.js";
import { parsedArray, readAthlete, refuse } from "./read-common.js";

/**
 * The check-ins' questions the coach keeps answers to (principles §5.3; Stage 4 owns the full registry): whether each
 * is answered by area, and for how many days an answer stays fresh (its last fresh day is `expiresAt`).
 */
export const CHECKIN_QUESTIONS = {
  soreness: { byArea: true, freshDays: 3 },
  tightness: { byArea: true, freshDays: 3 },
  pain: { byArea: true, freshDays: 3 },
  energy: { byArea: false, freshDays: 1 },
} as const;
export type CheckinQuestion = keyof typeof CHECKIN_QUESTIONS;
export const CHECKIN_IDS = Object.keys(CHECKIN_QUESTIONS) as [CheckinQuestion, ...CheckinQuestion[]];

const MAX_ANSWERS = 6;
const QUOTE_MAX = 200;
/** The rows one call may keep (a bare back's two included): one insert, 12 binds a row, under D1's 100. */
const MAX_ROWS = 8;

/** The areas a coach gives for "back"; a bare one is kept as both of `BARE_BACK`. */
const BACK_AREAS: ReadonlySet<string> = new Set(["upper-back", "low-back", "thoracic", "lats"]);
const BARE_BACK = ["upper-back", "low-back"] as const;
/** Words before "back" that name its part. */
const BACK_PARTS: ReadonlySet<string> = new Set(["upper", "lower", "low", "mid", "middle"]);
/** Words beside "back" that make it no body part: "the back of my legs", "back to back", "came back from". */
const NOT_BODY_AFTER: ReadonlySet<string> = new Set(["of", "to", "from", "off", "into"]);
const NOT_BODY_BEFORE: ReadonlySet<string> = new Set(["to", "came", "come", "coming", "got", "get", "getting", "go", "going", "went", "bounce", "bounced", "bouncing"]);

/** Does the quote name the back bare — "back" with no part before it, as a body part? */
export function bareBack(quote: string): boolean {
  const w = words(quote).trim().split(" ");
  return w.some((x, i) => x === "back" && !BACK_PARTS.has(w[i - 1] ?? "") && !NOT_BODY_BEFORE.has(w[i - 1] ?? "") && !NOT_BODY_AFTER.has(w[i + 1] ?? ""));
}

const REGION_SET = new Set<string>(REGIONS);
const MUSCLE_SET = new Set<string>(MUSCLES);

/** The last day an answer given on `date` stays fresh. */
export const freshThrough = (q: CheckinQuestion, date: string): string => addDays(date, CHECKIN_QUESTIONS[q].freshDays - 1);

const input = z
  .object({
    answers: z
      .array(
        z
          .object({
            question: z.enum(CHECKIN_IDS),
            area: z.string().min(1).max(80).optional(),
            value: z.number().int().min(0).max(10).optional(),
            quote: z.string().trim().min(1).max(QUOTE_MAX),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ANSWERS),
  })
  .strict();

/** Words, lower case, without punctuation: " my calf is sore " (padded, so a phrase matches only whole words). */
const words = (s: string): string => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
/** Is the quote whole words of the request (`empty`: no words at all; `absent`: not in it)? */
export function quoteIn(request: string, quote: string): "ok" | "empty" | "absent" {
  const quoted = words(quote);
  if (quoted.trim() === "") return "empty";
  return request && words(request).includes(quoted) ? "ok" : "absent";
}
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** Does the quote give this number — as digits or as a word? */
const givesNumber = (quote: string, n: number): boolean => words(quote).includes(` ${n} `) || words(quote).includes(` ${NUMBER_WORDS[n]} `);

/** Until when an Undo of these rows is offered (U's need, round 2): `{ expiresAt }`, the latest last fresh day among
 * them ("YYYY-MM-DD") — the run view keeps the Undo while an answer is fresh; nothing when none says. */
export function undoUntil(rows: ReadonlyArray<{ expiresAt?: string | null }>): { expiresAt?: string } {
  const days = rows.map((r) => r.expiresAt).filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d));
  return days.length > 0 ? { expiresAt: days.sort().at(-1)! } : {};
}

/** The handle an undo names; the run's own id is in it, so an undo can only reach its own run's answers. */
export const answerHandle = (mainRunId: string, toolUseId: string, from: "request" | "ask_athlete" = "request"): string =>
  `${from === "request" ? "ra" : "aa"}:${mainRunId}:${toolUseId}`;
/** `ra` record_answer's, `aa` an asked question's, `rm` remember's (Task 10: remember.ts `memoryHandle`). */
const HANDLE = /^(ra|aa|rm):([^:]{1,120}):([A-Za-z0-9_-]{1,120})$/;
/** The main run a handle belongs to, or null for a handle that isn't one. */
export const handleRunId = (handle: string): string | null => HANDLE.exec(handle)?.[2] ?? null;
/** Does a handle take back a memory (`remember`'s) rather than answers? */
export const isMemoryHandle = (handle: string): boolean => HANDLE.exec(handle)?.[1] === "rm";
const handleSource = (handle: string): "request" | "ask_athlete" => (handle.startsWith("aa:") ? "ask_athlete" : "request");

export interface Subject {
  kind: "region" | "muscle" | "focus_area";
  id: string;
  words: string;
}

const areaWords = (id: string): string => id.replace(/-/g, " ");

/** An area's subject: a library region, else a muscle, else one of the athlete's focus areas (`focus`: id → label). */
export function subjectOf(area: string, focus: ReadonlyMap<string, string>): Subject | null {
  if (REGION_SET.has(area)) return { kind: "region", id: area, words: areaWords(area) };
  if (MUSCLE_SET.has(area)) return { kind: "muscle", id: area, words: areaWords(area) };
  if (focus.has(area)) return { kind: "focus_area", id: area, words: focus.get(area)! };
  return null;
}

/** Is an area the library's own (no focus-area read needed to know it)? */
export const libraryArea = (area: string): boolean => REGION_SET.has(area) || MUSCLE_SET.has(area);

/** The athlete's focus areas as id → label, from the profile's JSON. */
export function focusAreasOf(raw: unknown): Map<string, string> {
  return new Map(
    parsedArray(raw).flatMap((f) => {
      const x = f as { id?: unknown; label?: unknown };
      return typeof x.id === "string" ? [[x.id, typeof x.label === "string" ? x.label : x.id] as const] : [];
    }),
  );
}

/** The fix for an area that is none: the ids it can be. */
export const AREA_FIX = `Use a region id (${REGIONS.join(", ")}), a muscle id from the library, or a focus-area id from read_profile.`;

/** "soreness — calves 8, hamstrings 3 · energy 3" */
export function answeredLine(rows: Array<{ questionId: string; subjectWords: string | null; valueNum: number | null }>): string {
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const bit = [r.subjectWords, r.valueNum !== null ? String(r.valueNum) : null].filter(Boolean).join(" ");
    groups.set(r.questionId, [...(groups.get(r.questionId) ?? []), bit]);
  }
  return [...groups]
    .map(([q, bits]) =>
      (CHECKIN_QUESTIONS as Record<string, { byArea: boolean }>)[q]?.byArea ? `${q} — ${bits.join(", ")}` : `${q}${bits.filter(Boolean).length ? ` ${bits.join(", ")}` : ""}`,
    )
    .join(" · ");
}

type AnswerRow = typeof athleteAnswers.$inferInsert & { subjectWords: string | null };

/** The insert for `rows` (≤ 6 rows, one statement under D1's 100 binds); a replay's rows exist already and are left. */
export function insertAnswers(db: Db, rows: readonly AnswerRow[]) {
  return db
    .insert(athleteAnswers)
    .values(rows.map(({ subjectWords: _w, ...row }) => row))
    .onConflictDoNothing();
}

export const recordAnswer: DesignTool = {
  name: "record_answer",
  description:
    "The main coach only: keep what the request itself states as check-in answers, so the next design knows it — soreness, tightness or pain by area (a region, muscle or focus-area id), energy on its own, each quoting the request's words; value 0–10 only a number the athlete gave.",
  inputSchema: {
    type: "object",
    properties: {
      answers: {
        type: "array",
        minItems: 1,
        maxItems: MAX_ANSWERS,
        items: {
          type: "object",
          properties: {
            question: { type: "string", enum: [...CHECKIN_IDS] },
            area: { type: "string", description: "soreness, tightness, pain: a region or muscle id, or one of the athlete's focus-area ids. Not for energy." },
            value: { type: "integer", minimum: 0, maximum: 10, description: "Only a number the athlete gave (\"a 6\", \"six\"); a word like \"wrecked\" is no number — leave it out." },
            quote: { type: "string", minLength: 1, maxLength: QUOTE_MAX, description: "The request's own words that state it, copied exactly." },
          },
          required: ["question", "quote"],
          additionalProperties: false,
        },
      },
    },
    required: ["answers"],
    additionalProperties: false,
  },
  statementCost: 2,
  cpuWeight: 0.2,
  roles: ["main"],
  async run(ctx, raw) {
    const p = parseAct(input, raw, `answers: 1–${MAX_ANSWERS}, each { question, area?, value? (0–10, only a number given), quote }`);
    if (isErr(p)) return p;
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      runRequest: sql`(select ${coachRuns.request} from ${coachRuns} where ${coachRuns.id} = ${ctx.run.id} and ${coachRuns.userId} = ${ctx.userId})`,
      focusAreas: sql`(select ${athleteProfiles.focusAreas} from ${athleteProfiles} where ${athleteProfiles.userId} = ${ctx.userId})`,
    });
    const request = typeof extra.runRequest === "string" ? extra.runRequest : "";
    const focus = focusAreasOf(extra.focusAreas);
    // Keyed by question and area, so an area kept twice is kept once — the coach's own answer before a bare back's.
    const kept = new Map<string, { row: Omit<AnswerRow, "id">; expanded: boolean }>();
    const handle = answerHandle(ctx.run.id, ctx.toolUseId ?? `call-${ctx.now.getTime()}`);
    for (const [i, a] of p.answers.entries()) {
      const found = quoteIn(request, a.quote);
      if (found === "empty") return refuse("bad_quote", `answers.${i}.quote has no words.`, "Quote the request's own words that state it.");
      if (found === "absent") {
        return refuse(
          "not_in_request",
          request ? `answers.${i}.quote "${a.quote}" is not words of the athlete's request.` : "This run has no request: the athlete only tapped to start it.",
          "Quote the request's own words exactly. For what you concluded rather than read, use remember with confidence inferred.",
        );
      }
      if (a.value !== undefined && !givesNumber(a.quote, a.value)) {
        return refuse(
          "value_not_stated",
          `answers.${i}: the quote gives no ${a.value}; a value is only a number the athlete gave.`,
          "Leave value out (the quote keeps their words), or quote the words that give the number.",
        );
      }
      let subject: Subject | null = null;
      if (CHECKIN_QUESTIONS[a.question].byArea) {
        if (!a.area) return refuse("bad_area", `answers.${i}: ${a.question} is recorded by area.`, AREA_FIX);
        subject = subjectOf(a.area, focus);
        if (!subject) return refuse("bad_area", `answers.${i}.area "${a.area}" is no region, muscle or focus area.`, AREA_FIX);
      } else if (a.area) {
        return refuse("bad_area", `answers.${i}: ${a.question} is not by area.`, "Leave area out for energy.");
      }
      // A bare "back" is both the upper and the low back (audit C4), whichever back area was given.
      const subjects: Array<{ subject: Subject | null; expanded: boolean }> = [{ subject, expanded: false }];
      if (subject && BACK_AREAS.has(subject.id) && bareBack(a.quote)) {
        for (const id of BARE_BACK) if (id !== subject.id) subjects.push({ subject: subjectOf(id, focus), expanded: true });
      }
      for (const s of subjects) {
        const key = `${a.question}:${s.subject?.kind ?? ""}:${s.subject?.id ?? ""}`;
        const had = kept.get(key);
        if (had && !(had.expanded && !s.expanded)) continue;
        kept.set(key, {
          expanded: s.expanded,
          row: {
            userId: ctx.userId,
            questionId: a.question,
            subjectKind: s.subject?.kind ?? null,
            subjectId: s.subject?.id ?? null,
            valueNum: a.value ?? null,
            valueChoice: null,
            text: a.quote,
            source: "request",
            localDate: athlete.today,
            at: ctx.now.toISOString(),
            expiresAt: freshThrough(a.question, athlete.today),
            subjectWords: s.subject?.words ?? null,
          },
        });
      }
    }
    if (kept.size > MAX_ROWS) {
      return refuse(
        "too_many_areas",
        `answers: ${kept.size} areas to keep; at most ${MAX_ROWS} at once (a bare "back" keeps two).`,
        "Keep the areas that change today's design; send the rest in a second call.",
      );
    }
    const rows: AnswerRow[] = [...kept.values()].map((k, n) => ({ id: `${handle}:${n}`, ...k.row }));
    // A rehearsal is never the athlete's record.
    if (!ctx.run.rehearsal) await insertAnswers(ctx.db, rows);
    const line = answeredLine(rows.map((r) => ({ questionId: r.questionId, subjectWords: r.subjectWords, valueNum: r.valueNum ?? null })));
    return {
      data: ctx.run.rehearsal ? { recorded: rows.length, rehearsal: true } : { recorded: rows.length, date: athlete.today, source: "request" },
      summary: `Noted from your request: ${line}`,
      receipt: {
        undo: { handle, ...undoUntil(rows) },
        recorded: rows.map((r) => ({ question: r.questionId, ...(r.subjectId ? { area: r.subjectId } : {}), ...(r.valueNum != null ? { value: r.valueNum } : {}) })),
      },
    };
  },
};

// ── An asked check-in question's answer (ask_athlete; the answer route writes it) ──────────────────────────────────

/** What ask_athlete stored of a question that declares a check-in: the question, its area, and each chip's mapping. */
export interface AskedCheckin {
  question: CheckinQuestion;
  area?: string;
  chips: Array<{ label: string; value?: number; area?: string }>;
}

/** The check-in a question asked, read from the ask call's own input (null for a question that declares none). */
export function askedCheckin(q: unknown): AskedCheckin | null {
  const x = q as { checkin?: { question?: unknown; area?: unknown }; chips?: unknown } | null;
  const question = x?.checkin?.question;
  if (typeof question !== "string" || !(question in CHECKIN_QUESTIONS)) return null;
  const chips = (Array.isArray(x!.chips) ? x!.chips : []).flatMap((c) => {
    if (typeof c === "string") return [{ label: c }];
    const o = c as { label?: unknown; value?: unknown; area?: unknown } | null;
    if (!o || typeof o.label !== "string") return [];
    return [{ label: o.label, ...(typeof o.value === "number" ? { value: o.value } : {}), ...(typeof o.area === "string" ? { area: o.area } : {}) }];
  });
  return { question: question as CheckinQuestion, ...(typeof x!.checkin!.area === "string" ? { area: x!.checkin!.area } : {}), chips };
}

/**
 * The rows the answers to an ask call keep: one per question that declares a check-in and was answered with one of its
 * chips (the others stay in the run's own record). A tapped chip gives its value and area (its own, else the
 * question's), its label as the choice. Words typed instead of a chip stay the run's answer only, never the check-in's:
 * they may not answer the question at all, and a check-in row is read later as the athlete's state (audit M8; only a
 * question with no chips at all — ask_athlete never asks one — would keep them, as text). `source
 * 'ask_athlete'`, ids `aa:<main run>:<tool-use id>:<n>` (n the question's place), fresh for the question's days. The
 * areas were checked when the question was asked.
 */
export function askedAnswerRows(o: {
  userId: string;
  mainRunId: string;
  toolUseId: string;
  questions: readonly unknown[];
  answers: readonly string[];
  localDate: string;
  at: string;
}): { handle: string; rows: AnswerRow[] } {
  const handle = answerHandle(o.mainRunId, o.toolUseId, "ask_athlete");
  const rows: AnswerRow[] = [];
  o.answers.forEach((text, n) => {
    const c = askedCheckin(o.questions[n]);
    if (!c) return;
    const chip = c.chips.find((ch) => ch.label.trim().toLowerCase() === text.trim().toLowerCase());
    // Words typed instead of one of the question's chips stay in the run's own record (audit M8).
    if (!chip && c.chips.length > 0) return;
    const area = chip?.area ?? c.area;
    // Soreness, tightness and pain are kept by area (principles §5.3).
    if (CHECKIN_QUESTIONS[c.question].byArea && !area) return;
    const subject = CHECKIN_QUESTIONS[c.question].byArea && area ? subjectOf(area, new Map([[area, area]])) : null;
    rows.push({
      id: `${handle}:${n}`,
      userId: o.userId,
      questionId: c.question,
      subjectKind: subject?.kind ?? null,
      subjectId: subject?.id ?? null,
      valueNum: chip?.value ?? null,
      valueChoice: chip ? chip.label : null,
      text: chip ? null : text,
      source: "ask_athlete",
      localDate: o.localDate,
      at: o.at,
      expiresAt: freshThrough(c.question, o.localDate),
      subjectWords: subject?.words ?? null,
    });
  });
  return { handle, rows };
}

/**
 * Take back the answers one call kept (its `handle`: record_answer's, or an asked question's), for `userId` only:
 * deletes them and answers what they were, or null when there were none (already taken back, or never this
 * athlete's). One statement.
 */
export async function undoRecordedAnswers(db: Db, userId: string, handle: string): Promise<{ line: string; count: number } | null> {
  const a = athleteAnswers;
  const gone = await db
    .delete(a)
    .where(and(eq(a.userId, userId), eq(a.source, handleSource(handle)), sql`substr(${a.id}, 1, ${handle.length + 1}) = ${`${handle}:`}`))
    .returning({ id: a.id, questionId: a.questionId, subjectKind: a.subjectKind, subjectId: a.subjectId, valueNum: a.valueNum });
  if (gone.length === 0) return null;
  gone.sort((x, y) => Number(x.id.split(":").at(-1)) - Number(y.id.split(":").at(-1)));
  const line = answeredLine(gone.map((r) => ({ questionId: r.questionId, subjectWords: r.subjectId ? areaWords(r.subjectId) : null, valueNum: r.valueNum })));
  return { line, count: gone.length };
}
