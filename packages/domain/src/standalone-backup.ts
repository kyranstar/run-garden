import { z } from "zod";
import { isLocalDate } from "./time.js";

// The standalone tool's backup file (Phase 2 spec §2c "Standalone import"): `{app: "tmj_tool", version: 2, …}`, the
// document the tool's own export writes. The document is version 2; its sessions are either the tool's version-2
// sessions (`version: 2`, written by its recorder) or pass-1 sessions (no version, a `plan` with a `phase`) that the
// tool carried over when it migrated in place.
//
// The document is validated part by part, so one damaged part never takes the rest with it: the envelope must be a
// backup (`standaloneBackupSchema`), each session is checked on its own (`standaloneSessionSchema`; an invalid one is
// reported and skipped, never half-imported), and the settings, places, preferences and block are read through
// their own schemas by the importer, which reports what it could not use. Unknown keys are allowed everywhere — the
// tool adds fields over time — and ignored.

const localDate = z.string().refine(isLocalDate, { message: "must be a YYYY-MM-DD calendar date" });
const id = z.string().min(1).max(200);
const finite = z.number().finite();

/** The envelope. Everything but the session list is read by its own schema below. */
export const standaloneBackupSchema = z
  .object({
    app: z.literal("tmj_tool"),
    version: z.literal(2),
    settings: z.unknown().optional(),
    locations: z.unknown().optional(),
    prefs: z.unknown().optional(),
    wishlist: z.unknown().optional(),
    block: z.unknown().optional(),
    sessions: z.array(z.unknown()).max(5000),
  })
  .passthrough();
export type StandaloneBackup = z.infer<typeof standaloneBackupSchema>;

/** A weight as the tool stored it: `{v, u}` (v may be missing on damaged rows), or a bare number in the tool's unit. */
const weightLike = z.union([z.object({ v: finite.nullable().optional(), u: z.string().optional() }).passthrough(), finite, z.null()]);

const setSchema = z
  .object({
    w: weightLike.optional(),
    reps: finite.nullable().optional(),
    secs: finite.nullable().optional(),
    done: z.boolean().optional(),
  })
  .passthrough();

const entrySchema = z
  .object({
    id,
    implement: z.string().max(60).nullable().optional(),
    format: z.string().max(60).nullable().optional(),
    /** Version 2: logged per side. */
    perSide: z.boolean().optional(),
    /** Pass 1's word for the same thing. */
    bilateral: z.boolean().optional(),
    clenched: z.boolean().optional(),
    sets: z.array(setSchema.nullable()).max(50).default([]),
  })
  .passthrough();

const check = finite.min(0).max(10).nullable().optional();

const sessionCommon = {
  id,
  date: localDate,
  startedAt: z.string().max(40).nullable().optional(),
  endedAt: z.string().max(40).nullable().optional(),
  seconds: finite.min(0).max(24 * 3600).nullable().optional(),
  pre: check,
  post: check,
  feelingOff: z.boolean().optional(),
  note: z.string().max(2000).nullable().optional(),
  entries: z.array(entrySchema).max(100).default([]),
  done: z
    .array(z.object({ id, secs: finite.min(0).nullable().optional() }).passthrough())
    .max(200)
    .default([]),
};

/** A session the tool's recorder wrote. */
export const standaloneSessionV2Schema = z
  .object({
    ...sessionCommon,
    version: z.literal(2),
    mode: z.string().max(40).nullable().optional(),
    theme: z.string().max(60).nullable().optional(),
    location: z.string().max(200).nullable().optional(),
    minutes: finite.min(0).max(600).nullable().optional(),
    plannedSeconds: finite.min(0).nullable().optional(),
    blockNumber: finite.int().min(0).nullable().optional(),
    completed: z.boolean().optional(),
    stepsTotal: finite.int().min(0).nullable().optional(),
    stepsDone: finite.int().min(0).nullable().optional(),
    newMove: id.nullable().optional(),
  })
  .passthrough();

/** A pass-1 session: no version; its plan says which phase it was (`flare` is a recovery session). */
export const standaloneSessionV1Schema = z
  .object({
    ...sessionCommon,
    version: z.literal(1).optional(),
    plan: z.object({ phase: z.string().max(40).optional() }).passthrough().nullable().optional(),
  })
  .passthrough();

export type StandaloneSessionV2 = z.infer<typeof standaloneSessionV2Schema>;
export type StandaloneSessionV1 = z.infer<typeof standaloneSessionV1Schema>;
export type StandaloneSession = ({ kind: "v2" } & StandaloneSessionV2) | ({ kind: "v1" } & StandaloneSessionV1);

/** One session, by its own version. */
export function parseStandaloneSession(raw: unknown): z.SafeParseReturnType<unknown, StandaloneSession> {
  const v2 = typeof raw === "object" && raw !== null && (raw as { version?: unknown }).version === 2;
  const parsed = v2 ? standaloneSessionV2Schema.safeParse(raw) : standaloneSessionV1Schema.safeParse(raw);
  if (!parsed.success) return parsed as z.SafeParseReturnType<unknown, StandaloneSession>;
  return { success: true, data: { kind: v2 ? "v2" : "v1", ...parsed.data } as StandaloneSession };
}

/** The tool's settings the import reads (first import only). */
export const standaloneSettingsSchema = z
  .object({
    unit: z.enum(["lb", "kg"]).optional(),
    weeklyGoal: finite.optional(),
    blockWeeks: finite.optional(),
    defaultMinutes: finite.optional(),
    /** The id of the place sessions happen at by default. */
    location: z.string().max(200).optional(),
  })
  .passthrough();

/** A place: its gear, and per weighted gear `{weights: "8, 12, 16 kg"}` as typed. */
export const standaloneLocationSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(60),
    equipment: z.array(z.string().max(60)).max(40).default([]),
  })
  .passthrough();

export const standalonePrefsSchema = z
  .object({
    ratings: z.record(id, finite).default({}),
    excluded: z.array(id).max(1000).default([]),
    pinned: z.array(id).max(1000).default([]),
    /** The day each move was first introduced, when the tool kept it. */
    introduced: z.record(id, z.string()).default({}),
  })
  .passthrough();

export const standaloneBlockSchema = z
  .object({
    number: finite.int().min(1),
    startedAt: localDate,
    weeks: finite.int().min(1).max(12),
    core: z.record(z.string().min(1).max(60), id.nullable()),
    rotations: z
      .array(
        z
          .object({ family: z.string().min(1).max(60), from: id.nullable(), to: id, date: localDate, why: z.string().max(200) })
          .passthrough(),
      )
      .max(200)
      .default([]),
  })
  .passthrough();

export const standaloneWishlistSchema = z.array(z.string().max(60)).max(40);
