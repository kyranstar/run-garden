/**
 * THE REVIEW (Phase 2b Task 7; mocks §5; spec §2b "Review and save") — after the player's last step, or "End and
 * review": the post-check per switched-on profile, each move's done sets (editable with the log card's steppers),
 * 👍 / 👎 / not-for-me, graduation offers (Switch / Not yet), what the session achieved, a note; Save or Discard.
 *
 * Offline like the player. Nothing is decided until Save (the engine's pending change set): ratings and a block
 * switch go with the saved session and the server applies them. Discard keeps nothing.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ConditionViewDto, ReviewBasisDto } from "@rg/api-client";
import { formatWeight, parseWeight, type Weight, type WeightUnit } from "@rg/domain";
import type { EngineData } from "@rg/exercise-library";
import { Lib, Prog, Review } from "@rg/session-engine";
import { ConfirmDialog } from "../components.js";
import { CheckScale, checkWord } from "../components/condition-check-sheet.js";
import { Stepper } from "../components/set-steppers.js";
import { IconClose } from "../icons.js";
import { editSet, reviewFacts, reviewRows, savedPrefs, setDone, setsLine, wireOf, type ReviewRow } from "../player/review.js";
import type { PlayerSource, PlayerState, ReviewKept } from "../player/run.js";
import type { PerformedSessionWire } from "@rg/domain";

export function ReviewScreen({
  state,
  onChange,
  src,
  data,
  title,
  profiles,
  basis,
  onSave,
  onDiscard,
  onLeave,
}: {
  state: PlayerState;
  onChange: (next: PlayerState) => void;
  src: PlayerSource;
  data: EngineData;
  title: string;
  profiles: readonly ConditionViewDto[];
  basis: ReviewBasisDto | null;
  onSave: (wire: PerformedSessionWire) => Promise<void>;
  onDiscard: () => Promise<void>;
  onLeave: () => void;
}) {
  // The review's own inputs live in the session kept on the device (audit 2b-B M-4): a reload, a crash or Leave keeps
  // them, and two tabs on one review read the same ones.
  const kept: ReviewKept = state.review ?? { post: {}, note: "", review: Review.start() };
  const { post, note, review } = kept;
  const keep = (change: Partial<ReviewKept>) => onChange({ ...state, review: { ...kept, ...change } });
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // When the session ended, kept with it: reopening the review later never re-dates it.
  const endedAt = useMemo(() => new Date(state.finishedAt ?? Date.now()).toISOString(), [state.finishedAt]);
  const facts = useMemo(() => reviewFacts(state, src, data, basis, { post, note }, endedAt), [state, src, data, basis, post, note, endedAt]);
  // An edit that withdraws an offer withdraws a yes to it too.
  const shown = Review.prune(review, facts.offers);
  const prefs = Review.effectivePrefs(savedPrefs(basis), shown);
  const rows = reviewRows(state, src.build.exercises, src.build.newMove);
  const visible = all ? rows : rows.slice(0, 3);
  const minutes = Math.max(0, Math.round(facts.save.seconds / 60));
  const name = (id: string) => (src.build.exercises[id] ?? basis?.exercises[id])?.name ?? id;
  const unit: WeightUnit = basis?.graduation.unit ?? Lib.kettlebellsAt(src.view.location)[0]?.u ?? "lb";

  const save = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await onSave(wireOf(src, facts, shown));
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <div className="player review">
      <header className="review-head">
        <h1 className="display review-title">
          {title} · {minutes} min
        </h1>
        <button type="button" className="player-icon" aria-label="Leave the session" onClick={onLeave}>
          <IconClose size={18} />
        </button>
      </header>
      <main className="review-main">
        {profiles.map((p) => {
          const before = src.build.params.checks?.[p.profileId];
          const beforeText = before ? `Before${before.pre !== null ? ` ${before.pre}` : ""}${before.feelingOff ? " · off" : ""}` : null;
          return (
            <section key={p.profileId} className="review-card review-check">
              <b>{p.check.label} now</b>
              {beforeText ? <span className="review-meta">{beforeText}</span> : null}
              <CheckScale
                label={`${checkWord(p.check.label)} now`}
                min={p.check.min}
                max={p.check.max}
                value={post[p.profileId] ?? null}
                onPick={(n) => keep({ post: { ...post, [p.profileId]: n } })}
              />
            </section>
          );
        })}

        {rows.length > 0 ? (
          <section className="review-card review-moves" aria-label="Moves">
            {visible.map((row) => (
              <ReviewMove
                key={row.exerciseId}
                row={row}
                open={open === row.exerciseId}
                onToggle={() => setOpen(open === row.exerciseId ? null : row.exerciseId)}
                rating={prefs.ratings[row.exerciseId] ?? null}
                excluded={prefs.excluded.includes(row.exerciseId)}
                onRate={(v) => keep({ review: Review.rate(review, savedPrefs(basis), row.exerciseId, v) })}
                state={state}
                onChange={onChange}
                src={src}
                unit={unit}
              />
            ))}
            {!all && rows.length > visible.length ? (
              <button type="button" className="review-more" onClick={() => setAll(true)}>
                <b>{rows.length - visible.length} more</b>
                <span aria-hidden="true">›</span>
              </button>
            ) : null}
          </section>
        ) : null}

        {facts.offers.map((o) => {
          const accepted = shown.graduate[o.family] === o.to;
          return (
            <section key={o.family} className="review-card">
              <b>{name(o.from)} is topped out</b>
              <span className="review-meta">Switch the block to {name(o.to)}?</span>
              <div className="btn-row">
                <button
                  type="button"
                  className={`btn${accepted ? " btn-primary" : ""}`}
                  aria-pressed={accepted}
                  onClick={() => keep({ review: Review.graduate(review, o.family, o.to, true) })}
                >
                  Switch
                </button>
                <button type="button" className="btn" onClick={() => keep({ review: Review.graduate(review, o.family, o.to, false) })}>
                  Not yet
                </button>
              </div>
            </section>
          );
        })}

        {facts.records.length + facts.milestones.length > 0 ? (
          <section className="review-card review-records">
            <span className="eyebrow">New</span>
            {facts.records
              .filter((r) => r.kind !== "first")
              .map((r) => (
                <b key={`${r.kind}-${r.exerciseId}`}>{r.text}</b>
              ))}
            {firstTimes(facts.records.filter((r) => r.kind === "first").map((r) => name(r.exerciseId)))}
            {facts.milestones.map((m) => (
              <b key={m.id}>{m.text}</b>
            ))}
          </section>
        ) : null}

        <textarea className="review-note" aria-label="Note" placeholder="Note" rows={2} value={note} onChange={(e) => keep({ note: e.target.value })} />
        {failed ? <p className="review-meta">Couldn't save on this device. Try again.</p> : null}
      </main>
      <footer className="player-actions review-actions">
        <button type="button" className="btn btn-primary player-primary" disabled={busy} onClick={() => void save()}>
          Save
        </button>
        <button type="button" className="btn player-primary" disabled={busy} onClick={() => setDiscarding(true)}>
          Discard
        </button>
      </footer>
      <ConfirmDialog
        open={discarding}
        onClose={() => setDiscarding(false)}
        title="Discard this session?"
        confirmLabel="Discard session"
        busy={busy}
        onConfirm={() => {
          setBusy(true);
          void onDiscard();
        }}
      >
        Nothing from it is kept.
      </ConfirmDialog>
    </div>
  );
}

/** "First time: Side plank reach" — several in one line: "First time: A, B and 4 more". */
function firstTimes(names: readonly string[]) {
  if (names.length === 0) return null;
  const text =
    names.length <= 3
      ? names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
      : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  return <b>First time: {text}</b>;
}

function ReviewMove({
  row,
  open,
  onToggle,
  rating,
  excluded,
  onRate,
  state,
  onChange,
  src,
  unit,
}: {
  row: ReviewRow;
  open: boolean;
  onToggle: () => void;
  rating: number | null;
  excluded: boolean;
  onRate: (v: 1 | -1 | "never") => void;
  state: PlayerState;
  onChange: (next: PlayerState) => void;
  src: PlayerSource;
  unit: WeightUnit;
}) {
  const line = setsLine(row);
  // An unlogged hold left before half its time was skipped, and the save says so too (ruling 2b-R15).
  const summary = line || (row.logged ? "Not done" : row.done ? "Done" : "Skipped");
  return (
    <div className="review-move">
      <div className="review-move-row">
        <button type="button" className="review-move-name" aria-expanded={open} aria-label={`Edit ${row.name}`} onClick={onToggle}>
          <b>
            {row.name}
            {row.isNew ? (
              <>
                {" "}
                <span className="session-new">New</span>
              </>
            ) : null}
          </b>
          <small className="num">{summary}</small>
        </button>
        <span className="review-rate">
          <button type="button" className="chipbtn" aria-pressed={rating === 1} aria-label={`👍 ${row.name}`} onClick={() => onRate(1)}>
            👍
          </button>
          <button type="button" className="chipbtn" aria-pressed={rating === -1} aria-label={`👎 ${row.name}`} onClick={() => onRate(-1)}>
            👎
          </button>
        </span>
      </div>
      {open ? (
        <div className="review-sets">
          {row.logged
            ? row.sets.map((set) => <SetEditor key={set.index} row={row} set={set} state={state} onChange={onChange} src={src} unit={unit} />)
            : null}
          <button type="button" className="chipbtn" aria-pressed={excluded} aria-label={`Not for me · ${row.name}`} onClick={() => onRate("never")}>
            Not for me
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SetEditor({
  row,
  set,
  state,
  onChange,
  src,
  unit,
}: {
  row: ReviewRow;
  set: ReviewRow["sets"][number];
  state: PlayerState;
  onChange: (next: PlayerState) => void;
  src: PlayerSource;
  unit: WeightUnit;
}) {
  const [weight, setWeight] = useState(set.w ? formatWeight(set.w) : "");
  const [count, setCount] = useState(String((row.metric === "time" ? set.secs : set.reps) ?? ""));
  // An edit of an earlier set fills this one too (the recorder's rule): show it, unless this one is being typed in.
  const typing = useRef(false);
  const shownCount = (row.metric === "time" ? set.secs : set.reps) ?? null;
  useEffect(() => {
    if (!typing.current) setWeight(set.w ? formatWeight(set.w) : "");
  }, [set.w]);
  useEffect(() => {
    if (!typing.current) setCount(shownCount === null ? "" : String(shownCount));
  }, [shownCount]);
  const implement = state.live.entries[row.exerciseId]?.implement ?? null;
  const kbWeights = Lib.kettlebellsAt(src.view.location);
  const field = row.metric === "time" ? "secs" : "reps";
  const commitWeight = (text: string) => {
    typing.current = true;
    setWeight(text);
    const w = text.trim() === "" ? null : parseWeight(text, set.w?.u ?? unit);
    if (w !== null || text.trim() === "") onChange(editSet(state, row.exerciseId, set.index, { w }));
  };
  const stepWeight = (dir: 1 | -1) => {
    const base: Weight | null = parseWeight(weight, set.w?.u ?? unit) ?? set.w ?? kbWeights[0] ?? null;
    if (!base) return;
    const next = Prog.stepWeight(base, dir, { implement, kbWeights });
    commitWeight(formatWeight(next));
  };
  const commitCount = (text: string) => {
    typing.current = true;
    setCount(text);
    const n = Number(text);
    if (text.trim() !== "" && Number.isFinite(n) && n >= 0) onChange(editSet(state, row.exerciseId, set.index, { [field]: Math.round(n) }));
  };
  const step = row.metric === "time" ? 5 : 1;
  return (
    <div
      className="review-set"
      onBlur={() => {
        typing.current = false;
      }}
    >
      <span className="eyebrow">Set {set.index + 1}</span>
      {row.log === "load" ? (
        <Stepper
          label="Weight"
          inputMode="decimal"
          value={weight}
          onChange={commitWeight}
          lessLabel="Lighter"
          moreLabel="Heavier"
          onLess={() => stepWeight(-1)}
          onMore={() => stepWeight(1)}
        />
      ) : null}
      <Stepper
        label={row.metric === "time" ? "Seconds" : "Reps"}
        inputMode="numeric"
        value={count}
        onChange={commitCount}
        lessLabel={row.metric === "time" ? "Fewer seconds" : "Fewer reps"}
        moreLabel={row.metric === "time" ? "More seconds" : "More reps"}
        onLess={() => commitCount(String(Math.max(0, (Number(count) || 0) - step)))}
        onMore={() => commitCount(String((Number(count) || 0) + step))}
      />
      <button
        type="button"
        className="chipbtn"
        aria-pressed={set.done}
        onClick={() => onChange(setDone(state, row.exerciseId, set.index, !set.done))}
      >
        Done
      </button>
    </div>
  );
}

