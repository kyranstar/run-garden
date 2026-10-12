/**
 * THE STUDIO (Stage 2 spec §2–§5): one place to see every move, understand it quickly, and turn moves into workouts.
 *
 *   Studio
 *   [⌕ Search moves, muscles, tags        ] [Filters]
 *   the home (quick starts · browse · themes · tags)  — or, once there is a query or a filter, the moves
 *
 * The URL is the state (`model.ts`): typing, a browse tap or a chip changes the search, so Back leaves the results and
 * a list can be returned to. The first step from the home into a list is a new history entry; every refinement after
 * it replaces that entry, so Back never walks through keystrokes.
 *
 * Instant and offline by construction: the library is in the bundle and `studioResults` is a pure function over it.
 * The three reads (`GET /api/library` for the athlete's pins, ratings and history; today's readings; the default
 * place's gear) only add knowledge — before they answer, or with no network, the list is the same list knowing less.
 * Typing defers the list's render (`useDeferredValue`) so the field never waits on 150 rows.
 *
 * Widths: one column below lg, the filters in a sheet. From lg (wide treatment) the list gets the filters as a column
 * beside it — the same `FilterControls` — and the Filters button steps aside. Task 5 adds the move's detail as the
 * right-hand pane.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import type { QuickStartKind } from "@rg/workout";
import { localTodayGuess } from "../../components.js";
import { SearchField } from "../../components/search-field.js";
import { IconFilters } from "../../icons.js";
import { FilterControls, FiltersSheet } from "./filters-sheet.js";
import { StudioHome } from "./home.js";
import { readStudio, setFilterCount, studioCtxFrom, studioResults, studioSearch, type StudioCtx, type StudioFilters } from "./model.js";
import { StudioResults } from "./search.js";

/** The athlete's side of the Studio: profiles and today's readings, their say on each move, the place's gear. */
export function useStudioCtx(): StudioCtx {
  const library = useQuery({ queryKey: ["library", "studio"], queryFn: () => api.listLibrary({ limit: 200 }), staleTime: 60_000 });
  const today = useQuery({ queryKey: ["today"], queryFn: api.today });
  const places = useQuery({ queryKey: ["places"], queryFn: api.listPlaces, staleTime: 60_000 });
  return useMemo(() => studioCtxFrom(library.data, today.data, places.data), [library.data, today.data, places.data]);
}

export interface StudioScreenProps {
  /** A row's ＋ (Task 5: the Add sheet). Absent, rows draw no Add button. */
  onAdd?: (rec: ExerciseRecord) => void;
  /** A row's name (Task 5: the detail). Absent, the name is plain text. */
  onOpen?: (rec: ExerciseRecord) => void;
  /** A quick start card (Task 7: the builder, pre-filled). Absent, the cards are not buttons. */
  onQuickStart?: (kind: QuickStartKind) => void;
}

export function StudioScreen({ onAdd, onOpen, onQuickStart }: StudioScreenProps = {}) {
  const [params, setParams] = useSearchParams();
  const search = params.toString();
  const state = useMemo(() => readStudio(new URLSearchParams(search)), [search]);
  const ctx = useStudioCtx();
  const [sheetOpen, setSheetOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const arrived = useRef(false);

  const q = useDeferredValue(state.q);
  const results = useMemo(
    () => (state.listing ? studioResults(EXERCISES, q, state.filters, ctx) : []),
    [state.listing, q, state.filters, ctx],
  );
  // What the sheet's primary action promises, at once (not deferred): the filters as they stand.
  const sheetCount = useMemo(
    () => (sheetOpen ? studioResults(EXERCISES, state.q, state.filters, ctx).length : 0),
    [sheetOpen, state.q, state.filters, ctx],
  );

  /** Go to a state: a new entry when it opens the list from the home, the same entry otherwise. */
  const go = useCallback(
    (q: string, filters: StudioFilters, all: boolean) => {
      const next = studioSearch(q, filters, all);
      const opening = !state.listing && next !== "";
      setParams(new URLSearchParams(next), { replace: !opening });
    },
    [setParams, state.listing],
  );

  const browse = (f: StudioFilters | "all") => {
    arrived.current = true;
    go("", f === "all" ? {} : f, f === "all");
  };
  const clear = () => {
    setSheetOpen(false);
    setParams(new URLSearchParams(), { replace: true });
  };

  // A browse tap swaps the home for the list under the reader's finger: bring the list's top into view and hand focus
  // to its heading, so neither the eye nor a screen reader is left where the tapped chip used to be.
  useEffect(() => {
    if (!state.listing || !arrived.current) return;
    arrived.current = false;
    heading.current?.focus({ preventScroll: true });
    const top = root.current?.getBoundingClientRect().top ?? 0;
    if (top < 0) root.current?.scrollIntoView?.({ block: "start" });
  }, [state.listing]);

  const set = setFilterCount(state.filters, ctx);
  const today = ctx.today ?? localTodayGuess();
  return (
    <div ref={root} className={`stu${state.listing ? " stu--results" : ""}`}>
      <h1>Studio</h1>
      <div className="stu-bar">
        <SearchField
          value={state.q}
          onChange={(v) => go(v, state.filters, state.all)}
          label="Search moves"
          placeholder="Search moves, muscles, tags"
        />
        <button type="button" className="btn stu-filters-btn" aria-haspopup="dialog" onClick={() => setSheetOpen(true)}>
          <IconFilters />
          Filters
          {set > 0 ? (
            <span className="stu-badge">
              <span className="visually-hidden">: </span>
              {set}
              <span className="visually-hidden"> set</span>
            </span>
          ) : null}
        </button>
      </div>

      {state.listing ? (
        <div className="stu-results">
          <aside className="stu-facets scroller" aria-label="Filters">
            <FilterControls filters={state.filters} ctx={ctx} level={2} onChange={(f) => go(state.q, f, state.all)} />
          </aside>
          <StudioResults
            q={state.q}
            filters={state.filters}
            ctx={ctx}
            records={EXERCISES}
            results={results}
            today={today}
            headingRef={heading}
            onFilters={(f) => go(state.q, f, state.all)}
            onClear={clear}
            onAdd={onAdd}
            onOpen={onOpen}
          />
        </div>
      ) : (
        <StudioHome ctx={ctx} onBrowse={browse} onQuickStart={onQuickStart} />
      )}

      <FiltersSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        filters={state.filters}
        ctx={ctx}
        count={sheetCount}
        onChange={(f) => go(state.q, f, state.all)}
        onClear={clear}
        onShow={() => {
          setSheetOpen(false);
          if (!state.listing) {
            arrived.current = true;
            go(state.q, state.filters, true);
          }
        }}
      />
    </div>
  );
}
