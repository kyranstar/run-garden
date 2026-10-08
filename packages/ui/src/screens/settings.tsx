import { Fragment, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  checkRestore,
  exportAccount,
  exportFileName,
  readExportFile,
  runRestore,
  type AccountExportFile,
  type CheckedRestore,
  type PlaceDto,
  type RestoreProgress,
  type StandaloneImportSummaryDto,
  type RestoreRowError,
  type RestoreSummary,
} from "@rg/api-client";
import { formatWeightIn, withWeightUnit, type UserPreferences, type Weight, type WeightUnit } from "@rg/domain";
import {
  Banner,
  Card,
  formatDayLong,
  formatDayShort,
  formatShortDate,
  relativeTime,
  Sheet,
  Spinner,
} from "../components.js";
import { md5Hex } from "../md5.js";
import { RestorePendingNotice } from "./restore-notice.js";
import { UnsyncedSessions } from "../components/unsynced-sessions.js";
import { forgetOfflineIdentity } from "../offline/me.js";
import { PlaceSheet } from "../components/place-sheet.js";
import { features } from "../features.js";

const TZ_OPTIONS: string[] = (() => {
  const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  return typeof sv === "function"
    ? sv("timeZone")
    : [
        "America/New_York",
        "America/Chicago",
        "America/Denver",
        "America/Los_Angeles",
        "Europe/London",
        "Europe/Paris",
        "Asia/Tokyo",
        "UTC",
      ];
})();

function TimeField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="time" value={value} onChange={(e) => onChange(e.target.value)} />
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  suffix,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label} ({suffix})
      </label>
      <input
        id={id}
        type="number"
        min={0}
        max={180}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

/** Exported for the units-selector unit test (settings.test.tsx). */
const FEET_PER_METRE = 3.28084;

/** What the Scheduling card saves — its own fields, never another card's. */
const SCHEDULING_KEYS = [
  "weekdayMorningTime",
  "weekdayEveningTime",
  "weekendMorningTime",
  "defaultWindow",
  "eveningReminderTime",
  "latestEveningFinish",
  "raceDate",
  "bufferBeforeMinutes",
  "bufferAfterMinutes",
  "raceDistanceKm",
  "raceCourseProfile",
  "raceCourseClimbMetres",
  "timezone",
] as const satisfies ReadonlyArray<keyof UserPreferences>;

export function SchedulingSection({ prefs }: { prefs: UserPreferences }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(prefs);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    // Only this card's own fields: the draft was copied when the page opened, and sending it whole would put back
    // whatever another card has changed since — a unit, a switch (Phase 2c).
    mutationFn: () => api.updateSettings(Object.fromEntries(SCHEDULING_KEYS.map((k) => [k, draft[k]])) as Partial<UserPreferences>),
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["today"] });
    },
  });
  const set = <K extends keyof UserPreferences>(k: K, v: UserPreferences[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  // Climb follows the same preference as every other distance: feet for a
  // miles athlete. Storage stays metric.
  const climbUnit = prefs.units === "mi" ? "ft" : "m";

  return (
    <Card title="Scheduling">
      <TimeField id="s-wm" label="Weekday morning run" value={draft.weekdayMorningTime} onChange={(v) => set("weekdayMorningTime", v)} />
      <TimeField id="s-we" label="Weekday evening run" value={draft.weekdayEveningTime} onChange={(v) => set("weekdayEveningTime", v)} />
      <TimeField id="s-sm" label="Weekend morning run" value={draft.weekendMorningTime} onChange={(v) => set("weekendMorningTime", v)} />
      <div className="field">
        <label htmlFor="s-window">Preferred window</label>
        <select
          id="s-window"
          value={draft.defaultWindow}
          onChange={(e) => set("defaultWindow", e.target.value as "morning" | "evening")}
        >
          <option value="morning">Morning</option>
          <option value="evening">Evening</option>
        </select>
      </div>
      <TimeField
        id="s-rem"
        label="Previous-evening reminder"
        value={draft.eveningReminderTime}
        onChange={(v) => set("eveningReminderTime", v)}
        hint="“Morning run tomorrow at 7:00 AM. Protect tonight's sleep.”"
      />
      <TimeField id="s-fin" label="Latest evening finish" value={draft.latestEveningFinish} onChange={(v) => set("latestEveningFinish", v)} />
      <div className="field">
        <label htmlFor="s-race">Race day</label>
        <input
          id="s-race"
          type="date"
          value={draft.raceDate ?? ""}
          onChange={(e) => set("raceDate", e.target.value || null)}
        />
        <span className="hint">
          Marked on your plan charts and cards; the coach plans the final weeks around it. Clear it
          when there's no race on the horizon.
        </span>
      </div>
      <div className="row" style={{ gap: "var(--space-5)" }}>
        <NumberField id="s-before" label="Buffer before" value={draft.bufferBeforeMinutes} onChange={(v) => set("bufferBeforeMinutes", v)} suffix="min" />
        <NumberField id="s-after" label="Buffer after" value={draft.bufferAfterMinutes} onChange={(v) => set("bufferAfterMinutes", v)} suffix="min" />
      </div>
      <div className="field">
        <label htmlFor="s-race-dist">Race distance</label>
        <select
          id="s-race-dist"
          value={draft.raceDistanceKm === null ? "" : String(draft.raceDistanceKm)}
          onChange={(e) => set("raceDistanceKm", e.target.value === "" ? null : Number(e.target.value))}
        >
          <option value="">Not set</option>
          <option value="5">5K</option>
          <option value="10">10K</option>
          <option value="21.0975">Half marathon</option>
          <option value="42.195">Marathon</option>
          {draft.raceDistanceKm !== null &&
          ![5, 10, 21.0975, 42.195].includes(draft.raceDistanceKm) ? (
            <option value={String(draft.raceDistanceKm)}>{draft.raceDistanceKm} km</option>
          ) : null}
        </select>
        <span className="hint">
          Turns your measured threshold into a goal time on the Plan page. Without it the race
          strip shows your threshold pace and makes no time prediction.
        </span>
      </div>
      <div className="field">
        <label htmlFor="s-course">Race course</label>
        <div className="row" style={{ gap: "var(--space-4)" }}>
          <select
            id="s-course"
            value={draft.raceCourseProfile ?? ""}
            onChange={(e) =>
              set(
                "raceCourseProfile",
                e.target.value === "" ? null : (e.target.value as "flat" | "rolling" | "hilly"),
              )
            }
          >
            <option value="">Not set</option>
            <option value="flat">Flat</option>
            <option value="rolling">Rolling</option>
            <option value="hilly">Hilly</option>
          </select>
          <span className="field-suffixed">
            <input
              id="s-course-climb"
              type="number"
              min={0}
              max={climbUnit === "ft" ? 65000 : 20000}
              placeholder="climb"
              aria-label={`Race course total climb in ${climbUnit === "ft" ? "feet" : "metres"}`}
              value={
                draft.raceCourseClimbMetres === null
                  ? ""
                  : climbUnit === "ft"
                    ? Math.round(draft.raceCourseClimbMetres * FEET_PER_METRE)
                    : draft.raceCourseClimbMetres
              }
              onChange={(e) =>
                set(
                  "raceCourseClimbMetres",
                  e.target.value === ""
                    ? null
                    : climbUnit === "ft"
                      ? Math.round((Number(e.target.value) / FEET_PER_METRE) * 10) / 10
                      : Number(e.target.value),
                )
              }
            />
            {/* The unit must never be a placeholder — it vanishes the moment
                a value is typed, and a climb read as metres instead of feet
                is off by 3.3× (live-reported 2026-08-14). */}
            <b aria-hidden>{climbUnit}</b>
          </span>
        </div>
        <span className="hint">
          The course's total climb from the race's own page is best; the category is the fallback.
          Compared against the climb your own runs actually carry.
        </span>
      </div>
      <div className="field">
        <label htmlFor="s-tz">Timezone</label>
        <input
          id="s-tz"
          type="text"
          list="tz-options"
          value={draft.timezone}
          onChange={(e) => set("timezone", e.target.value)}
          placeholder="Start typing a city…"
          autoComplete="off"
        />
        <datalist id="tz-options">
          {TZ_OPTIONS.map((tz) => (
            <option key={tz} value={tz} />
          ))}
        </datalist>
        <span className="hint">Type to search. Auto-synced from your Google Calendar when you connect it.</span>
      </div>
      <div className="row" style={{ gap: "var(--space-4)" }}>
        <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
          Save scheduling
        </button>
        {saved ? <span className="pill pill-ok">Saved</span> : null}
        {save.isError ? <span className="pill pill-warn">Couldn't save</span> : null}
      </div>
    </Card>
  );
}

// ── Phase 2c: health conditions, places and equipment, units, import (mocks §7) ─────────────────────────────────

/** Settings saved one at a time, as the control is tapped; the page's settings refresh after. */
function useSaveSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (partial: Partial<UserPreferences>) => api.updateSettings(partial),
    onSuccess: async (res) => {
      // What was saved shows at once: a read still in flight is cancelled first (it would land older settings over
      // the saved ones), and the refetch below brings the rest.
      await qc.cancelQueries({ queryKey: ["settings"] });
      qc.setQueryData(["settings"], (cur: unknown) => ({ ...(cur && typeof cur === "object" ? cur : {}), prefs: res.prefs }));
      for (const k of ["settings", "today", "plan", "plan-week", "library"]) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
}

/** The settings as they are now (a save elsewhere on the page included), the page's copy until they load. */
function useLivePrefs(prefs: UserPreferences): UserPreferences {
  const live = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  return live.data?.prefs ?? prefs;
}

/** Each condition profile the library knows, by its own name, with an on/off switch (spec §2c). */
export function HealthConditionsSection() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["conditions"], queryFn: api.listConditions });
  const toggle = useMutation({
    mutationFn: (c: { profileId: string; active: boolean }) => api.setCondition(c.profileId, c.active),
    onSuccess: (res) => {
      qc.setQueryData(["conditions"], res);
      for (const k of ["today", "programs", "library", "plan"]) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
  const profiles = list.data?.profiles ?? [];
  if (list.isError || (list.isSuccess && profiles.length === 0)) return null;
  return (
    <Card title="Health conditions" className="settings-new">
      {profiles.map((p) => {
        const on = toggle.isPending && toggle.variables?.profileId === p.profileId ? toggle.variables.active : p.active;
        return (
          <div key={p.profileId} className="setting-row">
            <div>
              <div>{p.label}</div>
              {on && p.since ? <small>{`Since ${formatShortDate(p.since)}`}</small> : null}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={p.label}
              className="program-switch"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate({ profileId: p.profileId, active: !p.active })}
            />
          </div>
        );
      })}
      {toggle.isError ? <Banner kind="warn">Couldn't save that — try again.</Banner> : null}
    </Card>
  );
}

/** A place's gear in a line: every label, or the count when there are many. */
function gearLine(place: PlaceDto, labels: Map<string, string>): string {
  if (place.equipment.length === 0) return "No equipment";
  if (place.equipment.length > 7) return `${place.equipment.length} items`;
  return place.equipment.map((id) => labels.get(id) ?? id).join(" · ");
}

/** The places, each with its gear and weights as typed; a default; the wishlist with what each item unlocks. */
export function PlacesSection({ prefs }: { prefs: UserPreferences }) {
  const places = useQuery({ queryKey: ["places"], queryFn: api.listPlaces });
  const live = useLivePrefs(prefs);
  const wishlist = live.equipmentWishlist;
  const library = useQuery({ queryKey: ["library", "wishlist"], queryFn: () => api.listLibrary(), enabled: wishlist.length > 0 });
  const saveSetting = useSaveSetting();
  const [open, setOpen] = useState<PlaceDto | "new" | null>(null);
  const vocabulary = places.data?.equipment ?? [];
  const labels = new Map(vocabulary.map((v) => [v.id, v.label]));
  const unlocks = new Map((library.data?.wishlist ?? []).map((w) => [w.equipmentId, w.unlocks]));
  const shown = saveSetting.isPending && saveSetting.variables?.equipmentWishlist ? saveSetting.variables.equipmentWishlist : wishlist;
  // Gear the default place already has is not a wish (Audit 2c-A MINOR-7).
  const owned = new Set((places.data?.places ?? []).find((p) => p.isDefault)?.equipment ?? []);
  const addable = vocabulary.filter((v) => !shown.includes(v.id) && !owned.has(v.id));

  if (places.isError) return null;
  return (
    <Card title="Places & equipment" className="settings-new">
      {(places.data?.places ?? []).map((p) => (
        <button key={p.id} type="button" className="place-row" onClick={() => setOpen(p)}>
          <span className="place-row-main">
            <b>
              {p.name}
              {p.isDefault ? <span className="faint"> · Default</span> : null}
            </b>
            <small>{gearLine(p, labels)}</small>
            {/* A list kept with no unit (saved before lists took one) is read in the unit in force: show it (Audit 2c-A MINOR-4). */}
            {Object.entries(p.implements).map(([id, typed]) => (
              <small key={id} className="place-weights">{`${labels.get(id) ?? id}: ${withWeightUnit(typed, live.weightUnit)}`}</small>
            ))}
          </span>
          <span className="faint" aria-hidden>
            ›
          </span>
        </button>
      ))}
      <button type="button" className="settings-link" disabled={!places.isSuccess} onClick={() => setOpen("new")}>
        Add a place
      </button>
      <h3 className="settings-subhead">Wishlist</h3>
      {shown.map((id) => (
        <div key={id} className="setting-row">
          <span>{labels.get(id) ?? id}</span>
          <span className="setting-row-end">
            {unlocks.has(id) ? <span className="faint">{`+${unlocks.get(id)} moves`}</span> : null}
            <button
              type="button"
              className="icon-tap"
              aria-label={`Remove ${labels.get(id) ?? id}`}
              disabled={saveSetting.isPending}
              onClick={() => saveSetting.mutate({ equipmentWishlist: shown.filter((x) => x !== id) })}
            >
              ✕
            </button>
          </span>
        </div>
      ))}
      {addable.length > 0 ? (
        <select
          className="settings-select"
          aria-label="Add to wishlist"
          value=""
          disabled={saveSetting.isPending || !places.isSuccess}
          onChange={(e) => {
            if (e.target.value) saveSetting.mutate({ equipmentWishlist: [...shown, e.target.value] });
          }}
        >
          <option value="">Add to wishlist…</option>
          {addable.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
      ) : null}
      {saveSetting.isError ? <Banner kind="warn">Couldn't save that — try again.</Banner> : null}
      {open ? <PlaceSheet place={open === "new" ? null : open} vocabulary={vocabulary} onClose={() => setOpen(null)} /> : null}
    </Card>
  );
}

/** One unit setting as a segmented choice, saved on a tap. */
function UnitChoice<K extends "units" | "temperatureUnit" | "weightUnit">({
  name,
  setting,
  value,
  options,
  save,
}: {
  name: string;
  setting: K;
  value: UserPreferences[K];
  options: ReadonlyArray<{ value: UserPreferences[K]; label: string }>;
  save: ReturnType<typeof useSaveSetting>;
}) {
  const pending = save.isPending ? (save.variables as Partial<UserPreferences> | undefined)?.[setting] : undefined;
  const current = pending ?? value;
  return (
    <div className="setting-row">
      <span>{name}</span>
      <div className="program-seg units-seg" role="group" aria-label={name}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={current === o.value}
            disabled={save.isPending}
            onClick={() => {
              if (o.value !== current) save.mutate({ [setting]: o.value } as Partial<UserPreferences>);
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Distance, temperature and weights (spec §2c "Units"): each saved alone, on a tap. */
export function UnitsSection({ prefs: initial }: { prefs: UserPreferences }) {
  const prefs = useLivePrefs(initial);
  const save = useSaveSetting();
  return (
    <Card title="Units" className="settings-new">
      <UnitChoice name="Distance" setting="units" value={prefs.units} options={[{ value: "km", label: "km" }, { value: "mi", label: "mi" }]} save={save} />
      <UnitChoice name="Temperature" setting="temperatureUnit" value={prefs.temperatureUnit} options={[{ value: "F", label: "°F" }, { value: "C", label: "°C" }]} save={save} />
      <UnitChoice name="Weights" setting="weightUnit" value={prefs.weightUnit} options={[{ value: "lb", label: "lb" }, { value: "kg", label: "kg" }]} save={save} />
      {save.isError ? <Banner kind="warn">Couldn't save that — try again.</Banner> : null}
    </Card>
  );
}

type ImportOracle = StandaloneImportSummaryDto["oracle"];
type OracleSet = { w: Weight | null; reps: number | null; secs: number | null };

/** A set as the tool's lift tile writes it: the weight in the tool's unit × reps, else the reps, else the hold. */
function oracleSet(s: OracleSet, unit: WeightUnit): string {
  if (s.w) return `${formatWeightIn(s.w, unit)}${s.reps != null ? ` × ${s.reps}` : s.secs ? ` · ${s.secs} s` : ""}`;
  return s.reps != null ? `${s.reps} reps` : s.secs ? `${s.secs} s` : "—";
}

/**
 * The standalone tool's own numbers over the file, laid out as its Progress tab reads them, for the owner to hold
 * side by side with that tab (Phase 2c Task 5; the oracle — Audit 2c-A MINOR-1): the totals, each of the last eight
 * weeks (sessions; volume in the tool's unit, and the whole kilos beside pounds), and each core lift's latest top set
 * as its lift tile shows it, with the best.
 */
function ImportNumbers({ oracle }: { oracle: ImportOracle }) {
  const unit = oracle.unit;
  const pounds = unit !== "kg";
  const count = (n: number) => n.toLocaleString("en-US");
  return (
    <>
      <h3 className="settings-subhead">Progress</h3>
      <div className="import-compare">
        <div className="setting-row">
          <span>Sessions</span>
          <b className="num">{count(oracle.sessionCount)}</b>
        </div>
        <div className="setting-row">
          <span>Records</span>
          <b className="num">{count(oracle.records)}</b>
        </div>
        <div className="setting-row">
          <span>Before and after</span>
          <b className="num">{count(oracle.prePostPairs)}</b>
        </div>
        {oracle.block ? (
          <div className="setting-row">
            <span>Block</span>
            <b className="num">{`${oracle.block.number} · week ${oracle.block.week}`}</b>
          </div>
        ) : null}
      </div>
      <h3 className="settings-subhead">Per week</h3>
      <table className="import-weeks num">
        <thead>
          <tr>
            <th scope="col">Week</th>
            <th scope="col">Sessions</th>
            <th scope="col">{unit}</th>
            {pounds ? <th scope="col">kg</th> : null}
          </tr>
        </thead>
        <tbody>
          {oracle.sessionsPerWeek.map((w, i) => {
            const v = oracle.weeklyVolume[i];
            return (
              <tr key={w.week}>
                <th scope="row">{formatShortDate(w.week)}</th>
                <td>{count(w.sessions)}</td>
                <td>{v ? count(v.inUnit) : "—"}</td>
                {pounds ? <td>{v ? count(v.kg) : "—"}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      {oracle.bestByCoreLift.length > 0 ? (
        <>
          <h3 className="settings-subhead">Lifts</h3>
          <div className="import-lifts">
            {oracle.bestByCoreLift.map((l) => (
              <div key={l.exerciseId} className="setting-row">
                <div>
                  <b>{l.name}</b>
                  {l.latest ? <small>{`Latest ${oracleSet(l.latest, unit)}`}</small> : null}
                  {l.best ? <small>{`Best ${oracleSet(l.best, unit)}`}</small> : null}
                  {!l.latest && !l.best ? <small>Not logged</small> : null}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

type ImportSummary = StandaloneImportSummaryDto;

/** "1 session", "183 sessions". */
const counted = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * A span of days with its year, oldest first (Audit C M-2): "Aug 3 – Sep 30, 2026"; across a new year both years,
 * "Oct 6, 2025 – Sep 28, 2026"; one day, "Sep 28, 2026".
 */
function importSpan(a: string | null, b: string | null): string | null {
  if (!a || !b) return null;
  const [first, last] = a <= b ? [a, b] : [b, a];
  const day = (d: string) => `${formatShortDate(d)}, ${d.slice(0, 4)}`;
  if (first === last) return day(last);
  return first.slice(0, 4) === last.slice(0, 4) ? `${formatShortDate(first)} – ${day(last)}` : `${day(first)} – ${day(last)}`;
}

/** Why the dry run (`read`) or the import was refused, in its own words (Audit C M-3). */
function importRefusal(e: unknown, step: "read" | "import"): string {
  const status = e instanceof ApiError ? e.status : null;
  const body = (e instanceof ApiError ? e.body : null) as { error?: unknown; reason?: unknown } | null;
  if (status === 422 && body?.reason === "newer_version") return "That backup is from a newer version of the standalone tool — Run Garden can't read it yet.";
  if (status === 422) return "That file isn't a backup from the standalone tool.";
  if (status === 423) return "A restore is running — import after it finishes.";
  if (status === 503 && body?.error === "busy") return "Another import is running — try again in a moment.";
  return step === "read" ? "Couldn't read that file — try again." : "Couldn't import that — try again.";
}

function SummaryRow({ title, note }: { title: string; note?: string | null }) {
  return (
    <div className="setting-row">
      <div>
        <b>{title}</b>
        {note ? <small>{note}</small> : null}
      </div>
    </div>
  );
}

/** What the import does to the program — one of ruling 2d-R5's three. */
function ProgramOutcomeRow({ s }: { s: ImportSummary }) {
  const block = s.block ? `block ${s.block.number} · week ${s.block.week}` : null;
  const lifts = counted(s.oracle.bestByCoreLift.length, "core lift");
  const name = s.program.name;
  if (s.program.outcome === "created") {
    return <SummaryRow title={`Makes the program ${name ?? ""}`.trim()} note={block ? `${block[0]!.toUpperCase()}${block.slice(1)} · ${lifts}` : null} />;
  }
  if (s.program.outcome === "adopted") return <SummaryRow title={`${name ?? "Your program"} takes ${block ?? "the file's block"}`} note={`${lifts} · its own settings stay`} />;
  return (
    <SummaryRow
      title={name ? `Your program ${name} stays as it is` : "Your programs stay as they are"}
      note={s.block ? "The file's block isn't used" : null}
    />
  );
}

/** The weight unit after the import (ruling 2d-R6): the tool's, or the account's kept. */
function WeightUnitRow({ s }: { s: ImportSummary }) {
  const { before, after } = s.weightUnit;
  if (after !== before) return <SummaryRow title={`Weights switch to ${after}`} note="The tool's setting" />;
  if (s.oracle.unit !== before) return <SummaryRow title={`Weights stay in ${before}`} note="Your setting here" />;
  return <SummaryRow title={`Weights in ${before}`} note="As in the tool" />;
}

/**
 * The summary sheet (mocks §7): only what the import will write (Audit C M-1) — the new sessions and their span, and
 * on a first import what happens to the program, the places and ratings it adds and the weight unit — and that
 * history stays out of the garden.
 */
function ImportSummaryRows({ s }: { s: ImportSummary }) {
  const added = s.firstImport ? counted(s.sessions.added, "session") : counted(s.sessions.added, "new session");
  const settings = [s.places.length ? counted(s.places.length, "place") : null, s.ratings ? counted(s.ratings, "rating") : null].filter(Boolean);
  return (
    <div className="import-summary">
      <SummaryRow title={added} note={importSpan(s.sessions.addedFirstDate, s.sessions.addedLastDate)} />
      {s.firstImport ? (
        <>
          <ProgramOutcomeRow s={s} />
          {settings.length ? <SummaryRow title={settings.join(" · ")} note={s.places.length ? s.places.join(", ") : null} /> : null}
          <WeightUnitRow s={s} />
        </>
      ) : (
        <SummaryRow title="Nothing else changes" note="Program, places and settings stay as they are" />
      )}
      <SummaryRow title="History stays out of the garden" note="Activity and records show it" />
      {s.sessions.invalid.length ? <small className="faint">{`${counted(s.sessions.invalid.length, "session")} skipped`}</small> : null}
    </div>
  );
}

/**
 * Import (spec §2c; mocks §7; Phase 2c Task 5): the standalone tool's backup — a dry run first and its summary (what
 * comes in; history stays out of the garden), then Import, then the tool's own numbers to compare with its Progress
 * tab (`ImportNumbers`). A backup already imported shows those numbers straight away. Hidden until the garden gate
 * keeps imported history out of the garden (`features.import`, Phase 2d): nothing reaches the importer before then.
 */
export function ImportSection() {
  const qc = useQueryClient();
  const [file, setFile] = useState<{ backup: unknown; exportedAt: string | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const dryRun = useMutation({ mutationFn: (backup: unknown) => api.importStandalone(backup, { dryRun: true }) });
  const run = useMutation({
    mutationFn: (backup: unknown) => api.importStandalone(backup),
    onSuccess: () => {
      for (const k of ["places", "conditions", "programs", "settings", "library", "today", "plan", "activities"]) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
  if (!features.import) return null;

  const choose = async (e: ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files?.[0];
    e.target.value = "";
    if (!chosen) return;
    setProblem(null);
    try {
      const backup = JSON.parse(await chosen.text()) as unknown;
      const exportedAt = typeof (backup as { lastExport?: unknown })?.lastExport === "string" ? String((backup as { lastExport: string }).lastExport) : null;
      setFile({ backup, exportedAt });
      run.reset();
      dryRun.mutate(backup);
    } catch {
      setProblem("That file isn't a backup from the standalone tool.");
    }
  };
  const close = () => {
    setFile(null);
    dryRun.reset();
    run.reset();
  };
  const s = run.data ?? dryRun.data;
  const date = file?.exportedAt && /^\d{4}-\d{2}-\d{2}/.test(file.exportedAt) ? formatShortDate(file.exportedAt.slice(0, 10)) : null;
  // A backup already imported: nothing would be written, so its numbers show at once.
  const nothingNew = !!dryRun.data && dryRun.data.sessions.added === 0 && !dryRun.data.firstImport;
  const finished = run.isSuccess || nothingNew;

  return (
    <Card title="Import" className="settings-new">
      <label className="place-row place-file">
        <span className="place-row-main">
          <b>From the standalone tool…</b>
          <small>Sessions, block, places and ratings</small>
        </span>
        <span className="faint" aria-hidden>
          ›
        </span>
        <input type="file" accept=".json,application/json" className="visually-hidden" onChange={(e) => void choose(e)} />
      </label>
      {problem ? <Banner kind="warn">{problem}</Banner> : null}
      {file ? (
        <Sheet
          open
          onClose={close}
          title={date ? `Import backup · ${date}` : "Import backup"}
          footer={
            finished ? (
              <button type="button" className="btn btn-primary" onClick={close}>
                Done
              </button>
            ) : (
              <button type="button" className="btn btn-primary" disabled={!dryRun.isSuccess || run.isPending} onClick={() => run.mutate(file.backup)}>
                Import
              </button>
            )
          }
        >
          {dryRun.isPending ? <Spinner label="Reading the backup" /> : null}
          {dryRun.isError ? <Banner kind="warn">{importRefusal(dryRun.error, "read")}</Banner> : null}
          {run.isError ? <Banner kind="warn">{importRefusal(run.error, "import")}</Banner> : null}
          {s && finished ? (
            <div className="import-result">
              {run.isSuccess ? (
                <SummaryRow title={`${counted(s.sessions.added, "session")} imported`} note={importSpan(s.sessions.addedFirstDate, s.sessions.addedLastDate)} />
              ) : (
                <SummaryRow title="Nothing new to import" note={importSpan(s.sessions.firstDate, s.sessions.lastDate)} />
              )}
              {s.sessions.invalid.length ? <small className="faint">{`${counted(s.sessions.invalid.length, "session")} skipped`}</small> : null}
              <ImportNumbers oracle={s.oracle} />
            </div>
          ) : null}
          {s && !finished ? <ImportSummaryRows s={s} /> : null}
        </Sheet>
      ) : null}
    </Card>
  );
}

/**
 * The one-shot deep history walk. Distinct from the rolling 14-day snapshot:
 * this reaches back as far as the account goes, across all three disciplines,
 * and runs in the cloud one 90-day chunk at a time (legacy: desktop bridge).
 */
function BackfillRow() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["backfill-status"],
    queryFn: api.backfillStatus,
    // Poll while there is something to watch: an active or queued walk, or an
    // errored one whose job is still live (the walker can resume it — the
    // copy must catch up when it does).
    refetchInterval: (q) => {
      const d = q.state.data;
      return d?.status === "running" || d?.status === "queued" || (d?.status === "error" && d.jobQueued)
        ? 5000
        : false;
    },
  });
  const coros = useQuery({ queryKey: ["coros-status"], queryFn: api.corosStatus });
  const cloud = coros.data?.connected === true;
  const start = useMutation({
    mutationFn: api.backfillHistory,
    onSuccess: () => {
      void status.refetch();
      void qc.invalidateQueries({ queryKey: ["runs"] });
    },
  });

  const s = status.data;
  const running = s?.status === "running";
  const queued = s?.status === "queued";
  // Honest states: queued names the executor it's waiting on, and an error
  // names which way it went wrong — never a spinner over nothing.
  const detail =
    s?.status === "error"
      ? cloud
        ? "It stalled — press Run again; the cloud walker resumes where it left off."
        : s.lastErrorCategory === "never_started"
        ? "It never started — connect COROS above and press Run again."
        : s.lastErrorCategory === "stalled"
          ? `It stopped partway through (${s.activitiesIngested} sessions so far). Press Run again — the walk resumes where it left off.`
          : "Couldn't read your history — press Run again."
      : queued
        ? cloud
          ? "Queued — running in the cloud; the first chunk lands within a minute."
          : "Queued — connect COROS above and it runs in the cloud."
        : running
          ? `Reading your COROS history — ${s.chunksCompleted} ${s.chunksCompleted === 1 ? "chunk" : "chunks"}, ${s.activitiesIngested} sessions so far${s.earliestDateReached ? `, back to ${s.earliestDateReached}` : ""}.`
          : s?.status === "done"
            ? `History loaded: ${s.activitiesIngested} sessions${s.earliestDateReached ? ` back to ${s.earliestDateReached}` : ""}.`
            : cloud
          ? "Pull your full run, lift, and yoga history from COROS. Runs once, in the cloud."
          : "Pull your full run, lift, and yoga history from COROS. Connect COROS above first — it runs in the cloud.";

  return (
    <div className="switch-row">
      <div>
        <strong>History</strong>
        <p className="faint">{detail}</p>
      </div>
      <button
        className="btn btn-small"
        disabled={start.isPending || running || queued}
        onClick={() => start.mutate()}
      >
        {running
          ? "Reading…"
          : queued
            ? "Queued…"
            : s?.status === "done" || s?.status === "error"
              ? "Run again"
              : "Backfill history"}
      </button>
    </div>
  );
}

/**
 * The official COROS sleep connection (sleep/recovery phase 2). This is the
 * ONE opt-in that adds nightly duration and depth: OAuth on the athlete's
 * own COROS account via the first-party MCP server — never the mobile API
 * that logs the phone app out. Nightly sleep HRV already flows without it.
 */
function CorosSleepRow({
  conn,
}: {
  conn: { status: string; lastSyncAt: string | null; lastErrorCategory: string | null } | undefined;
}) {
  const qc = useQueryClient();
  const disconnect = useMutation({
    mutationFn: api.corosMcpDisconnect,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["me"] }),
  });
  const connected = conn?.status === "connected";
  const needsReauth = conn?.status === "error";
  return (
    <div className="switch-row">
      <div>
        <strong>Sleep from COROS</strong>
        <p className="faint">
          {needsReauth
            ? "Sleep sync stopped — COROS expired the connection. Reconnect to resume."
            : connected
              ? `Connected · nightly duration and depth${conn?.lastSyncAt ? ` · synced ${relativeTime(conn.lastSyncAt)}` : ""}`
              : "Adds nightly duration and deep/REM. Opens COROS sign-in — your watch and phone app are untouched."}
        </p>
      </div>
      {connected ? (
        <button
          className="btn btn-small"
          disabled={disconnect.isPending}
          onClick={() => disconnect.mutate()}
        >
          Disconnect
        </button>
      ) : (
        <a className="btn btn-small" href="/api/auth/coros-mcp/start?redirect=/settings">
          {needsReauth ? "Reconnect" : "Connect"}
        </a>
      )}
    </div>
  );
}

function ConnectionsSection() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const calendars = useQuery({ queryKey: ["calendars"], queryFn: api.calendars, retry: false });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [chooseOpen, setChooseOpen] = useState(false);
  const choose = useMutation({
    mutationFn: (opts: { calendarId?: string; createNew?: boolean }) => api.chooseCalendar(opts),
    onSuccess: () => {
      setChooseOpen(false);
      void qc.invalidateQueries();
    },
  });
  const syncNow = useMutation({ mutationFn: api.calendarSync });

  const conn = (p: string) => me.data?.connections.find((c) => c.provider === p);
  const google = conn("google_calendar");
  const calendarChosen = !!settings.data?.prefs.calendarId;

  return (
    <Card title="Connections">
      <div className="switch-row">
        <div>
          <strong>Google Calendar</strong>
          <p className="faint">
            {google?.status === "error"
              ? "Mirroring stopped — Google expired the connection. Reconnect to resume."
              : google?.status === "connected"
                ? calendarChosen
                  ? `Connected · mirroring workouts${google.lastSyncAt ? ` · synced ${relativeTime(google.lastSyncAt)}` : ""}`
                  : "Connected · choose a calendar to start mirroring"
                : "Mirrors workouts with reminders"}
          </p>
        </div>
        {google?.status === "connected" ? (
          <div className="btn-row">
            <button className="btn btn-small" onClick={() => setChooseOpen(true)}>
              {calendarChosen ? "Change calendar" : "Choose calendar"}
            </button>
            {calendarChosen ? (
              <button className="btn btn-small" disabled={syncNow.isPending} onClick={() => syncNow.mutate()}>
                Sync now
              </button>
            ) : null}
          </div>
        ) : (
          <a className="btn btn-small" href="/api/auth/google/start?mode=calendar&redirect=/settings">
            {google?.status === "error" ? "Reconnect" : "Connect"}
          </a>
        )}
      </div>

      <CorosSleepRow conn={conn("coros_mcp")} />

      <Sheet open={chooseOpen} onClose={() => setChooseOpen(false)} title="Choose a calendar">
        <div className="stack">
          <button
            className="btn btn-primary"
            disabled={choose.isPending}
            onClick={() => choose.mutate({ createNew: true })}
          >
            Create a dedicated “Run Garden” calendar
          </button>
          {calendars.data?.calendars.map((cal) => (
            <button
              key={cal.id}
              className="btn"
              disabled={choose.isPending}
              onClick={() => choose.mutate({ calendarId: cal.id })}
            >
              {cal.summary}
              {cal.primary ? " (primary)" : ""}
            </button>
          ))}
          {calendars.isError ? (
            <Banner kind="warn">Connect Google Calendar first, then choose a calendar.</Banner>
          ) : null}
        </div>
      </Sheet>
    </Card>
  );
}

/** Cloud COROS connection (cloud-direct spec §1): email + password, hashed
 * in the browser before the request — the plaintext never leaves this
 * device. Exposed states: disconnected form / connected line / rejected
 * credentials with the form re-opened. */
export function CorosConnectSection() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["coros-status"], queryFn: api.corosStatus });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [region, setRegion] = useState<"us" | "eu" | "cn">("us");
  const [result, setResult] = useState<string | null>(null);
  const [failCode, setFailCode] = useState<string | null>(null);
  const connect = useMutation({
    mutationFn: () => {
      const pwdMd5 = md5Hex(password);
      return api.corosConnect({ email: email.trim(), pwdMd5, region });
    },
    onSuccess: (r) => {
      setResult(r.status);
      setFailCode(r.code ?? null);
      if (r.status === "connected") {
        setPassword("");
        // The connect kicked the first pull server-side — drop every cache
        // that pull can change, so screens refetch as it lands.
        for (const k of ["coros-status", "sync-status", "coros-read-now", "backfill-status"]) {
          void qc.invalidateQueries({ queryKey: [k] });
        }
      }
    },
    onError: () => {
      setResult("login_failed");
      setFailCode(null);
    },
  });
  const disconnect = useMutation({
    mutationFn: api.corosDisconnect,
    onSuccess: () => {
      setResult(null);
      void qc.invalidateQueries({ queryKey: ["coros-status"] });
    },
  });

  const s = status.data;
  const connected = s?.connected === true;
  const badCreds = s?.lastErrorCategory === "bad_credentials" || result === "bad_credentials";

  return (
    <Card title="COROS connection">
      {/* System 4 D2. `connected = s?.connected === true` reads "not connected"
          out of a query that has not answered, so a connected athlete was
          shown the whole ~300px connect form — email, password, region, the
          hashing reassurance — and then, 3s later, watched it collapse to one
          line: measured −136px with 37 landmarks jumping UPWARD, which is the
          worse direction, because by then their thumb is already moving.

          There is no honest slot to reserve here: the two branches differ by
          250px and reserving the taller one would leave a permanent hole for
          the connected majority. So the card WAITS, and while it waits it
          says so in a line the same shape as the answer it expects — one
          `.muted` paragraph. For the common (connected) case that is a 0px
          swap; for the disconnected case the form opens downward, and nothing
          above this card ever moves. */}
      {status.isLoading ? (
        <p className="muted">
          Checking your COROS connection… Once it's linked, activities and watch updates flow
          directly.
        </p>
      ) : connected && !badCreds ? (
        <div className="stack" style={{ gap: "var(--space-4)" }}>
          <p className="muted">
            Connected as <strong>{s?.email}</strong>
            {s?.lastSyncAt ? ` · last sync ${relativeTime(s.lastSyncAt)}` : " · first sync pending"}.
            Activities and watch updates flow directly.
          </p>
          <div>
            <button className="btn btn-small" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <form
          className="stack"
          style={{ gap: "var(--space-4)", maxWidth: "26rem" }}
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim() && password) connect.mutate();
          }}
        >
          {badCreds ? (
            <Banner kind="warn">COROS rejected the password — check it and try again.</Banner>
          ) : result === "login_failed" && failCode ? (
            <Banner kind="warn">
              COROS didn't accept this login (code {failCode}). Double-check the email, and if your
              account lives on another COROS server, switch the region below and try again.
            </Banner>
          ) : result === "login_failed" ? (
            <Banner kind="warn">Couldn't reach COROS just now — try again in a moment.</Banner>
          ) : (
            <p className="muted">
              Connect your COROS account so activities appear the moment you open the app. Your
              password is hashed on this device before it's sent, and only the hash is stored —
              encrypted.
            </p>
          )}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="COROS account email"
            aria-label="COROS account email"
            autoComplete="username"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="COROS password"
            aria-label="COROS password"
            autoComplete="current-password"
          />
          <label className="row" style={{ gap: "var(--space-4)" }}>
            <span className="muted">Region</span>
            <select value={region} onChange={(e) => setRegion(e.target.value as "us" | "eu" | "cn")} aria-label="COROS region">
              <option value="us">Americas / global</option>
              <option value="eu">Europe</option>
              <option value="cn">China</option>
            </select>
          </label>
          <div>
            <button className="btn btn-primary" type="submit" disabled={connect.isPending || !email.trim() || !password}>
              {connect.isPending ? "Checking with COROS…" : "Connect"}
            </button>
          </div>
        </form>
      )}
      <BackfillRow />
    </Card>
  );
}


function CorosSyncSection({ prefs }: { prefs: UserPreferences }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (corosWritesEnabled: boolean) => api.updateSettings({ corosWritesEnabled }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["plan"] });
      void qc.invalidateQueries({ queryKey: ["today"] });
    },
  });
  return (
    <Card title="COROS sync">
      <div className="switch-row">
        <div>
          <strong>Write date changes back to COROS</strong>
          <p className="faint">
            When you move a workout here, your COROS calendar is updated to match (verified
            after every write). When off, moves only change Run Garden and Google Calendar —
            workouts you move show “Not synced to COROS”.
          </p>
        </div>
        <button
          className="btn btn-small"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(!prefs.corosWritesEnabled)}
        >
          {prefs.corosWritesEnabled ? "Disable" : "Enable"}
        </button>
      </div>
    </Card>
  );
}

function AiSection({ prefs }: { prefs: UserPreferences }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const toggle = useMutation({
    mutationFn: (aiEnabled: boolean) => api.updateSettings({ aiEnabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["settings"] }),
  });
  const llm = settings.data?.llm;
  return (
    <Card title="AI">
      <div className="switch-row">
        <div>
          <strong>Activity reads &amp; weekly narration</strong>
          <p className="faint">
            This switch gates the coach&apos;s automatic activity reads and the weekly review
            narration. Coach chat, check-ins, and Studio plan generation are also AI-powered but
            run only when you ask. Scheduling, sync, and the garden are fully deterministic.
          </p>
        </div>
        <button className="btn btn-small" disabled={toggle.isPending} onClick={() => toggle.mutate(!prefs.aiEnabled)}>
          {prefs.aiEnabled ? "Disable AI" : "Enable AI"}
        </button>
      </div>
      {llm ? (
        <p className="muted" style={{ marginTop: "var(--space-4)" }}>
          Spend this week: ${llm.spentDollars.toFixed(2)} of ${llm.cutoffDollars.toFixed(0)} cutoff
          {llm.cutoff ? " — AI calls paused until the rolling week clears." : llm.warn ? " — approaching the warning level." : "."}
        </p>
      ) : null}
    </Card>
  );
}

function DiagnosticsSection() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const diagnostics = useQuery({
    queryKey: ["diagnostics"],
    queryFn: api.diagnostics,
    enabled: open,
  });
  const syncStatus = useQuery({
    queryKey: ["sync-status"],
    queryFn: api.syncStatus,
    enabled: open,
  });
  const syncNow = useMutation({
    mutationFn: api.readNow,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sync-status"] });
      void qc.invalidateQueries({ queryKey: ["diagnostics"] });
    },
  });

  const download = () => {
    const blob = new Blob([JSON.stringify(diagnostics.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "run-garden-diagnostics.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card title="Diagnostics">
      {/* A real toggle (System 4 D6). This used to REPLACE itself with its own
          content: after the tap there was no "Show diagnostics" and no "Hide"
          anywhere on the page, so the 262px it had just opened could only be
          closed by reloading — and because the state is not persisted, the
          reload also threw it away. The button now survives its own click, in
          the same slot, with the detail below it. */}
      <div className="stack">
        {/* The button is wrapped so it keeps its own width rather than
            stretching to the stack, and so the gap above the body is the
            stack's, not a second margin. */}
        <div>
          <button
            className="btn"
            aria-expanded={open}
            aria-controls="diag-body"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide diagnostics" : "Show diagnostics"}
          </button>
        </div>
        <div id="diag-body" className="disclosure-body">
          {!open ? null : diagnostics.isLoading ? (
            <Spinner />
          ) : diagnostics.data ? (
            <div className="stack">
              <DiagRows data={diagnostics.data} />
              {syncStatus.data?.lastCorosReadAt ? (
                <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
                  Last successful COROS read:{" "}
                  {new Date(syncStatus.data.lastCorosReadAt).toLocaleString()}
                </p>
              ) : null}
              <div className="btn-row">
                <button
                  className="btn btn-small"
                  disabled={syncNow.isPending}
                  onClick={() => syncNow.mutate()}
                >
                  {syncNow.isPending ? "Syncing…" : "Sync now"}
                </button>
                <button className="btn btn-small" onClick={download}>
                  Download sanitized JSON
                </button>
              </div>
            </div>
          ) : (
            <p className="muted">Couldn't load diagnostics.</p>
          )}
        </div>
      </div>
    </Card>
  );
}

function DiagRows({ data }: { data: Record<string, unknown> }) {
  const coros = data.coros as { lastRead: string | null; pendingWriteJobs: number } | undefined;
  const versions = data.versions as Record<string, unknown> | undefined;
  const providers = (data.providers as Array<{ provider: string; status: string; lastSyncAt: string | null }>) ?? [];
  const errors = (data.recentErrors as Array<{ category: string; createdAt: string; provider: string | null }>) ?? [];
  return (
    <div className="muted" style={{ fontSize: "var(--text-sm)" }}>
      <p>App {String(data.appVersion)} · fixture mode {data.fixtureMode ? "ON" : "off"}</p>
      <p>
        COROS: last read {coros?.lastRead ? new Date(coros.lastRead).toLocaleString() : "never"} ·{" "}
        {coros?.pendingWriteJobs ?? 0} pending write jobs
      </p>
      {providers.map((p) => (
        <p key={p.provider}>
          {p.provider}: {p.status}
          {p.lastSyncAt ? ` · synced ${new Date(p.lastSyncAt).toLocaleString()}` : ""}
        </p>
      ))}
      <p>
        Versions — simulation {String(versions?.simulation)} · normalizer {String(versions?.normalizer)} · estimator{" "}
        {String(versions?.estimator)} · garden day {String(versions?.gardenLastSimulated)}
      </p>
      <p>LLM cost (7d): ${Number(data.llmCost7dDollars ?? 0).toFixed(2)}</p>
      {errors.length > 0 ? (
        <details>
          <summary>Recent errors ({errors.length})</summary>
          {errors.map((e, i) => (
            <p key={i}>
              {formatDayShort(e.createdAt.slice(0, 10))} · {e.provider ?? "app"} · {e.category}
            </p>
          ))}
        </details>
      ) : (
        <p>No recent errors.</p>
      )}
    </div>
  );
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Where a restore stands (audit 1 data findings 5, 7, 8; rulings B1, B7, B8):
 * the file is checked page by page with the worker — no side effects — and
 * only a clean check reaches the confirm step; the confirm step says what the
 * file is before the one destructive tap; the summary says what to do next.
 */
export type RestoreStep =
  | { kind: "idle" }
  | { kind: "checking"; file: AccountExportFile; progress: RestoreProgress | null }
  | { kind: "problems"; file: AccountExportFile; errors: RestoreRowError[] }
  | { kind: "confirm"; file: AccountExportFile; checked: CheckedRestore }
  | { kind: "running"; file: AccountExportFile; checked: CheckedRestore; progress: RestoreProgress | null }
  | { kind: "done"; file: AccountExportFile; summary: RestoreSummary }
  | { kind: "failed"; file: AccountExportFile; checked: CheckedRestore | null; message: string };

function restoreErrorText(err: unknown): string {
  const body = err instanceof ApiError ? (err.body as { error?: string; table?: string; row?: number } | null) : null;
  switch (body?.error) {
    case "insert_failed":
      return `The restore stopped at ${body.table} row ${(body.row ?? 0) + 1}.`;
    case "no_active_restore":
      return "Another restore started, in another tab or device.";
    case "restore_running":
      return "A restore is already running on another device. Let it finish, or try again in a couple of minutes.";
    case "check_required":
      return "The file changed after it was checked. Choose it again.";
    case "check_expired":
      return "The check expired — it lasts a day. Choose the file again to check it.";
    case "check_incomplete":
      return "The check didn't cover the whole file. Choose it again.";
    case "newer_schema":
      return "This file is from a newer version of the app.";
    default:
      return "Restore stopped partway. Try again.";
  }
}

const hostOf = (origin: string | undefined): string | null => {
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

function ageText(exportedAt: string, now: Date): string {
  const days = Math.floor((now.getTime() - Date.parse(exportedAt)) / 86_400_000);
  if (!(days > 0)) return "today";
  return days === 1 ? "1 day ago" : `${days.toLocaleString()} days ago`;
}

const localDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA");

/** Rows per table, plain names for the ones an athlete recognises. */
const TABLE_LABELS: Record<string, string> = {
  planned_workouts: "Workouts",
  activities: "Activities",
  garden_day_inputs: "Garden days",
};

/**
 * The restore sheet. Exported for the Data card tests. Nothing is sent to
 * `begin` until "Replace everything in this account" is pressed; the checks
 * before it have no side effects.
 */
export function RestoreSheet({
  step,
  signedInEmail,
  appOrigin,
  now = new Date(),
  onCancel,
  onConfirm,
  onRetry,
}: {
  step: RestoreStep;
  signedInEmail: string | null;
  /** This app's origin — a file from anywhere else needs a second yes. */
  appOrigin: string;
  now?: Date;
  onCancel: () => void;
  onConfirm: () => void;
  onRetry: () => void;
}) {
  const [foreignOk, setForeignOk] = useState(false);
  if (step.kind === "idle") return null;
  const busy = step.kind === "checking" || step.kind === "running";
  const file = step.file;
  const fileEmail = typeof file.tables.users?.[0]?.email === "string" ? (file.tables.users[0]!.email as string) : null;
  const fromHost = hostOf(file.exportedFrom);
  const foreign = !file.exportedFrom || hostOf(file.exportedFrom) !== hostOf(appOrigin);
  const counts = step.kind === "confirm" || step.kind === "running" ? step.checked.fileCounts : null;

  let footer: ReactNode;
  if (step.kind === "confirm") {
    footer = (
      <div className="btn-row">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-danger" disabled={foreign && !foreignOk} onClick={onConfirm}>
          Replace everything in this account
        </button>
      </div>
    );
  } else if (step.kind === "failed") {
    footer = (
      <div className="btn-row">
        <button type="button" className="btn" onClick={onCancel}>
          Close
        </button>
        {step.checked ? (
          <button type="button" className="btn btn-danger" onClick={onRetry}>
            Try again
          </button>
        ) : null}
      </div>
    );
  } else {
    footer = (
      <div className="btn-row">
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          {step.kind === "done" ? "Done" : "Cancel"}
        </button>
      </div>
    );
  }

  return (
    <Sheet open onClose={busy ? () => undefined : onCancel} title="Restore from file" centered footer={footer}>
      <div className="stack">
        {step.kind === "checking" ? (
          <p className="muted">
            Checking the file…
            {step.progress ? ` ${step.progress.done.toLocaleString()} of ${step.progress.total.toLocaleString()} rows` : ""}
          </p>
        ) : null}

        {step.kind === "problems" ? (
          <>
            <Banner kind="warn">This file can't be restored.</Banner>
            <ul className="restore-problems">
              {step.errors.map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
          </>
        ) : null}

        {step.kind === "confirm" || step.kind === "running" ? (
          <>
            <dl className="restore-facts">
              <dt>From</dt>
              <dd>{fromHost ?? "Unknown"}</dd>
              <dt>Account</dt>
              <dd>{fileEmail ?? "Unknown"}</dd>
              <dt>Exported</dt>
              <dd>
                {formatDayLong(localDay(file.exportedAt))} · {ageText(file.exportedAt, now)}
              </dd>
              {Object.entries(TABLE_LABELS).map(([table, label]) => (
                <Fragment key={table}>
                  <dt>{label}</dt>
                  <dd>{(counts?.[table] ?? 0).toLocaleString()}</dd>
                </Fragment>
              ))}
            </dl>
            <details>
              <summary>All tables</summary>
              <ul className="restore-tables">
                {Object.entries(counts ?? {}).map(([table, n]) => (
                  <li key={table}>
                    {table}: {n.toLocaleString()}
                  </li>
                ))}
              </ul>
            </details>
            {fileEmail && signedInEmail && fileEmail !== signedInEmail ? (
              <Banner kind="warn">
                This file is from {fileEmail}. You're signed in as {signedInEmail}.
              </Banner>
            ) : null}
            {foreign ? (
              <>
                <Banner kind="warn">
                  {fromHost ? `This file came from ${fromHost}, not this app.` : "This file doesn't say which app it came from."}
                </Banner>
                {step.kind === "confirm" ? (
                  <label className="row" style={{ fontWeight: 500, cursor: "pointer" }}>
                    <input type="checkbox" checked={foreignOk} onChange={(e) => setForeignOk(e.target.checked)} />
                    Use it anyway
                  </label>
                ) : null}
              </>
            ) : null}
            <p>
              COROS and Google Calendar will be disconnected, and changes waiting to go to your watch won't be sent.
            </p>
          </>
        ) : null}

        {step.kind === "running" && step.progress ? (
          <p className="muted">
            Restoring… {step.progress.done.toLocaleString()} of {step.progress.total.toLocaleString()} rows
          </p>
        ) : null}

        {step.kind === "done" ? (
          <>
            <p>Restored.</p>
            <p>
              Reconnect COROS and Google Calendar, then run Backfill history to bring back activities since{" "}
              {formatDayLong(localDay(file.exportedAt))}.
            </p>
            {step.summary.short.length > 0 ? (
              <Banner kind="warn">
                Some tables came back short:{" "}
                {step.summary.short.map((s) => `${s.table} (${s.restored.toLocaleString()} of ${s.expected.toLocaleString()})`).join(", ")}.
              </Banner>
            ) : null}
          </>
        ) : null}

        {step.kind === "failed" ? <Banner kind="warn">{step.message}</Banner> : null}
      </div>
    </Sheet>
  );
}

/** Export everything, restore from a file, delete everything. */
export function DataSection({ appOrigin }: { appOrigin?: string } = {}) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<RestoreStep>({ kind: "idle" });
  /** Bumped per chosen file, so the sheet's own state starts fresh. */
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const me = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    retry: false,
    // A restore running elsewhere says so until it stops (B10): look again.
    refetchInterval: (q) => (q.state.data?.restore?.running ? 30_000 : false),
  });
  const origin = appOrigin ?? (typeof window !== "undefined" ? window.location.origin : "");
  const del = useMutation({
    mutationFn: async () => {
      // Whose unsynced saves go with the account — asked before it is deleted (afterwards `me` is a 401).
      const userId = me.data?.userId ?? (await api.me().catch(() => null))?.userId ?? null;
      await api.deleteAll();
      return userId;
    },
    onSuccess: async (userId) => {
      // Nothing of the deleted account may open on this device afterwards, offline included (ruling 2b-R6 as amended;
      // audit 2b-A I-1): the service worker's cached answers, the stored builds, the live sessions — and its unsynced
      // saves, which have no account to go to any more.
      await forgetOfflineIdentity(userId ? { dropOutboxOf: userId } : {});
      window.location.href = "/";
    },
  });
  const exp = useMutation({
    mutationFn: exportAccount,
    onSuccess: (blob) => saveBlob(blob, exportFileName()),
  });

  // Leaving mid-restore leaves a half-wiped account: ask first (finding 8).
  useEffect(() => {
    if (step.kind !== "running") return;
    const hold = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", hold);
    return () => window.removeEventListener("beforeunload", hold);
  }, [step.kind]);

  const run = async (file: AccountExportFile, checked: CheckedRestore) => {
    setStep({ kind: "running", file, checked, progress: null });
    try {
      const summary = await runRestore(file, checked, (progress) =>
        setStep({ kind: "running", file, checked, progress }),
      );
      setStep({ kind: "done", file, summary });
    } catch (err) {
      setStep({ kind: "failed", file, checked, message: restoreErrorText(err) });
    } finally {
      // Success or not, every screen's cached data is now stale — and a
      // failure must show "A restore didn't finish" right away.
      void qc.invalidateQueries();
    }
  };

  const choose = async (e: ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files?.[0];
    e.target.value = "";
    if (!chosen) return;
    setNotice(null);
    setAttempt((n) => n + 1);
    let file: AccountExportFile;
    try {
      file = await readExportFile(chosen);
    } catch {
      setNotice("That file isn't a Run Garden export.");
      return;
    }
    setStep({ kind: "checking", file, progress: null });
    try {
      const check = await checkRestore(file, (progress) => setStep({ kind: "checking", file, progress }));
      setStep(check.ok ? { kind: "confirm", file, checked: check.checked } : { kind: "problems", file, errors: check.errors });
    } catch {
      setStep({ kind: "failed", file, checked: null, message: "Couldn't check the file. Try again." });
    }
  };

  return (
    <Card title="Your data" anchor="your-data">
      <div className="stack">
        <RestorePendingNotice
          restore={me.data?.restore}
          onRestoreAgain={() => fileInput.current?.click()}
          ownRestoreId={step.kind === "failed" ? (step.checked?.restoreId ?? null) : null}
        />
        {/* A session the server refused (Phase 2b): nothing renders when there is none. */}
        <UnsyncedSessions />
        <div className="btn-row">
          <button className="btn" disabled={exp.isPending} onClick={() => exp.mutate()}>
            {exp.isPending ? "Exporting…" : "Export everything (JSON)"}
          </button>
          <button
            className="btn"
            disabled={step.kind === "checking" || step.kind === "running"}
            onClick={() => fileInput.current?.click()}
          >
            Restore from file…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => void choose(e)}
          />
          {!confirming ? (
            <button className="btn btn-danger" onClick={() => setConfirming(true)}>
              Delete all data
            </button>
          ) : (
            <button className="btn btn-danger" disabled={del.isPending} onClick={() => del.mutate()}>
              Really delete everything — cannot be undone
            </button>
          )}
        </div>
        {exp.isError ? <Banner kind="warn">Export failed. Try again.</Banner> : null}
        {notice ? <Banner kind="info">{notice}</Banner> : null}
      </div>
      <RestoreSheet
        key={attempt}
        step={step}
        signedInEmail={me.data?.email ?? null}
        appOrigin={origin}
        onCancel={() => setStep({ kind: "idle" })}
        onConfirm={() => {
          if (step.kind === "confirm") void run(step.file, step.checked);
        }}
        onRetry={() => {
          if (step.kind === "failed" && step.checked) void run(step.file, step.checked);
        }}
      />
    </Card>
  );
}

function GardenSection() {
  const qc = useQueryClient();
  const garden = useQuery({ queryKey: ["garden"], queryFn: api.garden });
  const [untilDate, setUntilDate] = useState("");
  const rest = (garden.data?.restMode as { active: boolean; until: string | null } | undefined) ?? {
    active: false,
    until: null,
  };
  const toggle = useMutation({
    mutationFn: (next: boolean) => api.gardenRestMode(next, next ? untilDate || null : null),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["garden"] }),
  });
  return (
    <Card title="Garden rest mode">
      {rest.active ? (
        <div className="stack">
          <Banner kind="info">
            Rest mode is active — your garden is peacefully dormant and won't decline.
            {rest.until ? ` Ends ${formatDayShort(rest.until)}.` : ""}
          </Banner>
          <button className="btn" disabled={toggle.isPending} onClick={() => toggle.mutate(false)}>
            End rest mode
          </button>
        </div>
      ) : (
        <div className="stack">
          <p className="muted">
            For injury, illness, travel, or a planned break: pause all garden decline. No reasons
            asked.
          </p>
          <div className="field">
            <label htmlFor="rest-until">Optional end date</label>
            <input
              id="rest-until"
              type="date"
              value={untilDate}
              onChange={(e) => setUntilDate(e.target.value)}
            />
          </div>
          <button className="btn" disabled={toggle.isPending} onClick={() => toggle.mutate(true)}>
            Start rest mode
          </button>
        </div>
      )}
    </Card>
  );
}

const MEMORY_GROUPS: Array<{ kind: "fact" | "rule" | "note"; label: string }> = [
  { kind: "fact", label: "About you" },
  { kind: "rule", label: "Rules & preferences" },
  { kind: "note", label: "Notes (time-boxed)" },
];

/**
 * Coach memory — observable and editable (coach UX spec §6). Deleting is
 * immediate and total: the next dossier simply lacks the item.
 */
function CoachMemorySection() {
  const qc = useQueryClient();
  const memory = useQuery({ queryKey: ["coach-memory"], queryFn: api.coachMemoryList });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["coach-memory"] });
    void qc.invalidateQueries({ queryKey: ["coach-state"] });
  };
  const update = useMutation({
    mutationFn: (v: { id: string; body: string }) => api.coachMemoryUpdate(v.id, v.body),
    onSettled: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.coachMemoryDelete(id),
    onSettled: invalidate,
  });
  const rows = memory.data?.memory ?? [];
  return (
    <div id="coach-memory">
      <Card title="Coach memory">
        <p className="muted">
          Everything the coach knows about you — learned from your messages, editable here,
          deleted for good the moment you say so.
        </p>
        {rows.length === 0 ? (
          <p className="faint">Nothing yet — the coach learns as you talk to it.</p>
        ) : (
          MEMORY_GROUPS.map(({ kind, label }) => {
            const group = rows.filter((m) => m.kind === kind);
            if (group.length === 0) return null;
            return (
              <div key={kind} style={{ marginTop: "var(--space-4)" }}>
                <h3 className="card-title">{label}</h3>
                {group.map((m) => (
                  <div key={m.id} className="memory-row">
                    {editing === m.id ? (
                      <input
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        aria-label="Edit memory"
                        style={{ flex: 1 }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && draft.trim()) {
                            update.mutate({ id: m.id, body: draft.trim() });
                            setEditing(null);
                          }
                          if (e.key === "Escape") setEditing(null);
                        }}
                      />
                    ) : (
                      <span>
                        {m.body}
                        {m.expiresAt ? <span className="faint"> · until {m.expiresAt}</span> : null}
                        <span className="faint"> · {m.provenance.source}, {m.learnedAt.slice(0, 10)}</span>
                      </span>
                    )}
                    <span className="row" style={{ gap: "var(--space-3)" }}>
                      <button
                        type="button"
                        className="linklike"
                        onClick={() => {
                          setEditing(m.id);
                          setDraft(m.body);
                        }}
                      >
                        Edit
                      </button>
                      <button type="button" className="linklike" onClick={() => remove.mutate(m.id)}>
                        Delete
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            );
          })
        )}
      </Card>
    </div>
  );
}

export function SettingsScreen() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: async () => {
      // An offline launch must not open this account afterwards: its cached answers, stored builds and live sessions
      // go (ruling 2b-R6). Unsynced saves stay, for this account's next sign-in.
      await forgetOfflineIdentity();
      window.location.href = "/welcome";
    },
  });

  if (settings.isLoading) return <Spinner label="Loading settings" />;
  if (!settings.data) return <Banner kind="warn">Couldn't load settings.</Banner>;

  return (
    <div className="stack">
      <div className="row-between screen-title">
        <h1>Settings</h1>
        <span className="faint">{me.data?.email}</span>
      </div>
      <ConnectionsSection />
      <CorosConnectSection />
      <SchedulingSection prefs={settings.data.prefs} />
      <HealthConditionsSection />
      <PlacesSection prefs={settings.data.prefs} />
      <UnitsSection prefs={settings.data.prefs} />
      <ImportSection />
      <CorosSyncSection prefs={settings.data.prefs} />
      <AiSection prefs={settings.data.prefs} />
      <CoachMemorySection />
      <GardenSection />
      <DiagnosticsSection />
      <DataSection />
      <div>
        <button className="btn" disabled={logout.isPending} onClick={() => logout.mutate()}>
          Sign out
        </button>
      </div>
    </div>
  );
}
