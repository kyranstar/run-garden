/**
 * LOG YOUR SESSION — the quick review after a watch session (Phase 3 Task 10; spec §5; approved mocks §3 and owner
 * calls 11–12: a sheet, not the full-screen review; the post-check, the sets and a note — no 👍 / 👎, no block switch,
 * no records).
 *
 * Opens prefilled from `GET …/watch-review`: the watch's logged sets paired with the build, its targets where the
 * watch logged nothing. Each move is one row — its sets as a line — that opens to the player's review steppers; watch
 * values and targets look the same (nothing labels where a value came from). The moves the watch logged show; the rest
 * wait behind "N more". Save goes through the outbox like the player's (keyed by the session's id and payload hash),
 * so it survives being offline ("will sync"), and a 409 `slot_done` is the outbox's conflict row in Settings → Data.
 * Not now closes and keeps nothing: the line stays on Today until its window ends.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type MeResponse, type WatchReviewBasisDto } from "@rg/api-client";
import {
  formatWeight,
  parseWeight,
  PERFORMED_LIMITS,
  type PerformedSessionWire,
  type PerformedSet,
  type Weight,
  type WeightUnit,
} from "@rg/domain";
import { Prog } from "@rg/session-engine";
import { Banner, formatDayLong, Sheet, Spinner } from "../components.js";
import { offlineDb } from "../offline/idb.js";
import { meWithOfflineFallback } from "../offline/me.js";
import { outboxEntries } from "../offline/outbox.js";
import { saveSession, type SaveResult } from "../player/save.js";
import { CheckScale, checkWord } from "./condition-check-sheet.js";
import { afterDrain, SAVED_SESSION_QUERIES } from "./outbox-sync.js";
import { Stepper } from "./set-steppers.js";

type Entry = Omit<WatchReviewBasisDto["entries"][number], "sets"> & { sets: PerformedSet[] };
export type ReviewSaveResult = SaveResult | "conflict";

/** One set as its line reads: "30 lb × 6", "8", "45 s", "20 kg · 30 s". */
function setText(s: PerformedSet): string {
  const count = s.reps !== null ? String(s.reps) : s.seconds !== null ? `${s.seconds} s` : "";
  if (!s.load) return count;
  return s.reps !== null ? `${formatWeight(s.load)} × ${s.reps}` : [formatWeight(s.load), count].filter(Boolean).join(" · ");
}

/** A move's sets in one line — one figure per set (per side pair for a one-sided move: "… each side"). */
export function entryLine(e: Pick<Entry, "perSide" | "sets">): string {
  const sets = e.perSide ? e.sets.filter((_, i) => i % 2 === 0) : e.sets;
  const text = sets.map(setText).filter(Boolean).join(" · ");
  return e.perSide && text ? `${text} each side` : text;
}

export function WatchReviewSheet({
  workoutId,
  title,
  onClose,
  onSaved,
  saveWaitMs,
}: {
  workoutId: string;
  /** The program's name, on the sheet's first line. */
  title: string;
  onClose: () => void;
  /**
   * Saved: "saved" when the server took it, "pending" when it waits in the outbox ("will sync"), "conflict" when the
   * server refused it because the slot was saved first (409 `slot_done`; the conflict row in Settings → Data).
   */
  onSaved: (result: ReviewSaveResult) => void;
  /** How long Save waits for the first send (tests). */
  saveWaitMs?: number;
}) {
  const qc = useQueryClient();
  const basis = useQuery({
    queryKey: ["watch-review", workoutId],
    queryFn: () => api.watchReview(workoutId),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  // A basis missing its entries (an older worker, a broken answer) is one that could not load.
  const b = basis.data && Array.isArray(basis.data.entries) ? basis.data : null;
  const [entries, setEntries] = useState<Entry[] | null>(null);
  useEffect(() => {
    if (b && entries === null) setEntries(b.entries.map((e) => ({ ...e, sets: e.sets.map(({ from: _from, ...s }) => s) })));
  }, [b, entries]);
  const [post, setPost] = useState<Record<string, number>>({});
  const [note, setNote] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  /** One id per sheet: a second tap on Save is the same session (the outbox keys by id and payload). */
  const sessionId = useRef<string>(crypto.randomUUID());

  // The moves the watch logged show; the rest wait behind "N more" (all of them show when the watch logged none).
  const logged = useMemo(() => new Set((b?.entries ?? []).flatMap((e, i) => (e.sets.some((s) => s.from === "watch") ? [i] : []))), [b]);
  const visible = (entries ?? []).map((e, i) => ({ e, i })).filter(({ i }) => all || logged.size === 0 || logged.has(i));
  const hidden = (entries?.length ?? 0) - visible.length;

  const editSet = (entry: number, index: number, change: Partial<PerformedSet>) =>
    setEntries((cur) => cur && cur.map((e, i) => (i !== entry ? e : { ...e, sets: e.sets.map((s, j) => (j === index ? { ...s, ...change } : s)) })));

  const save = async () => {
    if (!b || !entries) return;
    setBusy(true);
    setFailed(false);
    const at = new Date().toISOString();
    const wire: PerformedSessionWire = {
      id: sessionId.current,
      source: "watch_review",
      sourceRef: b.sourceRef,
      workoutId: b.workoutId,
      buildId: b.buildId,
      localDate: b.localDate,
      startedAt: b.startedAt,
      endedAt: b.endedAt,
      seconds: b.seconds,
      plannedSeconds: null,
      minutes: null,
      mode: null,
      theme: null,
      locationId: null,
      blockRef: null,
      blockNumber: null,
      completed: true,
      stepsTotal: null,
      stepsDone: null,
      movesDone: [],
      note: note.trim() === "" ? null : note,
      newMove: b.newMove,
      entries: entries
        .filter((e) => e.sets.length > 0)
        .map((e) => ({ exerciseId: e.exerciseId, implement: e.implement, format: e.format, perSide: e.perSide, sets: e.sets.map((s, i) => ({ ...s, setIndex: i })) })),
      checks: b.profiles.flatMap((p) => (post[p.profileId] !== undefined ? [{ profileId: p.profileId, kind: "post" as const, value: post[p.profileId]!, feelingOff: false, at }] : [])),
      review: { ratings: {}, excluded: {}, graduations: [] },
    };
    try {
      let result: ReviewSaveResult;
      // No IndexedDB here (a private window): straight to the server, or not at all. ONLY then — a save the outbox
      // refuses (its schema) never goes around it (audit 3-B UI-7): it would fail offline with nothing kept.
      const db = await offlineDb().catch(() => null);
      if (db) {
        const userId = qc.getQueryData<MeResponse>(["me"])?.userId ?? (await meWithOfflineFallback().catch(() => null))?.userId ?? null;
        if (!userId) throw new Error("no signed-in account to save for");
        result = await saveSession(db, wire, { savePerformed: api.savePerformed }, userId, {
          waitMs: saveWaitMs,
          onDrained: (r) => afterDrain(qc, r),
        });
        // Still in the outbox is not always "will sync": refused because the slot was saved first (409 `slot_done`),
        // it is the conflict in Settings → Data — closed as that, and Today no longer offers it (audit 3-B UI-5).
        if (result === "pending" && (await outboxEntries(db)).some((e) => e.performedId === wire.id && e.state === "conflict")) {
          result = "conflict";
        }
      } else {
        await api.savePerformed(wire.id, wire);
        result = "saved";
      }
      void qc.invalidateQueries({ queryKey: ["outbox"] });
      // Saved — or saved first by another session: Today, Plan and the garden show the slot done either way.
      if (result !== "pending") for (const k of SAVED_SESSION_QUERIES) void qc.invalidateQueries({ queryKey: [k] });
      onSaved(result);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  const foot = (
    <div className="btn-row btn-row--split">
      <button type="button" className="btn btn-primary" disabled={busy || !entries} onClick={() => void save()}>
        Save
      </button>
      <button type="button" className="btn" disabled={busy} onClick={onClose}>
        Not now
      </button>
    </div>
  );

  let body: React.ReactNode;
  if (basis.isLoading) body = <Spinner label="Loading the session" />;
  else if (!b || !entries) body = <Banner kind="warn">Couldn't load this session — try again in a moment.</Banner>;
  else
    body = (
      <>
        <p className="watch-review-when">
          {title} · {formatDayLong(b.localDate)} · {Math.max(1, Math.round(b.seconds / 60))} min
        </p>
        {b.profiles.map((p) => {
          const before = b.before[p.profileId];
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
                onPick={(n) =>
                  setPost((cur) => {
                    const next = { ...cur };
                    if (n === null) delete next[p.profileId];
                    else next[p.profileId] = n;
                    return next;
                  })
                }
              />
            </section>
          );
        })}
        {entries.length > 0 ? (
          <section className="review-card review-moves" aria-label="Moves">
            {visible.map(({ e, i }) => (
              <div key={`${e.exerciseId}-${i}`} className="review-move">
                <div className="review-move-row">
                  {/* Named by what it shows — the move and the values to check (audit 3-B UI-10); aria-expanded says it
                      opens. */}
                  <button type="button" className="review-move-name" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                    <b>{e.name}</b>{" "}
                    <small className="num">{entryLine(e)}</small>
                  </button>
                  <span className="review-chev" aria-hidden="true">
                    {open === i ? "⌃" : "›"}
                  </span>
                </div>
                {open === i ? (
                  <div className="review-sets">
                    {e.sets.map((s, j) => (
                      <SetEditor key={j} entry={e} set={s} index={j} unit={b.unit} onEdit={(change) => editSet(i, j, change)} />
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
            {hidden > 0 ? (
              <button type="button" className="review-more" onClick={() => setAll(true)}>
                <b>{hidden} more</b>
                <span aria-hidden="true">›</span>
              </button>
            ) : null}
          </section>
        ) : null}
        {/* At most what the server takes (audit 3-B UI-7): a longer note could not be kept, offline or not. */}
        <textarea
          className="review-note"
          aria-label="Note"
          placeholder="Note"
          rows={2}
          maxLength={PERFORMED_LIMITS.note}
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, PERFORMED_LIMITS.note))}
        />
        {failed ? <p className="review-meta">Couldn't save on this device. Try again.</p> : null}
      </>
    );

  return (
    <Sheet open onClose={onClose} title="Log your session" footer={foot}>
      <div className="stack watch-review">{body}</div>
    </Sheet>
  );
}

/** One set: weight (where the move is weighted), reps or seconds, and Done — the player's review steppers. */
function SetEditor({
  entry,
  set,
  index,
  unit,
  onEdit,
}: {
  entry: Entry;
  set: PerformedSet;
  index: number;
  unit: WeightUnit;
  onEdit: (change: Partial<PerformedSet>) => void;
}) {
  const timed = set.reps === null && set.seconds !== null;
  const weighted = entry.sets.some((s) => s.load !== null);
  const [weight, setWeight] = useState(set.load ? formatWeight(set.load) : "");
  const [count, setCount] = useState(String((timed ? set.seconds : set.reps) ?? ""));
  const commitWeight = (text: string) => {
    setWeight(text);
    const w = text.trim() === "" ? null : parseWeight(text, set.load?.u ?? unit);
    if (w !== null || text.trim() === "") onEdit({ load: w });
  };
  const stepWeight = (dir: 1 | -1) => {
    const base: Weight | null = parseWeight(weight, set.load?.u ?? unit) ?? set.load ?? null;
    if (!base) return;
    commitWeight(formatWeight(Prog.stepWeight(base, dir, { implement: null, kbWeights: [] })));
  };
  const commitCount = (text: string) => {
    setCount(text);
    const n = Number(text);
    if (text.trim() !== "" && Number.isFinite(n) && n >= 0) onEdit(timed ? { seconds: Math.round(n) } : { reps: Math.round(n) });
  };
  const step = timed ? 5 : 1;
  const n = entry.perSide ? Math.floor(index / 2) + 1 : index + 1;
  const side = set.side === "left" ? " · Left" : set.side === "right" ? " · Right" : "";
  return (
    <div className="review-set">
      <span className="eyebrow">
        Set {n}
        {side}
      </span>
      {weighted ? (
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
        label={timed ? "Seconds" : "Reps"}
        inputMode="numeric"
        value={count}
        onChange={commitCount}
        lessLabel={timed ? "Fewer seconds" : "Fewer reps"}
        moreLabel={timed ? "More seconds" : "More reps"}
        onLess={() => commitCount(String(Math.max(0, (Number(count) || 0) - step)))}
        onMore={() => commitCount(String((Number(count) || 0) + step))}
      />
      <button type="button" className="chipbtn" aria-pressed={set.done} onClick={() => onEdit({ done: !set.done })}>
        Done
      </button>
    </div>
  );
}
