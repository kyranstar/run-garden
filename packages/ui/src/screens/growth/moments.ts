/**
 * The objectives' garden moments on Today's arrival block (the new shape §7): a best ever on a key result, a finished
 * objective (moment-words.ts `objectiveMoments`), read from the objectives board — the same read and cache as Growth's
 * quests. The board is the coach's: with the coach off it is never read and there are none. The athlete's zone dates a
 * completion.
 *
 * `useArrivalShown` is Today's one call: the arrival plan the block shows — the garden's own plan, with the moments in
 * its lines. The garden's plan without them keeps driving the glow, the impulses and the mark-seen post, so a board
 * read landing after the garden's never replays them; and a board read that fails or comes back malformed only means
 * no moments — never a broken Today.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type GardenSeenState } from "@rg/api-client";
import { coachOn } from "../../features.js";
import { selectArrival, type ArrivalEvent, type ArrivalMoment, type ArrivalPlan } from "../arrival.js";
import { OBJECTIVE_BOARD_QUERY } from "../studio/objectives.js";
import { objectiveMoments } from "./moment-words.js";

const NONE: ArrivalMoment[] = [];

export function useObjectiveMoments(): readonly ArrivalMoment[] {
  const board = useQuery({ queryKey: OBJECTIVE_BOARD_QUERY, queryFn: api.objectiveBoard, enabled: coachOn(), staleTime: 60_000 });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  const tz = settings.data?.prefs?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return useMemo(() => {
    if (!board.data) return NONE;
    try {
      return objectiveMoments(board.data, tz);
    } catch {
      return NONE;
    }
  }, [board.data, tz]);
}

/** What the garden's read gives the arrival plan. */
interface GardenRead {
  events?: unknown;
  seen?: GardenSeenState | null;
  snapshot?: unknown;
}

/** The plan Today's arrival block shows: `plan`, with the objectives' moments in its lines. */
export function useArrivalShown(plan: ArrivalPlan | null, garden: GardenRead | undefined, today: string | undefined): ArrivalPlan | null {
  const moments = useObjectiveMoments();
  return useMemo(() => {
    if (!plan || !garden || moments.length === 0) return plan;
    const live = today ?? (garden.snapshot as { state?: { lastSimulatedDate?: string } } | undefined)?.state?.lastSimulatedDate;
    if (!live) return plan;
    return selectArrival((garden.events as ArrivalEvent[] | undefined) ?? [], garden.seen ?? null, live, moments);
  }, [plan, garden, today, moments]);
}
