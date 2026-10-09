/**
 * WHAT THE WATCH WILL SHOW (Phase 3 Task 8; spec §4.2; approved mocks §1 "Preview · from Send to watch", §2 "Preview ·
 * over 200 steps"; owner calls 2–6 and 8, 2026-10-08).
 *
 * Every step the watch runs, numbered, in order — one per set, read off the very program the push writes (the preview
 * IS the wire), so no "3 ×" grouping and no block headings: the watch has neither. Headed by the stamp the watch shows.
 * Each row: the name (the watch's own for a move it knows; a move it doesn't keeps its real name and a small "Free
 * text" tag), the target, the kg the watch shows with the athlete's unit beside it, the cue, and the rest on the right.
 *
 *  - Send posts the shown preview's digest (audit W-2 / W-8). A 409 `stale_preview` carries the fresh preview: it takes
 *    the shown one's place and nothing is sent until Send is tapped again. A 409 `stale` carries the fresh session: the
 *    sheet shows it, as Start's does.
 *  - "Too long for the watch" takes Send's place at the foot (owner call 8); the steps stay listed.
 *  - Send takes the focus once the steps are in, so Enter sends; Escape closes, as every sheet does.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, ApiError, type SessionDto, type WatchPreviewDto, type WatchPreviewStepDto } from "@rg/api-client";
import { formatWeight } from "@rg/domain";
import { Banner, Sheet, Spinner } from "../components.js";
import { IconAlert } from "../icons.js";

/** "13.6 kg": the kg the watch shows, to a tenth. */
function kgText(grams: number): string {
  return `${Number((grams / 1000).toFixed(1))} kg`;
}

/** "6 reps · 13.6 kg · 30 lb" — the target, the kg the watch shows, and the athlete's unit beside it (not twice). */
export function watchTargetText(step: Pick<WatchPreviewStepDto, "target" | "grams" | "load">): string {
  const parts: string[] = [];
  if (step.target.kind === "reps") parts.push(`${step.target.reps} reps`);
  else if (step.target.kind === "hold") parts.push(`${step.target.seconds} s`);
  if (step.grams !== null) {
    parts.push(kgText(step.grams));
    if (step.load && step.load.u !== "kg") parts.push(formatWeight(step.load));
  }
  return parts.join(" · ");
}

export function WatchPreviewSheet({
  workoutId,
  minutes,
  onClose,
  onSent,
  onStale,
  onRefused,
}: {
  workoutId: string;
  /** The session's length, beside the step count. */
  minutes: number | null;
  onClose: () => void;
  /** Send was taken: the session as it now stands (its push queued). */
  onSent: (session: SessionDto) => void;
  /** 409 `stale`: the day's inputs moved on — the fresh session, to show instead. */
  onStale: (session: SessionDto) => void;
  /** Any other refusal (the slot changed under the sheet): the sheet reads the session again. */
  onRefused?: () => void;
}) {
  const loaded = useQuery({
    queryKey: ["watch-preview", workoutId],
    queryFn: () => api.watchPreview(workoutId),
    // What is shown is what Send carries: never swapped under the athlete by a refetch.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  /** A fresh preview a 409 `stale_preview` handed back, shown in place of the loaded one. */
  const [swapped, setSwapped] = useState<WatchPreviewDto | null>(null);
  const preview = swapped ?? loaded.data ?? null;
  const [failed, setFailed] = useState(false);

  const send = useMutation({
    mutationFn: (p: WatchPreviewDto) => api.sendToWatch(workoutId, p.buildId, p.digest),
    onMutate: () => setFailed(false),
    onSuccess: (next) => onSent(next),
    onError: (err) => {
      const body = err instanceof ApiError ? (err.body as { error?: string; preview?: WatchPreviewDto; session?: SessionDto } | null) : null;
      if (body?.error === "stale_preview" && body.preview) setSwapped(body.preview);
      else if (body?.error === "stale" && body.session) onStale(body.session);
      else if (err instanceof ApiError && err.status === 409) onRefused?.();
      else setFailed(true);
    },
  });

  // Send takes the focus once the steps are in: Enter sends (the dialog itself held it while loading).
  const sendRef = useRef<HTMLButtonElement>(null);
  const canSend = !!preview && preview.refusal === null;
  useEffect(() => {
    if (canSend) sendRef.current?.focus();
  }, [canSend, preview?.digest]);

  let foot: React.ReactNode = null;
  if (preview?.refusal === "too_long") {
    foot = (
      <div className="watch-state watch-state--warn watch-state--solo">
        <span className="watch-state-label">
          <IconAlert size={16} />
          Too long for the watch
        </span>
      </div>
    );
  } else if (canSend) {
    foot = (
      <div className="btn-row btn-row--split">
        <button ref={sendRef} type="button" className="btn btn-primary watch-send" disabled={send.isPending} onClick={() => send.mutate(preview!)}>
          Send
        </button>
      </div>
    );
  }

  let body: React.ReactNode;
  if (loaded.isLoading && !preview) body = <Spinner label="Loading what the watch will show" />;
  else if (!preview) body = <Banner kind="warn">Couldn't load this — try again in a moment.</Banner>;
  else
    body = (
      <>
        <p className="watch-preview-when">
          {preview.steps.length} steps{minutes ? ` · ${minutes} min` : ""}
        </p>
        <ol className="wsteps">
          {preview.steps.map((s, i) => (
            <li key={i} className="wstep">
              <span className="wstep-n">{i + 1}</span>
              <span className="wstep-main">
                <span className="wstep-name">
                  {s.name}
                  {s.freeText ? (
                    <>
                      {" "}
                      <span className="wstep-free">Free text</span>
                    </>
                  ) : null}
                </span>
                {watchTargetText(s) ? <span className="wstep-target">{watchTargetText(s)}</span> : null}
                {s.overview ? <span className="wstep-cue">{s.overview}</span> : null}
              </span>
              {s.restSeconds > 0 ? <span className="wstep-rest">Rest {s.restSeconds} s</span> : <span aria-hidden="true" />}
            </li>
          ))}
        </ol>
        {failed ? <Banner kind="warn">Couldn't send — try again in a moment.</Banner> : null}
      </>
    );

  return (
    <Sheet open onClose={onClose} title={preview?.stamp ?? "Send to watch"} footer={foot}>
      <div className="stack watch-preview">{body}</div>
    </Sheet>
  );
}
