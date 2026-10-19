/**
 * change_programme(programmeId, days?, weeklyGoal?, minutes?, blockWeeks?, modes?, care?, why) — the main coach proposes
 * ONE change to an adaptive programme's settings (§8 §5, stream W): what the athlete's settings sheet edits — its days,
 * its weekly goal, its session minutes, its block length, its modes and its care — but its name and place.
 *
 * A SIBLING OF propose_plan, NOT A KIND OF IT: propose_plan carries the thread coach's own `CoachOp`s, judged by its
 * guardrails and applied by its appliers, for the coach's blocks; a programme is the athlete's own, its settings checked
 * by the settings sheet's rules (`adaptiveConfigSchema`, as `PATCH /api/programs/:id` takes them) and applied as that
 * save is (`updateProgram`, then its sessions placed a request's room at a time). Another target, other rules, another
 * applier and its own few statements: its own small schema, which the model reads beside propose_plan's, keeps each
 * tool's words to its own job.
 *
 * STORED as one op of kind `programme_change` (proposal-kinds.ts `ProgrammeChangeOp`) in the main run's proposal: only
 * the settings it changes (`change`), what they were (`base`, for the approve's stale check), the coach's `why`, and
 * what the card shows — the programme's name, its new pattern in one line, a line per setting ("Days Mon · Wed · Fri →
 * Tue · Thu") and, when they move, where its next sessions go (program-slots.ts `previewPlacement`: the pass's own rules,
 * written nowhere). One per programme: a second call for it replaces the first. Never reviewed: the finish makes it
 * the athlete's, approved with one tap.
 *
 * REFUSED, each teachable, nothing written: a role other than the main coach's (`not_for_role`); no setting given, or
 * one the sheet would not take — a day that isn't one, a goal past 1–7, minutes past 10–90, a block past 4–6 weeks, no
 * mode, a care that isn't a switched-on condition's (`invalid_input`); a programme that isn't the athlete's adaptive
 * one (`not_your_programme`) or is retired (`not_running`); settings it already has (`no_change`); a proposal already
 * with the athlete (`proposal_pending`) or closed; a restore under way.
 *
 * Statements: the athlete with the programme, the proposal and the restore marker (one read); the preview's (the
 * programme's slots, and its touched lookup); the proposal's guarded upsert.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { accountState, coachProposals, programs } from "@rg/database";
import { adaptiveConfigSchema, dayLabel, SESSION_MODES, type AdaptiveConfig } from "@rg/domain";
import { OPEN_PROPOSAL_STATUSES } from "../design-review.js";
import { clipProse } from "../design-prose.js";
import { PREVIEW_STATEMENTS, previewPlacement } from "../program-slots.js";
import {
  isProgrammeChangeOp,
  programmeChangeId,
  PROGRAMME_SETTINGS,
  sameSetting,
  type ProgrammeChangeOp,
  type ProgrammeSettings,
} from "../proposal-kinds.js";
import { capInWords, isErr, mainRunIdOf, parseAct, prose } from "./act-common.js";
import { designProposalId, upsertProposal } from "./propose.js";
import { parsedJson, plural, readAthlete, refuse, untrusted } from "./read-common.js";
import type { DesignTool, ToolOk } from "./types.js";

const WHY_MAX = 300;
/** A weekday's short name, Monday first (a programme's `preferredDays` count from its week's Monday). */
export const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const DAY_FULL = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
/** The modes as the settings sheet names them. */
export const MODE_WORDS: Record<(typeof SESSION_MODES)[number], string> = { recovery: "Recovery", consistent: "Consistent", build: "Build" };
/** The next sessions the card names. */
const NEXT_SHOWN = 3;

const input = z
  .object({
    programmeId: z.string().min(1).max(200),
    days: z.array(z.string().max(20)).max(7).optional(),
    weeklyGoal: z.number().int().optional(),
    minutes: z.number().int().optional(),
    blockWeeks: z.number().int().optional(),
    modes: z.array(z.string().max(20)).max(3).optional(),
    care: z.record(z.string().max(80), z.boolean()).optional(),
    why: prose(WHY_MAX),
  })
  .strict();

/** A day's index from its name — "Tue", "tuesday", "Tues", "Weds", "th" — Monday 0; null for what isn't one day. */
export function dayIndex(name: string): number | null {
  const n = name.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z]{2,9}$/.test(n)) return null;
  // Three letters or more name a day by its first three; two only when one day starts so ("tu", "th", "sa", "su").
  const hits = n.length >= 3 ? DAY_FULL.flatMap((d, i) => (d.slice(0, 3) === n.slice(0, 3) ? [i] : [])) : DAY_FULL.flatMap((d, i) => (d.startsWith(n) ? [i] : []));
  return hits.length === 1 ? hits[0]! : null;
}

/** "Mon · Wed · Fri", or "any day" for none. */
export const daysWords = (days: readonly number[]): string => (days.length === 0 ? "any day" : [...days].sort((a, b) => a - b).map((d) => DAY_SHORT[d]).join(" · "));
const modesWords = (modes: readonly string[]): string => modes.map((m) => MODE_WORDS[m as keyof typeof MODE_WORDS] ?? m).join(" · ");

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What the card says changes, a line each, in the settings sheet's order; care by each condition's own care label. */
export function settingLines(from: ProgrammeSettings, to: ProgrammeSettings, careLabel: (id: string) => string): string[] {
  const out: string[] = [];
  if (from.weeklyGoal !== to.weeklyGoal) out.push(`Weekly goal ${from.weeklyGoal} → ${plural(to.weeklyGoal, "session")}`);
  if (!same(from.preferredDays, to.preferredDays)) out.push(`Days ${daysWords(from.preferredDays)} → ${daysWords(to.preferredDays)}`);
  if (from.defaultMinutes !== to.defaultMinutes) out.push(`Minutes ${from.defaultMinutes} → ${to.defaultMinutes}`);
  if (from.blockWeeks !== to.blockWeeks) out.push(`Block length ${from.blockWeeks} → ${plural(to.blockWeeks, "week")}`);
  if (!same(from.modes, to.modes)) out.push(`Modes ${modesWords(from.modes)} → ${modesWords(to.modes)}`);
  const care = [...new Set([...from.careProfiles, ...to.careProfiles])];
  for (const id of care) {
    const was = from.careProfiles.includes(id);
    const is = to.careProfiles.includes(id);
    if (was !== is) out.push(`${careLabel(id)} ${was ? "on" : "off"} → ${is ? "on" : "off"}`);
  }
  return out;
}

/** Where the next sessions go, when they move: "Next sessions move to Tue 21 Oct · Thu 23 Oct" — null when they stay. */
export function nextLine(before: readonly string[], after: readonly string[]): string | null {
  const was = before.slice(0, NEXT_SHOWN);
  const next = after.slice(0, NEXT_SHOWN);
  if (next.length === 0 || same(was, next)) return null;
  return `${was.length > 0 ? "Next sessions move to" : "Next sessions"} ${next.map(dayLabel).join(" · ")}`;
}

/** The card's title: "Mobility: new days", "Mobility: new days and goal", "Mobility: new settings" (three or more). */
export function programmeTitle(name: string, changed: readonly (keyof ProgrammeSettings)[]): string {
  const WORD: Record<keyof ProgrammeSettings, string> = { preferredDays: "days", weeklyGoal: "goal", defaultMinutes: "length", blockWeeks: "block length", modes: "modes", careProfiles: "care" };
  const order = PROGRAMME_SETTINGS.filter((k) => changed.includes(k)).map((k) => WORD[k]);
  const what = order.length === 1 ? order[0] : order.length === 2 ? `${order[0]} and ${order[1]}` : "settings";
  return `${name}: new ${what}`;
}

/** The new pattern in one line: "Tue · Thu · 2 a week · 30 min". */
export const programmeSummary = (c: ProgrammeSettings): string => `${daysWords(c.preferredDays)} · ${c.weeklyGoal} a week · ${c.defaultMinutes} min`;

const settingsOf = (c: AdaptiveConfig): ProgrammeSettings => ({
  weeklyGoal: c.weeklyGoal,
  preferredDays: c.preferredDays,
  defaultMinutes: c.defaultMinutes,
  blockWeeks: c.blockWeeks,
  modes: c.modes,
  careProfiles: c.careProfiles,
});

/** What a stored change answers. */
function storedAnswer(proposalId: string, op: ProgrammeChangeOp, o: { replaced?: boolean } = {}): ToolOk {
  return {
    data: {
      stored: true,
      proposalId,
      opId: op.id,
      ...(o.replaced ? { replaced: true } : {}),
      programmeId: op.programId,
      title: untrusted(op.title),
      summary: op.summary,
      lines: op.lines,
      why: untrusted(op.why),
      issues: op.issues,
      next: "It goes to the athlete as one card — Approve or Not now — never reviewed. A second change_programme for this programme replaces it. Call finish when the rest is done.",
    },
    summary: `Programme: ${op.title}`,
    receipt: { proposalId, opId: op.id, programmeId: op.programId },
  };
}

/** The programme as the read gives it. */
interface ProgrammeRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  config: unknown;
  disciplines: unknown;
}

export const changeProgramme: DesignTool = {
  name: "change_programme",
  description: "The main coach: one change to a programme's settings (read_plans) — days, weekly goal, minutes, block length, modes, care — as one card. A second call for it replaces it.",
  inputSchema: {
    type: "object",
    properties: {
      programmeId: { type: "string" },
      days: { type: "array", items: { type: "string" }, description: '["Tue", "Thu"]; [] is any day.' },
      weeklyGoal: { type: "integer", description: "1 to 7." },
      minutes: { type: "integer", description: "10 to 90." },
      blockWeeks: { type: "integer", description: "4 to 6." },
      modes: { type: "array", items: { enum: [...SESSION_MODES] } },
      care: { type: "object", additionalProperties: { type: "boolean" }, description: '{ "<profileId>": false } turns a condition\'s care off.' },
      why: { type: "string", description: `Why, in one plain line the athlete reads on the card: ${capInWords(WHY_MAX)}.` },
    },
    required: ["programmeId", "why"],
    additionalProperties: false,
  },
  statementCost: 1 + PREVIEW_STATEMENTS + 1,
  cpuWeight: 0.5,
  roles: ["main"],
  async run(ctx, raw) {
    const parsed = parseAct(input, raw, "programmeId, the settings to change (days, weeklyGoal, minutes, blockWeeks, modes, care) and why");
    if (isErr(parsed)) return parsed;
    const mainRunId = mainRunIdOf(ctx);
    if (ctx.run.role !== "main" || !mainRunId) return refuse("not_for_role", "Only the main coach changes a programme.", "Say in your finish line what you would change.");
    const given = (["days", "weeklyGoal", "minutes", "blockWeeks", "modes", "care"] as const).filter((k) => parsed[k] !== undefined);
    if (given.length === 0) return refuse("invalid_input", "No setting to change.", "Name what changes: days, weeklyGoal, minutes, blockWeeks, modes or care.");
    // The sheet's own limits, said in its words, before anything is read.
    const wrong: string[] = [];
    const days = (parsed.days ?? []).map((d) => ({ d, i: dayIndex(d) }));
    for (const { d, i } of days) if (i === null) wrong.push(`days: ${JSON.stringify(d)} isn't a day (Mon … Sun)`);
    if (new Set(days.map((x) => x.i)).size < days.length) wrong.push("days: a day is named twice");
    if (parsed.weeklyGoal !== undefined && (parsed.weeklyGoal < 1 || parsed.weeklyGoal > 7)) wrong.push("weeklyGoal: 1 to 7 sessions a week");
    if (parsed.minutes !== undefined && (parsed.minutes < 10 || parsed.minutes > 90)) wrong.push("minutes: 10 to 90");
    if (parsed.blockWeeks !== undefined && (parsed.blockWeeks < 4 || parsed.blockWeeks > 6)) wrong.push("blockWeeks: 4 to 6 weeks");
    const modes = parsed.modes ?? [];
    for (const m of modes) if (!(SESSION_MODES as readonly string[]).includes(m)) wrong.push(`modes: ${JSON.stringify(m)} isn't a mode (${SESSION_MODES.join(", ")})`);
    if (parsed.modes !== undefined && modes.length === 0) wrong.push("modes: at least one");
    if (wrong.length > 0) return refuse("invalid_input", wrong.join("; "), "Call it again with settings the programme's settings take.");

    const proposalId = designProposalId(mainRunId);
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      programme: sql`(select json_object('id', ${programs.id}, 'name', ${programs.name}, 'kind', ${programs.kind}, 'status', ${programs.status},
          'config', json(${programs.config}), 'disciplines', json(${programs.disciplines}))
        from ${programs} where ${programs.id} = ${parsed.programmeId} and ${programs.userId} = ${ctx.userId})`,
      propOps: sql`(select ${coachProposals.ops} from ${coachProposals} where ${coachProposals.id} = ${proposalId} and ${coachProposals.userId} = ${ctx.userId})`,
      propStatus: sql`(select ${coachProposals.status} from ${coachProposals} where ${coachProposals.id} = ${proposalId} and ${coachProposals.userId} = ${ctx.userId})`,
      restoring: sql`(select ${accountState.restoreId} from ${accountState} where ${accountState.userId} = ${ctx.userId})`,
    });
    const opsText = typeof extra.propOps === "string" ? extra.propOps : null;
    const all = ((opsText ? parsedJson(opsText) : null) as unknown[] | null) ?? [];
    const opId = programmeChangeId(parsed.programmeId);
    const held = all.find((o) => isProgrammeChangeOp(o) && o.id === opId) as ProgrammeChangeOp | undefined;
    // A replay of this very call: what it stored, or that a later one replaced it.
    if (ctx.toolUseId && held) {
      if (held.toolUseId === ctx.toolUseId) return storedAnswer(proposalId, held);
      if (held.replaces?.includes(ctx.toolUseId)) return { data: { stored: true, proposalId, superseded: true, note: "a later change to this programme replaced this one" }, summary: "An earlier programme change, already replaced" };
    }
    const status = typeof extra.propStatus === "string" ? extra.propStatus : null;
    if (status === "pending") return refuse("proposal_pending", "Your proposal is already with the athlete.", "Call finish.");
    if (status !== null && !(OPEN_PROPOSAL_STATUSES as readonly string[]).includes(status)) {
      return refuse("proposal_closed", `This design's proposal is already ${status}.`, "Finish: say what you would change, and the athlete can ask again.");
    }
    if (typeof extra.restoring === "string" && extra.restoring.length > 0) {
      return refuse("restoring", "The athlete's account is being restored right now.", "Finish, and say the change can be asked for again once the restore is done.");
    }
    const programme = parsedJson(extra.programme) as ProgrammeRow | null;
    if (!programme || programme.kind !== "adaptive") {
      return refuse("not_your_programme", `${JSON.stringify(parsed.programmeId)} isn't one of the athlete's programmes.`, "Use a programme id from read_plans (kind programme) — a block of yours is propose_plan's.");
    }
    if (programme.status !== "active") return refuse("not_running", `${programme.name} is ${programme.status}.`, "Say so in your finish line; the athlete starts a programme in Plan.");
    const current = adaptiveConfigSchema.parse(parsedJson(programme.config) ?? programme.config ?? {});

    // Care: only a switched-on condition's that has care, as the sheet shows them; the others are kept as they are.
    const caring = new Map(athlete.profiles.flatMap((p) => (p.care ? [[p.id, p.care.block.label] as const] : [])));
    const careWrong = Object.keys(parsed.care ?? {}).filter((id) => !caring.has(id));
    if (careWrong.length > 0) {
      return refuse("invalid_input", `care: ${careWrong.map((id) => JSON.stringify(id)).join(", ")} isn't a switched-on condition with care${caring.size > 0 ? ` (${[...caring.keys()].join(", ")})` : " (none is on)"}.`, "Name a condition read_profile lists as switched on, or leave care out.");
    }
    const careProfiles = parsed.care
      ? [...current.careProfiles.filter((id) => parsed.care![id] !== false), ...Object.entries(parsed.care).filter(([id, on]) => on && !current.careProfiles.includes(id)).map(([id]) => id)]
      : current.careProfiles;
    const wanted: ProgrammeSettings = {
      weeklyGoal: parsed.weeklyGoal ?? current.weeklyGoal,
      // In week order, as the sheet saves them (placement fills them in that order).
      preferredDays: parsed.days ? days.map((x) => x.i!).sort((a, b) => a - b) : current.preferredDays,
      defaultMinutes: parsed.minutes ?? current.defaultMinutes,
      blockWeeks: parsed.blockWeeks ?? current.blockWeeks,
      // In the engine's order, whatever order they were named in.
      modes: parsed.modes ? SESSION_MODES.filter((m) => modes.includes(m)) : current.modes,
      careProfiles,
    };
    const from = settingsOf(current);
    const changed = PROGRAMME_SETTINGS.filter((k) => !sameSetting(k, from[k], wanted[k]));
    if (changed.length === 0) {
      return refuse("no_change", `${programme.name} already has ${programmeSummary(from)}${parsed.blockWeeks !== undefined ? `, ${from.blockWeeks}-week blocks` : ""}.`, "Change something it doesn't have — or, for one session, adjust_plan.");
    }
    const next = adaptiveConfigSchema.safeParse({ ...current, ...wanted });
    if (!next.success) {
      return refuse("invalid_input", next.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), "Call it again with settings the programme's settings take.");
    }
    const change = Object.fromEntries(changed.map((k) => [k, wanted[k]])) as Partial<ProgrammeSettings>;
    const base = Object.fromEntries(changed.map((k) => [k, from[k]])) as Partial<ProgrammeSettings>;

    // Where its sessions go: the pass's own rules over its slots, written nowhere.
    const preview = await previewPlacement(
      ctx.db,
      ctx.userId,
      { id: programme.id, status: programme.status, disciplines: (Array.isArray(programme.disciplines) ? programme.disciplines : parsedJson(programme.disciplines) ?? []) as string[] },
      next.data,
      athlete.today,
      athlete.prefs,
      ctx.now.toISOString(),
    );
    const careLabel = (id: string) => caring.get(id) ?? id;
    const moved = nextLine(preview.before, preview.after);
    const issues =
      wanted.preferredDays.length > 0 && wanted.preferredDays.length < wanted.weeklyGoal
        ? [{ code: "days_short", message: `${plural(wanted.preferredDays.length, "day")} for ${wanted.weeklyGoal} sessions a week: the rest go on the week's other days` }]
        : [];
    const at = ctx.now.toISOString();
    const toolUseId = ctx.toolUseId ?? `call-${at}`;
    const op: ProgrammeChangeOp = {
      kind: "programme_change",
      id: opId,
      programId: programme.id,
      change,
      base,
      why: clipProse(parsed.why, WHY_MAX),
      issues,
      title: programmeTitle(programme.name, changed),
      summary: programmeSummary(wanted),
      lines: [...settingLines(from, wanted, careLabel), ...(moved ? [moved] : [])],
      date: athlete.today,
      toolUseId,
      ...(held ? { replaces: [...(held.replaces ?? []), held.toolUseId] } : {}),
      at,
    };
    const ops = held ? all.map((o) => (o === held ? op : o)) : [...all, op];
    if (!(await upsertProposal(ctx, proposalId, ops, opsText, at))) {
      return refuse("proposal_changed", "The proposal changed while the change was being stored.", "Call change_programme again with the same settings.");
    }
    return storedAnswer(proposalId, op, { replaced: !!held });
  },
};
