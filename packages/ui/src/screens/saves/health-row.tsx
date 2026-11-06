/**
 * THE IMPORT'S HEALTH ROW (design 2026-11-05 §3.2, §6.5; server: `GET /api/my-saves/health`): one small labelled light
 * per stage and source —
 *
 *   ✓ Instagram  – YouTube  ✓ Screening  ✕ Reader  ✓ Matching  ✓ Coach  ✓ Budget
 *   Reader: 3 of 4 failed                                     ← the worst light's line, when one isn't green
 *
 * Each light is its colour, a glyph and a word: grey (nothing to judge in the window) is never green. A tap on a light
 * opens its failures under the row: the post (which opens its trail), when, why in plain words, and Retry where there is
 * a post to retry. All green, the row is the only thing shown. On Settings → Saves and the coach's saves card.
 */
import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, SAVES_HEALTH_QUERY, SAVES_LINKS_QUERY, SAVES_STATUS_QUERY } from "@rg/api-client";
import { HEALTH_LABELS, HEALTH_MARKS, type HealthLight, type HealthLightDto, type ImportHealthDto } from "@rg/saves";
import { TrailSheet } from "./trail-sheet.js";
import { whenWords } from "./trail-model.js";

// The labels, the glyphs and words, and the red rule are the popup's too: one copy, in @rg/saves.
export { HEALTH_LABELS, HEALTH_MARKS, redLine } from "@rg/saves";

/** The row's read: an answer the shape of the health's, else nothing (an older Worker, the feature off). */
export function healthOf(data: unknown): ImportHealthDto | null {
  const d = data as Partial<ImportHealthDto> | null | undefined;
  return d && Array.isArray(d.lights) ? (d as ImportHealthDto) : null;
}

export function HealthRow({ health, compact = false }: { health: ImportHealthDto; compact?: boolean }) {
  const [open, setOpen] = useState<HealthLight | null>(null);
  const [trail, setTrail] = useState<string | null>(null);
  const id = useId();
  const shown = health.lights.find((l) => l.light === open) ?? null;
  return (
    <div className={compact ? "health health--compact" : "health"} role="group" aria-label="Import health">
      <ul className="health-lights">
        {health.lights.map((l) => {
          const m = HEALTH_MARKS[l.color];
          return (
            <li key={l.light}>
              <button
                type="button"
                className={`health-light health-light--${l.color}`}
                aria-expanded={open === l.light}
                aria-controls={`${id}-panel`}
                onClick={() => setOpen((o) => (o === l.light ? null : l.light))}
              >
                <span className="health-mark" aria-hidden="true">
                  {m.mark}
                </span>
                <span className="health-label">{HEALTH_LABELS[l.light]}</span>
                <span className="visually-hidden">{`: ${m.word}`}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {health.worst ? <p className="health-line">{health.worst}</p> : null}
      <div id={`${id}-panel`} className="health-panel" hidden={!shown}>
        {shown ? <Failures light={shown} onTrail={setTrail} /> : null}
      </div>
      {trail ? <TrailSheet postId={trail} onClose={() => setTrail(null)} /> : null}
    </div>
  );
}

function Failures({ light, onTrail }: { light: HealthLightDto; onTrail: (postId: string) => void }) {
  if (light.failures.length === 0) {
    return (
      <p className="health-none">
        {light.line ?? (light.color === "grey" ? "Nothing to judge in the last 7 days." : "Nothing failed in the last 7 days.")}
      </p>
    );
  }
  return (
    <>
      {light.line ? <p className="health-line">{light.line}</p> : null}
      <ul className="health-failures" aria-label={`${HEALTH_LABELS[light.light]}: what failed`}>
        {light.failures.map((f, i) => (
          <Failure key={`${f.postId ?? "none"}-${f.at}-${i}`} failure={f} onTrail={onTrail} />
        ))}
      </ul>
    </>
  );
}

function Failure({ failure: f, onTrail }: { failure: HealthLightDto["failures"][number]; onTrail: (postId: string) => void }) {
  const qc = useQueryClient();
  // A post is read again by its override; a read that failed before its post, by pasting its link again (audit
  // 2026-11-06, I3) — a link the Worker checked, drawn only as text.
  const again = useMutation({
    mutationFn: async (to: { postId: string } | { link: string }): Promise<unknown> =>
      "postId" in to ? api.savesOverride(to.postId, "process") : api.savesAddLink(to.link),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: SAVES_HEALTH_QUERY });
      void qc.invalidateQueries({ queryKey: SAVES_STATUS_QUERY });
      void qc.invalidateQueries({ queryKey: SAVES_LINKS_QUERY });
    },
  });
  const target = f.postId ? { postId: f.postId } : f.retryLink ? { link: f.retryLink } : null;
  // Moving again already, or read since: nothing to retry.
  const said = again.isSuccess
    ? "Sent to be read again"
    : again.error instanceof ApiError && again.error.status === 409
      ? "Nothing to retry now"
      : again.isError
        ? "Couldn't send that — try again"
        : "";
  return (
    <li className="health-failure">
      <span className="health-failure-what">
        {f.postId ? (
          <button type="button" className="linklike tap-pad health-failure-title" aria-haspopup="dialog" onClick={() => onTrail(f.postId!)}>
            {f.title}
          </button>
        ) : (
          <span className="health-failure-title">{f.title}</span>
        )}
        <span className="health-failure-why">{[whenWords(f.at), f.why].filter(Boolean).join(" · ")}</span>
        {said ? (
          <span className="health-failure-why" role="status">
            {said}
          </span>
        ) : null}
      </span>
      {target && !again.isSuccess ? (
        <button type="button" className="btn btn-small" disabled={again.isPending} onClick={() => again.mutate(target)}>
          Retry
        </button>
      ) : null}
    </li>
  );
}
