/**
 * ONE POST'S TRAIL, AS ITS OWNER READS IT (design 2026-11-05 §3.4, §6.3). The account first — what the post is, its
 * moves and how each came out, one health word — then every event oldest first, each with its blobs listed (their text
 * is read one at a time: `readBlob`). A post from before the trail has no events: its account and events are rebuilt
 * from the columns that were kept, each marked `rebuilt`, never passed off as what happened at the time (§6.6).
 *
 * D1 statements: the post 1, its events 1, its blobs' list 1, its links 1 — 4.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { EXERCISES } from "@rg/exercise-library";
import { failureWords, IMPORT_STAGES } from "@rg/saves";
import type { BlobKind, ImportBlobDto, ImportStage, ImportTrailDto, TrailEventDto, TrailSource, TrailStatus } from "@rg/saves";
import type { Db } from "./db.js";
import { EXTRACT_MODEL_DEFAULT } from "./saves-relay.js";
import { videoOfTrail } from "./saves-video.js";

const { savedPosts, importEvents, importBlobs, savedPostMoves, personalMoves } = schema;

const LIBRARY_NAME = new Map(EXERCISES.map((e) => [e.id, e.name]));
const RANK: Record<TrailStatus, number> = { fail: 3, warn: 2, info: 0, skip: 0, ok: 0 };

interface Extracted {
  kind?: string;
  summary?: string;
  moves?: { name?: string; purpose?: string; why?: string; useWhen?: unknown; skipWhen?: unknown; quotes?: unknown }[];
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
              ...(q.check === "verified" || q.check === "in_speech" || q.check === "not_found" ? { check: q.check } : {}),
            }]
          : [],
      )
    : [];

export async function readPostTrail(db: Db, userId: string, postId: string): Promise<ImportTrailDto | null> {
  const [p] = await db
    .select()
    .from(savedPosts)
    .where(and(eq(savedPosts.id, postId), eq(savedPosts.userId, userId)))
    .limit(1);
  if (!p) return null;
  const rows = await db
    .select()
    .from(importEvents)
    .where(and(eq(importEvents.userId, userId), eq(importEvents.postId, postId)))
    .orderBy(asc(importEvents.at), sql`rowid`);
  const blobs = await db
    .select({ id: importBlobs.id, kind: importBlobs.kind, eventId: importBlobs.eventId, chars: sql<number>`length(${importBlobs.text})` })
    .from(importBlobs)
    .where(and(eq(importBlobs.userId, userId), eq(importBlobs.postId, postId)));
  const links = await db
    .select({ position: savedPostMoves.position, moveId: savedPostMoves.moveId, moveKind: savedPostMoves.moveKind, status: savedPostMoves.status, name: sql<string | null>`json_extract(${personalMoves.record}, '$.name')` })
    .from(savedPostMoves)
    .leftJoin(personalMoves, and(eq(personalMoves.id, savedPostMoves.moveId), eq(personalMoves.userId, userId)))
    .where(and(eq(savedPostMoves.userId, userId), eq(savedPostMoves.postId, postId)));

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
  const rebuiltSteps = hasOwnReading ? [] : rebuiltEvents(p, links);
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

/** The steps of a post from before the trail, built from its kept columns: labelled `rebuilt`, in pipeline order. */
function rebuiltEvents(p: typeof savedPosts.$inferSelect, links: readonly { moveKind: string; status: string }[]): TrailEventDto[] {
  const base = (stage: ImportStage, status: TrailStatus, summary: string, detail: unknown): TrailEventDto => ({
    id: `rebuilt:${stage}`, stage, source: "worker", status, summary, detail, moveId: null, model: null, promptVersion: null,
    costMicros: null, latencyMs: null, attempt: null, runId: null, proposalId: null, rebuilt: true, blobs: [], at: p.updatedAt,
  });
  const out: TrailEventDto[] = [];
  if (p.filterVerdict || p.filterStage) {
    const kept = p.filterVerdict !== "not";
    out.push(base("screen", "ok", `${kept ? "Kept" : "Not training"}: ${p.filterReason ?? ""}`.replace(/: $/, ""), {
      verdict: p.filterVerdict, reason: p.filterReason, stage: p.filterStage,
    }));
  }
  const extraction = p.extraction as Extracted | null;
  if (extraction) {
    const n = extraction.moves?.length ?? 0;
    out.push(base("extract", "ok", `Read ${n} move${n === 1 ? "" : "s"}`, { kind: extraction.kind ?? null, moves: n }));
  } else if (p.status === "failed") {
    out.push(base("extract", "fail", failureWords(p.lastErrorCode ?? "unknown", p.lastError) ?? "Something went wrong", { code: p.lastErrorCode }));
  }
  // Matching, from the links it left (plan Task 11).
  const kept = links.filter((l) => l.status !== "removed");
  if (kept.length) {
    const library = kept.filter((l) => l.moveKind === "library").length;
    const yours = kept.length - library;
    const parts = [yours ? `${yours} already yours` : "", library ? `${library} from the library` : ""].filter(Boolean).join(", ");
    out.push(base("match", "ok", `${kept.length} move${kept.length === 1 ? "" : "s"}: ${parts}`, { links: kept.length }));
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
