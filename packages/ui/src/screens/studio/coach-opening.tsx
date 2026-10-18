/**
 * THE COACH'S OPENING SCREEN (the new shape §5: "Coach, opened from the nav"), for a new conversation:
 *
 *   🌱 A middling morning — steady suits today.          ← one coach line from the day's own data (no model call)
 *   [Ease me back in] [Get me ready for race day]        ← "needs you" chips, when something does (§8 §6; at most two)
 *   [Something for right now] [Plan my week] [I'm sore]  ← starter chips; with something seen, its own
 *   Also waiting · …                                     ← suggestions still open from before, when there are any
 *   OR START SOMETHING YOURSELF
 *   Jaw care 5 min · Desk reset 8 min · … · ＋ Yours     ← the Studio's quick starts
 *   Build your own · Templates · Browse moves · Log your session (a watch session to log)
 *
 * A chip is the athlete's words: one tap sends it. The box under it all is the conversation's own (coach-conversation).
 * A "needs you" chip says its `label` and sends its `request` (`GET /api/coach/nudges`: the thread coach's old signals —
 * a missed session, a return after a gap, a plan's outline week, a race or a plan's end close — read, never spent on).
 */
import { useId, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CoachAlsoOpenDto, type CoachNudgeDto } from "@rg/api-client";
import { LogYourSession } from "../../components/today-program.js";
import { IconCoachSmall } from "../../icons.js";
import { AlsoWaiting } from "./also-waiting.js";
import { BUILD_NEW_HREF } from "./build-entry.js";
import { NUDGES_QUERY, openingLine, starterChips } from "./coach-conversation-model.js";
import type { CoachFocus } from "./coach-focus.js";
import type { StudioCtx } from "./model.js";
import { QuickStarts } from "./quick-starts.js";
import { TEMPLATES_HREF } from "./templates-model.js";

/** The heading over the ways to start without the coach. */
export const START_YOURSELF = "Or start something yourself";

export { NUDGES_QUERY };
/** At most this many "needs you" chips, before the starters (the server's own cap, held here too). */
export const NUDGES_SHOWN = 2;

/** The coach's words, left, with its mark: a line of the conversation (the opening's, a turn's answer). */
export function CoachSays({ children, turn, focusable = false }: { children: ReactNode; turn?: string; focusable?: boolean }) {
  return (
    <div className="coach-msg coach-msg--coach" data-turn={turn} tabIndex={focusable ? -1 : undefined}>
      <span className="coach-msg-mark" aria-hidden="true">
        <IconCoachSmall size={16} />
      </span>
      <span className="visually-hidden">Coach: </span>
      <div className="coach-msg-body">{children}</div>
    </div>
  );
}

export function CoachOpening({
  ctx,
  seeing,
  alsoOpen,
  busy,
  onAsk,
}: {
  ctx: StudioCtx;
  /** What the coach sees (not dropped): the chips are its own. */
  seeing: CoachFocus | null;
  /** Suggestions still open from before. */
  alsoOpen: readonly CoachAlsoOpenDto[];
  busy: boolean;
  /** A chip tapped: its words, sent. */
  onAsk: (words: string) => void;
}) {
  const startId = useId();
  const today = useQuery({ queryKey: ["today"], queryFn: api.today });
  const objectives = useQuery({ queryKey: ["objectives"], queryFn: api.listObjectives, staleTime: 60_000, retry: false });
  const objective = (objectives.data?.objectives ?? []).find((o) => o.status === "active")?.title ?? null;
  const chips = starterChips(seeing, { objective });
  // A failed read is no chips, never a line: the starters stand alone.
  const qc = useQueryClient();
  const nudgeRead = useQuery({ queryKey: NUDGES_QUERY, queryFn: api.coachNudges, retry: false, staleTime: 0 });
  const nudges: CoachNudgeDto[] = (nudgeRead.data?.nudges ?? []).slice(0, NUDGES_SHOWN);
  /** A chip tapped goes at once, before any read comes back — and a read already on its way is cancelled, so its late
   * answer can't bring it back. */
  const dropNudge = (id: string) => {
    void qc.cancelQueries({ queryKey: NUDGES_QUERY });
    qc.setQueryData<{ nudges: CoachNudgeDto[] }>(NUDGES_QUERY, (cur) => (cur ? { nudges: cur.nudges.filter((x) => x.id !== id) } : cur));
  };
  const offer = today.data?.watchReviews?.[0] ?? null;
  return (
    <div className="coach-opening">
      <CoachSays>
        <p>{openingLine(today.data)}</p>
      </CoachSays>
      <div className="coach-chips" role="group" aria-label="Ways to start">
        {nudges.map((n) => (
          <button key={n.id} type="button" className="chip coach-chip coach-chip--needs" disabled={busy} onClick={() => {
              dropNudge(n.id);
              onAsk(n.request);
            }}
          >
            {n.label}
          </button>
        ))}
        {chips.map((c) => (
          <button key={c} type="button" className="chip coach-chip" disabled={busy} onClick={() => onAsk(c)}>
            {c}
          </button>
        ))}
      </div>
      {alsoOpen.length > 0 ? <AlsoWaiting items={alsoOpen} today={ctx.today} /> : null}
      <section className="coach-start" aria-labelledby={startId}>
        <h3 id={startId} className="eyebrow">
          {START_YOURSELF}
        </h3>
        <QuickStarts ctx={ctx} />
        <div className="coach-start-links">
          <Link className="linklike tap-pad" to={BUILD_NEW_HREF}>
            Build your own
          </Link>
          <Link className="linklike tap-pad" to={TEMPLATES_HREF}>
            Templates
          </Link>
          <Link className="linklike tap-pad" to="/studio">
            Browse moves
          </Link>
          {offer ? <LogYourSession offer={offer} small /> : null}
        </div>
      </section>
    </div>
  );
}
