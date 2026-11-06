/**
 * EVERY MOVE, ONE TAP DOWN (Phase 2a Task 7; mocks §3). The how-to sheet for one move of a built session: its
 * dose, why it is here today, the summary, setup, steps, cues, the switched-on profile's own note, easier and
 * harder versions, and last time.
 *
 * Rating, "not for me" and pin write through `PUT /api/library/:id/prefs`, which arrives in Phase 2c: until then
 * those controls are left out, never shown dead. "Best" waits for the library's history read (2c) the same way.
 *
 * A move from the saves (its why says so, or it is one of the owner's own) names where it came from (audit 2026-11-06,
 * I10): each post's creator (text) and How it came in — the post's trail, open at the move. Read from the move's own
 * read (`GET /api/library/:id`) only for such a move; offline, the section is left out.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ConditionViewDto, type SessionExerciseDto, type SessionItemDto } from "@rg/api-client";
import { isPersonalId } from "@rg/saves";
import { secondsText, type DoseTarget } from "@rg/domain";
import { formatShortDate, Sheet } from "../components.js";
import { checkWord } from "./condition-check-sheet.js";
import { libraryItemQuery } from "../screens/studio/prefs.js";
import { TrailSheet, TRAIL_OPEN_LABEL } from "../screens/saves/trail-sheet.js";

/** The why the engine gives a move from the saves (session-engine `select.ts`). */
const FROM_SAVES = "From your saves";

/** A move the session's slice does not carry, named from its id ("frontRackSquat" → "Front rack squat"). */
export function nameFromId(id: string): string {
  const words = id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const span = (lo: number, hi: number) => (lo === hi ? `${lo}` : `${lo}–${hi}`);

/** The library's dose, in a line: "3 × 5–8 · rest 75 s · kettlebell". */
export function howtoDose(ex: SessionExerciseDto): string {
  const d = ex.dose;
  const [lo, hi] = d.range;
  const amount =
    d.type === "time" || d.type === "carry"
      ? `${span(lo, hi)} s`
      : d.type === "breaths"
        ? `${span(lo, hi)} breaths`
        : span(lo, hi);
  const sets = d.sets ? `${span(d.sets[0], d.sets[1])} × ${amount}` : amount;
  const gear = [...ex.equipment.all, ex.equipment.oneOf.join(" or ")]
    .filter((g) => g.length > 0)
    .map((g) => g.replace(/-/g, " "))
    .join(" · ");
  return [sets, d.restSec ? `rest ${secondsText(d.restSec)}` : null, gear || null].filter(Boolean).join(" · ");
}

export interface HowtoTarget extends DoseTarget {
  last: string | null;
  lastDate: string | null;
  note: string;
}

export function ExerciseHowto({
  exercise,
  item,
  target,
  profiles,
  exercises,
  onClose,
}: {
  exercise: SessionExerciseDto;
  /** The slot it fills today, when opened from a session. */
  item?: SessionItemDto;
  target?: HowtoTarget | null;
  profiles: readonly ConditionViewDto[];
  /** The session's slice, for naming easier and harder versions. */
  exercises: Readonly<Record<string, SessionExerciseDto | undefined>>;
  onClose: () => void;
}) {
  const t = exercise.text;
  const why = [...(item?.why ?? [])];
  if (target?.note && !why.includes(target.note)) why.push(target.note);
  const cues = [...t.focus, ...t.mistakes, t.breathing].filter((c) => c && c.trim().length > 0);
  const notes = profiles
    .map((p) => ({ word: checkWord(p.check.label), note: t.conditions[p.profileId] }))
    .filter((n): n is { word: string; note: string } => !!n.note);
  const named = (id: string) => exercises[id]?.name ?? nameFromId(id);
  // Where a move from the saves came from: its links, from the move's own read (audit 2026-11-06, I10).
  const fromSaves = (item?.why ?? []).includes(FROM_SAVES) || isPersonalId(exercise.id);
  const read = useQuery({ queryKey: libraryItemQuery(exercise.id), queryFn: () => api.getLibraryItem(exercise.id), enabled: fromSaves, retry: false, staleTime: 60_000 });
  const saved = fromSaves ? (read.data?.provenance ?? []).filter((l) => l.creator?.trim() || l.postId) : [];
  const [trail, setTrail] = useState<{ postId: string; position: number | null } | null>(null);
  return (
    <Sheet open onClose={onClose} title={exercise.name}>
      <div className="stack howto">
        <p className="howto-dose">{howtoDose(exercise)}</p>
        {why.length > 0 ? <p className="howto-why">{why.join(" · ")}</p> : null}
        {t.summary ? <p className="howto-summary">{t.summary}</p> : null}
        {t.setup.length > 0 ? (
          <section>
            <h3 className="howto-head">Setup</h3>
            {t.setup.map((line, i) => (
              <p key={i} className="howto-text">
                {line}
              </p>
            ))}
          </section>
        ) : null}
        {t.steps.length > 0 ? (
          <section>
            <h3 className="howto-head">Steps</h3>
            <ol className="howto-steps">
              {t.steps.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ol>
          </section>
        ) : null}
        {cues.length > 0 ? (
          <section>
            <h3 className="howto-head">Focus · Mistakes · Breathing</h3>
            <p className="howto-text howto-cues">{cues.join(" · ")}</p>
          </section>
        ) : null}
        {notes.map((n) => (
          <section key={n.word}>
            <h3 className="howto-head">{n.word}</h3>
            <p className="howto-text">{n.note}</p>
          </section>
        ))}
        {exercise.easier.length + exercise.harder.length > 0 ? (
          <div className="howto-variants">
            {exercise.easier.slice(0, 1).map((id) => (
              <span key={`e-${id}`} className="howto-variant">
                Easier · {named(id)}
              </span>
            ))}
            {exercise.harder.slice(0, 1).map((id) => (
              <span key={`h-${id}`} className="howto-variant">
                Harder · {named(id)}
              </span>
            ))}
          </div>
        ) : null}
        {saved.length > 0 ? (
          <section className="howto-saved">
            <h3 className="howto-head">{FROM_SAVES}</h3>
            <ul className="howto-saved-list">
              {saved.map((l, i) => (
                <li key={`${l.postId ?? l.url ?? ""}-${i}`}>
                  {l.creator?.trim() ? <span className="howto-saved-by">{l.creator.trim()}</span> : null}
                  {l.postId ? (
                    <button
                      type="button"
                      className="linklike tap-pad howto-saved-open"
                      aria-haspopup="dialog"
                      onClick={() => setTrail({ postId: l.postId!, position: typeof l.position === "number" ? l.position : null })}
                    >
                      {TRAIL_OPEN_LABEL}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {target?.last ? (
          <div className="howto-last">
            <b>Last time{target.lastDate ? ` · ${formatShortDate(target.lastDate)}` : ""}</b>{" "}
            <small className="num">{target.last}</small>
          </div>
        ) : null}
      </div>
      {trail ? <TrailSheet postId={trail.postId} onClose={() => setTrail(null)} {...(trail.position !== null ? { focus: { position: trail.position } } : {})} /> : null}
    </Sheet>
  );
}
