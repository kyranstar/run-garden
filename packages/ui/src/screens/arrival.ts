/**
 * The arrival block's pure logic: which ceremonies fire, which beat/today
 * lines render, which plants sprout in and sparkle — all derived from the
 * garden's event feed and the server-side seen watermark (spec §3–§4,
 * docs/superpowers/specs/2026-08-05-garden-reward-loop-design.md).
 * No React, no fetching: everything here is unit-testable in isolation.
 */

import type { GardenSeenState } from "@rg/api-client";
import { addDays, sportLabel, type GardenEvent } from "@rg/domain";
import { SPECIES_BY_ID } from "@rg/garden-engine";

/** A garden event as the route serves it — durable, or today's preview.
 * Durable rows also carry the DB `createdAt` (recentGardenEvents selects
 * every column); preview events never have one — they aren't rows yet. */
export type ArrivalEvent = GardenEvent & { preview?: boolean; createdAt?: string };

export interface ArrivalCeremony {
  kind: "species" | "ground";
  speciesId?: string;
  ground?: string;
  /** True when the unlock is same-day (not yet durable) — its speciesId must
   * be recorded as celebrated so tomorrow's durable row doesn't re-fire. */
  fromPreview: boolean;
}

export interface ArrivalPlan {
  /** Sequential ceremony queue: grounds first, then species rare-first. */
  ceremonies: ArrivalCeremony[];
  beatLines: string[];
  beatOverflow: boolean;
  todayLines: string[];
  todayOverflow: boolean;
  /** Plants added in the arrival window — the renderer sprouts these in. */
  enteringPlantIds: string[];
  /** Rare-ish arrivals worth a one-shot sparkle in the atmosphere layer. */
  sparkles: Array<
    | { kind: "plant"; plantId: string; speciesId: string }
    | { kind: "wildlife"; wildlifeId: string }
  >;
  /** Brand-new garden: nothing to celebrate — mark seen silently. */
  markSeenImmediately: boolean;
  /** What POST /api/garden/seen should record after this presentation. */
  nextSeen: GardenSeenState;
}

export function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Region-unlock ceremony copy, keyed by the carved ground kind. */
export const GROUND_CEREMONY_COPY: Record<string, string> = {
  stream: "Long runs carved the stream — new ground, new water.",
  terrace: "Strength work built the stone terrace.",
  glade: "Steady yoga cleared the still glade.",
  meadow: "The garden expanded into new meadow.",
};

/** Overnight-beat ordering: reveals lead, plumbing trails. */
export const BEAT_PRIORITY: Record<string, number> = {
  species_unlocked: 0,
  wildlife_arrived: 1,
  plant_added: 2,
  region_unlocked: 3,
};

export function eventSentence(e: GardenEvent): string | null {
  switch (e.kind) {
    case "run_completed": {
      const catg = e.workoutCategory ?? "";
      // Strength/yoga sessions ride the same run_completed event as runs (see
      // applyRun), so route them to discipline-true copy before falling
      // through to the generic run sentences below.
      if (catg === "strength") {
        return e.detail === "unplanned"
          ? "An extra strength session fed the soil."
          : "A strength session fed the soil.";
      }
      if (catg === "yoga") {
        return e.detail === "unplanned"
          ? "An extra yoga session tended the meadow."
          : "A yoga session tended the meadow.";
      }
      if (e.detail === "unplanned") return "An extra run gave the garden a light watering.";
      const article = /^[aeiou]/i.test(catg) ? "An" : "A";
      return catg ? `${article} ${catg} run watered the garden.` : "A run watered the garden.";
    }
    case "plant_added": {
      const sp = e.speciesId ? SPECIES_BY_ID.get(e.speciesId) : undefined;
      const name = sp?.name ?? "plant";
      // Rarity earns its own verb — a rare arrival should not read like clover.
      if (e.detail === "tree_seed") {
        if (sp?.rarity === "rare") return `A rare ${name} seed was planted.`;
        if (sp?.rarity === "uncommon") return `An uncommon ${name} seed was planted.`;
        return `A ${name} seed was planted.`;
      }
      if (sp?.rarity === "rare") return `A rare ${name} has taken root — a lucky find.`;
      if (sp?.rarity === "uncommon") return `An uncommon ${name} took root.`;
      return `A ${name} took root.`;
    }
    case "species_unlocked": {
      const name = e.speciesId ? (SPECIES_BY_ID.get(e.speciesId)?.name ?? e.speciesId) : "";
      return `New species unlocked: ${name}.`;
    }
    case "wildlife_arrived":
      return `${cap(e.wildlifeId ?? "wildlife")} arrived in the garden.`;
    case "wildlife_departed":
      return `${cap(e.wildlifeId ?? "wildlife")} moved on for now.`;
    case "plant_died":
      return "A plant died back — it stays as habitat.";
    case "region_unlocked":
      return GROUND_CEREMONY_COPY[e.detail ?? ""] ?? "The garden expanded into new ground.";
    case "rest_mode_started":
      return "Garden rest mode began.";
    case "rest_mode_ended":
      return "Garden rest mode ended.";
    case "missed_run":
      return "A missed run left the soil a little drier.";
    case "rest_observed":
      return "A rest day — soil health improved.";
    case "soil_tended":
      return "Strength work fed the soil.";
    case "life_tended":
      return "Yoga brought the meadow back to life.";
    case "adventure_logged":
      return e.detail
        ? `A ${sportLabel(e.detail).toLowerCase()} fed the garden — wild air does it good.`
        : "An adventure fed the garden — wild air does it good.";
    default:
      return null;
  }
}

interface Watermark {
  d: string;
  s: number;
}

const after = (e: ArrivalEvent, wm: Watermark): boolean =>
  e.date > wm.d || (e.date === wm.d && e.seq > wm.s);

const RARITY_RANK = { rare: 0, uncommon: 1, common: 2 } as const;

export function selectArrival(
  events: ArrivalEvent[],
  seen: GardenSeenState | null,
  todayDate: string,
): ArrivalPlan {
  const durable = events.filter((e) => !e.preview);
  const preview = events.filter((e) => e.preview);

  // Brand-new garden: genesis is not an achievement — mark seen silently.
  if (!seen && durable.length === 0) {
    return {
      ceremonies: [],
      beatLines: [],
      beatOverflow: false,
      todayLines: [],
      todayOverflow: false,
      enteringPlantIds: preview
        .filter((e) => e.kind === "plant_added" && e.plantId)
        .map((e) => e.plantId!),
      sparkles: [],
      markSeenImmediately: true,
      nextSeen: { lastSeenDate: todayDate, lastSeenSeq: -1, celebratedSpeciesIds: [] },
    };
  }

  // Missing row on an existing garden (migration day): start of yesterday,
  // so the first post-deploy load doesn't replay all history as one block.
  const wm: Watermark = seen
    ? { d: seen.lastSeenDate, s: seen.lastSeenSeq }
    : { d: addDays(todayDate, -1), s: -1 };
  const celebrated = new Set(seen?.celebratedSpeciesIds ?? []);
  const fresh = durable.filter((e) => after(e, wm));

  // C13: resimulateFrom rewrites events onto their ORIGINAL past date when
  // late history changes what happened there (a late-synced activity, a
  // match edit) — so an unlock this watermark never covered can land at or
  // before it, permanently excluded from `fresh`'s append-only admission (a
  // real regression the watermark can't recover from on its own). Unlock
  // MOMENTS still deserve exactly one celebration no matter when the
  // rewrite lands; everything else from a rebuilt day stays ordinary log
  // history — `backfilled` only ever feeds ceremonies.
  //
  // Gate on INSERTION TIME, not position (round 2 fix — a position-only
  // test regressed): an ORDINARY event that was fresh on some earlier visit
  // and properly celebrated via `fresh` is, on every later visit, ALSO
  // "behind the watermark and not in `celebrated`" — `celebrated` only ever
  // tracked preview-transitional and backfilled ids, never plain fresh ones
  // — so a test keyed on (date, seq) alone can't tell that apart from a
  // genuinely rebuilt row and replays it forever. `createdAt` can:
  // resimulateFrom deletes and reinserts the row, so a REBUILT event's
  // createdAt is strictly after the moment the user's watermark was last
  // saved (seen.updatedAt) — an event that was already sitting there when
  // the tip was computed never can be. Requires a real watermark WITH a
  // real updatedAt: the migration-day default (missing seen row, above) has
  // neither, and deliberately starts at "yesterday" precisely so a
  // never-before-seen garden doesn't replay its whole history as one block
  // — that cliff must stay untouched.
  const backfilled = seen?.updatedAt
    ? durable.filter(
        (e) => !after(e, wm) && e.createdAt !== undefined && e.createdAt > seen.updatedAt!,
      )
    : [];
  // `celebrated` is the permanent ledger for both: species ids as before,
  // and ground kinds under a `ground:` prefix (a real species id is always a
  // bare snake_case name, so the two id spaces never collide).
  const groundId = (ground: string): string => `ground:${ground}`;

  const speciesSeen = new Set<string>();
  const speciesCeremonies = [
    ...fresh.filter((e) => e.kind === "species_unlocked" && e.speciesId),
    ...backfilled.filter((e) => e.kind === "species_unlocked" && e.speciesId),
    ...preview.filter((e) => e.kind === "species_unlocked" && e.speciesId),
  ]
    .filter((e) => !celebrated.has(e.speciesId!))
    .filter((e) => !speciesSeen.has(e.speciesId!) && speciesSeen.add(e.speciesId!))
    .map((e) => ({ kind: "species" as const, speciesId: e.speciesId!, fromPreview: !!e.preview }))
    .sort(
      (a, b) =>
        RARITY_RANK[SPECIES_BY_ID.get(a.speciesId)?.rarity ?? "common"] -
        RARITY_RANK[SPECIES_BY_ID.get(b.speciesId)?.rarity ?? "common"],
    );
  const groundSeen = new Set<string>();
  const groundCeremonies = [...fresh, ...backfilled]
    .filter((e) => e.kind === "region_unlocked")
    .filter((e) => !celebrated.has(groundId(e.detail ?? "meadow")))
    .filter((e) => {
      const g = e.detail ?? "meadow";
      return !groundSeen.has(g) && groundSeen.add(g);
    })
    .map((e) => ({ kind: "ground" as const, ground: e.detail ?? "meadow", fromPreview: false }));
  const ceremonies: ArrivalCeremony[] = [...groundCeremonies, ...speciesCeremonies];

  // Events a ceremony (or an earlier celebration) already owns stay out of
  // the text lines — the card is the louder version of the same news.
  const consumedSpecies = new Set([...speciesSeen, ...celebrated]);
  const notConsumed = (e: ArrivalEvent): boolean => {
    if (e.kind === "region_unlocked" && groundCeremonies.length > 0) return false;
    if (e.kind === "species_unlocked" && e.speciesId && consumedSpecies.has(e.speciesId))
      return false;
    return true;
  };

  const beatSrc = fresh
    .filter(notConsumed)
    .sort((a, b) => (BEAT_PRIORITY[a.kind] ?? 9) - (BEAT_PRIORITY[b.kind] ?? 9))
    .map(eventSentence)
    .filter((t): t is string => !!t);
  const todaySrc = preview
    .filter(notConsumed)
    .map(eventSentence)
    .filter((t): t is string => !!t);

  const tip = durable.reduce<Watermark>((acc, e) => (after(e, acc) ? { d: e.date, s: e.seq } : acc), wm);
  const previewCelebrated = speciesCeremonies
    .filter((c) => c.fromPreview)
    .map((c) => c.speciesId);
  // Backfilled admissions must be remembered forever: their event's
  // (date, seq) sits at-or-before the watermark by definition, so it can
  // never re-enter `fresh` on a later visit to earn the ordinary
  // prune-once-covered treatment below — nothing else would ever stop them
  // from replaying as "new" again.
  const backfilledIds = [
    ...speciesCeremonies
      .filter((c) => !c.fromPreview && backfilled.some((e) => e.kind === "species_unlocked" && e.speciesId === c.speciesId))
      .map((c) => c.speciesId),
    ...groundCeremonies
      .filter((c) => backfilled.some((e) => e.kind === "region_unlocked" && (e.detail ?? "meadow") === c.ground))
      .map((c) => groundId(c.ground)),
  ];
  // Prior celebrated ids stay only while a FRESH durable row hasn't put them
  // back in front of the user this visit (even just to be silently deduped
  // here) — once one has, every future watermark covers its position for
  // good. Ids admitted via `backfilled` are deliberately NOT matched by this
  // rule (their row is never fresh), which is what keeps them celebrated
  // exactly once via `backfilledIds` above instead of being pruned right
  // back out.
  const retained = [...celebrated].filter(
    (id) =>
      !fresh.some(
        (e) =>
          (e.kind === "species_unlocked" && e.speciesId === id) ||
          (e.kind === "region_unlocked" && groundId(e.detail ?? "meadow") === id),
      ),
  );

  const window = [...fresh, ...preview];
  return {
    ceremonies,
    beatLines: beatSrc.slice(0, 3),
    beatOverflow: beatSrc.length > 3,
    todayLines: todaySrc.slice(0, 2),
    todayOverflow: todaySrc.length > 2,
    enteringPlantIds: window
      .filter((e) => e.kind === "plant_added" && e.plantId)
      .map((e) => e.plantId!),
    sparkles: window.flatMap((e): ArrivalPlan["sparkles"] => {
      if (e.kind === "wildlife_arrived" && e.wildlifeId) {
        return [{ kind: "wildlife", wildlifeId: e.wildlifeId }];
      }
      if (e.kind === "plant_added" && e.plantId && e.speciesId) {
        const r = SPECIES_BY_ID.get(e.speciesId)?.rarity;
        if (r === "rare" || r === "uncommon") {
          return [{ kind: "plant", plantId: e.plantId, speciesId: e.speciesId }];
        }
      }
      return [];
    }),
    markSeenImmediately: false,
    nextSeen: {
      lastSeenDate: tip.d,
      lastSeenSeq: tip.s,
      celebratedSpeciesIds: [...new Set([...previewCelebrated, ...retained, ...backfilledIds])],
    },
  };
}

/** True when a non-null COROS read timestamp advanced between polls. */
export function shouldInvalidateGarden(prev: string | null, next: string | null): boolean {
  return !!prev && !!next && prev !== next;
}
