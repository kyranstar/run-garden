/**
 * ONE POST'S TRAIL, AS ITS OWNER READS IT (design 2026-11-05 §3.4, §6.3). The account first — what the post is, its
 * moves and how each came out, one health word — then every event oldest first, each with its blobs listed (their text
 * is read one at a time: `readBlob`). A post from before the trail has no events: its account and events are rebuilt
 * from the columns that were kept, each marked `rebuilt`, never passed off as what happened at the time (§6.6) — at read
 * time, never written (phase 5a: the controller's ruling, no production write). The rebuild carries what was kept: where
 * it came from, the screening, the reading, the links and their flags, the batch, the owner's choices and what was saved,
 * each dated by the time kept for it or not at all.
 *
 * D1 statements: the post (with its batch) 1, its events 1, its blobs' list 1, its links (with their moves and
 * provenance) 1 — 4.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { EXERCISES } from "@rg/exercise-library";
import { failureWords, IMPORT_STAGES } from "@rg/saves";
import type { BlobKind, ImportBlobDto, ImportStage, ImportTrailDto, TrailEventDto, TrailSource, TrailStatus } from "@rg/saves";
import { nowInstant } from "@rg/domain";
import type { Db } from "./db.js";
import { EXTRACT_MODEL_DEFAULT } from "./saves-relay.js";
import { readAgainGateSql, readingCostOf } from "./saves-reread.js";
import { videoOfTrail } from "./saves-video.js";

const { savedPosts, importEvents, importBlobs, savedPostMoves, personalMoves, saveBatches, exerciseProvenance } = schema;

const LIBRARY_NAME = new Map(EXERCISES.map((e) => [e.id, e.name]));
const RANK: Record<TrailStatus, number> = { fail: 3, warn: 2, info: 0, skip: 0, ok: 0 };

interface Extracted {
  kind?: string;
  summary?: string;
  moves?: {
    name?: string; purpose?: string; why?: string; useWhen?: unknown; skipWhen?: unknown; quotes?: unknown;
    dose?: { text?: unknown }; evidence?: unknown; confidence?: unknown;
  }[];
  insights?: unknown[];
}

type Case = { text: string; evidence: "stated" | "inferred" };
const casesOf = (v: unknown): Case[] =>
  Array.isArray(v)
    ? v.flatMap((c) => (c && typeof c.text === "string" ? [{ text: c.text, evidence: c.evidence === "stated" ? ("stated" as const) : ("inferred" as const) }] : []))
    : [];
type Quote = NonNullable<ImportTrailDto["account"]["moves"][number]["quotes"]>[number];
const quotesOf = (v: unknown): Quote[] =>
  Array.isArray(v)
    ? v.flatMap((q): Quote[] =>
        q && typeof q.text === "string" && typeof q.field === "string"
          ? [{
              field: q.field, text: q.text, from: typeof q.from === "string" ? q.from : "caption",
              ...(typeof q.at === "number" ? { at: q.at } : {}),
              ...(q.check === "verified" || q.check === "in_speech" || q.check === "on_screen" || q.check === "not_found" ? { check: q.check } : {}),
            }]
          : [],
      )
    : [];

export async function readPostTrail(db: Db, userId: string, postId: string, now: string = nowInstant()): Promise<ImportTrailDto | null> {
  const [found] = await db
    .select({
      p: savedPosts,
      // Read it again may be asked now (phase 5a): the ask's own gate, in the same statement.
      readable: sql<number>`${readAgainGateSql(userId, postId, now)}`,
      batch: {
        id: saveBatches.id, status: saveBatches.status, createdAt: saveBatches.createdAt, releasedAt: saveBatches.releasedAt,
        savedAt: saveBatches.savedAt, fittedAt: saveBatches.fittedAt, fitStartedAt: saveBatches.fitStartedAt, theme: saveBatches.theme,
      },
    })
    .from(savedPosts)
    .leftJoin(saveBatches, and(eq(saveBatches.id, savedPosts.batchId), eq(saveBatches.userId, userId)))
    .where(and(eq(savedPosts.id, postId), eq(savedPosts.userId, userId)))
    .limit(1);
  if (!found) return null;
  const p = found.p;
  const batch = found.batch?.id ? (found.batch as KeptBatch) : null;
  const rows = await db
    .select()
    .from(importEvents)
    .where(and(eq(importEvents.userId, userId), eq(importEvents.postId, postId)))
    .orderBy(asc(importEvents.at), sql`rowid`);
  const blobs = await db
    .select({ id: importBlobs.id, kind: importBlobs.kind, eventId: importBlobs.eventId, chars: sql<number>`length(${importBlobs.text})` })
    .from(importBlobs)
    .where(and(eq(importBlobs.userId, userId), eq(importBlobs.postId, postId)));
  // Each link with what the account holds of it: its move's name and state (merged into another, the owner's choice, an
  // edit), the move its flag says it looks like, and its provenance (written on Save: when, and the note it kept).
  const links: KeptLink[] = await db
    .select({
      position: savedPostMoves.position,
      moveId: savedPostMoves.moveId,
      moveKind: savedPostMoves.moveKind,
      status: savedPostMoves.status,
      name: sql<string | null>`json_extract(${personalMoves.record}, '$.name')`,
      confidence: savedPostMoves.confidence,
      checkFlag: savedPostMoves.checkFlag,
      likeMoveId: savedPostMoves.likeMoveId,
      likeName: sql<string | null>`(select json_extract(lm.record, '$.name') from personal_moves lm where lm.user_id = ${userId} and lm.id = ${savedPostMoves.likeMoveId})`,
      createdAt: savedPostMoves.createdAt,
      moveStatus: personalMoves.status,
      mergedInto: personalMoves.mergedInto,
      mergedName: sql<string | null>`(select json_extract(mm.record, '$.name') from personal_moves mm where mm.user_id = ${userId} and mm.id = ${personalMoves.mergedInto})`,
      fitChoice: personalMoves.fitChoice,
      edited: personalMoves.editedByOwner,
      savedAt: exerciseProvenance.createdAt,
      note: exerciseProvenance.note,
    })
    .from(savedPostMoves)
    .leftJoin(personalMoves, and(eq(personalMoves.id, savedPostMoves.moveId), eq(personalMoves.userId, userId)))
    .leftJoin(exerciseProvenance, and(eq(exerciseProvenance.id, savedPostMoves.id), eq(exerciseProvenance.userId, userId)))
    .where(and(eq(savedPostMoves.userId, userId), eq(savedPostMoves.postId, postId)))
    .orderBy(asc(savedPostMoves.position));

  const byEvent = new Map<string, TrailEventDto["blobs"]>();
  for (const b of blobs) {
    if (!b.eventId) continue;
    const list = byEvent.get(b.eventId) ?? [];
    list.push({ id: b.id, kind: b.kind as BlobKind, chars: Number(b.chars) });
    byEvent.set(b.eventId, list);
  }
  const stored: TrailEventDto[] = rows.map((r) => ({
        id: r.id,
        stage: r.stage as ImportStage,
        source: r.source as TrailSource,
        status: r.status as TrailStatus,
        summary: r.summary,
        detail: r.detail ?? null,
        moveId: r.moveId,
        model: r.model,
        promptVersion: r.promptVersion,
        costMicros: r.costMicros,
        latencyMs: r.latencyMs,
        attempt: r.attempt,
        runId: r.runId,
        proposalId: r.proposalId,
        rebuilt: r.rebuilt,
        blobs: byEvent.get(r.id) ?? [],
        at: r.at,
      }));
  // A post from before the trail has no screening or reading of its own; one touched since (saved, edited) has later
  // steps only. Either way its kept columns are rebuilt, marked, before whatever came after (final review I4).
  const hasOwnReading = stored.some((e) => e.stage === "screen" || e.stage === "extract");
  // A step the trail recorded itself is never rebuilt beside it (a post saved after the trail began has its own save
  // step); the owner's choices are rebuilt unless the trail recorded the fit of the post's own batch.
  const recorded = (e: TrailEventDto): boolean =>
    e.stage === "choice"
      ? rows.some((r) => r.stage === "choice" && !!r.batchId && r.batchId === p.batchId)
      : stored.some((s) => s.stage === e.stage);
  const rebuiltSteps = hasOwnReading ? [] : rebuiltEvents(p, batch, links).filter((e) => !recorded(e));
  const rebuilt = rebuiltSteps.length > 0;
  const events = [...rebuiltSteps, ...stored];

  const extraction = (p.extraction ?? null) as Extracted | null;
  // How each move came out: the match event's word when the trail has one, else the link's kind.
  const matched = [...events].reverse().find((e) => e.stage === "match")?.detail as { moves?: { position: number; outcome?: string }[] } | undefined;
  const outcomeAt = new Map((matched?.moves ?? []).map((m) => [m.position, m.outcome]));
  const linkAt = new Map(links.map((l) => [l.position, l]));
  const moves = (extraction?.moves ?? []).map((m, position) => {
    const link = linkAt.get(position);
    const said = outcomeAt.get(position);
    const outcome: "new" | "yours" | "library" =
      said === "library" || link?.moveKind === "library" ? "library" : said === "new" ? "new" : link ? "yours" : "new";
    return {
      position,
      name: (link?.moveKind === "library" ? LIBRARY_NAME.get(link.moveId) : link?.name) ?? m.name ?? "",
      outcome,
      moveId: link?.moveId ?? null,
      purpose: typeof m.purpose === "string" && m.purpose.trim() ? m.purpose : null,
      // What the post says of it (extract-6): when to use it or not, why, and its quotes with their checks.
      ...(typeof m.why === "string" && m.why.trim() ? { why: m.why } : {}),
      ...(casesOf(m.useWhen).length ? { useWhen: casesOf(m.useWhen) } : {}),
      ...(casesOf(m.skipWhen).length ? { skipWhen: casesOf(m.skipWhen) } : {}),
      ...(quotesOf(m.quotes).length ? { quotes: quotesOf(m.quotes) } : {}),
    };
  });

  // The import's outcome: each stage judged by its last step, so a step that failed and then worked is a retry, not a
  // failure (final review I1).
  const lastOf = new Map<ImportStage, TrailEventDto>();
  for (const e of events) if (e.status !== "info" && e.status !== "skip") lastOf.set(e.stage, e);
  const worst = [...lastOf.values()].reduce<TrailEventDto | null>((w, e) => (RANK[e.status] > (w ? RANK[w.status] : 0) ? e : w), null);
  const retried = !worst && events.some((e) => e.status === "fail");
  return {
    post: {
      id: p.id,
      source: p.source,
      url: p.url,
      title: p.title,
      creator: { handle: p.creatorHandle ?? "", ...(p.creatorName ? { name: p.creatorName } : {}) },
      mediaType: p.mediaType,
      postedAt: p.postedAt,
      firstSeenAt: p.firstSeenAt,
      status: p.status,
      origin: p.origin ?? null,
      durationSec: p.durationSec ?? null,
      videoSeen: p.videoSeen ?? null,
      readAgain: readAgainOf(p, Number(found.readable) === 1, rows),
      video: videoOfTrail(
        { source: p.source, status: p.status, durationSec: p.durationSec ?? null, videoSeen: p.videoSeen ?? null, watchVideo: p.watchVideo ?? null },
        links.some((l) => l.status === "saved"),
        EXTRACT_MODEL_DEFAULT,
      ),
    },
    account: {
      kind: extraction?.kind ?? null,
      summary: extraction?.summary ?? null,
      moves,
      // A failed post is failed whatever its steps say (final review, 2026-11-05): never "Read cleanly".
      health:
        p.status === "failed" && worst?.status !== "fail"
          ? { status: "fail", line: failureWords(p.lastErrorCode ?? "unknown", p.lastError) ?? "Something went wrong" }
          : worst
            ? { status: worst.status, line: worst.summary }
            : events.length === 0
              ? { status: "info", line: "Nothing recorded yet" }
              : retried
                ? { status: "warn", line: "Read cleanly after a retry" }
                : { status: "ok", line: "Read cleanly" },
    },
    events,
    rebuilt,
  };
}

/** Read it again on the trail: offered (with its price) while it may be asked; asked, until the reading is under way. */
function readAgainOf(
  p: typeof savedPosts.$inferSelect,
  readable: boolean,
  rows: readonly { stage: string; detail: unknown }[],
): ImportTrailDto["post"]["readAgain"] {
  const lastChoice = [...rows].reverse().find((r) => r.stage === "choice");
  const asked = (p.status === "queued" || p.status === "extracting") && (lastChoice?.detail as { action?: unknown } | null)?.action === "reread";
  if (!readable && !asked) return null;
  return { offer: readable, asked, costMicros: readingCostOf(p) };
}

/** The post's batch, as the trail's read joins it. */
interface KeptBatch {
  id: string;
  status: string;
  createdAt: string;
  releasedAt: string | null;
  savedAt: string | null;
  fittedAt: string | null;
  fitStartedAt: string | null;
  theme: string | null;
}

/** One link of the post, with what the account holds of its move and its provenance. */
interface KeptLink {
  position: number;
  moveId: string;
  moveKind: string;
  status: string;
  name: string | null;
  confidence: number | null;
  checkFlag: boolean;
  likeMoveId: string | null;
  likeName: string | null;
  createdAt: string;
  moveStatus: string | null;
  mergedInto: string | null;
  mergedName: string | null;
  fitChoice: string | null;
  edited: boolean | null;
  savedAt: string | null;
  note: string | null;
}

const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;
const KIND_WORDS: Readonly<Record<string, string>> = { routine: "a routine", single_move: "single move", tips: "tips", not_training: "not training" };
/** A batch's standing, in the owner's words. */
function batchWords(b: KeptBatch): string {
  if (b.status === "saved") return b.fittedAt ? "saved and fitted in" : "saved, not yet fitted in";
  if (b.status === "released") return "waiting for you";
  if (b.status === "held") return "held back";
  if (b.status === "dismissed") return "put aside";
  if (b.status === "superseded") return "a later one replaced it";
  return b.status;
}
/** The earliest of some kept times; "" when none was kept. */
const earliest = (times: readonly (string | null | undefined)[]): string => times.filter((t): t is string => !!t).sort()[0] ?? "";
/** A move's name as the account has it: the library's, else its record's. */
const nameOf = (l: Pick<KeptLink, "moveKind" | "moveId" | "name">): string | null => (l.moveKind === "library" ? (LIBRARY_NAME.get(l.moveId) ?? null) : l.name);

/**
 * The steps of a post from before the trail, built from its kept columns: labelled `rebuilt`, in pipeline order. Each is
 * dated by the time kept for it — captured, matched (its links' creation), the batch's release, the fit, the save — and
 * a step no time was kept for has none (`at: ""`), never the post's last touch (the controller's addition 2).
 */
function rebuiltEvents(p: typeof savedPosts.$inferSelect, batch: KeptBatch | null, links: readonly KeptLink[]): TrailEventDto[] {
  const base = (stage: ImportStage, status: TrailStatus, summary: string, detail: unknown, at: string, source: TrailSource = "worker"): TrailEventDto => ({
    id: `rebuilt:${stage}`, stage, source, status, summary, detail, moveId: null, model: null, promptVersion: null,
    costMicros: null, latencyMs: null, attempt: null, runId: null, proposalId: null, rebuilt: true, blobs: [], at,
  });
  const out: TrailEventDto[] = [];
  const extraction = p.extraction as Extracted | null;

  // Provenance: where it came from, by whom, when it was captured.
  const creator = p.creatorName && p.creatorHandle ? `${p.creatorName} (${p.creatorHandle})` : p.creatorName || p.creatorHandle || null;
  out.push(base(
    "submit",
    "ok",
    p.seeded ? "Brought in with the first import" : p.origin === "pasted" ? "Pasted as a link" : "Found by the extension",
    { source: p.source, creator, mediaType: p.mediaType, captured: p.firstSeenAt, posted: p.postedAt },
    p.firstSeenAt,
    "extension",
  ));

  if (p.filterVerdict || p.filterStage) {
    const kept = p.filterVerdict !== "not";
    out.push(base("screen", "ok", `${kept ? "Kept" : "Not training"}: ${p.filterReason ?? ""}`.replace(/: $/, ""), {
      verdict: p.filterVerdict, reason: p.filterReason, stage: p.filterStage,
    }, ""));
  }

  if (extraction) {
    const moves = extraction.moves ?? [];
    const kind = typeof extraction.kind === "string" ? extraction.kind : null;
    // The reading as it was kept: each move's name, its dose in the post's words, what it is for, what the reading said
    // it stated or guessed — and the post's notes.
    const notes = (Array.isArray(extraction.insights) ? extraction.insights : []).flatMap((i): string[] =>
      typeof i === "string" ? [i] : i && typeof i === "object" && typeof (i as { text?: unknown }).text === "string" && !(i as { dropped?: unknown }).dropped ? [(i as { text: string }).text] : [],
    );
    out.push(base("extract", "ok", `Read ${plural(moves.length, "move")}${kind ? ` (${KIND_WORDS[kind] ?? kind})` : ""}`, {
      kind,
      moves: moves.map((m, position) => ({
        position,
        name: typeof m.name === "string" ? m.name : null,
        dose: typeof m.dose?.text === "string" && m.dose.text.trim() ? m.dose.text : null,
        purpose: typeof m.purpose === "string" && m.purpose.trim() ? m.purpose : null,
        evidence: m.evidence && typeof m.evidence === "object" ? m.evidence : null,
        confidence: typeof m.confidence === "string" ? m.confidence : null,
      })),
      ...(notes.length ? { notes } : {}),
    }, ""));
  } else if (p.status === "failed") {
    out.push(base("extract", "fail", failureWords(p.lastErrorCode ?? "unknown", p.lastError) ?? "Something went wrong", { code: p.lastErrorCode }, ""));
  }

  // Matching, from the links it left: how each came out, and its flags — check this, looks like, merged, left out.
  if (links.length) {
    const kept = links.filter((l) => l.status !== "removed");
    const library = links.filter((l) => l.moveKind === "library").length;
    const yours = links.length - library;
    const parts = [yours ? `${yours} already yours` : "", library ? `${library} from the library` : ""].filter(Boolean).join(", ");
    const checks = kept.filter((l) => l.checkFlag).length;
    const removed = links.length - kept.length;
    const flags = [checks ? `${checks} to check` : "", removed ? `${removed} left out` : ""].filter(Boolean).join(", ");
    out.push(base("match", "ok", `${plural(links.length, "move")}: ${parts}${flags ? ` — ${flags}` : ""}`, {
      moves: links.map((l) => ({
        position: l.position,
        name: extraction?.moves?.[l.position]?.name ?? nameOf(l),
        outcome: l.moveKind === "library" ? "library" : "personal",
        moveId: l.moveId,
        check: l.checkFlag,
        ...(l.likeMoveId ? { like: { id: l.likeMoveId, name: l.likeName ?? LIBRARY_NAME.get(l.likeMoveId) ?? null } } : {}),
        ...(l.moveStatus === "merged" && l.mergedInto ? { mergedInto: { id: l.mergedInto, name: l.mergedName ?? LIBRARY_NAME.get(l.mergedInto) ?? null } } : {}),
        now: l.status,
        ...(l.confidence !== null ? { confidence: l.confidence } : {}),
      })),
    }, earliest(links.map((l) => l.createdAt))));
  }

  if (batch) {
    const words = batchWords(batch);
    out.push(base("batch", "info", `Joined a batch — ${words}`, { batchId: batch.id, batch: words, ...(batch.theme ? { theme: batch.theme } : {}) }, batch.releasedAt ?? batch.createdAt));
  }

  // The owner's choices: their word on the post, each move in or out, the moves they edited.
  const choices: Record<string, string> = {};
  const edited: string[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    if (l.moveKind !== "personal" || seen.has(l.moveId)) continue;
    seen.add(l.moveId);
    if (l.fitChoice === "include" || l.fitChoice === "skip") choices[l.moveId] = l.fitChoice;
    if (l.edited) edited.push(nameOf(l) ?? "a move");
  }
  const word = p.status === "skipped_by_owner" ? "skipped" : p.status === "reference_only" ? "reference" : p.filterStage === "owner" ? "read anyway" : null;
  const ins = Object.values(choices).filter((c) => c === "include").length;
  const outs = Object.values(choices).length - ins;
  const counted = [ins ? `${ins} in` : "", outs ? `${outs} left out` : "", edited.length ? `${edited.length} edited` : ""].filter(Boolean).join(", ");
  if (word || counted) {
    const said = word === "skipped" ? "You skipped it" : word === "reference" ? "You kept it as a reference" : word ? "You had it read anyway" : null;
    out.push(base("choice", "info", [said, counted ? `${said ? "your" : "Your"} choices: ${counted}` : null].filter(Boolean).join("; "), {
      ...(word ? { post: word } : {}),
      ...(Object.keys(choices).length ? { choices } : {}),
      ...(edited.length ? { edited } : {}),
    }, counted && batch ? (batch.fitStartedAt ?? batch.savedAt ?? "") : "", "owner"));
  }

  // What was saved: each move with the note its provenance kept.
  const saved = links.filter((l) => l.status === "saved");
  if (saved.length) {
    out.push(base("save", "ok", `Saved: ${plural(saved.length, "move")} joined your library`, {
      moves: saved.map((l) => ({ position: l.position, name: nameOf(l), ...(l.note ? { note: l.note } : {}) })),
    }, earliest(saved.map((l) => l.savedAt)) || (batch?.savedAt ?? "")));
  }
  return out.sort((a, b) => IMPORT_STAGES.indexOf(a.stage) - IMPORT_STAGES.indexOf(b.stage));
}

/** One blob's text, the owner's only. */
export async function readBlob(db: Db, userId: string, blobId: string): Promise<ImportBlobDto | null> {
  const [b] = await db
    .select({ id: importBlobs.id, kind: importBlobs.kind, text: importBlobs.text, cut: importBlobs.cut })
    .from(importBlobs)
    .where(and(eq(importBlobs.id, blobId), eq(importBlobs.userId, userId)))
    .limit(1);
  return b ? { id: b.id, kind: b.kind as BlobKind, text: b.text, cut: b.cut } : null;
}
