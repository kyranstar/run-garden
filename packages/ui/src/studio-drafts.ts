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
import { newId, workoutDocSchema, type WorkoutDoc } from "@rg/domain";
import { startEditing, type DraftDoc } from "@rg/workout";
import { offlineDb, type OfflineDb } from "./offline/idb.js";

/** The one key the current draft is stored under. */
export const DRAFT_KEY = "current";

/** A create from the draft: a planned workout (Start now, Schedule) or a template (Save as template). */
export type CreateKind = "workout" | "template";
export type CreateKeys = Partial<Record<CreateKind, string>>;

export interface StudioDraft {
  doc: DraftDoc;
  /** Epoch ms of the last change. */
  updatedAt: number;
  /**
   * The key (`clientId`) of each create from this draft that has not landed, kept with the draft on the device: a
   * retry whose answer was lost — after a reload too — names the same workout or template, and the server answers that
   * one, never a second. Edits keep them; the create landing, or the draft going, drops them.
   */
  keys?: CreateKeys;
}

/** What the server takes as a `clientId`. */
const KEY_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/** The stored record's keys that still read as keys; undefined when none do. */
function keysOf(raw: unknown): CreateKeys | undefined {
  const k: unknown = raw && typeof raw === "object" ? (raw as { keys?: unknown }).keys : undefined;
  if (!k || typeof k !== "object") return undefined;
  const out: CreateKeys = {};
  for (const kind of ["workout", "template"] as const) {
    const v = (k as Record<string, unknown>)[kind];
    if (typeof v === "string" && KEY_SHAPE.test(v)) out[kind] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A draft with its keys set to `keys` (none: the field goes). */
function withKeys<T extends object>(draft: T, keys: CreateKeys | undefined): T & { keys?: CreateKeys } {
  const { keys: _gone, ...rest } = draft as T & { keys?: unknown };
  return (keys && Object.keys(keys).length > 0 ? { ...rest, keys } : rest) as T & { keys?: CreateKeys };
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
  return withKeys({ doc: startEditing(kept).doc, updatedAt: typeof updatedAt === "number" ? updatedAt : 0 }, keysOf(raw));
}

export interface DraftStore {
  load(): Promise<StudioDraft | null>;
  /** Saves the draft's document; its create keys stay. */
  save(doc: DraftDoc, now?: number): Promise<StudioDraft>;
  clear(): Promise<void>;
  /** The draft's key for a create of `kind`, made and kept with it on first asking; null when there is no draft. */
  createKey(kind: CreateKind): Promise<string | null>;
  /** That create landed: its key goes, so the next create from the draft is another. */
  createLanded(kind: CreateKind): Promise<void>;
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
      // Read and written in one transaction: a key asked for meanwhile is never written over.
      const next = (current: unknown): StudioDraft => withKeys({ doc, updatedAt: now }, keysOf(current));
      const d = await db();
      if (!d) return (memory = next(memory));
      return (await d.update<StudioDraft>("drafts", DRAFT_KEY, next)) ?? next(undefined);
    },
    async clear() {
      const d = await db();
      if (d) await d.delete("drafts", DRAFT_KEY);
      else memory = null;
    },
    async createKey(kind) {
      const fresh = newId();
      let key: string | null = null;
      const keep = <T>(current: T | undefined): T | undefined => {
        if (!readDraft(current)) return current;
        const keys = keysOf(current) ?? {};
        key = keys[kind] ?? fresh;
        return withKeys(current as T & object, { ...keys, [kind]: key }) as T;
      };
      const d = await db();
      if (!d) memory = keep(memory ?? undefined) ?? null;
      else await d.update<StudioDraft>("drafts", DRAFT_KEY, keep);
      return key;
    },
    async createLanded(kind) {
      const drop = <T>(current: T | undefined): T | undefined => {
        const keys = keysOf(current);
        if (!keys?.[kind]) return current;
        const { [kind]: _landed, ...rest } = keys;
        return withKeys(current as T & object, rest) as T;
      };
      const d = await db();
      if (!d) memory = drop(memory ?? undefined) ?? null;
      else await d.update<StudioDraft>("drafts", DRAFT_KEY, drop);
    },
  };
}

export const STUDIO_DRAFT_QUERY = ["studio-draft"] as const;

const deviceDrafts = draftStore();

/**
 * The current draft, shared by every screen that shows it (the Add sheet, the builder): `draft` is null when there is
 * none (or before it has been read — `loaded` says which); `save` and `clear` write through to the device and the
 * shared cache. `load` reads the device itself: a write that depends on what the draft was (Add's Undo) reads it at the
 * moment of writing, never from what a render last saw.
 */
export function useStudioDraft(store: DraftStore = deviceDrafts): {
  draft: StudioDraft | null;
  loaded: boolean;
  save: (doc: DraftDoc) => Promise<StudioDraft>;
  clear: () => Promise<void>;
  load: () => Promise<StudioDraft | null>;
  createKey: DraftStore["createKey"];
  createLanded: DraftStore["createLanded"];
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
  const load = useCallback(() => store.load(), [store]);
  // A create's key is the device's alone (nothing shows it): the shared cache is left as it is.
  const createKey = useCallback((kind: CreateKind) => store.createKey(kind), [store]);
  const createLanded = useCallback((kind: CreateKind) => store.createLanded(kind), [store]);
  // Read, whatever the answer (a read that failed is no draft): the choices it decides can now be offered.
  return { draft: q.data ?? null, loaded: q.isSuccess || q.isError, save, clear, load, createKey, createLanded };
}
