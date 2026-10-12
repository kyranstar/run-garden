/**
 * ADD A MOVE TO A PART (Stage 2 spec §8; principles §2.2 "design from the whole library"). One sheet over the builder:
 *
 *   Add to Warm-up                                            ✕
 *   [⌕ Search moves, muscles, tags                ]
 *   SUGGESTED          ← the part's own suggestions, with why
 *   Hip airplane — rehearses the hinge for Deadlift
 *   WARM-UP            ← then the part's kind of move ([Warm-up ✕] widens it to every move)
 *   Cat-cow · …
 *
 * The same search as the Studio's list (`studioResults`: the shared `searchLibrary`, the place's gear, today's fit),
 * so the two rank alike and it works offline — and the same chips: the part's kind of move and the Studio's two
 * defaults (the place's gear, "fits today"), each removable, so a move the defaults hide is one tap away, never
 * missing. A tap puts the move into this part, dosed for it (`suggestedItem`: one set in a light part), with the
 * suggestion's reason as its why; a refusal (a full part) says so and nothing changes. Moves already in the workout
 * are left out.
 */
import { useMemo, useState } from "react";
import { EXERCISES, label, type ExerciseRecord } from "@rg/exercise-library";
import type { WorkoutDoc, WorkoutPart } from "@rg/domain";
import { makeLibraryIndex, type Suggestion } from "@rg/workout";
import { Sheet } from "../../components.js";
import { SearchField } from "../../components/search-field.js";
import { IconClose } from "../../icons.js";
import { browsePurposeOf, sentence } from "./build-model.js";
import { activeChips, fitOf, FIT_WORD, studioResults, type StudioCtx, type StudioFilters } from "./model.js";

function PickRow({ rec, why, ctx, onPick }: { rec: ExerciseRecord; why?: string; ctx: StudioCtx; onPick: (rec: ExerciseRecord, why?: string) => void }) {
  const fit = fitOf(rec, ctx);
  return (
    <li>
      <button type="button" className="stu-pick" onClick={() => onPick(rec, why)}>
        <span className="stu-pick-name">{rec.name}</span>
        <span className="stu-pick-sum">{why ? sentence(why) : rec.text.summary}</span>
        {fit && fit.state !== "fits" ? <span className={`stu-swap-fit stu-fit--${fit.state}`}>{FIT_WORD[fit.state]}</span> : null}
      </button>
    </li>
  );
}

export function MovePicker({
  doc,
  part,
  suggestions,
  ctx,
  error,
  onPick,
  onClose,
  library = EXERCISES,
}: {
  doc: WorkoutDoc;
  part: WorkoutPart;
  suggestions: readonly Suggestion[];
  ctx: StudioCtx;
  /** Why the last pick was refused. */
  error: string | null;
  onPick: (rec: ExerciseRecord, why?: string) => void;
  onClose: () => void;
  library?: readonly ExerciseRecord[];
}) {
  const [q, setQ] = useState("");
  const purpose = browsePurposeOf(part.purpose);
  const [filters, setFilters] = useState<StudioFilters>(purpose ? { part: purpose } : {});
  const find = useMemo(() => makeLibraryIndex(library), [library]);
  const inDoc = useMemo(
    () => new Set(doc.parts.flatMap((p) => p.items.flatMap((i) => (i.kind === "exercise" ? [find(i.libraryId)?.id ?? i.libraryId] : [])))),
    [doc, find],
  );
  const suggested = q.trim() ? [] : suggestions.flatMap((s) => {
    const rec = find(s.libraryId);
    return rec && !inDoc.has(rec.id) ? [{ rec, why: s.reason }] : [];
  });
  const listed = useMemo(() => {
    const shown = new Set(suggested.map((s) => s.rec.id));
    return studioResults(library, q, filters, ctx).filter((r) => !inDoc.has(r.id) && !shown.has(r.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library, q, filters, ctx, inDoc, suggestions]);
  const chips = activeChips(filters, ctx);
  const title = `Add to ${label(part.purpose)}`;
  return (
    <Sheet open onClose={onClose} title={title}>
      <div className="stu-picker">
        <SearchField value={q} onChange={setQ} label="Search moves" placeholder="Search moves, muscles, tags" />
        {chips.length ? (
          <div className="stu-chips">
            {chips.map((c) => (
              <button key={c.key} type="button" className="chip stu-chip-x" aria-label={`Remove ${c.label}`} onClick={() => setFilters(c.without)}>
                {c.label}
                <IconClose />
              </button>
            ))}
          </div>
        ) : null}
        {error ? (
          <p className="stu-build-error" role="alert">
            {error}
          </p>
        ) : null}
        {suggested.length ? (
          <section className="stu-picker-sec" aria-label="Suggested">
            <h3 className="eyebrow">Suggested</h3>
            <ul className="stu-pick-list">
              {suggested.map((s) => (
                <PickRow key={s.rec.id} rec={s.rec} why={s.why} ctx={ctx} onPick={onPick} />
              ))}
            </ul>
          </section>
        ) : null}
        <section className="stu-picker-sec" aria-label="Moves">
          {suggested.length ? <h3 className="eyebrow">{filters.part ? label(filters.part) : "Moves"}</h3> : null}
          {listed.length ? (
            <ul className="stu-pick-list">
              {listed.map((r) => (
                <PickRow key={r.id} rec={r} ctx={ctx} onPick={onPick} />
              ))}
            </ul>
          ) : (
            <p className="muted">{q.trim() ? "No moves match." : "No more moves of this kind here."}</p>
          )}
        </section>
      </div>
    </Sheet>
  );
}
