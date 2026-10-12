/**
 * THE STUDIO (Stage 2 spec §2–§5): one place to see every move, understand it quickly, and turn moves into workouts.
 *
 *   Studio
 *   [⌕ Search moves, muscles, tags        ] [Filters]
 *   the home (quick starts · browse · themes · tags)  — or, once there is a query or a filter, the moves
 *
 * The URL is the state (`model.ts`), so Back leaves the results and a list can be returned to:
 *  - the first step from the home into a list is a new history entry (marked `fromHome`); every refinement after it
 *    replaces that entry, and going back to the home from it goes BACK to the entry it left — so Back never shows the
 *    home twice and never walks through keystrokes;
 *  - the field's text lives here and reaches the URL after a pause (`URL_WRITE_MS`): the list follows every keystroke
 *    at once, the address catches up, and a fast typist never meets WebKit's limit on history writes (~100 in 30 s).
 *    When the URL moves under the field (Back, a link), the field follows it.
 *
 * Instant and offline by construction: the library is in the bundle and `studioResults` is a pure function over it.
 * The three reads (`GET /api/library` for the athlete's pins, ratings and history; today's readings; the default
 * place's gear) only add knowledge — before they answer, or with no network, the list is the same list knowing less.
 * The whole view is deferred (`useDeferredValue`): the field and the chips answer at once, the 150-row list a frame
 * later, and the home stays until the list is ready rather than flashing a wrong one.
 *
 * Focus never falls to <body> when the control that had it goes away: a removed chip hands it to the next chip (else
 * the list's heading), Clear to the field, a loosening or a browse tap to the list's heading.
 *
 * Widths: one column below lg, the filters in a sheet. From lg (wide treatment) the filters are a column beside the
 * list — the same `FilterControls` — placed by the grid; the list comes first in the DOM, so reading order and Tab
 * reach the moves before the facets. Task 5 adds the move's detail as the right-hand pane.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import type { QuickStartKind } from "@rg/workout";
import { localTodayGuess } from "../../components.js";
import { SearchField } from "../../components/search-field.js";
import { IconFilters } from "../../icons.js";
import { FilterControls, FiltersSheet } from "./filters-sheet.js";
import { StudioHome } from "./home.js";
import {
  clearable,
  readStudio,
  setFilterCount,
  studioCtxFrom,
  studioResults,
  studioSearch,
  type StudioCtx,
  type StudioFilters,
} from "./model.js";
import { StudioResults } from "./search.js";

/** How long the field waits before writing the query to the URL. */
export const URL_WRITE_MS = 250;

/**
 * The athlete's side of the Studio: profiles and today's readings, their say on each move, the place's gear.
 *
 * `limit: 200` is the route's cap and covers the whole library today (150 moves). Past 200 the prefs of the moves
 * beyond it would simply be missing — those rows would show no history or pin — until this asks for them by page.
 */
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

/** Where focus goes once the next render lands: the field, the list's heading, or the chip now at an index. */
type FocusTo = { to: "field" | "heading" | number; reveal?: boolean };

export function StudioScreen({ onAdd, onOpen, onQuickStart }: StudioScreenProps = {}) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const search = params.toString();
  const url = useMemo(() => readStudio(new URLSearchParams(search)), [search]);
  const ctx = useStudioCtx();
  const [sheetOpen, setSheetOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusNext = useRef<FocusTo | null>(null);

  // ── The field, and the URL it writes to ──
  const [text, setText] = useState(url.q);
  const written = useRef(url.q);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  // The URL moved under the field (Back, a link, a write that was not the field's): the field follows it.
  useEffect(() => {
    if (url.q === written.current) return;
    written.current = url.q;
    cancel();
    setText(url.q);
  }, [url.q]);

  const here = useRef({ search, state: location.state as { fromHome?: boolean } | null });
  here.current = { search, state: location.state as { fromHome?: boolean } | null };

  /** Write a state to the URL: a new entry when it opens a list from the home, back to that home when it closes. */
  const write = useCallback(
    (q: string, filters: StudioFilters, all: boolean) => {
      cancel();
      written.current = q;
      const next = studioSearch(q, filters, all);
      const { search: now, state } = here.current;
      if (now === "") {
        if (next !== "") setParams(new URLSearchParams(next), { state: { fromHome: true } });
        return;
      }
      if (next === "" && state?.fromHome) {
        navigate(-1);
        return;
      }
      setParams(new URLSearchParams(next), { replace: true, state });
    },
    [navigate, setParams],
  );

  const type = (v: string) => {
    setText(v);
    cancel();
    const { filters, all } = url;
    timer.current = setTimeout(() => {
      timer.current = null;
      write(v, filters, all);
    }, URL_WRITE_MS);
  };

  // ── What shows: the whole view deferred, so the field never waits on the list ──
  const listing = text.trim() !== "" || url.all || Object.keys(url.filters).length > 0;
  const view = useMemo(() => ({ q: text, filters: url.filters, listing }), [text, url.filters, listing]);
  const shown = useDeferredValue(view);
  const results = useMemo(
    () => (shown.listing ? studioResults(EXERCISES, shown.q, shown.filters, ctx) : []),
    [shown.listing, shown.q, shown.filters, ctx],
  );
  // What the sheet's primary action promises, at once (not deferred): the filters as they stand.
  const sheetCount = useMemo(
    () => (sheetOpen ? studioResults(EXERCISES, text, url.filters, ctx).length : 0),
    [sheetOpen, text, url.filters, ctx],
  );

  // ── Focus: never left on <body> when the control that had it goes away ──
  useEffect(() => {
    const want = focusNext.current;
    const r = root.current;
    if (!want || !r) return;
    const field = r.querySelector<HTMLInputElement>(".search-field input");
    const chip = typeof want.to === "number" ? r.querySelectorAll<HTMLElement>(".stu-chip-x")[want.to] : null;
    const target = want.to === "field" ? field : (chip ?? heading.current);
    // The list is on its way (the view is deferred): wait for the render that brings it.
    if (!target && listing) return;
    focusNext.current = null;
    (target ?? field)?.focus({ preventScroll: true });
    if (want.reveal && (r.getBoundingClientRect().top ?? 0) < 0) r.scrollIntoView?.({ block: "start" });
  });

  const browse = (f: StudioFilters | "all") => {
    focusNext.current = { to: "heading", reveal: true };
    write("", f === "all" ? {} : f, f === "all");
  };
  const setFilters = (f: StudioFilters) => write(text, f, url.all);

  const set = setFilterCount(url.filters, ctx);
  const today = ctx.today ?? localTodayGuess();
  return (
    <div ref={root} className={`stu${shown.listing ? " stu--results" : ""}`}>
      <h1>Studio</h1>
      <div className="stu-bar">
        <SearchField value={text} onChange={type} label="Search moves" placeholder="Search moves, muscles, tags" />
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

      {shown.listing ? (
        <div className="stu-results">
          <StudioResults
            q={text}
            filters={url.filters}
            listFilters={shown.filters}
            ctx={ctx}
            records={EXERCISES}
            results={results}
            today={today}
            canClear={clearable(url.filters, url.all)}
            headingRef={heading}
            onRemove={(f, i) => {
              focusNext.current = { to: i };
              setFilters(f);
            }}
            onLoosen={(f) => {
              focusNext.current = { to: "heading" };
              setFilters(f);
            }}
            onClear={() => {
              focusNext.current = { to: "field" };
              write(text, {}, false);
            }}
            onAdd={onAdd}
            onOpen={onOpen}
          />
          <aside className="stu-facets scroller" aria-label="Filters">
            <FilterControls filters={url.filters} ctx={ctx} level={2} onChange={setFilters} />
          </aside>
        </div>
      ) : (
        <StudioHome ctx={ctx} onBrowse={browse} onQuickStart={onQuickStart} />
      )}

      <FiltersSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        filters={url.filters}
        ctx={ctx}
        count={sheetCount}
        onChange={setFilters}
        onClear={() => setFilters({})}
        onShow={() => {
          setSheetOpen(false);
          focusNext.current = { to: "heading", reveal: true };
          if (!listing) write(text, url.filters, true);
        }}
      />
    </div>
  );
}
