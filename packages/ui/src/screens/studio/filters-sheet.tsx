/**
 * THE FILTERS (Stage 2 spec §4): part · body area (then its muscles) · contraction · equipment · tags · theme ·
 * difficulty · fits today · yours. One value per facet, so every facet maps to one removable chip.
 *
 * One component, two homes: below lg the "Filters" button opens it in a Sheet (a bottom sheet on a phone, its actions
 * pinned under the one scrolling body); from lg it is the Studio's left column, always there beside the list. A choice
 * applies at once — the list behind updates as you tap — and the sheet's primary action says how many moves it shows.
 *
 * Kept short: the long, less-used facets (tags, theme, difficulty) show a first row and keep the rest one tap down
 * (`ChipRow`); a chosen value always shows. Chips are toggle buttons (`aria-pressed`) and a pressed chip shows a check,
 * so the choice never rests on colour. Equipment is the one facet that always has a value: the place's gear by
 * default, any equipment, or one piece.
 */
import { useId } from "react";
import { CONTRACTIONS, EQUIPMENT, EQUIPMENT_IDS, EXERCISES, label, MUSCLE_REGION, MUSCLES, REGIONS, type ExerciseRecord } from "@rg/exercise-library";
import { Sheet, countNoun } from "../../components.js";
import { ChipRow, type ChipSpec } from "./chip-row.js";
import { browseParts, browseTags, difficultyLabel, visibleThemes, type Mine, type StudioCtx, type StudioFilters } from "./model.js";

const has = (pred: (r: ExerciseRecord) => boolean): boolean => EXERCISES.some(pred);
const AREAS = REGIONS.filter((g) => has((r) => r.regions.includes(g)));
const HOWS = CONTRACTIONS.filter((c) => has((r) => r.contraction.includes(c)));
const GEAR = EQUIPMENT_IDS.filter((g) => has((r) => r.equipment.all.includes(g) || r.equipment.oneOf.includes(g)));
const musclesIn = (area: string) =>
  MUSCLES.filter((m) => MUSCLE_REGION[m] === area && has((r) => r.muscles.primary.includes(m) || r.muscles.secondary.includes(m)));
const MAXES = [1, 2, 3, 4];
const MINE: ReadonlyArray<[Mine, string]> = [
  ["pinned", "Pinned"],
  ["set-aside", "Not for me"],
];

/** The first row each long facet shows before its "More". */
const FIRST_TAGS = 6;
const FIRST_THEMES = 4;

function Facet({
  title,
  level,
  chips,
  limit,
  more,
  less,
}: {
  title: string;
  level: 2 | 3;
  chips: readonly ChipSpec[];
  limit?: number;
  more?: string;
  less?: string;
}) {
  const id = useId();
  const Heading = `h${level}` as "h2" | "h3";
  return (
    <div className="stu-facet" role="group" aria-labelledby={id}>
      <Heading id={id} className="eyebrow">
        {title}
      </Heading>
      <ChipRow chips={chips} limit={limit} more={more} less={less} toggle />
    </div>
  );
}

export function FilterControls({
  filters: f,
  ctx,
  onChange,
  level = 3,
}: {
  filters: StudioFilters;
  ctx: StudioCtx;
  onChange: (next: StudioFilters) => void;
  /** The facets' heading level: 3 inside the sheet (its title is the 2), 2 in the page's own column. */
  level?: 2 | 3;
}) {
  /** A single-value facet: tap to choose, tap the chosen one again to let go. */
  const pick = <K extends keyof StudioFilters>(key: K, value: StudioFilters[K]) => {
    const next = { ...f };
    if (f[key] === value) delete next[key];
    else next[key] = value;
    if (key === "area") delete next.muscle;
    onChange(next);
  };
  const setGear = (gear: StudioFilters["gear"]) => {
    const next = { ...f };
    if (gear === undefined) delete next.gear;
    else next.gear = gear;
    onChange(next);
  };
  const choice = <K extends keyof StudioFilters>(key: K, value: StudioFilters[K], text: string): ChipSpec => ({
    key: String(value),
    label: text,
    on: f[key] === value,
    onClick: () => pick(key, value),
  });
  const gear: ChipSpec[] = [
    ...(ctx.place ? [{ key: "place", label: `At ${ctx.place.name}`, on: f.gear === undefined, onClick: () => setGear(undefined) }] : []),
    { key: "any", label: "Any equipment", on: f.gear === "any" || (f.gear === undefined && !ctx.place), onClick: () => setGear("any") },
    ...GEAR.map((g) => ({ key: g, label: EQUIPMENT[g], on: f.gear === g, onClick: () => setGear(f.gear === g ? undefined : g) })),
  ];
  const muscles = f.area ? musclesIn(f.area) : [];
  return (
    <div className="stu-facets-body">
      <Facet level={level} title="Part" chips={browseParts(EXERCISES, ctx).map((p) => choice("part", p, label(p)))} />
      <Facet level={level} title="Body area" chips={AREAS.map((g) => choice("area", g, label(g)))} />
      {f.area && muscles.length > 1 ? (
        <Facet level={level} title={`${label(f.area)}: muscle`} chips={muscles.map((m) => choice("muscle", m, label(m)))} />
      ) : null}
      <Facet level={level} title="Contraction" chips={HOWS.map((c) => choice("how", c, label(c)))} />
      <Facet level={level} title="Equipment" chips={gear} />
      <Facet
        level={level}
        title="Tags"
        chips={browseTags(EXERCISES).map((t) => choice("tag", t, label(t)))}
        limit={FIRST_TAGS}
        more="More tags"
        less="Fewer tags"
      />
      <Facet
        level={level}
        title="Theme"
        chips={visibleThemes(ctx).map((t) => choice("theme", t.id, t.name))}
        limit={FIRST_THEMES}
        more="More themes"
        less="Fewer themes"
      />
      <Facet
        level={level}
        title="Difficulty"
        chips={MAXES.map((m) => choice("max", m, difficultyLabel(m).replace("Difficulty ", "")))}
        limit={0}
        more="Show levels"
        less="Hide levels"
      />
      {ctx.profiles.length > 0 ? (
        <Facet
          level={level}
          title="Today"
          chips={[{ key: "fit", label: "Fits today", on: f.fit !== false, onClick: () => pick("fit", false) }]}
        />
      ) : null}
      <Facet level={level} title="Yours" chips={MINE.map(([m, text]) => choice("mine", m, text))} />
    </div>
  );
}

export function FiltersSheet({
  open,
  onClose,
  filters,
  ctx,
  count,
  onChange,
  onClear,
  onShow,
}: {
  open: boolean;
  onClose: () => void;
  filters: StudioFilters;
  ctx: StudioCtx;
  /** How many moves the filters show now. */
  count: number;
  onChange: (next: StudioFilters) => void;
  /** Resets the filters; the sheet stays open. */
  onClear: () => void;
  onShow: () => void;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Filters"
      footer={
        <div className="btn-row stu-sheet-actions">
          <button type="button" className="btn" onClick={onClear}>
            Clear
          </button>
          <button type="button" className="btn btn-primary" onClick={onShow}>
            {`Show ${countNoun(count, "move")}`}
          </button>
        </div>
      }
    >
      <FilterControls filters={filters} ctx={ctx} onChange={onChange} />
    </Sheet>
  );
}
