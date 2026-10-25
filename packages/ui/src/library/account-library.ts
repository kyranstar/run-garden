/**
 * THE ACCOUNT'S LIBRARY ON THE DEVICE (saved-posts import, Task 14): the bundled library (`EXERCISES`) and the owner's
 * own moves (`GET /api/library/personal`), as the Worker reads them (apps/worker/src/services/account-library.ts):
 *
 *  - `all` — what a document's moves resolve in: the bundled library and every move the read lists, active and
 *    archived. The builder's judge and minutes, an edit, a build made on the device, a move's detail opened from its
 *    address — an old workout holding an archived move still reads, times and plays.
 *  - `offered` — what the Studio offers: search, browse, the pickers, the suggestions and quick starts. The bundled
 *    library and the active moves; an archived move never (`StudioCtx.library`).
 *
 * Made ONCE PER ANSWER: every screen asking shares the query's data object, so each view is one array however many
 * components read it, and every index made per array (`makeLibraryIndex`, the fit cache) is found again. With no moves
 * — or before the read answers, or when it fails with nothing kept — both views are `EXERCISES` itself: the Studio is
 * the bundled library, as it always was, and works offline.
 *
 * A record is taken only under a personal id (`isPersonalId`): a move of the account can never stand in for a public
 * one. A move merged into another is listed under its target (its id among the target's `legacyIds`), so it resolves
 * as the target.
 */
import { useQuery } from "@tanstack/react-query";
import { api, type PersonalMoveDto, type PersonalMovesDto } from "@rg/api-client";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { isPersonalId } from "@rg/saves";
import { makeLibraryIndex } from "@rg/workout";

export const PERSONAL_MOVES_QUERY = ["library", "personal"] as const;

export interface AccountLibrary {
  /** The bundled library and every move of the account's (active and archived): what a document's moves resolve in. */
  all: readonly ExerciseRecord[];
  /** The bundled library and the active moves: what the Studio offers. */
  offered: readonly ExerciseRecord[];
  /** `all`'s index: a move by its id or a legacy id (a merged move's id finds its target). */
  find: (id: string) => ExerciseRecord | undefined;
  /** The account's own moves by id, with their status and the posts they came from. */
  mine: ReadonlyMap<string, PersonalMoveDto>;
}

/** No moves of the account's: both views the bundled library itself. */
export const PUBLIC_LIBRARY: AccountLibrary = Object.freeze({
  all: EXERCISES,
  offered: EXERCISES,
  find: makeLibraryIndex(EXERCISES),
  mine: new Map<string, PersonalMoveDto>(),
});

const made = new WeakMap<object, AccountLibrary>();

/** A listed move that reads as one: a record under a personal id. */
const usable = (m: unknown): m is PersonalMoveDto => {
  const r = (m as PersonalMoveDto | null)?.record;
  return !!r && typeof r === "object" && typeof r.id === "string" && isPersonalId(r.id) && typeof r.name === "string";
};

/** The two views of one answer of the personal read, made once for it. */
export function accountLibraryOf(data: PersonalMovesDto | undefined): AccountLibrary {
  if (!data || typeof data !== "object") return PUBLIC_LIBRARY;
  const had = made.get(data);
  if (had) return had;
  const moves = (Array.isArray(data.moves) ? data.moves : []).filter(usable);
  let lib = PUBLIC_LIBRARY;
  if (moves.length > 0) {
    const all = [...EXERCISES, ...moves.map((m) => m.record)];
    const active = moves.filter((m) => m.status === "active").map((m) => m.record);
    lib = {
      all,
      offered: active.length > 0 ? [...EXERCISES, ...active] : EXERCISES,
      find: makeLibraryIndex(all),
      mine: new Map(moves.map((m) => [m.record.id, { ...m, links: Array.isArray(m.links) ? m.links : [] }])),
    };
  }
  made.set(data, lib);
  return lib;
}

/** The account's library as read on a page: and whether its read has answered, or (offline) given up for now. */
export type AccountLibraryRead = AccountLibrary & { settled: boolean };

/**
 * The account's library, and whether its read has answered — or, offline, given up for now (`settled`): what is built
 * once from it and kept (a quick start) waits for that. The read is the Studio's other reads' kind: kept a minute, the
 * app's few retries, never on a 401; offline the service worker answers it from the Studio's cache. Read it once for a
 * page (a screen, a sheet), never in a component an edit mounts and unmounts: a failed read is asked again by each
 * component that mounts to read it.
 */
export function useAccountLibrary(): AccountLibraryRead {
  const q = useQuery({ queryKey: PERSONAL_MOVES_QUERY, queryFn: api.listPersonalMoves, staleTime: 60_000 });
  const lib = accountLibraryOf(q.data);
  return { ...lib, settled: !q.isPending || q.fetchStatus === "paused" };
}
