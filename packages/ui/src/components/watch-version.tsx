/**
 * THE WATCH HAS AN EARLIER VERSION OF THIS SESSION — and what the athlete can do about it, in its own sheet (the owner,
 * 2026-10-19: "not actionable or removable").
 *
 * One plain sentence, then what is honestly possible for this row (`GET /api/plan/workouts/:id`'s `watchVersion`):
 *
 *  - "Send this version to the watch", only when a content rewrite can reach it — else one line saying why, and with
 *    COROS updates off or COROS not connected what to do first ("…, then send it from here");
 *  - "Keep the watch's version": Run Garden takes the watch's copy at the next COROS read — said at once, and the row
 *    says it until then;
 *  - an app-built session (a programme's, an on-demand one, a Studio or template workout), whose earlier copy nothing
 *    from here replaces and whose content no read takes from the wire, offers "Leave the watch as it is" alone: the
 *    account line stops counting it, and this sentence stays, quietly.
 *
 * Every press says what it did in the block's own place, holding its height, with the focus on that line — the row's
 * view changes under it (and the sheet lets this block tell the story), so nothing below moves and the focus is never
 * dropped to the page. The sentence is drawn at once; the choice once its read has answered (it lands with the sheet's
 * other reads, below which nothing tappable sits).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type WatchVersionDto } from "@rg/api-client";

type Why = WatchVersionDto["why"];

/** An app-built session: never rewritten from here (ruling 3-R13), and never taken from the wire. */
export const APP_BUILT_CHOICE: WatchVersionDto = { send: false, why: "cant_rewrite" };

/** Why the app's version can't be sent, in one line: what is true, and what to do first when the athlete can. */
export function watchVersionWhy(why: Why, appBuilt = false): string | null {
  switch (why) {
    case "cant_rewrite":
      return appBuilt ? "Run Garden can't replace the copy already on your watch." : "Run Garden can't rewrite this one on your watch.";
    case "writes_off":
      return "Turn on COROS updates in Settings, then send it from here.";
    case "not_connected":
      return "Reconnect COROS in Settings, then send it from here.";
    default:
      return null;
  }
}

/** What a refused or failed press says: the server's reason in the same words, else that it didn't get through. */
export function watchVersionFailure(err: unknown, appBuilt = false): string {
  const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
  if (code === "nothing_to_send") return "There's nothing to send for this one any more.";
  if (code === "app_built") return watchVersionWhy("cant_rewrite", true)!;
  return watchVersionWhy(code as Why, appBuilt) ?? "That didn't go through — try again.";
}

/** What each press did, said where its buttons were. */
const DONE = {
  send: "Sending this version to your watch.",
  keep: "Run Garden will take the watch's version at the next sync.",
  leave: "Left as it is. It isn't counted any more.",
} as const;

export function WatchVersion({
  workoutId,
  show,
  choice,
  appBuilt = false,
  left = false,
  settingsLink,
  onDone,
}: {
  workoutId: string;
  /** The row's view says the watch has an earlier version (`content_stale`). */
  show: boolean;
  /** What can be done (the sheet's read; `APP_BUILT_CHOICE` for an app-built one); undefined while it is out. */
  choice: WatchVersionDto | undefined;
  appBuilt?: boolean;
  /** An app-built session already left as it is. */
  left?: boolean;
  /** The screen's own Settings link, beside a line that sends the athlete there. */
  settingsLink?: ReactNode;
  /** A press went through: the block tells the story from here. */
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const [done, setDone] = useState<keyof typeof DONE | null>(null);
  const [hold, setHold] = useState<number | null>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);
  const settled = () => {
    for (const key of [["sync-status"], ["plan"], ["plan-week"], ["today"], ["workout", workoutId]]) {
      void qc.invalidateQueries({ queryKey: key });
    }
  };
  const finish = (what: keyof typeof DONE) => () => {
    setHold(actionsRef.current?.offsetHeight ?? null);
    setDone(what);
    onDone?.();
    settled();
  };
  const send = useMutation({ mutationFn: () => api.sendWatchVersion(workoutId), onSuccess: finish("send") });
  const keep = useMutation({
    mutationFn: () => api.keepWatchVersion(workoutId),
    onSuccess: () => {
      finish("keep")();
      // The read that takes it, now if COROS answers (its own request; a fresh read is a no-op): best effort.
      void api.readNow().then(settled, () => undefined);
    },
  });
  const leave = useMutation({ mutationFn: () => api.leaveWatchVersion(workoutId), onSuccess: finish("leave") });
  useEffect(() => {
    if (done) doneRef.current?.focus({ preventScroll: true });
  }, [done]);

  if (!show && !done) return null;
  const busy = send.isPending || keep.isPending || leave.isPending;
  const why = appBuilt ? (left ? null : watchVersionWhy("cant_rewrite", true)) : choice && !choice.send ? watchVersionWhy(choice.why) : null;
  const toSettings = !appBuilt && (choice?.why === "writes_off" || choice?.why === "not_connected");
  const failed = send.error ?? keep.error ?? leave.error;
  const buttons = done ? null : appBuilt ? (
    left ? null : (
      <button className="btn btn-wrap" disabled={busy} aria-busy={leave.isPending} onClick={() => leave.mutate()}>
        Leave the watch as it is
      </button>
    )
  ) : choice ? (
    <>
      {choice.send ? (
        <button className="btn btn-wrap" disabled={busy} aria-busy={send.isPending} onClick={() => send.mutate()}>
          Send this version to the watch
        </button>
      ) : null}
      <button className="btn btn-wrap" disabled={busy} aria-busy={keep.isPending} onClick={() => keep.mutate()}>
        {"Keep the watch's version"}
      </button>
    </>
  ) : null;
  return (
    <div className="watch-version">
      <p className="note watch-version-says">
        Your watch has an earlier version of this session.
        {why ? ` ${why}` : null}
        {why && toSettings && settingsLink ? <> {settingsLink}</> : null}
        {appBuilt && left && !done ? " You've left it as it is." : null}
      </p>
      {buttons || done ? (
        <div className="btn-row watch-version-actions" ref={actionsRef} style={done && hold ? { minHeight: hold } : undefined}>
          {done ? (
            <p className="watch-version-done" role="status" tabIndex={-1} ref={doneRef}>
              {DONE[done]}
            </p>
          ) : (
            buttons
          )}
        </div>
      ) : null}
      {failed && !done ? (
        <p className="watch-version-error" role="alert">
          {watchVersionFailure(failed, appBuilt)}
        </p>
      ) : null}
    </div>
  );
}
