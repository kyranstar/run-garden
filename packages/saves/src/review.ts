import { z } from "zod";
import { DOSE_TYPES, PROFILE_IDS, type ExerciseRecord } from "@rg/exercise-library";
import { PERSONAL_ID_RE } from "./ids.js";
import type { MoveGroup } from "./breakdown.js";

// The review of a batch ("From your saves", Studio `/studio/saves/:batchId`): the owner's side of what the import
// brought, before anything of it is used. The Worker answers these shapes (apps/worker/src/routes/my-saves.ts); the app
// reads them (packages/ui/src/screens/studio/saves.tsx).

/** A move's say in "Fit these in": use it in the plan, or leave it out. */
export type FitChoice = "include" | "skip";

/** What a batch's links hold: distinct new moves, distinct moves the owner already had, and the rows taken out. */
export interface SaveBatchCountsDto {
  new: number;
  linked: number;
  removed: number;
}

/** One batch, as the list and the review's head show it. */
export interface SaveBatchDto {
  id: string;
  status: "held" | "released" | "saved" | "dismissed" | "superseded";
  /** "From your saves: 2 new moves (1 hip, 1 neck), 1 you already had." — null while held. */
  notice: string | null;
  theme: string | null;
  createdAt: string;
  releasedAt: string | null;
  savedAt: string | null;
  /** When a pins card naming it was approved (the coach fitted it in, spec §17.1); null until then. */
  fittedAt: string | null;
  counts: SaveBatchCountsDto;
  /** When the owner put the batch aside ("not now"); null until then, and again once Fit them in brings it back. */
  dismissedAt: string | null;
  /** When the latest "Fit them in" started; null until then, and once its run could not start or its card closed. */
  fitStartedAt: string | null;
  /** The server's reading of the one-hour rule: a fit is under way. */
  fitting: boolean;
}

/** The words "Fit these in" sends — the coach opening's chip and the batch page's button alike (the coach reads the whole
 * saves section for it). */
export const FIT_SAVES_REQUEST = "Fit the new moves from my saves into my training.";

/** A reason a row says "Check this" (`SaveBatchRowDto.move.checkWhy`). */
export type CheckWhy = "low_confidence" | "inferred_name" | "inferred_dose" | "near_duplicate";

export interface SaveBatchesDto {
  batches: SaveBatchDto[];
}

/** One move found in one saved post (a link, `saved_post_moves`). Every string a model wrote is text, never markup. */
export interface SaveBatchRowDto {
  postMoveId: string;
  /** The move's place in the post. */
  position: number;
  /** Pending until the batch is saved; removed rows are left out of the save. */
  status: "pending" | "saved" | "removed";
  post: {
    /** The post's address as stored (the app links it only when it is http or https). */
    url: string | null;
    /** The creator's handle, else their name. */
    creator: string | null;
    /** What the post was: a routine, one move, tips. */
    kind: string | null;
  };
  move: {
    /** The move the link names: a pending personal move (new), a library move or an active personal one (linked). */
    id: string;
    /** A new move's own name (the owner's edit too); a linked row's name as the post gave it. */
    name: string;
    summary: string;
    kind: "new" | "linked";
    /** The move it is linked to: its name. */
    linkedName?: string;
    /** "Check this": a match the names alone did not settle, or a move the reading was unsure of. */
    check: boolean;
    /**
     * Why it says "Check this", as data (only on a row it flags): the match or the reading was not confident, or the post
     * never said the move's name or its dose (the reading's evidence: inferred).
     */
    checkWhy?: CheckWhy[];
    /** The dose as the post prescribed it ("3 x 10"), beside the stored one. */
    seenDose: string | null;
    /** The extraction's `purpose` at the link's position: what the post says the move is for. */
    purpose: string | null;
    /** The move this one looks like (a near-duplicate flagged at the cut): its id and name. Only on a row that has one. */
    like?: { id: string; name: string };
    /** The move's stored fit choice: null for the coach's call, and always for a linked row. */
    choice: FitChoice | null;
  };
  /** A personal move's record (new, or linked to one of the owner's own). */
  record?: ExerciseRecord;
}

/**
 * One insight of a post of the batch that has a kept row (spec §17): what the post says about when, why or how often to
 * do something — what the coach keeps in memory when the batch is saved. A model's reading of a stranger's post: the
 * text and the creator are drawn as text.
 */
export interface SaveBatchInsightDto {
  postId: string;
  url: string | null;
  /** The creator's handle, else their name. */
  creator: string | null;
  text: string;
}

export interface SaveBatchDetailDto {
  batch: SaveBatchDto;
  rows: SaveBatchRowDto[];
  /** In the posts' order (absent from an answer kept from before it was added). */
  insights?: SaveBatchInsightDto[];
}

const line = (max: number) => z.string().max(max);

/**
 * The owner's edit of a personal move (`PUT /api/my-saves/moves/:id`): each field sent replaces the record's, except
 * `conditions` and `text.conditions`, which replace the profiles they name. The result is held to the library's own
 * validation; the id never changes.
 */
export const personalMovePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    text: z
      .object({
        summary: line(160).optional(),
        steps: z.array(line(200)).max(12).optional(),
        focus: z.array(line(160)).max(8).optional(),
        mistakes: z.array(line(160)).max(8).optional(),
        conditions: z.record(line(160)).optional(),
      })
      .strict()
      .optional(),
    dose: z
      .object({
        type: z.enum(DOSE_TYPES),
        range: z.tuple([z.number(), z.number()]),
        sets: z.tuple([z.number().int(), z.number().int()]).optional(),
        restSec: z.number().int().min(0).max(900).optional(),
        secsPerRep: z.number().min(0).max(60).optional(),
        startKg: z.number().min(0).max(500).optional(),
      })
      .strict()
      .optional(),
    conditions: z.record(z.record(z.union([z.number(), z.boolean()]))).optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0 && (p.text === undefined || Object.keys(p.text).length > 0), { message: "nothing to change" })
  .refine(
    (p) =>
      [...Object.keys(p.conditions ?? {}), ...Object.keys(p.text?.conditions ?? {})].every((k) =>
        (PROFILE_IDS as readonly string[]).includes(k),
      ),
    { message: "not a condition profile" },
  );
export type PersonalMovePatch = z.infer<typeof personalMovePatchSchema>;

/** `POST /api/my-saves/post-moves/:id/rematch`: a library move or one of the owner's active moves ("Same as…"), or null — the move is its own ("Not this move"). */
export const rematchSchema = z.object({ to: z.string().min(1).max(80).nullable() }).strict();

/** `POST /api/my-saves/batches`: a themed held batch of these posts' moves (the bootstrap's batches are 20–60 posts). */
export const createBatchSchema = z
  .object({ theme: z.string().trim().max(60).nullable(), postIds: z.array(z.string().min(1).max(80)).min(1).max(100) })
  .strict();

/** `POST /api/my-saves/batches/:id/fit`: each new move's say, by id (a move left out of `choices` is the coach's call). */
export const fitSchema = z
  .object({ choices: z.record(z.string().regex(PERSONAL_ID_RE), z.enum(["include", "skip"])) })
  .strict()
  .refine((b) => Object.keys(b.choices).length <= 60, { message: "too many choices" });
export type FitBody = z.infer<typeof fitSchema>;

/** The answer to a fit: the batch, the words to send the coach, and what the fit takes in. */
export interface FitAnswerDto {
  batchId: string;
  /** `FIT_SAVES_REQUEST`. */
  request: string;
  moves: number;
  links: number;
}

/** The batch the open card is about. */
export interface OpenSavesBatchDto {
  id: string;
  counts: { new: number; linked: number };
  groups: Array<{ group: MoveGroup; count: number }>;
  line: string;
  fitting: boolean;
}

export interface OpenSavesDto {
  open: OpenSavesBatchDto | null;
}
