import { useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError, type CoachAnalyzeResult } from "@rg/api-client";
import { Spinner } from "../components.js";

/**
 * The coach's read of one completed effort (effort-analysis spec §6).
 * Strictly trigger-only: this card mounts when the user asks for it, and
 * mounting IS the trigger — cached reads return instantly, first reads run
 * the coach (up to a couple of minutes). Re-run forces a fresh read.
 */
export function CoachRead({ activityId }: { activityId: string }) {
  const started = useRef(false);
  const analyze = useMutation<CoachAnalyzeResult, unknown, boolean>({
    mutationFn: (force: boolean) => api.coachAnalyze(activityId, force),
  });
  const { mutate } = analyze;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    mutate(false);
  }, [mutate]);

  if (analyze.isPending) {
    return (
      <div className="coach-read">
        <Spinner label="The coach is reading this effort…" />
        {/* Audit M4: the spinner's label lives in a visually-hidden span for
            screen readers — sighted users saw a bare spinner with no sense of
            what was happening or that a first read can take a while. */}
        <p className="muted coach-read-waiting">
          The coach is reading this effort — first reads can take a minute or two.
        </p>
      </div>
    );
  }
  if (analyze.isError) {
    const resting = analyze.error instanceof ApiError && analyze.error.status === 429;
    return (
      <div className="coach-read">
        <p className="muted">
          {resting
            ? "The coach is resting — weekly budget reached. Try again next week."
            : "The coach couldn't read this effort just now."}
        </p>
        {!resting ? (
          <button className="btn btn-small" onClick={() => analyze.mutate(false)}>
            Try again
          </button>
        ) : null}
      </div>
    );
  }
  if (!analyze.data) return null;
  return (
    <div className="coach-read">
      <p className="coach-read-body">{analyze.data.message.body}</p>
      <div className="coach-read-meta">
        <span className="faint">
          Coach · {new Date(analyze.data.message.at).toLocaleDateString()}
        </span>
        <button
          className="btn btn-small"
          disabled={analyze.isPending}
          onClick={() => analyze.mutate(true)}
        >
          ↻ Fresh read
        </button>
      </div>
    </div>
  );
}
