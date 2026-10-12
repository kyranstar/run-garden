/**
 * THE RESULT LIST (Stage 2 spec §4–§5): under the search field, the filters in force as removable chips — the
 * Studio's own defaults (the place's gear, today's fit) among them, so nothing is hidden without saying so — with the
 * count and, when there is a filter to clear, Clear beside them; then the moves, four short lines each.
 *
 * One voice per fact: a list browsed by a part does not repeat the part on its rows, rows say "Fits today" only when
 * that filter is off (with it on, only the exceptions: "With care"), a row names its gear only when the place's gear
 * does not cover it, and an empty result says "No moves match" without a "0 moves" beside it.
 *
 * An empty result is a direction, not a dead end: it offers the removals that would show the most ("Show 12 without
 * Ski"), each one tap.
 *
 * The chips and the count follow the field at once; the rows may trail a frame behind (`useDeferredValue` upstream),
 * so they read their row-level choices from the same deferred filters as the results they show.
 */
import { type Ref } from "react";
import type { ExerciseRecord } from "@rg/exercise-library";
import { countNoun } from "../../components.js";
import { IconClose } from "../../icons.js";
import { MoveRow } from "./move-row.js";
import { activeChips, fitFilterOn, fitOf, loosenings, type Fit, type StudioCtx, type StudioFilters } from "./model.js";

export function StudioResults({
  q,
  filters,
  listFilters,
  ctx,
  records,
  results,
  today,
  canClear,
  headingRef,
  onRemove,
  onLoosen,
  onClear,
  onAdd,
  onOpen,
  openHref,
  openId = null,
}: {
  q: string;
  /** The filters in force now: the chips. */
  filters: StudioFilters;
  /** The filters `results` were found with (they may trail `filters` by a frame). */
  listFilters: StudioFilters;
  ctx: StudioCtx;
  /** The library searched (for what an empty result could loosen). */
  records: readonly ExerciseRecord[];
  results: readonly ExerciseRecord[];
  today: string;
  /** Whether Clear has a filter to clear. */
  canClear: boolean;
  /** The list's heading, where focus goes when the list opens or the control that had it goes away. */
  headingRef?: Ref<HTMLHeadingElement>;
  /** A chip's ✕: the filters without it, and where the chip was (for focus). */
  onRemove: (next: StudioFilters, index: number) => void;
  /** An empty result's "Show N without X". */
  onLoosen: (next: StudioFilters) => void;
  onClear: () => void;
  onAdd?: (rec: ExerciseRecord) => void;
  /** A row's tap: the move's detail. */
  onOpen?: (rec: ExerciseRecord) => void;
  /** The detail's address for a move (rows are links to it). */
  openHref?: (id: string) => string;
  /** The move open beside the list, if any. */
  openId?: string | null;
}) {
  const chips = activeChips(filters, ctx);
  const word = q.trim();
  // While "Fits today" is in force every row fits or needs care, so a row says only the exception (care); with it
  // off the list mixes them, and every row says where it stands.
  const plainFits = !fitFilterOn(listFilters, ctx);
  const placeGear = ctx.place?.equipment ?? null;
  return (
    <div className="stu-results-main">
      <div className="stu-chips">
        {chips.map((c, i) => (
          <button
            key={c.key}
            type="button"
            className="chip stu-chip-x"
            aria-label={`Remove ${c.label}`}
            onClick={() => onRemove(c.without, i)}
          >
            {c.label}
            <IconClose />
          </button>
        ))}
        <span className="stu-tally">
          {/* Always in the DOM so the next count is announced; empty at zero, where the empty state speaks. */}
          <span className="stu-count" aria-live="polite">
            {results.length > 0 ? countNoun(results.length, "move") : ""}
          </span>
          {canClear ? (
            <button type="button" className="linklike stu-clear tap-pad" onClick={onClear}>
              Clear
            </button>
          ) : null}
        </span>
      </div>
      <h2 className="visually-hidden" ref={headingRef} tabIndex={-1}>
        Moves
      </h2>
      {results.length > 0 ? (
        <ul className="stu-list">
          {results.map((rec) => (
            <MoveRow
              key={rec.id}
              rec={rec}
              fit={shownFit(fitOf(rec, ctx), plainFits)}
              prefs={ctx.prefs.get(rec.id)}
              today={today}
              browsedPart={listFilters.part}
              placeGear={placeGear}
              onAdd={onAdd}
              onOpen={onOpen}
              href={openHref?.(rec.id)}
              current={rec.id === openId}
            />
          ))}
        </ul>
      ) : (
        <Empty word={word} filters={filters} ctx={ctx} records={records} onLoosen={onLoosen} />
      )}
    </div>
  );
}

const shownFit = (fit: Fit | null, plainFits: boolean): Fit | null => (fit && (fit.state !== "fits" || plainFits) ? fit : null);

function Empty({
  word,
  filters,
  ctx,
  records,
  onLoosen,
}: {
  word: string;
  filters: StudioFilters;
  ctx: StudioCtx;
  records: readonly ExerciseRecord[];
  onLoosen: (next: StudioFilters) => void;
}) {
  const ways = loosenings(records, word, filters, ctx);
  return (
    <div className="stu-empty">
      <p className="stu-empty-head">{word ? `No moves match “${word}”.` : "No moves match."}</p>
      {ways.length > 0 ? (
        <div className="btn-row">
          {ways.map((w) => (
            <button key={w.chip.key} type="button" className="btn btn-small" onClick={() => onLoosen(w.chip.without)}>
              {`Show ${w.count} without ${w.chip.label}`}
            </button>
          ))}
        </div>
      ) : word ? (
        <p className="muted">Try another word.</p>
      ) : null}
    </div>
  );
}
