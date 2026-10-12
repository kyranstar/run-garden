/**
 * THE ATHLETE'S SAY ON ONE MOVE (Stage 2 spec §6–§7): their rating, the pin ("keep it in my rotation" — the engine
 * prefers pinned moves) and "not for me". One hook for the detail's toggles and the Add sheet's Pin, so both show the
 * same answer and a change in one is the other's at once.
 *
 * A tap shows at once (optimistic) and writes `PUT /api/library/:id/prefs` with only what changed; the answer updates
 * the move's own read and the Studio's list (so rows, the "Pinned" filter and the ranking follow). A write that fails
 * puts the toggle back and says so — nothing is kept on this device to send later.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ExercisePrefsPatch, type LibraryItemDto, type LibraryListDto } from "@rg/api-client";
import type { MovePrefs, StudioCtx } from "./model.js";

export const libraryItemQuery = (id: string) => ["library", "item", id] as const;
const sayQuery = (id: string) => ["library", "say", id] as const;
const STUDIO_LIBRARY = ["library", "studio"] as const;

export type Say = Pick<MovePrefs, "rating" | "pinned" | "excluded">;

const NONE: Say = { rating: null, pinned: false, excluded: false };

/** The move's own read (`GET /api/library/:id`): its history and the athlete's say, fresh. */
export function useLibraryItem(id: string) {
  return useQuery({ queryKey: libraryItemQuery(id), queryFn: () => api.getLibraryItem(id), staleTime: 60_000 });
}

export function useMoveSay(id: string, ctx: StudioCtx): {
  say: Say;
  set: (patch: ExercisePrefsPatch) => void;
  error: string | null;
} {
  const qc = useQueryClient();
  const item = useLibraryItem(id);
  // What this page last saved for the move: the answer stands even when neither read is here to carry it (the list
  // and the move's own read both failed, say), and every hook on the move hears it (the detail and the Add sheet).
  const written = useQuery({ queryKey: sayQuery(id), queryFn: () => null as Say | null, enabled: false, staleTime: Infinity });
  const [pending, setPending] = useState<{ id: string; say: Say } | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const known = ctx.prefs.get(id);
  const stored: Say =
    item.data?.prefs ?? written.data ?? (known ? { rating: known.rating, pinned: known.pinned, excluded: known.excluded } : NONE);
  const say = pending?.id === id ? pending.say : stored;

  const set = (patch: ExercisePrefsPatch) => {
    const next: Say = { ...say, ...patch };
    setPending({ id, say: next });
    setError(null);
    api
      .setExercisePrefs(id, patch)
      .then(({ prefs }) => {
        const saved: Say = { rating: prefs.rating, pinned: prefs.pinned, excluded: prefs.excluded };
        qc.setQueryData<Say>(sayQuery(id), saved);
        qc.setQueryData<LibraryItemDto>(libraryItemQuery(id), (old) => (old ? { ...old, prefs } : old));
        qc.setQueryData<LibraryListDto>(STUDIO_LIBRARY, (old) =>
          old ? { ...old, items: old.items.map((r) => (r.id === id ? { ...r, ...saved } : r)) } : old,
        );
      })
      .catch(() => setError({ id, text: "Couldn't save that. Check your connection." }))
      .finally(() => setPending((p) => (p?.id === id && p.say === next ? null : p)));
  };
  return { say, set, error: error?.id === id ? error.text : null };
}
