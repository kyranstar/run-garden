/**
 * SETTINGS → COACH & AI (Stage 3 Task 10; spec §6; reshaped by the new shape, 2026-10-17): the AI switch, each request's
 * spending limit (lowered, never raised past its default), the model in use, and ONE line of this week's AI spend; the
 * coach's training times live beside the run times (Settings → Training). The coach decides how much to plan from the
 * athlete's words now (no time-frame up front), so "Start with" and "Next workouts" are gone. The coach's parts show
 * only with the coach designer on (`coachOn`); a server whose coach is off (a 404) shows none. Each change saves at
 * once, the coach's settings whole (`PUT /api/coach/preferences`).
 */
import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type CoachPreferencesDto, type CoachSpendDto } from "@rg/api-client";
import {
  COACH_CEILING_DEFAULTS_USD,
  COACH_CEILING_MIN_USD,
  COACH_TRAINING_TIMES_MAX,
  type CoachCeilingKind,
  type CoachPreferences,
  type UserPreferences,
} from "@rg/domain";
import { OUT_OF_CREDITS_LINE } from "../../ai-credits.js";
import { Card } from "../../components.js";
import { coachOn } from "../../features.js";

/** The coach's settings' read. */
export const COACH_PREFERENCES_QUERY = ["coach-preferences"] as const;

const usd = (v: number): string => `$${v.toFixed(2)}`;

/** Each limit by what a request asks for: one workout, or a plan of several (a request that plans raises its run to it). */
const LIMITS: ReadonlyArray<{ kind: CoachCeilingKind; label: string }> = [
  { kind: "day", label: "One workout" },
  { kind: "set", label: "A plan of several" },
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

/** What a week's AI spend reads as: what the coach's own count says, else the settings' (the same week, the same cap). */
export interface SpendLike {
  spentUsd: number;
  cutoffUsd: number;
  warnUsd: number | null;
  cutoff: boolean;
}

export function spendOf(coach: CoachSpendDto | null | undefined, llm: { spentDollars: number; cutoffDollars: number; warn: boolean; cutoff: boolean } | null | undefined): SpendLike | null {
  if (coach) {
    return {
      spentUsd: coach.spentUsd,
      cutoffUsd: coach.cutoffMicros / 1_000_000,
      warnUsd: coach.warnMicros / 1_000_000,
      cutoff: coach.spentMicros >= coach.cutoffMicros,
    };
  }
  if (llm) return { spentUsd: llm.spentDollars, cutoffUsd: llm.cutoffDollars, warnUsd: null, cutoff: llm.cutoff };
  return null;
}

/**
 * THE ONE SPEND LINE (the new shape: Coach & AI, one spend line): "AI this week: $1.20 of $20.00" — past the week's
 * warning, that the coach keeps going to the cutoff (fix wave 3B, M4); at the cutoff, that it waits for the week.
 */
export function spendLine(s: SpendLike): string {
  const head = `AI this week: ${usd(s.spentUsd)} of ${usd(s.cutoffUsd)}`;
  if (s.cutoff) return `${head} — paused until the week clears.`;
  if (s.warnUsd !== null && s.spentUsd > s.warnUsd) return `${head} — past ${dollars(s.warnUsd * 1_000_000)}, the coach keeps going until ${dollars(s.cutoffUsd * 1_000_000)}.`;
  return head;
}

/** The coach's limits for one request, and the model in use (rendered as it is by a test). */
export function CoachLimits({
  data,
  busy = false,
  error = null,
  onSave,
}: {
  data: CoachPreferencesDto;
  busy?: boolean;
  error?: string | null;
  onSave: (next: CoachPreferences) => void;
}) {
  const { coach, settings } = data;
  return (
    <>
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
      {error ? (
        <p className="coach-setting-why" role="status">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** The coach's settings, read and saved whole (`PUT /api/coach/preferences`); none when the server's coach is off. */
function useCoachPreferences() {
  const qc = useQueryClient();
  const prefs = useQuery({ queryKey: COACH_PREFERENCES_QUERY, queryFn: api.coachPreferences, retry: false });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (next: CoachPreferences) => api.coachPreferencesUpdate(next),
    onSuccess: (res) => {
      setError(null);
      qc.setQueryData(COACH_PREFERENCES_QUERY, res);
    },
    onError: () => setError("Couldn't save that — try again."),
  });
  // A server whose coach is off answers 404: nothing to set (nor from an answer that is not the settings at all).
  const off = (prefs.error instanceof ApiError && prefs.error.status === 404) || !prefs.data?.settings;
  return { data: off ? undefined : prefs.data, busy: save.isPending, error, save: (next: CoachPreferences) => save.mutate(next) };
}

function CoachLimitsLive() {
  const p = useCoachPreferences();
  return p.data ? <CoachLimits data={p.data} busy={p.busy} error={p.error} onSave={p.save} /> : null;
}

/**
 * The coach's training times (the times it may plan into), beside the run times in Settings → Training (the new shape:
 * the times merged). Each change saves at once; after "Add a time" the focus goes to the new time's field (fix wave 3B,
 * B-I9). Drawn from what the server answered (a test renders it so).
 */
export function TrainingTimesView({ data, busy = false, onSave }: { data: CoachPreferencesDto; busy?: boolean; onSave: (next: CoachPreferences) => void }) {
  const { coach, settings } = data;
  const [times, setTimes] = useState<string[]>(settings.trainingTimes);
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
    <div className="coach-setting" ref={timesBox}>
      <span className="coach-setting-label">The coach&rsquo;s training times</span>
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
  );
}

function TrainingTimesLive() {
  const p = useCoachPreferences();
  return p.data ? <TrainingTimesView data={p.data} busy={p.busy} onSave={p.save} /> : null;
}

/** The coach's training times, in Settings → Training: only with the coach designer on. */
export function TrainingTimes() {
  return coachOn() ? <TrainingTimesLive /> : null;
}

/**
 * SETTINGS → COACH & AI (the new shape): one card — the AI switch (the activity reads and the week's story, the only AI
 * that runs unasked), the coach's limits for one request and its model (with the coach designer on), and ONE line of
 * the week's AI spend. Each change saves at once.
 */
export function CoachAiSection({ prefs }: { prefs: UserPreferences }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const coachSpend = useQuery({ queryKey: ["coach-spend"], queryFn: api.coachSpend, retry: false, enabled: coachOn() });
  const live = settings.data?.prefs ?? prefs;
  const toggle = useMutation({
    mutationFn: (aiEnabled: boolean) => api.updateSettings({ aiEnabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["settings"] }),
  });
  const on = toggle.isPending && toggle.variables !== undefined ? toggle.variables : live.aiEnabled;
  const llm = settings.data?.llm ?? null;
  const spend = spendOf(coachOn() ? coachSpend.data : null, llm);
  return (
    <Card title="Coach & AI">
      <div className="setting-row">
        <div>
          <div>Activity reads and the week&rsquo;s story</div>
          <small>The only AI that runs without you asking.</small>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Activity reads and the week's story"
          className="program-switch"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(!live.aiEnabled)}
        />
      </div>
      {coachOn() ? <CoachLimitsLive /> : null}
      {spend ? <p className="coach-spend">{spendLine(spend)}</p> : null}
      {llm?.outOfCreditsSince ? <p className="ai-credits ai-credits-note">{OUT_OF_CREDITS_LINE}</p> : null}
    </Card>
  );
}
