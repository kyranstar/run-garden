/**
 * THE COACH'S OPENING SCREEN (the new shape §5: "Coach, opened from the nav"), for a new conversation:
 *
 *   🌱 Saturday's long run is in — 16 km at 5:40 /km.     ← the coach's one line: what it noticed, else the day's
 *   [Plan today around it] [Ease me back in]             ← what it noticed first, then "needs you" (at most two)
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
 * THE COACH NOTICES (stream H): the same read brings the coach's own line when it has one, free — last week's review on
 * Monday (and until the athlete asks the coach anything), else a session just finished, in figures or in the coach's
 * paid-for read of it. Its chips come first: "Log how it felt" when the app offers the session's quick review (it opens
 * the review, nothing spent), then what a tap sends ("Plan this week", "Plan tomorrow around it"), then "needs you" — two
 * at most. A line drawn here is kept on this device as shown (`markOpeningSeen`): the next opening asks for what comes
 * after it. With none, the day's own line, as before.
 *
 * IT HOLDS STILL WHILE IT IS READ (UX System 4: a read landing moves nothing under a tap; the Studio home's f030c6a).
 * What it draws is its reads' to decide, and any of them landing late would push what is under it down, under a tap
 * aimed at it. So it is drawn in two parts, top first, each once its own reads have answered or failed (`settling`):
 *  - the line and the chips, and "Also waiting" under them: today, the objectives (the objective's chip), the chips' read
 *    and the current run's — those two a read made for this opening: never one kept from an earlier one, which could
 *    show a chip asked since (review-3 I1). Nothing is drawn before them.
 *  - "Or start something yourself" — the quick starts and the links — last on the screen: the Studio's reads and the
 *    templates (a switched-on profile's care tile, a pinned template, each wrapping the row). Until then a quiet status
 *    in its place, under everything else: a slow or failing library never keeps the coach's line from the athlete.
 * (Offline there is no opening: the conversation's own read hasn't answered.) Each is drawn once: a read landing
 * afterwards changes neither the line nor the chips (a tapped chip still goes at once, and a session's quick review once
 * it is saved — the athlete's own doing).
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type CoachAlsoOpenDto, type CoachNudgeDto, type CoachOpeningDto } from "@rg/api-client";
import { formatDayLong, settling, Sheet, Spinner } from "../../components.js";
import { LogYourSession, type WatchReviewOffer } from "../../components/today-program.js";
import { WatchReviewSheet } from "../../components/watch-review-sheet.js";
import { IconCoachSmall } from "../../icons.js";
import { TEMPLATES_QUERY } from "./add-sheet.js";
import { AlsoWaiting } from "./also-waiting.js";
import { BUILD_NEW_HREF } from "./build-entry.js";
import { markOpeningSeen, NUDGES_QUERY, openingChips, openingLine, readOpeningSeen, starterChips, startersBeside } from "./coach-conversation-model.js";
import type { CoachFocus } from "./coach-focus.js";
import type { StudioCtx } from "./model.js";
import { QuickStarts } from "./quick-starts.js";
import { useStudioReads } from "./screen.js";
import { TEMPLATES_HREF } from "./templates-model.js";

/** The heading over the ways to start without the coach. */
export const START_YOURSELF = "Or start something yourself";
/** What the opening says while its reads answer. */
export const OPENING_LOADING = "Loading";
/** Under last week's review's sentence: the whole review, where reviews live. */
export const READ_THE_REVIEW = "Read it all";

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
  opening: CoachOpeningDto | null;
  nudges: CoachNudgeDto[];
  objective: string | null;
  offers: WatchReviewOffer[];
}

/** "Log how it felt": the session's quick review, opened over the page (no model, nothing spent). */
function HowItFelt({ offer, label, disabled }: { offer: WatchReviewOffer; label: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="chip coach-chip coach-chip--opening" disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open
        ? createPortal(<WatchReviewSheet workoutId={offer.workoutId} title={offer.title} onClose={() => setOpen(false)} onSaved={() => setOpen(false)} />, document.body)
        : null}
    </>
  );
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
  // The openings this device has shown, as the sheet opened: the read asks for what comes after them.
  const [seen] = useState(readOpeningSeen);
  // A failed read is no chips and no line of its own: the day's line and the starters stand alone.
  const nudgeRead = useQuery({
    queryKey: [...NUDGES_QUERY, seen.join(",")],
    queryFn: () => api.coachNudges(seen),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  // The line and the chips wait for their own reads only; the ways to start yourself, under them, for the Studio's.
  const holding = settling(today, objectives) || !nudgeRead.isFetchedAfterMount || !alsoKnown;
  const startHolding = studio.loading || settling(templates);

  // Drawn once, from the reads as they answered.
  const drawn = useRef<Drawn | null>(null);
  if (!holding && drawn.current === null) {
    drawn.current = {
      line: nudgeRead.data?.opening?.line ?? openingLine(today.data),
      opening: nudgeRead.data?.opening ?? null,
      nudges: (nudgeRead.data?.nudges ?? []).slice(0, NUDGES_SHOWN),
      objective: (objectives.data?.objectives ?? []).find((o) => o.status === "active")?.title ?? null,
      offers: today.data?.watchReviews ?? [],
    };
  }
  /** Chips tapped here: gone at once, before any read comes back (one landing later changes nothing drawn, and the next
   * opening draws from a read of its own). */
  const [tapped, setTapped] = useState<readonly string[]>([]);
  const shownId = drawn.current?.opening?.id ?? null;
  useEffect(() => {
    if (shownId) markOpeningSeen(shownId);
  }, [shownId]);

  const d = drawn.current;
  if (holding || d === null) {
    return (
      <div className="coach-opening coach-opening--holding">
        <Spinner label={OPENING_LOADING} />
      </div>
    );
  }
  // The quick reviews as drawn, less any saved since (the athlete's own doing); one offered after the draw waits for the
  // next opening.
  const live = today.data?.watchReviews ?? [];
  const offers = d.offers.filter((o) => live.some((l) => l.workoutId === o.workoutId));
  const first = openingChips(d.opening, d.nudges, offers).filter((c) => !tapped.includes(c.id));
  const starters = startersBeside(starterChips(seeing, { objective: d.objective }), d.opening);
  const feltFor = first.find((c) => c.kind === "review")?.workoutId ?? null;
  // "Log your session" below, unless the chip above already opens that same review.
  const offer = offers.find((o) => o.workoutId !== feltFor) ?? null;
  return (
    <div className="coach-opening">
      <CoachSays>
        <p>{d.line}</p>
        {d.opening?.source === "review" && d.opening.review ? <ReadTheReview review={d.opening.review} /> : null}
      </CoachSays>
      <div className="coach-chips" role="group" aria-label="Ways to start">
        {first.map((c) => {
          if (c.kind === "review") {
            const o = offers.find((x) => x.workoutId === c.workoutId)!;
            return <HowItFelt key={c.id} offer={o} label={c.label} disabled={busy} />;
          }
          return (
            <button
              key={c.id}
              type="button"
              className={`chip coach-chip ${c.needs ? "coach-chip--needs" : "coach-chip--opening"}`}
              disabled={busy}
              onClick={() => {
                setTapped((t) => [...t, c.id]);
                onAsk(c.request);
              }}
            >
              {c.label}
            </button>
          );
        })}
        {starters.map((c) => (
          <button key={c} type="button" className="chip coach-chip" disabled={busy} onClick={() => onAsk(c)}>
            {c}
          </button>
        ))}
      </div>
      {alsoOpen.length > 0 ? <AlsoWaiting items={alsoOpen} today={ctx.today} /> : null}
      {startHolding ? (
        // Last on the screen, so its waiting moves nothing under a tap: the line and the chips are above it. (Answered
        // once, `settling` never puts it back: a read again keeps what it had, a failed one counts as answered.)
        <section className="coach-start coach-start--holding" aria-label={START_YOURSELF}>
          <Spinner label={OPENING_LOADING} />
        </section>
      ) : (
        <StartYourself ctx={ctx} headingId={startId} offer={offer} />
      )}
    </div>
  );
}

/** "Or start something yourself": the quick starts and the links — drawn once the Studio's reads have answered. */
function StartYourself({ ctx, headingId, offer }: { ctx: StudioCtx; headingId: string; offer: WatchReviewOffer | null }) {
  return (
    <section className="coach-start" aria-labelledby={headingId}>
      <h3 id={headingId} className="eyebrow">
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
  );
}

/** The sheet's name, and the week it reviews. */
export const REVIEW_SHEET_TITLE = "Last week's review";

/**
 * "Read it all": last week's whole review, in a sheet of its own over the coach — from the opening read itself, never
 * the activity feed (whose latest 40 activities may hold none of that week, and where it sits behind "Full review").
 */
function ReadTheReview({ review }: { review: { weekStart: string; narrative: string } }) {
  const [open, setOpen] = useState(false);
  const paragraphs = review.narrative
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <>
      <button type="button" className="linklike tap-pad coach-opening-more" onClick={() => setOpen(true)}>
        {READ_THE_REVIEW}
      </button>
      {open
        ? createPortal(
            <Sheet open onClose={() => setOpen(false)} title={REVIEW_SHEET_TITLE}>
              <div className="coach-review">
                <p className="review-week">Week of {formatDayLong(review.weekStart)}</p>
                {paragraphs.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            </Sheet>,
            document.body,
          )
        : null}
    </>
  );
}
