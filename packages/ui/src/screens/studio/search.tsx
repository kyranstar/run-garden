/**
 * THE RESULT LIST (Stage 2 spec §4–§5): under the search field, the filters in force as removable chips — the
 * Studio's own defaults (the place's gear, today's fit) among them, so nothing is hidden without saying so — with the
 * count and Clear beside them; then the moves, four short lines each. A browse by part names that part on each row.
 *
 * An empty result is a direction, not a dead end: it offers the removals that would show the most ("Show 12 without
 * Ski"), each one tap.
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
  ctx,
  records,
  results,
  today,
  headingRef,
  onFilters,
  onClear,
  onAdd,
  onOpen,
}: {
  q: string;
  filters: StudioFilters;
  ctx: StudioCtx;
  /** The library searched (for what an empty result could loosen). */
  records: readonly ExerciseRecord[];
  results: readonly ExerciseRecord[];
  today: string;
  /** The list's heading, focused when a browse tap opens the list. */
  headingRef?: Ref<HTMLHeadingElement>;
  onFilters: (next: StudioFilters) => void;
  onClear: () => void;
  onAdd?: (rec: ExerciseRecord) => void;
  onOpen?: (rec: ExerciseRecord) => void;
}) {
  const chips = activeChips(filters, ctx);
  const word = q.trim();
  // While "Fits today" is in force every row fits or needs care, so a row says only the exception (care); with it
  // off the list mixes them, and every row says where it stands.
  const plainFits = !fitFilterOn(filters, ctx);
  return (
    <div className="stu-results-main">
      <div className="stu-chips">
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            className="chip stu-chip-x"
            aria-label={`Remove ${c.label}`}
            onClick={() => onFilters(c.without)}
          >
            {c.label}
            <IconClose />
          </button>
        ))}
        <span className="stu-tally">
          <span className="stu-count" aria-live="polite">
            {countNoun(results.length, "move")}
          </span>
          <button type="button" className="linklike stu-clear tap-pad" onClick={onClear}>
            Clear
          </button>
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
              purpose={filters.part}
              onAdd={onAdd}
              onOpen={onOpen}
            />
          ))}
        </ul>
      ) : (
        <Empty word={word} filters={filters} ctx={ctx} records={records} onFilters={onFilters} />
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
  onFilters,
}: {
  word: string;
  filters: StudioFilters;
  ctx: StudioCtx;
  records: readonly ExerciseRecord[];
  onFilters: (next: StudioFilters) => void;
}) {
  const ways = loosenings(records, word, filters, ctx);
  return (
    <div className="stu-empty">
      <p className="stu-empty-head">{word ? `No moves match “${word}”.` : "No moves match."}</p>
      {ways.length > 0 ? (
        <div className="btn-row">
          {ways.map((w) => (
            <button key={w.chip.key} type="button" className="btn btn-small" onClick={() => onFilters(w.chip.without)}>
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
