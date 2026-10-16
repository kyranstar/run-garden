/**
 * THE STUDIO (Stage 2 spec §2–§7): one place to see every move, understand it quickly, and turn moves into workouts.
 *
 *   Studio
 *   [⌕ Search moves, muscles, tags        ] [Filters]
 *   the home (quick starts · browse · themes · tags)  — or, once there is a query or a filter, the moves
 *   a move's detail (`/studio/move/:id`): a sheet over the list on a phone, the right-hand pane from md
 *   Add: one small sheet; then a quiet line — where the move went, Open, Undo
 *
 * The URL is the state (`model.ts`), so Back leaves the results and a list can be returned to:
 *  - the first step from the home into a list is a new history entry (marked `fromHome`); every refinement after it
 *    replaces that entry, and going back to the home from it goes BACK to the entry it left — so Back never shows the
 *    home twice and never walks through keystrokes;
 *  - the field's text lives here and reaches the URL after a pause (`URL_WRITE_MS`): the list follows every keystroke
 *    at once, the address catches up, and a fast typist never meets WebKit's limit on history writes (~100 in 30 s).
 *    When the URL moves under the field (Back, a link), the field follows it.
 *  - a move opened from the list is a new entry (`/studio/move/:id` with the list's own search, so the list stays
 *    behind it); another row while one is open swaps it in place; Easier and Harder go one deeper. Closing goes back
 *    as many entries as it went in — or, when the list changed under an open pane, replaces the entry with the list.
 *
 * Instant and offline by construction: the library is in the bundle and `studioResults` is a pure function over it.
 * The three reads (`GET /api/library` for the athlete's pins, ratings and history; today's readings; the default
 * place's gear) only add knowledge — before they answer, or with no network, the list is the same list knowing less.
 * The whole view is deferred (`useDeferredValue`): the field and the chips answer at once, the 150-row list a frame
 * later, and the home stays until the list is ready rather than flashing a wrong one.
 *
 * Focus never falls to <body> when the control that had it goes away: a removed chip hands it to the next chip (else
 * the list's heading), Clear to the field, a loosening or a browse tap to the list's heading; a closed detail to the
 * row that opened it; a dismissed confirmation to the Add that made it.
 *
 * Widths: one column below md, the detail a sheet, the filters a sheet. From md the detail is a pane beside the list
 * or the home (`.stu--detail`); from lg (wide treatment) the filters are a column beside the list — the same
 * `FilterControls` — placed by the grid. The list comes first in the DOM, so reading order and Tab reach the moves
 * before the facets and the pane.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useMatch, useNavigate, useNavigationType, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { accountTodayGuess } from "../../components.js";
import { SearchField } from "../../components/search-field.js";
import { WatchPreviewSheet } from "../../components/watch-preview-sheet.js";
import { IconFilters } from "../../icons.js";
import { AddedLine, AddSheet, writeErrorText, type Added } from "./add-sheet.js";
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
import { MoveDetail, type MoveLink } from "./move-detail.js";
import { StudioResults } from "./search.js";

/** How long the field waits before writing the query to the URL. */
export const URL_WRITE_MS = 250;

/** md: from here the detail is a pane beside the list rather than a sheet over it. */
export const DETAIL_PANE_MIN_PX = 900;

/** Whether the viewport is at least `px` wide, following it as it changes; false where there is no window to ask. */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [on, setOn] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const change = () => setOn(mq.matches);
    change();
    mq.addEventListener?.("change", change);
    return () => mq.removeEventListener?.("change", change);
  }, [query]);
  return on;
}

/** A move's address, carrying the list's own search so the list is still there behind it. */
export const moveHref = (id: string, search: string): string => `/studio/move/${encodeURIComponent(id)}${search ? `?${search}` : ""}`;

const byId = new Map<string, ExerciseRecord>();
for (const r of EXERCISES) {
  byId.set(r.id, r);
  for (const old of r.legacyIds) if (!byId.has(old)) byId.set(old, r);
}

/**
 * The athlete's side of the Studio: profiles and today's readings, their say on each move, the place's gear.
 *
 * `limit: 200` is the route's cap and covers the whole library today (150 moves). Past 200 the prefs of the moves
 * beyond it would simply be missing — those rows would show no history or pin — until this asks for them by page.
 */
export function useStudioCtx(): StudioCtx {
  return useStudioReads().ctx;
}

/**
 * The context, and whether its reads have all answered — or, offline, given up for now (`paused`): what is built from
 * them once and kept (a quick start) waits for that, rather than being built twice, the first time knowing less.
 * `profilesKnown`: the library read (the switched-on profiles' one full list) has answered at some point — false while
 * it is paused or failed with nothing kept, when "no profile is on" would be a guess.
 */
export function useStudioReads(): { ctx: StudioCtx; settled: boolean; profilesKnown: boolean } {
  const library = useQuery({ queryKey: ["library", "studio"], queryFn: () => api.listLibrary({ limit: 200 }), staleTime: 60_000 });
  const today = useQuery({ queryKey: ["today"], queryFn: api.today });
  const places = useQuery({ queryKey: ["places"], queryFn: api.listPlaces, staleTime: 60_000 });
  // The focus areas (CUJ R7): what the suggestions and the quick starts lean to.
  const profile = useQuery({ queryKey: ["profile"], queryFn: api.getProfile, staleTime: 60_000 });
  const ctx = useMemo(() => studioCtxFrom(library.data, today.data, places.data, profile.data), [library.data, today.data, places.data, profile.data]);
  const settled = [library, today, places, profile].every((q) => !q.isPending || q.fetchStatus === "paused");
  return { ctx, settled, profilesKnown: library.data !== undefined };
}

/** What a history entry under the Studio carries: whether it came from the home, and how deep into moves it is. */
interface StudioHistory {
  fromHome?: boolean;
  /** A list's entry, a step from the home: that home entry's key. */
  homeKey?: string;
  /** A home that took a list's place (Clear): the home entry just below it, the same page, which Back steps over. */
  dupOf?: string;
  /** How many move entries were pushed since the list (closing goes back that many). */
  moveDepth?: number;
  /** The list's search when the first move was opened from it. */
  list?: string;
}

/** Where focus goes once the next render lands. */
type FocusTo =
  | { to: "field" | "heading" | number; reveal?: boolean }
  /** The row of a move whose detail closed. */
  | { to: "move"; id: string }
  /** The Add that made a dismissed confirmation. */
  | { to: "add"; id: string; from: "detail" | "list" }
  /** The confirmation line on the page, after an Add from the list — that Add's (`n`): a newer one's line disarms it. */
  | { to: "line"; n: number };

export function StudioScreen() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const search = params.toString();
  const url = useMemo(() => readStudio(new URLSearchParams(search)), [search]);
  const ctx = useStudioCtx();
  const qc = useQueryClient();
  const wide = useMinWidth(DETAIL_PANE_MIN_PX);
  const [sheetOpen, setSheetOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusNext = useRef<FocusTo | null>(null);

  // ── The move open, from the path ──
  const moveMatch = useMatch("/studio/move/:id");
  const openId = moveMatch?.params.id ?? null;
  const openRec = openId ? (byId.get(openId) ?? null) : null;

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

  const state = location.state as StudioHistory | null;
  const here = useRef({ search, state, openId, key: location.key });
  here.current = { search, state, openId, key: location.key };

  /**
   * Back to the home from a list that was a step from it: this entry becomes the home, in place. Never a Back — a Back
   * lands later, and a tap made before it lands (a quick start, a move) would be undone by it. The home entry below
   * is then the same page twice: Back steps over it (`dupOf`), so one Back still leaves the Studio from here.
   */
  const homeInPlace = useCallback(
    (from: StudioHistory | null) => {
      const { fromHome: _was, homeKey, ...rest } = from ?? {};
      navigate({ pathname: "/studio", search: "" }, { replace: true, state: { ...rest, ...(homeKey ? { dupOf: homeKey } : {}) } satisfies StudioHistory });
    },
    [navigate],
  );
  // Back from a home that took a list's place: the entry it lands on is that same home — stepped over, on to wherever
  // the Studio was opened from. (A Forward onto it comes from no such home, and stays.)
  const navType = useNavigationType();
  const left = useRef<{ key: string; state: StudioHistory | null } | null>(null);
  useEffect(() => {
    const from = left.current;
    left.current = { key: location.key, state };
    if (navType === "POP" && from && from.key !== location.key && from.state?.dupOf === location.key) navigate(-1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  /** Write a state to the URL: a new entry when it opens a list from the home, back to that home when it closes. */
  const write = useCallback(
    (q: string, filters: StudioFilters, all: boolean) => {
      cancel();
      written.current = q;
      const next = studioSearch(q, filters, all);
      const { search: now, state, openId, key } = here.current;
      // A move is open: the list under it changes in place — the move's entry is replaced, never a new one pushed, so
      // closing it backs out of exactly the entries opening it made.
      if (openId) {
        setParams(new URLSearchParams(next), { replace: true, state });
        return;
      }
      if (now === "") {
        if (next !== "") setParams(new URLSearchParams(next), { state: { ...state, fromHome: true, homeKey: key } });
        return;
      }
      if (next === "" && state?.fromHome) {
        homeInPlace(state);
        return;
      }
      setParams(new URLSearchParams(next), { replace: true, state });
    },
    [setParams, homeInPlace],
  );
  // The latest `write`, for the field's late one: the write made by the render the typing happened in resolves its
  // address against the location of that render — a move tapped inside the pause (`/studio/move/:id`) had the list's
  // address written over its entry, and the detail opened and shut.
  const writeLatest = useRef(write);
  writeLatest.current = write;

  const type = (v: string) => {
    setText(v);
    cancel();
    const { filters, all } = url;
    timer.current = setTimeout(() => {
      timer.current = null;
      writeLatest.current(v, filters, all);
    }, URL_WRITE_MS);
  };

  // ── A move's detail: opened, swapped, closed ──
  const openMove = useCallback(
    (rec: ExerciseRecord) => {
      const { search, state, openId } = here.current;
      // One open beside the list: swap it in place. Otherwise a new entry, so Back closes it.
      if (openId) navigate(moveHref(rec.id, search), { replace: true, state });
      else navigate(moveHref(rec.id, search), { state: { moveDepth: 1, list: search } satisfies StudioHistory });
    },
    [navigate],
  );
  const moveLink = useCallback(
    (id: string): MoveLink => ({
      to: moveHref(id, search),
      state: { moveDepth: (state?.moveDepth ?? 0) + 1, list: state?.list ?? search } satisfies StudioHistory,
    }),
    [search, state],
  );
  /** A list to land on once a close's Back has landed: the list changed while the pane was open. */
  const relist = useRef<string | null>(null);
  const closeMove = useCallback(() => {
    const { search, state, openId } = here.current;
    if (openId) focusNext.current = { to: "move", id: openId };
    if (state?.moveDepth) {
      // Back out of every move entry; the list as it is now then takes the place of the one they started from.
      relist.current = state.list !== search ? search : null;
      navigate(-state.moveDepth);
    } else navigate({ pathname: "/studio", search: search ? `?${search}` : "" }, { replace: true });
  }, [navigate]);
  // The close's Back has landed (this runs on the entry it lands on — nothing in between changes what it reads): put
  // the list as it now is in that entry — a step from the home when it landed on the home (so the home is there once,
  // behind it), back to that home when the list is now empty and the entry came from one, else in the entry's place.
  // Landed on a move after all: nothing to put, and the redirect is dropped — never left armed for a later close.
  useEffect(() => {
    const want = relist.current;
    if (want === null) return;
    relist.current = null;
    if (openId) return;
    if (want === search) return;
    const to = { pathname: "/studio", search: want ? `?${want}` : "" };
    if (search === "") navigate(to, { state: { fromHome: true, homeKey: location.key } satisfies StudioHistory });
    else if (want === "" && state?.fromHome) homeInPlace(state);
    else navigate(to, { replace: true, state });
  }, [openId, search, state, navigate, location.key, homeInPlace]);
  const openHref = useCallback((id: string) => moveHref(id, search), [search]);

  // ── Add: the one small sheet, then the line ──
  const [adding, setAdding] = useState<{ rec: ExerciseRecord; from: Added["from"]; n: number } | null>(null);
  const [added, setAdded] = useState<Added | null>(null);
  const addCount = useRef(0);
  const addFromList = useCallback((rec: ExerciseRecord) => setAdding({ rec, from: "list", n: ++addCount.current }), []);
  const addFromDetail = useCallback((rec: ExerciseRecord) => setAdding({ rec, from: "detail", n: ++addCount.current }), []);
  const undo = async () => {
    const a = added;
    if (!a || a.phase !== "done") return;
    setAdded({ ...a, phase: "undoing", error: undefined });
    const settle = (next: Partial<Added>) => setAdded((cur) => (cur?.n === a.n ? { ...cur, ...next } : cur));
    try {
      const back = await a.undo();
      // Whether the watch holds another copy is the server's word on the undone workout; that the copy has the move in
      // it is known only when the Add's own version was sent (`a.sent`, kept as `addSent`).
      settle({ phase: "undone", error: undefined, watch: back?.watch, sent: false, addSent: a.sent === true });
    } catch (e) {
      settle({ phase: "done", error: writeErrorText(e, true) });
    }
  };
  const dismiss = () => {
    if (added) focusNext.current = { to: "add", id: added.rec.id, from: added.from };
    setAdded(null);
  };
  // "Send the new version": the session's own Send — its watch preview, then the push — for the workout added to.
  const [sendingWatch, setSendingWatch] = useState<{ n: number; workoutId: string; minutes: number } | null>(null);
  const sendWatch = (workoutId: string) => {
    if (added?.watch?.workoutId === workoutId) setSendingWatch({ n: added.n, workoutId, minutes: added.watch.minutes });
  };
  const watchWritten = (workoutId: string) => {
    void qc.invalidateQueries({ queryKey: ["session", workoutId] });
    void qc.invalidateQueries({ queryKey: ["plan"] });
    void qc.invalidateQueries({ queryKey: ["today"] });
  };
  // The line shows where the Add was made: in the detail's foot while that move is open, else on the page.
  const inDetail = !!added && added.from === "detail" && openRec?.id === added.rec.id;

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
    const rowOf = (id: string) => [...r.querySelectorAll<HTMLElement>(".stu-move")].find((el) => el.dataset.id === id) ?? null;
    let target: HTMLElement | null;
    if (want.to === "move") {
      // Wait for the close to land (Back is asynchronous), then the row that opened it — else the list, else the page.
      if (openId === want.id) return;
      target = rowOf(want.id)?.querySelector<HTMLElement>(".stu-move-open") ?? (listing ? heading.current : title.current);
      if (!target && listing) return;
    } else if (want.to === "line") {
      // Meant for a line a newer Add has replaced: nothing to go to, now or later.
      if (added?.n !== want.n) {
        focusNext.current = null;
        return;
      }
      // After an Add from the list: the line's words, Open and Undo the next Tab stops.
      target = r.querySelector<HTMLElement>(".stu-added--on .stu-added-said");
      if (!target) return;
    } else if (want.to === "add") {
      target =
        (want.from === "detail" ? r.querySelector<HTMLElement>(".stu-detail-add") : rowOf(want.id)?.querySelector<HTMLElement>(".stu-move-add")) ??
        (listing ? heading.current : title.current);
    } else {
      const chip = typeof want.to === "number" ? r.querySelectorAll<HTMLElement>(".stu-chip-x")[want.to] : null;
      // Decided from the NEW state (`listing`), not the deferred view: a list that is closing still draws its old
      // chips and heading for a frame, and focusing one of them would leave focus on a node about to unmount.
      target = want.to === "field" || !listing ? field : (chip ?? heading.current);
      // The list is on its way (the view is deferred): wait for the render that brings it.
      if (!target && listing) return;
      target ??= field;
    }
    focusNext.current = null;
    target?.focus({ preventScroll: true });
    if ("reveal" in want && want.reveal && (r.getBoundingClientRect().top ?? 0) < 0) r.scrollIntoView?.({ block: "start" });
  });

  const browse = (f: StudioFilters | "all") => {
    focusNext.current = { to: "heading", reveal: true };
    write("", f === "all" ? {} : f, f === "all");
  };
  const setFilters = (f: StudioFilters) => write(text, f, url.all);

  const set = setFilterCount(url.filters, ctx);
  const today = accountTodayGuess(ctx.today, ctx.timeZone);
  // A move the library does not have (an old link): the list, without it.
  if (openId && !openRec) return <Navigate to={{ pathname: "/studio", search: search ? `?${search}` : "" }} replace />;

  const detail = openRec ? (
    <MoveDetail
      rec={openRec}
      ctx={ctx}
      today={today}
      wide={wide}
      onClose={closeMove}
      onAdd={addFromDetail}
      moveLink={moveLink}
      added={<AddedLine added={inDetail ? added : null} onUndo={() => void undo()} onDismiss={dismiss} onSendWatch={sendWatch} />}
    />
  ) : null;
  return (
    <div ref={root} className={`stu${shown.listing ? " stu--results" : ""}${openRec && wide ? " stu--detail" : ""}`}>
      <h1 ref={title} tabIndex={-1}>
        Studio
      </h1>
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

      <div className="stu-main">
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
              onAdd={addFromList}
              onOpen={openMove}
              openHref={openHref}
              openId={openRec?.id ?? null}
            />
            <aside className="stu-facets scroller" aria-label="Filters">
              <FilterControls filters={url.filters} ctx={ctx} level={2} onChange={setFilters} />
            </aside>
          </div>
        ) : (
          <StudioHome ctx={ctx} onBrowse={browse} />
        )}
        {wide ? detail : null}
      </div>
      {wide ? null : detail}

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
      {adding ? (
        <AddSheet
          key={adding.n}
          rec={adding.rec}
          ctx={ctx}
          today={today}
          onClose={() => setAdding(null)}
          onAdded={(done) => {
            setAdded({ ...done, n: adding.n, rec: adding.rec, from: adding.from, phase: "done" });
            setAdding(null);
            // From the list, the line is far from the ＋ in Tab order: focus goes to it, so Open and Undo are next. (From
            // the detail it sits right above the Add that focus returns to.)
            if (adding.from === "list") focusNext.current = { to: "line", n: adding.n };
          }}
          onLeaveWhileSaving={(writing) => {
            // Closed past the wait: the page keeps the write — "Still saving…", then where it went, or why not.
            const { n, rec, from } = adding;
            const base = { n, rec, from, text: "", href: "", notes: [], undo: async () => undefined };
            setAdded({ ...base, phase: "saving" });
            const settle = (next: Added) => setAdded((cur) => (cur?.n === n ? next : cur));
            writing.then(
              (done) => {
                // Open and Undo arrive now: if focus is still where the closed sheet left it (the row's ＋) — or nowhere —
                // it moves to the line, as after any Add from the list.
                const a = document.activeElement;
                const plus = [...(root.current?.querySelectorAll<HTMLElement>(".stu-move") ?? [])]
                  .find((el) => el.dataset.id === rec.id)
                  ?.querySelector(".stu-move-add");
                if (from === "list" && (!a || a === document.body || a === plus)) focusNext.current = { to: "line", n };
                settle({ ...done, n, rec, from, phase: "done" });
              },
              (e) => settle({ ...base, phase: "failed", error: writeErrorText(e) }),
            );
          }}
        />
      ) : null}
      <AddedLine added={inDetail ? null : added} onUndo={() => void undo()} onDismiss={dismiss} onSendWatch={sendWatch} />
      {sendingWatch ? (
        <WatchPreviewSheet
          workoutId={sendingWatch.workoutId}
          minutes={sendingWatch.minutes}
          onClose={() => setSendingWatch(null)}
          onSent={() => {
            const { n, workoutId } = sendingWatch;
            setSendingWatch(null);
            // Send's button goes with the send; the line puts focus on its words (`AddedLine`), never the page.
            setAdded((cur) => (cur?.n === n ? { ...cur, sent: true } : cur));
            // As the session sheet does after a Send: run the queued push, then read again what it changed.
            watchWritten(workoutId);
            void api
              .drainWatch()
              .catch(() => undefined)
              .finally(() => watchWritten(workoutId));
          }}
          onStale={() => {
            setSendingWatch(null);
            watchWritten(sendingWatch.workoutId);
          }}
          onRefused={() => {
            setSendingWatch(null);
            watchWritten(sendingWatch.workoutId);
          }}
        />
      ) : null}
    </div>
  );
}
