import { useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError, type CoachAnalyzeResult } from "@rg/api-client";
import { Spinner } from "../components.js";

/** How long to wait before re-asking when another surface is mid-generation. */
const WORKING_POLL_MAX = 20; // ×4s ≈ 80s of patience
const WORKING_POLL_MS = 4000;

/**
 * The coach's read of one completed effort. Reads are ambient now (rework
 * spec §1) — most mounts serve the ledger instantly; a miss generates
 * synchronously, and a 202 "working" (another tab or the ambient pipeline is
 * mid-read) polls instead of double-calling the model.
 */
export function CoachRead({ activityId }: { activityId: string }) {
  const started = useRef(false);
  const alive = useRef(true);
  const analyze = useMutation<CoachAnalyzeResult, unknown, boolean>({
    mutationFn: (force: boolean) => api.coachAnalyze(activityId, force),
  });
  const { mutate, data } = analyze;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    mutate(false);
    return () => {
      alive.current = false;
    };
  }, [mutate]);

  // 202 working → someone else is generating; check back shortly. Bounded
  // (audit finding 14): a read stuck in a stale claim window otherwise kept
  // an "a minute or two" spinner alive for ten minutes.
  const polls = useRef(0);
  useEffect(() => {
    if (data?.status !== "working") return;
    if (polls.current >= WORKING_POLL_MAX) return;
    const t = setTimeout(() => {
      polls.current += 1;
      if (alive.current) mutate(false);
    }, WORKING_POLL_MS);
    return () => clearTimeout(t);
  }, [data, mutate]);

  if (data?.status === "working" && polls.current >= WORKING_POLL_MAX) {
    return (
      <div className="coach-read">
        <p className="muted">
          This read is taking longer than it should — it retries on its own; check back in a few
          minutes.
        </p>
      </div>
    );
  }
  if (analyze.isPending || data?.status === "working") {
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
    const status = analyze.error instanceof ApiError ? analyze.error.status : 0;
    const resting = status === 429;
    const disabled = status === 503;
    return (
      <div className="coach-read">
        <p className="muted">
          {resting
            ? "The coach is resting — weekly budget reached. Try again next week."
            : disabled
              ? "AI is turned off in Settings — the coach can't read efforts."
              : "The coach couldn't read this effort just now."}
        </p>
        {!resting && !disabled ? (
          <button className="btn btn-small" onClick={() => analyze.mutate(false)}>
            Try again
          </button>
        ) : null}
      </div>
    );
  }
  if (!analyze.data?.read) return null;
  const read = analyze.data.read;
  return (
    <div className="coach-read">
      {read.glance ? <p className="coach-read-glance">{read.glance}</p> : null}
      <p className="coach-read-body">{read.body}</p>
      <div className="coach-read-meta">
        <span className="faint">Coach · {new Date(read.at).toLocaleDateString()}</span>
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
