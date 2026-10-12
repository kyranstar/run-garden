/**
 * Shared fixtures for the Studio's tests: the payloads the screen reads (`GET /api/library`, `/api/plan/today`,
 * `/api/places`), generic and with no personal data. The condition profile is the library's public TMJ profile.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createPath, Router, type To } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LibraryListDto, LibraryRowDto, PlacesResponse, TodayResponse } from "@rg/api-client";
import { EXERCISES } from "@rg/exercise-library";

export const TODAY = "2026-10-11";

/** A library row for one record, with the athlete's say on it. */
export function row(id: string, over: Partial<LibraryRowDto> = {}): LibraryRowDto {
  const ex = EXERCISES.find((e) => e.id === id)!;
  return {
    id: ex.id,
    name: ex.name,
    family: ex.family,
    patterns: [...ex.patterns],
    regions: [...ex.regions],
    roles: [...ex.roles],
    equipment: { all: [...ex.equipment.all], oneOf: [...ex.equipment.oneOf] },
    difficulty: ex.difficulty,
    summary: ex.text.summary,
    purposes: [...ex.purposes],
    contraction: [...ex.contraction],
    tags: [...ex.tags],
    primaryMuscles: [...ex.muscles.primary],
    lastDoneOn: null,
    timesDone30d: 0,
    doneCleanly: false,
    safety: {},
    rating: null,
    excluded: false,
    pinned: false,
    saved: false,
    unlocksWith: null,
    ...over,
  };
}

export function libraryDto(opts: { tmj?: boolean; items?: LibraryRowDto[] } = {}): LibraryListDto {
  return {
    total: EXERCISES.length,
    matched: EXERCISES.length,
    items: opts.items ?? [],
    place: { id: "home", name: "Home" },
    profiles: opts.tmj ? [{ profileId: "tmj", label: "TMJ" }] : [],
    wishlist: [],
  };
}

/** Today's payload, as much as the Studio reads: the date and the switched-on profiles' readings. */
export function todayDto(reading: { value: number | null; feelingOff?: boolean } | null, tmj = true): TodayResponse {
  return {
    today: TODAY,
    conditions: tmj
      ? [
          {
            profileId: "tmj",
            check: { label: "Jaw / head", min: 0, max: 10 },
            care: "Jaw care",
            today: reading ? { value: reading.value, feelingOff: reading.feelingOff ?? false } : null,
          },
        ]
      : [],
  } as unknown as TodayResponse;
}

export function placesDto(equipment: string[], name = "Home"): PlacesResponse {
  return { places: [{ id: "p1", name, equipment, implements: {}, isDefault: true }], equipment: [] };
}

export interface Primed {
  library?: LibraryListDto;
  today?: TodayResponse;
  places?: PlacesResponse;
}

export function primedClient(p: Primed = {}): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (p.library) qc.setQueryData(["library", "studio"], p.library);
  if (p.today) qc.setQueryData(["today"], p.today);
  if (p.places) qc.setQueryData(["places"], p.places);
  return qc;
}

/**
 * A router for a static render: what `StaticRouter` does (no layout effects, so no server-render warnings), without
 * loading react-router-dom's CommonJS `/server` entry beside the ESM one — two copies would be two router contexts.
 */
export function staticRouter(path: string, el: ReactElement): ReactElement {
  const url = new URL(path, "http://studio.test");
  const refuse = () => {
    throw new Error("a static render cannot navigate");
  };
  return createElement(
    Router,
    {
      location: { pathname: url.pathname, search: url.search, hash: "", state: null, key: "static" },
      navigator: { createHref: (to: To) => (typeof to === "string" ? to : createPath(to)), push: refuse, replace: refuse, go: refuse },
      static: true,
    },
    el,
  );
}

export function renderAt(path: string, el: ReactElement, p: Primed = {}): string {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: primedClient(p) }, staticRouter(path, el)));
}

/** Text content of some markup, tags dropped and entities decoded enough for assertions. */
export function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
