/**
 * TODAY'S "NEEDS YOU" CHIP (where you stand, spec 2026-11-05 §7.2, §13.5). When the coach's read sees drift — a
 * discipline slipping, sessions not logged, a key result behind — Today shows that one chip, worded as an observation and
 * a question ("1 of 4 planned lifts logged in 3 weeks — talk it through?"). A tap opens the coach with its words and its
 * id, and the run it starts diagnoses with the athlete first. Proactive means this chip, never a push: nothing starts
 * without the tap.
 *
 * The read is the coach opening's own (`GET /api/coach/nudges`, the same rules), kept under NUDGES_QUERY so a turn sent
 * anywhere reads it again. Nothing without the coach's sheet in the app, without a drift chip, or when the read fails.
 * The label is the app's words with a key result's name in it (the athlete's): drawn as text.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import { useCoach } from "../screens/studio/coach-ask.js";
import { NUDGES_QUERY } from "../screens/studio/coach-conversation-model.js";
import { isDriftNudge } from "../screens/studio/coach-focus.js";

/** The region's name. */
export const NEEDS_YOU_LABEL = "Needs you";

export function NeedsYouToday() {
  const coach = useCoach();
  const read = useQuery({
    queryKey: [...NUDGES_QUERY, "today"],
    queryFn: () => api.coachNudges(),
    enabled: coach !== null,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const drift = (read.data?.nudges ?? []).find((n) => isDriftNudge(n.id));
  if (!coach || !drift) return null;
  return (
    <section className="needs-you-today" aria-label={NEEDS_YOU_LABEL}>
      <button type="button" className="chip coach-chip coach-chip--needs" onClick={() => coach.open({ ask: { request: drift.request, nudge: drift.id }, seeing: null })}>
        {drift.label}
      </button>
    </section>
  );
}
