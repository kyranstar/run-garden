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
 *  - A skipped session says so and offers Un-skip, and nothing else: no pre-check, no build, no Skip (ruling 2a-R15).
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
  type MeResponse,
  type SessionDto,
  type SessionItemDto,
  type SessionOverrides,
  type WorkoutDto,
} from "@rg/api-client";
import { doseText, type DoseStep, type DoseTarget } from "@rg/domain";
import { Banner, CompletionPill, EmptyState, formatDayLong, formatTime, Sheet, Spinner } from "../components.js";
import { features } from "../features.js";
import { IconInfo, IconSwap } from "../icons.js";
import { offlineDb } from "../offline/idb.js";
import { requestPersistentStorage } from "../offline/live.js";
import { chimes } from "../player/audio.js";
import { rememberStart } from "../player/stored.js";
import { MoveSheet } from "../screens/move-sheet.js";
import { CheckScale, checkWord, conditionChipLabel, FeelingOffToggle } from "./condition-check-sheet.js";
import { ExerciseHowto, type HowtoTarget } from "./exercise-howto.js";
import { MODE_LABEL } from "./today-program.js";

type Mode = keyof typeof MODE_LABEL;
type Picker = "mode" | "theme" | "minutes" | "place";

const BLOCK_ORDER = ["arrive", "prep", "core", "accessory", "care", "cooldown"] as const;
export const BLOCK_LABEL: Record<string, string> = {
  arrive: "Arrive",
  prep: "Prep",
  core: "Core",
  accessory: "Accessory",
  cooldown: "Cool-down",
};
/** Format markers worth a word; a block of holds or straight sets says nothing more than its name. */
export const FORMAT_LABEL: Record<string, string> = { flow: "Flow", superset: "Superset", circuit: "Circuit", ladder: "Ladder" };
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
  const gone = session.error instanceof ApiError && session.error.status === 404;
  const programs = useQuery({ queryKey: ["programs"], queryFn: api.listPrograms, staleTime: 60_000 });
  const [picker, setPicker] = useState<Picker | null>(null);
  const [swapping, setSwapping] = useState<string | null>(null);
  const [howto, setHowto] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [off, setOff] = useState<Record<string, boolean>>({});
  /** The pre-check reopened from the reading on the when-line, to change the answer (ruling 2a-R14). */
  const [rechecking, setRechecking] = useState(false);
  const asked = useRef(false);
  /** After Build: focus the reading (or the sheet) once the pre-check is gone. */
  const refocus = useRef(false);
  const body0 = useRef<HTMLDivElement>(null);

  const refreshPlan = () => {
    for (const k of ["today", "plan", "plan-week", "programs"]) void qc.invalidateQueries({ queryKey: [k] });
  };
  const build = useMutation({
    mutationFn: (body: BuildSessionRequest) => api.buildSession(w.id, body),
    onSuccess: (next) => {
      const before = qc.getQueryData<SessionDto>(key);
      qc.setQueryData(key, next);
      // A new build renames and resizes the row; so does a stored build adopted by an outline row (the row's state
      // changes, 2a UI re-review U5). The stored build returned unchanged changed nothing.
      if (
        next.build?.buildId !== before?.build?.buildId ||
        next.build?.builtAt !== before?.build?.builtAt ||
        next.contentState !== before?.contentState
      )
        refreshPlan();
    },
    onError: (err) => {
      const body = err instanceof ApiError ? (err.body as { error?: string; session?: SessionDto } | null) : null;
      if (body?.error === "locked" && body.session) qc.setQueryData(key, body.session);
      else void qc.invalidateQueries({ queryKey: key });
    },
  });
  /** The session's name as the player shows it (kept for the Start handler, which runs after this render). */
  const titleRef = useRef("");
  /** Start locked the session, but the device could not keep it (no IndexedDB, storage full): said before it plays. */
  const [notKept, setNotKept] = useState(false);
  const start = useMutation({
    mutationFn: (buildId: string) => api.startSession(w.id, buildId),
    onSuccess: async (next) => {
      qc.setQueryData(key, next);
      refreshPlan();
      // The player plays what Start leaves on the device, never the network (ruling 2b-R1). Without IndexedDB it
      // still opens, online, from the started session — but it keeps nothing, so the sheet says so first and Continue
      // goes on (audit 2b-B I-2).
      try {
        const db = await offlineDb();
        await rememberStart(db, next, titleRef.current, qc.getQueryData<MeResponse>(["me"])?.userId ?? null);
      } catch {
        setNotKept(true);
        return;
      }
      navigate(`/session/${encodeURIComponent(w.id)}`);
    },
    // The day's inputs changed since this build (a check, a save, an edit): show the fresh build to Start again. The
    // fresh build may have renamed or resized the row, so Today and Plan refetch too.
    onError: (err) => {
      const body = err instanceof ApiError ? (err.body as { error?: string; session?: SessionDto } | null) : null;
      if ((body?.error === "stale" || body?.error === "locked") && body.session) qc.setQueryData(key, body.session);
      else void qc.invalidateQueries({ queryKey: key });
      refreshPlan();
    },
  });
  const skip = useMutation({
    mutationFn: () => api.skip(w.id),
    onSuccess: () => {
      refreshPlan();
      onClose();
    },
  });
  const unskip = useMutation({
    mutationFn: () => api.unskipWorkout(w.id),
    onSuccess: () => {
      refreshPlan();
      // Completion feeds the garden, as the run sheet's Un-skip does.
      void qc.invalidateQueries({ queryKey: ["garden"] });
      void qc.invalidateQueries({ queryKey: key });
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
  // Skipped is not today's to-do (ruling 2a-R15): nothing is asked or built until it is un-skipped.
  const skipped = w.completionState === "skipped";
  const changeable = !!s && !locked && !skipped && !past && !ahead;
  const unanswered = s && changeable ? s.profiles.filter((p) => !s.checks[p.profileId]) : [];
  const needsCheck = unanswered.length > 0;
  // What the pre-check asks: the profiles still unanswered, or — reopened from the reading — every one.
  const asking = needsCheck ? unanswered : s && changeable && rechecking ? s.profiles : [];
  const preCheck = asking.length > 0;

  // Opening builds — or returns the stored build when nothing changed — unless the pre-check comes first.
  useEffect(() => {
    if (!s || asked.current || locked || skipped || past || needsCheck) return;
    asked.current = true;
    build.mutate({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, locked, skipped, past, needsCheck]);

  // The pre-check (ruling 2a-R14): a number, Feeling off, or both, per profile, in any order — nothing is sent until
  // Build, which waits for every profile asked to have one or the other. Feeling off alone is an answer.
  const answer = (profileId: string, value: number | null) =>
    setAnswers((cur) => {
      const next = { ...cur };
      if (value === null) delete next[profileId];
      else next[profileId] = value;
      return next;
    });
  const answered = asking.every((p) => answers[p.profileId] !== undefined || !!off[p.profileId]);
  const submit = () => {
    asked.current = true;
    build.mutate(
      {
        checks: Object.fromEntries(
          asking.map((p) => [p.profileId, { pre: answers[p.profileId] ?? null, feelingOff: !!off[p.profileId] }]),
        ),
      },
      {
        onSuccess: () => {
          setRechecking(false);
          // Build leaves with the pre-check: focus goes to the reading, not out of the dialog (2a UI re-review U7).
          refocus.current = true;
        },
      },
    );
  };
  // The reading on the when-line reopens the pre-check, filled in with the reading as it stands.
  const recheck = () => {
    if (rechecking || !s) {
      setRechecking(false);
      return;
    }
    const held = s.profiles.flatMap((p) => (s.checks[p.profileId] ? [[p.profileId, s.checks[p.profileId]!] as const] : []));
    setAnswers(Object.fromEntries(held.flatMap(([id, c]) => (c.pre === null ? [] : [[id, c.pre]]))));
    setOff(Object.fromEntries(held.map(([id, c]) => [id, c.feelingOff])));
    setRechecking(true);
  };

  const program = programs.data?.programs.find((p) => p.id === w.programId);
  const title = program?.name ?? withoutTheme(w.title, s?.view?.theme?.name);
  titleRef.current = title;
  // A started or done session reads as it was built — a later check cannot change it (2a UI re-review U3).
  const shownChecks = s && locked && s.build ? s.build.params.checks : (s?.checks ?? {});
  const readings = s
    ? s.profiles
        .filter((p) => shownChecks[p.profileId])
        .map((p) => conditionChipLabel({ ...p, today: { value: shownChecks[p.profileId]!.pre, feelingOff: shownChecks[p.profileId]!.feelingOff } }))
    : [];
  const reading = readings.join(" · ");

  const view = s?.view ?? null;
  const params = s?.build?.params ?? { checks: {}, overrides: {}, swaps: {} };
  const rebuild = (patch: SessionOverrides) => build.mutate({ overrides: { ...params.overrides, ...patch } });
  const pickMode = (mode: Mode) => {
    // A theme picked by hand stays only while it suits the new mode.
    const { theme, ...rest } = params.overrides;
    const keepTheme = theme && s?.choices.themes.find((t) => t.id === theme)?.modes.includes(mode);
    build.mutate({ overrides: { ...rest, ...(keepTheme ? { theme } : {}), mode } });
  };

  const showBuild = !!(s?.build && view) && !preCheck;
  useEffect(() => {
    if (!refocus.current || preCheck) return;
    refocus.current = false;
    const el = body0.current;
    const target = el?.querySelector<HTMLElement>(".session-reading") ?? el?.closest<HTMLElement>('[role="dialog"]');
    target?.focus();
  });
  const canPlay = features.player && date === today && !past && !skipped;
  // The pinned foot holds the sheet's actions — and is left out when there are none (loading, or a started or done
  // session without the player), rather than drawn as an empty band (audit 2a-UI M6).
  const actions: React.ReactNode[] = [];
  if (skipped) {
    actions.push(
      <button key="unskip" type="button" className="btn" disabled={unskip.isPending} onClick={() => unskip.mutate()}>
        Un-skip
      </button>,
    );
  } else {
    if (preCheck) {
      actions.push(
        <button key="build" type="button" className="btn btn-primary" disabled={!answered || build.isPending} onClick={submit}>
          Build
        </button>,
      );
    }
    if (canPlay && showBuild && !locked) {
      actions.push(
        <button
          key="start"
          type="button"
          className="btn btn-primary"
          disabled={start.isPending}
          onClick={() => {
            // Inside the tap: audio unlocks only in a gesture, and storage is asked to persist (offline spike).
            chimes.unlock();
            void requestPersistentStorage();
            start.mutate(s!.build!.buildId);
          }}
        >
          Start · {view!.minutes} min
        </button>,
      );
    }
    if (canPlay && s?.contentState === "started") {
      actions.push(
        <button
          key="continue"
          type="button"
          className="btn btn-primary"
          onClick={() => {
            chimes.unlock();
            navigate(`/session/${encodeURIComponent(w.id)}`);
          }}
        >
          Continue
        </button>,
      );
    }
    if (past && !locked) {
      actions.push(
        <button key="today" type="button" className="btn btn-primary" disabled={moveToToday.isPending} onClick={() => moveToToday.mutate()}>
          Move to today
        </button>,
      );
    }
    if (!locked && s) {
      actions.push(
        <button key="move" type="button" className="btn" onClick={() => setMoving(true)}>
          Move
        </button>,
        <button key="skip" type="button" className="btn" disabled={skip.isPending} onClick={() => skip.mutate()}>
          Skip
        </button>,
      );
    }
  }
  const footer = actions.length > 0 ? <div className="btn-row">{actions}</div> : null;

  let body: React.ReactNode;
  if (session.isLoading) body = <Spinner label="Loading the session" />;
  // Only a 404 means the session left the plan; a failure to load says that (audit 2a-UI M7).
  else if (!s)
    body = gone ? (
      <EmptyState title="This session is no longer in the plan" />
    ) : (
      <Banner kind="warn">Couldn't load this session — try again in a moment.</Banner>
    );
  else if (skipped) {
    body = (
      <div className="stack">
        <p className="session-status">
          <CompletionPill state="skipped" />
        </p>
        {showBuild ? <BuiltSession s={s} locked onPick={setPicker} onSwap={setSwapping} onHowto={setHowto} /> : null}
      </div>
    );
  } else if (preCheck) {
    body = (
      <div className="stack session-precheck">
        {asking.map((p) => (
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
                word={asking.length > 1 ? checkWord(p.check.label) : undefined}
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
        {build.isError ? <Banner kind="warn">Couldn't build this session — try again in a moment.</Banner> : null}
      </div>
    );
  } else if (!showBuild) {
    // A day gone is never built (audit 2a-UI I2): a plain line, never a spinner for a build that will not start.
    body = past ? (
      <p className="session-none">Nothing was built for this day.</p>
    ) : build.isError ? (
      <Banner kind="warn">Couldn't build this session — try again in a moment.</Banner>
    ) : (
      <Spinner label="Building the session" />
    );
  } else {
    // A day gone keeps the build it had, read-only: it can no longer be rebuilt (only moved to today).
    body = <BuiltSession s={s} locked={locked || past} onPick={setPicker} onSwap={setSwapping} onHowto={setHowto} />;
  }

  const items = s?.build?.items ?? [];
  const swapItem = swapping ? items.find((i) => i.slotKey === swapping) : undefined;
  const howtoItem = howto ? items.find((i) => i.slotKey === howto) : undefined;

  return (
    <Sheet open onClose={onClose} title={title} footer={footer}>
      <div ref={body0} className="stack session-sheet">
        <p className="session-when">
          {formatDayLong(date)} at {formatTime(w.effectiveTime)}
          {reading ? " · " : null}
          {reading && changeable && !needsCheck ? (
            <button type="button" className="linklike session-reading" aria-expanded={rechecking} onClick={recheck}>
              {reading}
            </button>
          ) : (
            reading
          )}
        </p>
        {notKept ? (
          <Banner kind="warn">
            This session isn't being kept on this device. It plays while you're online, and a reload starts it again.
          </Banner>
        ) : null}
        {body}
      </div>
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
                  className="btn"
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
