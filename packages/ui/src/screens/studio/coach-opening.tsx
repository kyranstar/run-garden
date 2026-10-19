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
 *
 * IT HOLDS STILL WHILE IT IS READ (UX System 4: a read landing moves nothing under a tap; the Studio home's f030c6a).
 * What it draws is its reads' to decide — the line and the objective's chip (today, the objectives), the "needs you"
 * chips, "Also waiting" (the current run's read), the quick starts (the Studio's reads, the templates) — and any of them
 * landing late would push what is under it down, under a tap aimed at it. So nothing is drawn until they have answered
 * or failed (`settling`) — the chips' read and the current run's, a read made for this opening: never one kept from an
 * earlier one, which could show a chip asked since (review-3 I1). (Offline there is no opening: the conversation's own
 * read hasn't answered.)
 * Then it is drawn once: a read landing afterwards changes neither the line nor the chips (a tapped chip still goes at
 * once, and a session's quick review once it is saved — the athlete's own doing).
 */
import { useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type CoachAlsoOpenDto, type CoachNudgeDto } from "@rg/api-client";
import { settling, Spinner } from "../../components.js";
import { LogYourSession, type WatchReviewOffer } from "../../components/today-program.js";
import { IconCoachSmall } from "../../icons.js";
import { TEMPLATES_QUERY } from "./add-sheet.js";
import { AlsoWaiting } from "./also-waiting.js";
import { BUILD_NEW_HREF } from "./build-entry.js";
import { NUDGES_QUERY, openingLine, starterChips } from "./coach-conversation-model.js";
import type { CoachFocus } from "./coach-focus.js";
import type { StudioCtx } from "./model.js";
import { QuickStarts } from "./quick-starts.js";
import { useStudioReads } from "./screen.js";
import { TEMPLATES_HREF } from "./templates-model.js";

/** The heading over the ways to start without the coach. */
export const START_YOURSELF = "Or start something yourself";
/** What the opening says while its reads answer. */
export const OPENING_LOADING = "Loading";

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

/** What the opening drew from its reads, kept as it was drawn. */
interface Drawn {
  line: string;
  nudges: CoachNudgeDto[];
  objective: string | null;
  offer: WatchReviewOffer | null;
}

export function CoachOpening({
  ctx,
  seeing,
  alsoOpen,
  alsoKnown = true,
  busy,
  onAsk,
}: {
  ctx: StudioCtx;
  /** What the coach sees (not dropped): the chips are its own. */
  seeing: CoachFocus | null;
  /** Suggestions still open from before. */
  alsoOpen: readonly CoachAlsoOpenDto[];
  /** The read that says which (the current run's) has answered since the sheet opened. */
  alsoKnown?: boolean;
  busy: boolean;
  /** A chip tapped: its words, sent. */
  onAsk: (words: string) => void;
}) {
  const startId = useId();
  const studio = useStudioReads();
  const templates = useQuery({ queryKey: TEMPLATES_QUERY, queryFn: api.templates, staleTime: 30_000 });
  const today = useQuery({ queryKey: ["today"], queryFn: api.today });
  const objectives = useQuery({ queryKey: ["objectives"], queryFn: api.listObjectives, staleTime: 60_000, retry: false });
  // A failed read is no chips, never a line: the starters stand alone.
  const nudgeRead = useQuery({ queryKey: NUDGES_QUERY, queryFn: api.coachNudges, retry: false, staleTime: 0, refetchOnWindowFocus: false });
  const holding = studio.loading || settling(today, objectives, templates) || !nudgeRead.isFetchedAfterMount || !alsoKnown;

  // Drawn once, from the reads as they answered.
  const drawn = useRef<Drawn | null>(null);
  if (!holding && drawn.current === null) {
    drawn.current = {
      line: openingLine(today.data),
      nudges: (nudgeRead.data?.nudges ?? []).slice(0, NUDGES_SHOWN),
      objective: (objectives.data?.objectives ?? []).find((o) => o.status === "active")?.title ?? null,
      offer: today.data?.watchReviews?.[0] ?? null,
    };
  }
  /** Chips tapped here: gone at once, before any read comes back (one landing later changes nothing drawn, and the next
   * opening draws from a read of its own). */
  const [tapped, setTapped] = useState<readonly string[]>([]);

  const d = drawn.current;
  if (holding || d === null) {
    return (
      <div className="coach-opening coach-opening--holding">
        <Spinner label={OPENING_LOADING} />
      </div>
    );
  }
  const chips = starterChips(seeing, { objective: d.objective });
  const nudges = d.nudges.filter((n) => !tapped.includes(n.id));
  // The quick review goes once it is saved; one that arrives after the opening is drawn waits for the next.
  const offer = d.offer && (today.data?.watchReviews ?? []).some((o) => o.workoutId === d.offer!.workoutId) ? d.offer : null;
  return (
    <div className="coach-opening">
      <CoachSays>
        <p>{d.line}</p>
      </CoachSays>
      <div className="coach-chips" role="group" aria-label="Ways to start">
        {nudges.map((n) => (
          <button key={n.id} type="button" className="chip coach-chip coach-chip--needs" disabled={busy} onClick={() => {
              setTapped((t) => [...t, n.id]);
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
