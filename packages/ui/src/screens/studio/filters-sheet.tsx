/**
 * THE FILTERS (Stage 2 spec §4): part · body area (then its muscles) · contraction · equipment · tags · theme ·
 * difficulty · fits today · yours. One value per facet, so every facet maps to one removable chip.
 *
 * One component, two homes: below lg the "Filters" button opens it in a Sheet (a bottom sheet on a phone, its actions
 * pinned under the one scrolling body); from lg it is the Studio's left column, always there beside the list. A choice
 * applies at once — the list behind updates as you tap — and the sheet's primary action says how many moves it shows.
 *
 * Chips are toggle buttons (`aria-pressed`) and a pressed chip shows a check, so the choice never rests on colour.
 * Equipment is the one facet that always has a value: the place's gear by default, any equipment, or one piece.
 */
import { useId, type ReactNode } from "react";
import {
  CONTRACTIONS,
  EQUIPMENT,
  EQUIPMENT_IDS,
  EXERCISES,
  label,
  MUSCLE_REGION,
  MUSCLES,
  REGIONS,
  type ExerciseRecord,
} from "@rg/exercise-library";
import { Sheet, countNoun } from "../../components.js";
import { IconCheck } from "../../icons.js";
import {
  browseParts,
  browseTags,
  difficultyLabel,
  visibleThemes,
  type Mine,
  type StudioCtx,
  type StudioFilters,
} from "./model.js";

const has = (pred: (r: ExerciseRecord) => boolean): boolean => EXERCISES.some(pred);
const AREAS = REGIONS.filter((g) => has((r) => r.regions.includes(g)));
const HOWS = CONTRACTIONS.filter((c) => has((r) => r.contraction.includes(c)));
const GEAR = EQUIPMENT_IDS.filter((g) => has((r) => r.equipment.all.includes(g) || r.equipment.oneOf.includes(g)));
const musclesIn = (area: string) =>
  MUSCLES.filter((m) => MUSCLE_REGION[m] === area && has((r) => r.muscles.primary.includes(m) || r.muscles.secondary.includes(m)));
const MAXES = [1, 2, 3, 4];

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" className="chip" aria-pressed={on} onClick={onClick}>
      {on ? <IconCheck /> : null}
      {children}
    </button>
  );
}

function Facet({ title, level, children }: { title: string; level: 2 | 3; children: ReactNode }) {
  const id = useId();
  const Heading = `h${level}` as "h2" | "h3";
  return (
    <div className="stu-facet" role="group" aria-labelledby={id}>
      <Heading id={id} className="eyebrow">
        {title}
      </Heading>
      <div className="stu-chipset">{children}</div>
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
  const fitOn = f.fit !== false;
  const mine: Array<[Mine, string]> = [
    ["pinned", "Pinned"],
    ["set-aside", "Not for me"],
  ];
  return (
    <div className="stu-facets-body">
      <Facet level={level} title="Part">
        {browseParts(EXERCISES, ctx).map((p) => (
          <Toggle key={p} on={f.part === p} onClick={() => pick("part", p)}>
            {label(p)}
          </Toggle>
        ))}
      </Facet>
      <Facet level={level} title="Body area">
        {AREAS.map((g) => (
          <Toggle key={g} on={f.area === g} onClick={() => pick("area", g)}>
            {label(g)}
          </Toggle>
        ))}
      </Facet>
      {f.area && musclesIn(f.area).length > 1 ? (
        <Facet level={level} title={`${label(f.area)}: muscle`}>
          {musclesIn(f.area).map((m) => (
            <Toggle key={m} on={f.muscle === m} onClick={() => pick("muscle", m)}>
              {label(m)}
            </Toggle>
          ))}
        </Facet>
      ) : null}
      <Facet level={level} title="Contraction">
        {HOWS.map((c) => (
          <Toggle key={c} on={f.how === c} onClick={() => pick("how", c)}>
            {label(c)}
          </Toggle>
        ))}
      </Facet>
      <Facet level={level} title="Equipment">
        {ctx.place ? (
          <Toggle on={f.gear === undefined} onClick={() => setGear(undefined)}>
            {`At ${ctx.place.name}`}
          </Toggle>
        ) : null}
        <Toggle on={f.gear === "any" || (f.gear === undefined && !ctx.place)} onClick={() => setGear("any")}>
          Any equipment
        </Toggle>
        {GEAR.map((g) => (
          <Toggle key={g} on={f.gear === g} onClick={() => setGear(f.gear === g ? undefined : g)}>
            {EQUIPMENT[g]}
          </Toggle>
        ))}
      </Facet>
      <Facet level={level} title="Tags">
        {browseTags(EXERCISES).map((t) => (
          <Toggle key={t} on={f.tag === t} onClick={() => pick("tag", t)}>
            {label(t)}
          </Toggle>
        ))}
      </Facet>
      <Facet level={level} title="Theme">
        {visibleThemes(ctx).map((t) => (
          <Toggle key={t.id} on={f.theme === t.id} onClick={() => pick("theme", t.id)}>
            {t.name}
          </Toggle>
        ))}
      </Facet>
      <Facet level={level} title="Difficulty">
        {MAXES.map((m) => (
          <Toggle key={m} on={f.max === m} onClick={() => pick("max", m)}>
            {difficultyLabel(m).replace("Difficulty ", "")}
          </Toggle>
        ))}
      </Facet>
      {ctx.profiles.length > 0 ? (
        <Facet level={level} title="Today">
          <Toggle on={fitOn} onClick={() => pick("fit", false)}>
            Fits today
          </Toggle>
        </Facet>
      ) : null}
      <Facet level={level} title="Yours">
        {mine.map(([m, text]) => (
          <Toggle key={m} on={f.mine === m} onClick={() => pick("mine", m)}>
            {text}
          </Toggle>
        ))}
      </Facet>
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
