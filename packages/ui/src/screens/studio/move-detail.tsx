/**
 * A MOVE, IN FULL (Stage 2 spec §6) — the "expandable to learn more": a row's tap opens it, as a sheet over the list
 * on a phone and as the right-hand pane from md (900px), the list still beside it. In the spec's order:
 *
 *   Goblet squat                                        ✕
 *   Hold the weight at your chest and sit down between your heels.
 *   Strength · Isotonic · Posture · Kettlebell or Dumbbells · Difficulty 2 of 5
 *   2 × 7 · ✓ Fits today
 *   HOW              setup (bullets), then the steps (numbered)
 *   FOCUS · COMMON MISTAKES · BREATHING · WHY
 *   TMJ              the move's note for each switched-on profile, in its own plain words
 *   MUSCLES          the primary ones, then "Also" the secondary
 *   EASIER AND HARDER  each a link to that move
 *   FROM YOUR SAVES  one of the athlete's own moves (saved-posts import): each post it came from — its creator, and a
 *                    link that opens the post in a new tab, and under them the post's note on the move (what it is
 *                    for, or when to do it); the meta line starts "Yours"
 *   YOUR HISTORY     last done · times in 30 days · best set or hold; 👍 👎 · Pin · Not for me
 *   ──────────────────────────────────────────────────────
 *   [ Add ]  [ Ask ]       (Ask: the app's coach sheet, about this move — coach everywhere, A3)
 *
 * Everything but the history and the athlete's say is the account's library on the device (the bundle, and the
 * athlete's own moves once their read has answered: `useAccountLibrary`), so the detail opens at once and offline; the
 * move's own read (`GET /api/library/:id`) adds the best set and the freshest say when it answers. Terms explain
 * themselves one tap down (the glossary), as on a row. A section with nothing to say is not drawn. An archived move of
 * the athlete's own — kept for the workouts and history that hold it, never offered — still opens from its address,
 * marked so, with no Add and no say (the server takes neither for it).
 *
 * A creator's name and a link's note are a model's reading of a post: drawn as text, never as markup, and never as an
 * address. A post's address is a link only when it is a web page's (http or https).
 *
 * Focus: the sheet takes it on open and hands it back on close (`Sheet`); the pane moves it to its heading on open,
 * and when an Easier or Harder link swaps the move in place, both put it on the new move's heading (the sheet: on the
 * dialog) and scroll back to its top.
 */
import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { Link } from "react-router-dom";
import type { ExerciseRecord } from "@rg/exercise-library";
import { formatWeightIn, secondsText, type WeightUnit } from "@rg/domain";
import type { LibraryItemDto, PersonalMoveDto } from "@rg/api-client";
import { PUBLIC_LIBRARY, useAccountLibrary } from "../../library/account-library.js";
import { Sheet, useEscapeKey, useIsomorphicLayoutEffect } from "../../components.js";
import { IconCheck, IconClose, IconPin } from "../../icons.js";
import { checkWord } from "../../components/condition-check-sheet.js";
import { useWeightUnit } from "../../use-units.js";
import { FitBadge, Term, dotted, gearLine } from "./move-row.js";
import { doseLine, fitOf, historyLine, type StudioCtx } from "./model.js";
import { useLibraryItem, useMoveSay, type Say } from "./prefs.js";
import { AskCoach, useCoachSeeing } from "./coach-ask.js";
import { moveFocus } from "./coach-focus.js";

/** Where a link to another move goes: its address, and the history state the screen keeps (`screen.tsx`). */
export interface MoveLink {
  to: string;
  state?: unknown;
}

/** The moves a ladder names that the library has, in its order. */
const ladder = (ids: readonly string[], find: (id: string) => ExerciseRecord | undefined): ExerciseRecord[] =>
  ids.map((id) => find(id)).filter((r): r is ExerciseRecord => !!r);

/** A saved post's address as a link: a web page's only (never `javascript:` or the like); null otherwise. */
export function postHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * The posts one of the athlete's own moves came from: each its creator (as text) and a link that opens it, and under
 * them the post's note on the move (as text).
 */
function SavedFrom({ links }: { links: PersonalMoveDto["links"] }) {
  const shown = links
    .map((l) => ({ creator: l.creator?.trim() || null, href: postHref(l.url), note: l.note?.trim() || null }))
    .filter((l) => l.creator || l.href || l.note);
  if (shown.length === 0) return null;
  return (
    <ul className="stu-saved">
      {shown.map((l, i) => (
        <li key={`${i}-${l.href ?? ""}`}>
          {l.creator ? <span className="stu-saved-by">{l.creator}</span> : null}
          {l.href ? (
            <a className="stu-saved-link" href={l.href} target="_blank" rel="noopener noreferrer">
              Open post
              {l.creator ? <span className="visually-hidden">{` by ${l.creator}`}</span> : null}
            </a>
          ) : null}
          {l.note ? <p className="stu-saved-note">{l.note}</p> : null}
        </li>
      ))}
    </ul>
  );
}

/** "Best: 12 kg × 8", "Best hold: 45 s", "Best: 10 reps" — in the athlete's weight unit; null with no best yet. */
export function bestLine(best: LibraryItemDto["history"]["best"] | null | undefined, unit: WeightUnit): string | null {
  if (!best) return null;
  if (best.secs) return `Best hold: ${secondsText(best.secs)}`;
  if (best.w && best.reps) return `Best: ${formatWeightIn(best.w, unit)} × ${best.reps}`;
  if (best.w) return `Best: ${formatWeightIn(best.w, unit)}`;
  if (best.reps) return `Best: ${best.reps} reps`;
  return null;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="stu-detail-sec" aria-labelledby={id}>
      <h3 id={id} className="eyebrow">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Terms joined by commas, each one explaining itself. */
function TermList({ ids }: { ids: readonly string[] }) {
  return (
    <span className="stu-meta-g">
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 ? ", " : null}
          <Term id={id} />
        </span>
      ))}
    </span>
  );
}

const Lines = ({ items, ordered = false }: { items: readonly string[]; ordered?: boolean }) => {
  const List = ordered ? "ol" : "ul";
  return (
    <List className="stu-detail-list">
      {items.map((x, i) => (
        <li key={`${i}-${x}`}>{x}</li>
      ))}
    </List>
  );
};

export interface MoveDetailBodyProps {
  rec: ExerciseRecord;
  ctx: StudioCtx;
  today: string;
  /** The athlete's say now (rating, pin, not for me). */
  say: Say;
  onSay: (patch: Partial<Say>) => void;
  /** Why the last change to the say did not save, if it did not. */
  sayError?: string | null;
  /** The move's own read: its best set. Absent until it answers (or offline). */
  best?: LibraryItemDto["history"]["best"] | null;
  weightUnit: WeightUnit;
  /** The address of another move (Easier, Harder). */
  moveLink: (id: string) => MoveLink;
  /** The account's library on the device: what a ladder's moves resolve in. The bundled library when absent. */
  find?: (id: string) => ExerciseRecord | undefined;
  /** One of the athlete's own moves: its status and the posts it came from. */
  own?: PersonalMoveDto | null;
}

/** Everything under the name, in the spec's order. */
export function MoveDetailBody({ rec, ctx, today, say, onSay, sayError, best, weightUnit, moveLink, find = PUBLIC_LIBRARY.find, own = null }: MoveDetailBodyProps) {
  const t = rec.text;
  const fit = fitOf(rec, ctx);
  const gear = gearLine(rec);
  const notes = ctx.profiles.map((p) => ({ p, note: t.conditions[p.id] })).filter((x): x is { p: (typeof x)["p"]; note: string } => !!x.note);
  const easier = ladder(rec.easier, find);
  const harder = ladder(rec.harder, find);
  const archived = own?.status === "archived";
  const prefs = ctx.prefs.get(rec.id);
  // The history in words; the athlete's own marks are the toggles below, not words.
  const history = historyLine(prefs ? { ...prefs, pinned: false, excluded: false } : null, today);
  const bestText = bestLine(best, weightUnit);
  return (
    <div className="stu-detail-content">
      <p className="stu-detail-sum">{t.summary}</p>
      <p className="stu-meta stu-detail-meta">
        {dotted([
          own ? <span className="pill pill-neutral">Yours</span> : null,
          archived ? <span>Archived</span> : null,
          rec.purposes.length ? <TermList ids={rec.purposes} /> : null,
          rec.contraction.length ? <TermList ids={rec.contraction} /> : null,
          rec.tags.length ? <TermList ids={rec.tags} /> : null,
          gear ? <span>{gear}</span> : null,
          <span>{`Difficulty ${rec.difficulty} of 5`}</span>,
        ])}
      </p>
      <p className="stu-meta stu-meta--dose stu-detail-dose">
        {dotted([<span key="dose">{doseLine(rec)}</span>, fit ? <FitBadge fit={fit} /> : null])}
      </p>

      {t.setup.length || t.steps.length ? (
        <Section title="How">
          {t.setup.length ? <Lines items={t.setup} /> : null}
          {t.steps.length ? <Lines items={t.steps} ordered /> : null}
        </Section>
      ) : null}
      {t.focus.length ? (
        <Section title="Focus">
          <Lines items={t.focus} />
        </Section>
      ) : null}
      {t.mistakes.length ? (
        <Section title="Common mistakes">
          <Lines items={t.mistakes} />
        </Section>
      ) : null}
      {t.breathing ? (
        <Section title="Breathing">
          <p>{t.breathing}</p>
        </Section>
      ) : null}
      {t.why ? (
        <Section title="Why">
          <p>{t.why}</p>
        </Section>
      ) : null}
      {notes.map(({ p, note }) => (
        <Section key={p.id} title={checkWord(p.check.label)}>
          <p className="stu-detail-note">{note}</p>
        </Section>
      ))}
      <Section title="Muscles">
        <p className="stu-meta stu-detail-muscles">
          <TermList ids={rec.muscles.primary} />
        </p>
        {rec.muscles.secondary.length ? (
          <p className="stu-meta stu-detail-muscles">
            <span>Also</span>
            <TermList ids={rec.muscles.secondary} />
          </p>
        ) : null}
      </Section>
      {easier.length || harder.length ? (
        <Section title="Easier and harder">
          <ul className="stu-ladder">
            {[...easier.map((r) => ["Easier", r] as const), ...harder.map((r) => ["Harder", r] as const)].map(([way, r]) => {
              const link = moveLink(r.id);
              return (
                <li key={`${way}-${r.id}`}>
                  <span className="stu-ladder-way">{way}</span>
                  <Link to={link.to} state={link.state} className="stu-ladder-link">
                    {r.name}
                  </Link>
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}
      {own && own.links.length ? (
        <Section title="From your saves">
          <SavedFrom links={own.links} />
        </Section>
      ) : null}
      <Section title="Your history">
        <p className="stu-detail-history">{[...history, ...(bestText ? [bestText] : [])].join(" · ") || "Not done yet."}</p>
        {archived ? null : (
          <div className="btn-row stu-say" role="group" aria-label={`Your say on ${rec.name}`}>
            <button
              type="button"
              className="chipbtn"
              aria-pressed={say.rating === 1}
              aria-label="More like this"
              onClick={() => onSay({ rating: say.rating === 1 ? null : 1 })}
            >
              {say.rating === 1 ? <IconCheck /> : null}
              <span aria-hidden="true">👍</span>
            </button>
            <button
              type="button"
              className="chipbtn"
              aria-pressed={say.rating === -1}
              aria-label="Less like this"
              onClick={() => onSay({ rating: say.rating === -1 ? null : -1 })}
            >
              {say.rating === -1 ? <IconCheck /> : null}
              <span aria-hidden="true">👎</span>
            </button>
            <button type="button" className="chipbtn" aria-pressed={say.pinned} onClick={() => onSay({ pinned: !say.pinned })}>
              {say.pinned ? <IconCheck /> : <IconPin />}
              Pin
            </button>
            <button type="button" className="chipbtn" aria-pressed={say.excluded} onClick={() => onSay({ excluded: !say.excluded })}>
              {say.excluded ? <IconCheck /> : null}
              Not for me
            </button>
          </div>
        )}
        {sayError ? (
          <p className="stu-detail-error" role="alert">
            {sayError}
          </p>
        ) : null}
      </Section>
    </div>
  );
}

export interface MoveDetailProps {
  rec: ExerciseRecord;
  ctx: StudioCtx;
  today: string;
  /** From md: the right-hand pane beside the list. Below it: a sheet over the list. */
  wide: boolean;
  onClose: () => void;
  onAdd: (rec: ExerciseRecord) => void;
  moveLink: (id: string) => MoveLink;
  /** The confirmation line of an Add made from here (Open · Undo), drawn above Add. */
  added?: ReactNode;
}

/** The detail, as a sheet (phones) or the pane (from md). */
export function MoveDetail({ rec, ctx, today, wide, onClose, onAdd, moveLink, added }: MoveDetailProps) {
  const account = useAccountLibrary();
  const own = account.mine.get(rec.id) ?? null;
  // Archived: kept for what holds it, never offered — no Add.
  const addable = own?.status !== "archived";
  const item = useLibraryItem(rec.id);
  const { say, set, error } = useMoveSay(rec.id, ctx);
  const weightUnit = useWeightUnit();
  // What the coach sees while the move is open (the new shape §5): its "Seeing" hint when the nav's Coach opens it.
  useCoachSeeing(moveFocus(rec));
  const body = (
    <MoveDetailBody
      rec={rec}
      ctx={ctx}
      today={today}
      say={say}
      onSay={set}
      sayError={error}
      best={item.data?.history.best}
      weightUnit={weightUnit}
      moveLink={moveLink}
      find={account.find}
      own={own}
    />
  );
  const foot = (
    <div className="stu-detail-actions">
      {added}
      <div className="stu-detail-buttons">
        {addable ? (
          <button type="button" className="btn btn-primary stu-detail-add" onClick={() => onAdd(rec)}>
            Add
          </button>
        ) : null}
        {/* A phone's sheet is modal — the nav's Coach out of reach — so it asks itself, seeing the move (the integrated
            review, I3). The pane beside the list (from md) leaves the nav in reach: the nav's Coach sees the move. */}
        {wide ? null : <AskCoach focus={moveFocus(rec)} />}
      </div>
    </div>
  );
  return wide ? (
    <DetailPane rec={rec} onClose={onClose} foot={foot}>
      {body}
    </DetailPane>
  ) : (
    <Sheet open onClose={onClose} title={rec.name} footer={foot}>
      <InSheet id={rec.id}>{body}</InSheet>
    </Sheet>
  );
}

/** In the sheet, a move swapped in place (Easier, Harder) starts at its top, with focus on the dialog that names it. */
function InSheet({ id, children }: { id: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const dialog = ref.current?.closest<HTMLElement>('[role="dialog"]');
    ref.current?.closest(".sheet-body")?.scrollTo?.({ top: 0 });
    dialog?.focus();
  }, [id]);
  return <div ref={ref}>{children}</div>;
}

/**
 * Publishes where the pane starts on the screen as `--pane-top`, so it is never taller than the room below that and
 * its Add is in view at once — at rest it starts under the title and the search, and once the page scrolls it sticks
 * at the gutter (the stylesheet takes the larger of the two). Measured on open and on every scroll and resize, once a
 * frame.
 */
export function usePaneTop(ref: RefObject<HTMLElement | null>): void {
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      el.style.setProperty("--pane-top", `${Math.max(0, Math.round(el.getBoundingClientRect().top))}px`);
    };
    const ask = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", ask, { passive: true });
    window.addEventListener("resize", ask);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", ask);
      window.removeEventListener("resize", ask);
    };
  }, [ref]);
}

/** The right-hand pane (from md): not modal — the list stays usable beside it — but Escape closes it. */
function DetailPane({ rec, onClose, foot, children }: { rec: ExerciseRecord; onClose: () => void; foot: ReactNode; children: ReactNode }) {
  const id = useId();
  const pane = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEscapeKey(true, onClose);
  usePaneTop(pane);
  // Open, or a new move in place: focus its name, from the top.
  useEffect(() => {
    body.current?.scrollTo?.({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, [rec.id]);
  return (
    <aside ref={pane} className="stu-detail" aria-labelledby={id}>
      <div className="row-between stu-detail-head">
        <h2 id={id} ref={heading} tabIndex={-1}>
          {rec.name}
        </h2>
        <button type="button" className="btn sheet-close" onClick={onClose} aria-label="Close">
          <IconClose size={16} />
        </button>
      </div>
      <div ref={body} className="stu-detail-body scroller">
        {children}
      </div>
      <div className="stu-detail-foot">{foot}</div>
    </aside>
  );
}
