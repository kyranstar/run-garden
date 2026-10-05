/**
 * THE SESSION SHEET (Phase 2a Task 7; mocks §2–3) — the workout sheet for a program slot, from Today and Plan.
 *
 * The pre-check first, when today's reading is missing (the same reading the Today chip records — either answers
 * the other); then what was built and why: mode · theme · time · place as chips, each a short picker that rebuilds;
 * one reason line; the moves by block with their format, dose, ↑ (up today) and New; ⇄ offers the slot's
 * alternatives and Use rebuilds with the swap; ⓘ opens the how-to. Opening the sheet builds (the server returns
 * the stored build when nothing changed), so a reading given on the Today chip is always the one built with.
 *
 *  - A day ahead is a preview (no pre-check, never startable); a day gone offers "Move to today".
 *  - A started or done session is read-only: no pickers, no swaps.
 *  - Start (and Continue) belong to the player, which arrives in 2b: hidden behind `features.player` until then.
 *  - "Don't show again" on a swap writes the move's prefs (`PUT /api/library/:id/prefs`, 2c): left out until then.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type BuildSessionRequest,
  type SessionDto,
  type SessionItemDto,
  type SessionOverrides,
  type WorkoutDto,
} from "@rg/api-client";
import { doseText, type DoseStep, type DoseTarget } from "@rg/domain";
import { Banner, EmptyState, formatDayLong, formatTime, Sheet, Spinner } from "../components.js";
import { features } from "../features.js";
import { IconInfo, IconSwap } from "../icons.js";
import { MoveSheet } from "../screens/move-sheet.js";
import { CheckScale, conditionChipLabel, FeelingOffToggle } from "./condition-check-sheet.js";
import { ExerciseHowto, type HowtoTarget } from "./exercise-howto.js";
import { MODE_LABEL } from "./today-program.js";

type Mode = keyof typeof MODE_LABEL;
type Picker = "mode" | "theme" | "minutes" | "place";

const BLOCK_ORDER = ["arrive", "prep", "core", "accessory", "care", "cooldown"] as const;
const BLOCK_LABEL: Record<string, string> = {
  arrive: "Arrive",
  prep: "Prep",
  core: "Core",
  accessory: "Accessory",
  cooldown: "Cool-down",
};
/** Format markers worth a word; a block of holds or straight sets says nothing more than its name. */
const FORMAT_LABEL: Record<string, string> = { flow: "Flow", superset: "Superset", circuit: "Circuit", ladder: "Ladder" };
/** The time picker's lengths (the build takes 10–90). */
const MINUTES = [15, 20, 25, 30, 40, 45, 60, 75, 90];
const PICKER_TITLE: Record<Picker, string> = { mode: "Mode", theme: "Theme", minutes: "Time", place: "Place" };

/** The program's name: the row's title without the theme a build appends. */
function withoutTheme(title: string, theme: string | null | undefined): string {
  const suffix = theme ? ` · ${theme}` : null;
  return suffix && title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
}

function itemDose(s: SessionDto, item: SessionItemDto): { text: string; up: boolean } {
  const build = s.build!;
  const target = (build.targets[item.exerciseId] as DoseTarget | undefined) ?? null;
  const steps = build.steps.filter((st) => st.slotKey === item.slotKey && st.kind !== "rest") as unknown as DoseStep[];
  return {
    text: doseText({ sets: item.sets, steps, target, perSide: build.exercises[item.exerciseId]?.laterality === "unilateral" }),
    up: target?.action === "up",
  };
}

export function SessionSheet({ w, today, onClose }: { w: WorkoutDto; today: string; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const key = ["session", w.id];
  const session = useQuery({ queryKey: key, queryFn: () => api.getSession(w.id) });
  const programs = useQuery({ queryKey: ["programs"], queryFn: api.listPrograms, staleTime: 60_000 });
  const [picker, setPicker] = useState<Picker | null>(null);
  const [swapping, setSwapping] = useState<string | null>(null);
  const [howto, setHowto] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [off, setOff] = useState<Record<string, boolean>>({});
  const asked = useRef(false);

  const refreshPlan = () => {
    for (const k of ["today", "plan", "plan-week", "programs"]) void qc.invalidateQueries({ queryKey: [k] });
  };
  const build = useMutation({
    mutationFn: (body: BuildSessionRequest) => api.buildSession(w.id, body),
    onSuccess: (next) => {
      const before = qc.getQueryData<SessionDto>(key);
      qc.setQueryData(key, next);
      // A new build renames and resizes the row; the stored build returned unchanged changed nothing.
      if (next.build?.buildId !== before?.build?.buildId || next.build?.builtAt !== before?.build?.builtAt) refreshPlan();
    },
    onError: (err) => {
      const body = err instanceof ApiError ? (err.body as { error?: string; session?: SessionDto } | null) : null;
      if (body?.error === "locked" && body.session) qc.setQueryData(key, body.session);
      else void qc.invalidateQueries({ queryKey: key });
    },
  });
  const start = useMutation({
    mutationFn: () => api.startSession(w.id),
    onSuccess: (next) => {
      qc.setQueryData(key, next);
      refreshPlan();
      navigate(`/session/${encodeURIComponent(w.id)}`);
    },
  });
  const skip = useMutation({
    mutationFn: () => api.skip(w.id),
    onSuccess: () => {
      refreshPlan();
      onClose();
    },
  });
  const moveToToday = useMutation({
    mutationFn: () => api.move(w.id, today, w.effectiveTime),
    onSuccess: () => {
      refreshPlan();
      void qc.invalidateQueries({ queryKey: key });
    },
  });

  const s = session.data;
  const date = s?.date ?? w.effectiveDate;
  const locked = !!s && (s.locked || s.contentState === "started" || s.contentState === "done");
  const past = date < today;
  const ahead = date > today;
  const unanswered = s && !locked && !past && !ahead ? s.profiles.filter((p) => !s.checks[p.profileId]) : [];
  const needsCheck = unanswered.length > 0;

  // Opening builds — or returns the stored build when nothing changed — unless the pre-check comes first.
  useEffect(() => {
    if (!s || asked.current || locked || past || needsCheck) return;
    asked.current = true;
    build.mutate({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, locked, past, needsCheck]);

  const answer = (profileId: string, value: number) => {
    const next = { ...answers, [profileId]: value };
    setAnswers(next);
    if (unanswered.every((p) => next[p.profileId] !== undefined)) {
      asked.current = true;
      build.mutate({
        checks: Object.fromEntries(
          unanswered.map((p) => [p.profileId, { pre: next[p.profileId]!, feelingOff: !!off[p.profileId] }]),
        ),
      });
    }
  };

  const program = programs.data?.programs.find((p) => p.id === w.programId);
  const title = program?.name ?? withoutTheme(w.title, s?.view?.theme?.name);
  const readings = s
    ? s.profiles
        .filter((p) => s.checks[p.profileId])
        .map((p) => conditionChipLabel({ ...p, today: { value: s.checks[p.profileId]!.pre, feelingOff: s.checks[p.profileId]!.feelingOff } }))
    : [];
  const when = [`${formatDayLong(date)} at ${formatTime(w.effectiveTime)}`, ...readings].join(" · ");

  const view = s?.view ?? null;
  const params = s?.build?.params ?? { checks: {}, overrides: {}, swaps: {} };
  const rebuild = (patch: SessionOverrides) => build.mutate({ overrides: { ...params.overrides, ...patch } });
  const pickMode = (mode: Mode) => {
    // A theme picked by hand stays only while it suits the new mode.
    const { theme, ...rest } = params.overrides;
    const keepTheme = theme && s?.choices.themes.find((t) => t.id === theme)?.modes.includes(mode);
    build.mutate({ overrides: { ...rest, ...(keepTheme ? { theme } : {}), mode } });
  };

  const showBuild = !!(s?.build && view) && !needsCheck;
  const canPlay = features.player && date === today && !past;
  const footer = (
    <div className="btn-row">
      {canPlay && showBuild && !locked ? (
        <button type="button" className="btn btn-primary" disabled={start.isPending} onClick={() => start.mutate()}>
          Start · {view!.minutes} min
        </button>
      ) : null}
      {canPlay && s?.contentState === "started" ? (
        <button type="button" className="btn btn-primary" onClick={() => navigate(`/session/${encodeURIComponent(w.id)}`)}>
          Continue
        </button>
      ) : null}
      {past && !locked ? (
        <button type="button" className="btn btn-primary" disabled={moveToToday.isPending} onClick={() => moveToToday.mutate()}>
          Move to today
        </button>
      ) : null}
      {!locked && s ? (
        <>
          <button type="button" className="btn" onClick={() => setMoving(true)}>
            Move
          </button>
          <button type="button" className="btn" disabled={skip.isPending} onClick={() => skip.mutate()}>
            Skip
          </button>
        </>
      ) : null}
    </div>
  );

  let body: React.ReactNode;
  if (session.isLoading) body = <Spinner label="Loading the session" />;
  else if (!s) body = <EmptyState title="This session is no longer in the plan" />;
  else if (needsCheck) {
    body = (
      <div className="stack session-precheck">
        {unanswered.map((p) => (
          <section key={p.profileId} className="stack">
            <b>{p.check.label} right now</b>
            <CheckScale
              label={p.check.label}
              min={p.check.min}
              max={p.check.max}
              value={answers[p.profileId] ?? null}
              disabled={build.isPending}
              onPick={(n) => answer(p.profileId, n)}
            />
            <div className="row">
              <FeelingOffToggle
                on={!!off[p.profileId]}
                disabled={build.isPending}
                onToggle={() => setOff((o) => ({ ...o, [p.profileId]: !o[p.profileId] }))}
              />
            </div>
          </section>
        ))}
        {program?.block ? (
          <div className="session-blockrow">
            <b>
              Block {program.block.number} · week {program.block.week} of {program.block.weeks}
            </b>
            <small>
              {program.block.core
                .map((c) => c.name)
                .filter(Boolean)
                .join(" · ")}
            </small>
          </div>
        ) : null}
      </div>
    );
  } else if (!showBuild) {
    body = build.isError ? (
      <Banner kind="warn">Couldn't build this session — try again in a moment.</Banner>
    ) : (
      <Spinner label="Building the session" />
    );
  } else {
    body = <BuiltSession s={s} locked={locked} onPick={setPicker} onSwap={setSwapping} onHowto={setHowto} />;
  }

  const items = s?.build?.items ?? [];
  const swapItem = swapping ? items.find((i) => i.slotKey === swapping) : undefined;
  const howtoItem = howto ? items.find((i) => i.slotKey === howto) : undefined;

  return (
    <Sheet open onClose={onClose} title={title} footer={footer}>
      <p className="session-when">{when}</p>
      {body}
      {picker && view && s ? (
        <ChoiceSheet
          title={PICKER_TITLE[picker]}
          onClose={() => setPicker(null)}
          options={
            picker === "mode"
              ? s.choices.modes.map((m) => ({ id: m, label: MODE_LABEL[m], on: m === view.mode }))
              : picker === "theme"
                ? s.choices.themes
                    .filter((t) => t.modes.includes(view.mode))
                    .map((t) => ({ id: t.id, label: t.name, on: t.id === view.theme?.id }))
                : picker === "minutes"
                  ? [...new Set([...MINUTES, view.minutes])]
                      .sort((a, b) => a - b)
                      .map((m) => ({ id: String(m), label: `${m} min`, on: m === view.minutes }))
                  : s.choices.locations.map((l) => ({ id: l.id, label: l.name, on: l.id === view.location.id }))
          }
          onPick={(id) => {
            setPicker(null);
            if (picker === "mode") pickMode(id as Mode);
            else if (picker === "theme") rebuild({ theme: id });
            else if (picker === "minutes") rebuild({ minutes: Number(id) });
            else rebuild({ locationId: id });
          }}
        />
      ) : null}
      {swapItem && s?.build ? (
        <Sheet open onClose={() => setSwapping(null)} title={`Swap ${s.build.exercises[swapItem.exerciseId]?.name ?? ""}`}>
          <div className="choice-moves">
            {(s.build.alternatives[swapItem.slotKey] ?? []).map((alt) => (
              <div key={alt.id} className="choice-move">
                <div className="choice-move-text">
                  <b>{alt.name}</b>
                  {alt.reasons.length > 0 ? <small>{alt.reasons.join(" · ")}</small> : null}
                </div>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={build.isPending}
                  onClick={() => {
                    const from = params.swaps[swapItem.slotKey]?.from ?? swapItem.exerciseId;
                    setSwapping(null);
                    build.mutate({ swaps: { ...params.swaps, [swapItem.slotKey]: { from, to: alt.id } } });
                  }}
                >
                  Use
                </button>
              </div>
            ))}
          </div>
        </Sheet>
      ) : null}
      {howtoItem && s?.build?.exercises[howtoItem.exerciseId] ? (
        <ExerciseHowto
          exercise={s.build.exercises[howtoItem.exerciseId]!}
          item={howtoItem}
          target={(s.build.targets[howtoItem.exerciseId] as HowtoTarget | undefined) ?? null}
          profiles={s.profiles}
          exercises={s.build.exercises}
          onClose={() => setHowto(null)}
        />
      ) : null}
      <MoveSheet
        workout={w}
        open={moving}
        onClose={() => {
          setMoving(false);
          void qc.invalidateQueries({ queryKey: key });
        }}
      />
    </Sheet>
  );
}

/** What was built: the chips, the reason line, and the moves by block. */
function BuiltSession({
  s,
  locked,
  onPick,
  onSwap,
  onHowto,
}: {
  s: SessionDto;
  locked: boolean;
  onPick: (p: Picker) => void;
  onSwap: (slotKey: string) => void;
  onHowto: (slotKey: string) => void;
}) {
  const build = s.build!;
  const view = s.view!;
  const careLabel = s.profiles.find((p) => p.care)?.care ?? "Care";
  const chips: Array<{ picker: Picker; label: string; on?: boolean; can: boolean }> = [
    { picker: "mode", label: MODE_LABEL[view.mode], on: true, can: s.choices.modes.length > 1 },
    { picker: "theme", label: view.theme?.name ?? "Theme", can: s.choices.themes.some((t) => t.modes.includes(view.mode)) },
    { picker: "minutes", label: `${view.minutes} min`, can: true },
    { picker: "place", label: view.location.name, can: s.choices.locations.length > 1 },
  ];
  return (
    <div className="stack session-built">
      <div className="session-chips">
        {chips.map((c) =>
          locked || !c.can ? (
            <span key={c.picker} className={`session-chip${c.on ? " is-on" : ""}`}>
              {c.label}
            </span>
          ) : (
            <button
              key={c.picker}
              type="button"
              className={`session-chip${c.on ? " is-on" : ""}`}
              aria-haspopup="dialog"
              onClick={() => onPick(c.picker)}
            >
              {c.label} ▾
            </button>
          ),
        )}
      </div>
      {view.modeReasons.length > 0 ? <p className="session-reason">{view.modeReasons.join(" ")}</p> : null}
      <div className="session-blocks">
        {BLOCK_ORDER.map((blockId) => {
          const items = build.items.filter((i) => i.block === blockId);
          if (items.length === 0) return null;
          const format = FORMAT_LABEL[items[0]!.format];
          const rounds = Math.max(
            1,
            ...build.steps.filter((st) => st.block === blockId).map((st) => st.format.round ?? 1),
          );
          const label = blockId === "care" ? careLabel : BLOCK_LABEL[blockId]!;
          return (
            <section key={blockId} className="session-block">
              <h3 className="session-block-head">
                {label}
                {format ? ` · ${format}${rounds > 1 ? ` × ${rounds}` : ""}` : ""}
              </h3>
              {items.map((item) => {
                const ex = build.exercises[item.exerciseId];
                const name = ex?.name ?? item.exerciseId;
                const dose = itemDose(s, item);
                const alternatives = build.alternatives[item.slotKey] ?? [];
                return (
                  <div key={item.slotKey} className="session-move">
                    <span className="session-move-n">{item.group ?? ""}</span>{" "}
                    <span className="session-move-text">
                      <b>{name}</b>
                      {item.isNew ? (
                        <>
                          {" "}
                          <span className="session-new">New</span>
                        </>
                      ) : null}{" "}
                      <small>
                        {dose.text}
                        {dose.up ? (
                          <>
                            {" "}
                            <span className="dose-up" title="Goes up today">
                              ↑
                            </span>
                          </>
                        ) : null}
                      </small>
                    </span>
                    {!locked && alternatives.length > 0 ? (
                      <button type="button" className="session-move-icon" aria-label={`Swap ${name}`} onClick={() => onSwap(item.slotKey)}>
                        <IconSwap size={16} />
                      </button>
                    ) : (
                      <span aria-hidden="true" />
                    )}
                    <button type="button" className="session-move-icon" aria-label={`How to do ${name}`} onClick={() => onHowto(item.slotKey)}>
                      <IconInfo size={16} />
                    </button>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** A short picker: one choice per row, the current one marked. */
function ChoiceSheet({
  title,
  options,
  onPick,
  onClose,
}: {
  title: string;
  options: Array<{ id: string; label: string; on: boolean }>;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet open onClose={onClose} title={title} centered>
      <div className="choice-list">
        {options.map((o) => (
          <button key={o.id} type="button" aria-pressed={o.on} onClick={() => onPick(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
