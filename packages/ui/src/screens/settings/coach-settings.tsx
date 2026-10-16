/**
 * SETTINGS → COACH (Stage 3 Task 10; spec §6): how the coach starts when you don't say, how many "next workouts", your
 * training times, each request's spending limit (lowered, never raised past its default), the model in use and this
 * week's AI spend — past the week's warning, one plain line that the coach keeps going to the cutoff (fix wave 3B, M4). Shown only with the coach designer on (`coachOn`); a server whose coach is off (a 404) shows nothing.
 * Each change saves at once, the settings whole (`PUT /api/coach/preferences`).
 */
import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type CoachPreferencesDto, type CoachSpendDto } from "@rg/api-client";
import {
  COACH_CEILING_DEFAULTS_USD,
  COACH_CEILING_MIN_USD,
  COACH_NEXT_N,
  COACH_TRAINING_TIMES_MAX,
  type CoachCeilingKind,
  type CoachPreferences,
  type CoachScopeKind,
} from "@rg/domain";
import { Card } from "../../components.js";
import { coachOn } from "../../features.js";

/** The settings' read: the composer reads it too (its default scope and N). */
export const COACH_PREFERENCES_QUERY = ["coach-preferences"] as const;

const usd = (v: number): string => `$${v.toFixed(2)}`;

/** The scopes, in the composer's words (fix wave 3B, M8): "Next 7 days", "Next 3 workouts" — never "This week". */
export function scopeChoices(nextN: number): Array<{ value: CoachScopeKind; label: string }> {
  return [
    { value: "now", label: "Now" },
    { value: "later_today", label: "Later today" },
    { value: "week", label: "Next 7 days" },
    { value: "next_n", label: `Next ${nextN} workouts` },
  ];
}

/** Each limit by what it covers: a workout for today, or planning ahead — the composer's own button. */
const LIMITS: ReadonlyArray<{ kind: CoachCeilingKind; label: string }> = [
  { kind: "day", label: "Now or later today" },
  { kind: "set", label: "Plan ahead" },
];

/** "$5", "$5.50": whole dollars bare. */
const dollars = (micros: number): string => {
  const v = micros / 1_000_000;
  return Number.isInteger(v) ? `$${v}` : usd(v);
};

/** A typed limit: the dollars it means, or why not ("At most $1.50."). */
export function readLimit(kind: CoachCeilingKind, text: string): { usd: number } | { why: string } {
  const value = Number(text.replace(/^\$/, "").trim());
  const max = COACH_CEILING_DEFAULTS_USD[kind];
  if (!text.trim() || !Number.isFinite(value)) return { why: "A dollar amount, like 1.25." };
  if (value > max) return { why: `At most ${usd(max)}.` };
  if (value < COACH_CEILING_MIN_USD) return { why: `At least ${usd(COACH_CEILING_MIN_USD)}.` };
  return { usd: Math.round(value * 100) / 100 };
}

/** The settings with one limit changed: a limit back at its default is no setting at all. */
function withLimit(coach: CoachPreferences, kind: CoachCeilingKind, value: number): CoachPreferences {
  const ceilings = { ...coach.ceilingsUsd };
  if (value === COACH_CEILING_DEFAULTS_USD[kind]) delete ceilings[kind];
  else ceilings[kind] = value;
  const { ceilingsUsd: _old, ...rest } = coach;
  return Object.keys(ceilings).length > 0 ? { ...rest, ceilingsUsd: ceilings } : rest;
}

function LimitRow({ kind, label, value, busy, onSave }: { kind: CoachCeilingKind; label: string; value: number; busy: boolean; onSave: (usd: number) => void }) {
  const id = useId();
  const [text, setText] = useState(value.toFixed(2));
  const [why, setWhy] = useState<string | null>(null);
  useEffect(() => setText(value.toFixed(2)), [value]);
  const commit = () => {
    const read = readLimit(kind, text);
    if ("why" in read) return setWhy(read.why);
    setWhy(null);
    if (read.usd !== value) onSave(read.usd);
  };
  return (
    <div className="setting-row coach-limit">
      <label htmlFor={id}>{label}</label>
      <span className="coach-limit-field">
        <span aria-hidden="true">$</span>
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={COACH_CEILING_MIN_USD}
          max={COACH_CEILING_DEFAULTS_USD[kind]}
          step={0.25}
          value={text}
          disabled={busy}
          aria-invalid={why ? true : undefined}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
      </span>
      {why ? (
        <p className="coach-setting-why" role="status">
          {why}
        </p>
      ) : null}
    </div>
  );
}

/** The card, from what the server answered (rendered as it is by a test). */
export function CoachSettingsView({
  data,
  spend,
  busy = false,
  error = null,
  onSave,
}: {
  data: CoachPreferencesDto;
  spend: CoachSpendDto | null;
  busy?: boolean;
  error?: string | null;
  onSave: (next: CoachPreferences) => void;
}) {
  const { coach, settings } = data;
  const nId = useId();
  const [times, setTimes] = useState<string[]>(settings.trainingTimes);
  // After "Add a time", the focus goes to the new time's field (fix wave 3B, B-I9).
  const timesBox = useRef<HTMLDivElement>(null);
  const [added, setAdded] = useState(false);
  useEffect(() => {
    if (!added) return;
    setAdded(false);
    [...(timesBox.current?.querySelectorAll<HTMLInputElement>('input[type="time"]') ?? [])].at(-1)?.focus();
  }, [added]);
  // What was saved comes back as the list (sorted, each once): the rows follow it.
  const saved = settings.trainingTimes.join(",");
  useEffect(() => setTimes(saved ? saved.split(",") : []), [saved]);
  const saveTimes = (next: string[]) => {
    const kept = [...new Set(next.filter((t) => /^\d{2}:\d{2}$/.test(t)))].sort();
    const { trainingTimes: _old, ...rest } = coach;
    onSave(kept.length > 0 ? { ...rest, trainingTimes: kept } : rest);
  };
  return (
    <Card title="Coach">
      <div className="coach-setting">
        <span className="coach-setting-label" id={`${nId}-scope`}>
          Start with
        </span>
        <div className="program-seg coach-scope-seg" role="group" aria-labelledby={`${nId}-scope`}>
          {scopeChoices(settings.nextN).map((o) => (
            <button
              key={o.value}
              type="button"
              aria-pressed={settings.defaultScope === o.value}
              disabled={busy}
              onClick={() => {
                if (o.value !== settings.defaultScope) onSave({ ...coach, defaultScope: o.value });
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <label htmlFor={nId}>Next workouts</label>
        <select
          id={nId}
          className="coach-n"
          value={settings.nextN}
          disabled={busy}
          onChange={(e) => onSave({ ...coach, nextN: Number(e.target.value) })}
        >
          {Array.from({ length: COACH_NEXT_N.max - COACH_NEXT_N.min + 1 }, (_, i) => COACH_NEXT_N.min + i).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div className="coach-setting" ref={timesBox}>
        <span className="coach-setting-label">Training times</span>
        {times.length === 0 ? <p className="faint">None set.</p> : null}
        {times.map((t, i) => (
          <div key={`${i}-${t}`} className="coach-time-row">
            <input
              type="time"
              aria-label={`Training time ${i + 1}`}
              defaultValue={t}
              disabled={busy}
              onBlur={(e) => {
                const next = times.map((x, j) => (j === i ? e.target.value : x));
                setTimes(next);
                if (e.target.value && e.target.value !== t) saveTimes(next);
              }}
            />
            <button
              type="button"
              className="linklike tap-pad"
              disabled={busy}
              onClick={() => {
                const next = times.filter((_, j) => j !== i);
                setTimes(next);
                saveTimes(next);
              }}
            >
              Remove
            </button>
          </div>
        ))}
        {times.length < COACH_TRAINING_TIMES_MAX ? (
          <button
            type="button"
            className="btn btn-small"
            disabled={busy || times.includes("")}
            onClick={() => {
              setTimes([...times, ""]);
              setAdded(true);
            }}
          >
            Add a time
          </button>
        ) : null}
      </div>
      <div className="coach-setting">
        <span className="coach-setting-label">Spending limit for one request</span>
        {LIMITS.map((l) => (
          <LimitRow
            key={l.kind}
            kind={l.kind}
            label={l.label}
            value={settings.ceilingsUsd[l.kind]}
            busy={busy}
            onSave={(v) => onSave(withLimit(coach, l.kind, v))}
          />
        ))}
      </div>
      <div className="setting-row">
        <span>Model</span>
        <span className="coach-setting-value">{data.model.name}</span>
      </div>
      {spend ? (
        <div className="setting-row">
          <span>AI spend this week</span>
          <span className="coach-setting-value">
            {usd(spend.spentUsd)} of {usd(spend.cutoffMicros / 1_000_000)}
          </span>
        </div>
      ) : null}
      {/* Past the week's warning, one plain line: the cutoff is still ahead (fix wave 3B, M4). */}
      {spend && spend.spentMicros > spend.warnMicros && spend.spentMicros < spend.cutoffMicros ? (
        <p className="coach-setting-why">{`Over ${dollars(spend.warnMicros)} this week — the coach keeps going until ${dollars(spend.cutoffMicros)}.`}</p>
      ) : null}
      {error ? (
        <p className="coach-setting-why" role="status">
          {error}
        </p>
      ) : null}
    </Card>
  );
}

function CoachSectionLive() {
  const qc = useQueryClient();
  const prefs = useQuery({ queryKey: COACH_PREFERENCES_QUERY, queryFn: api.coachPreferences, retry: false });
  const spend = useQuery({ queryKey: ["coach-spend"], queryFn: api.coachSpend, retry: false });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (next: CoachPreferences) => api.coachPreferencesUpdate(next),
    onSuccess: (res) => {
      setError(null);
      qc.setQueryData(COACH_PREFERENCES_QUERY, res);
    },
    onError: () => setError("Couldn't save that — try again."),
  });
  // A server whose coach is off answers 404: nothing to set.
  if (prefs.error instanceof ApiError && prefs.error.status === 404) return null;
  if (!prefs.data) return null;
  return <CoachSettingsView data={prefs.data} spend={spend.data ?? null} busy={save.isPending} error={error} onSave={(next) => save.mutate(next)} />;
}

/** Settings → Coach: only with the coach designer on. */
export function CoachSection() {
  return coachOn() ? <CoachSectionLive /> : null;
}
