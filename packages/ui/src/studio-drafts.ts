/**
 * THE WORKOUT BEING BUILT (Stage 2 spec §7, §12): one draft at a time, kept on this device in the offline database's
 * `drafts` store (`offline/idb.ts`), so "To the workout I'm building" and the builder work with no network and the
 * draft outlives the page. Signing out forgets it, with the rest of the offline identity (`forgetOfflineIdentity`).
 *
 * The draft is a `DraftDoc`: its parts may be empty (a new workout starts with empty warm-up, main and cool-down).
 * What is stored is checked on the way out — a draft an older build wrote, or a broken one, reads as none — and the
 * only way to a document that saves is the editor's `toProposable`.
 *
 * With no IndexedDB (a private window, an old browser) the draft lives for the page's life only, in memory.
 */
import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { workoutDocSchema, type WorkoutDoc } from "@rg/domain";
import { startEditing, type DraftDoc } from "@rg/workout";
import { offlineDb, type OfflineDb } from "./offline/idb.js";

/** The one key the current draft is stored under. */
export const DRAFT_KEY = "current";

export interface StudioDraft {
  doc: DraftDoc;
  /** Epoch ms of the last change. */
  updatedAt: number;
}

/** Stands in for an empty part's missing items, so the schema checks everything else about the part. */
const PROBE = { kind: "rest", seconds: 1 } as const;

/** A stored draft, if it still reads as one (empty parts allowed); null otherwise. */
export function readDraft(raw: unknown): StudioDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const { doc, updatedAt } = raw as { doc?: unknown; updatedAt?: unknown };
  if (!doc || typeof doc !== "object") return null;
  const parts: unknown = (doc as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  const empty = parts.map((p) => !!p && typeof p === "object" && Array.isArray((p as { items?: unknown }).items) && (p as { items: unknown[] }).items.length === 0);
  const probe = {
    ...(doc as object),
    parts: parts.length === 0 ? [{ purpose: "main", format: "straight", items: [PROBE] }] : parts.map((p, i) => (empty[i] ? { ...(p as object), items: [PROBE] } : p)),
  };
  const parsed = workoutDocSchema.safeParse(probe);
  if (!parsed.success) return null;
  const kept: WorkoutDoc = {
    ...parsed.data,
    parts: parts.length === 0 ? [] : parsed.data.parts.map((p, i) => (empty[i] ? { ...p, items: [] } : p)),
  };
  return { doc: startEditing(kept).doc, updatedAt: typeof updatedAt === "number" ? updatedAt : 0 };
}

export interface DraftStore {
  load(): Promise<StudioDraft | null>;
  save(doc: DraftDoc, now?: number): Promise<StudioDraft>;
  clear(): Promise<void>;
}

/** The page's own copy, for a device with no IndexedDB. */
let memory: StudioDraft | null = null;

/** The draft store: the offline database, else (no IndexedDB) the page's memory. */
export function draftStore(open: () => Promise<OfflineDb> = offlineDb): DraftStore {
  const db = async (): Promise<OfflineDb | null> => open().catch(() => null);
  return {
    async load() {
      const d = await db();
      if (!d) return memory;
      return readDraft(await d.get("drafts", DRAFT_KEY).catch(() => undefined));
    },
    async save(doc, now = Date.now()) {
      const draft: StudioDraft = { doc, updatedAt: now };
      const d = await db();
      if (d) await d.put("drafts", DRAFT_KEY, draft);
      else memory = draft;
      return draft;
    },
    async clear() {
      const d = await db();
      if (d) await d.delete("drafts", DRAFT_KEY);
      else memory = null;
    },
  };
}

export const STUDIO_DRAFT_QUERY = ["studio-draft"] as const;

const deviceDrafts = draftStore();

/**
 * The current draft, shared by every screen that shows it (the Add sheet, the builder): `draft` is null when there is
 * none (or before it has been read); `save` and `clear` write through to the device and the shared cache.
 */
export function useStudioDraft(store: DraftStore = deviceDrafts): {
  draft: StudioDraft | null;
  loaded: boolean;
  save: (doc: DraftDoc) => Promise<StudioDraft>;
  clear: () => Promise<void>;
} {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: STUDIO_DRAFT_QUERY, queryFn: () => store.load(), networkMode: "always", staleTime: 0 });
  const save = useCallback(
    async (doc: DraftDoc) => {
      const saved = await store.save(doc);
      qc.setQueryData(STUDIO_DRAFT_QUERY, saved);
      return saved;
    },
    [qc, store],
  );
  const clear = useCallback(async () => {
    await store.clear();
    qc.setQueryData(STUDIO_DRAFT_QUERY, null);
  }, [qc, store]);
  return { draft: q.data ?? null, loaded: q.isSuccess, save, clear };
}
