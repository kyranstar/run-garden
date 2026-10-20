/**
 * THE WATCH HAS AN EARLIER VERSION OF THIS SESSION — and what the athlete can do about it, in its own sheet (the owner,
 * 2026-10-19: "not actionable or removable").
 *
 * One plain sentence, then what is honestly possible for this row (`GET /api/plan/workouts/:id`'s `watchVersion`):
 * "Send this version to the watch" only when a content rewrite can reach it, else one line saying why; and "Keep the
 * watch's version" always — the app stops calling it a divergence, and nothing is written to the watch. Either one
 * counts the account line down. The sentence is drawn at once; the choice once its read has answered (it lands with
 * the sheet's other reads, below which nothing tappable sits).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type WatchVersionDto } from "@rg/api-client";

/**
 * Why the app's version can't be sent, in one line — or nothing where the sheet's own action already says it with its
 * Settings link (COROS updates off, COROS not connected: `SyncActionNote`'s banner on the same row).
 */
export function watchVersionWhy(why: WatchVersionDto["why"]): string | null {
  return why === "cant_rewrite" ? "Run Garden can't rewrite this one on your watch." : null;
}

/** An app-built session (a programme's, an on-demand one, a Studio or template workout): never rewritten from here. */
export const APP_BUILT_CHOICE: WatchVersionDto = { send: false, why: "cant_rewrite" };

/** What a failed press says: the server's reason when it gave one, else that it didn't get through. */
function failureText(err: unknown): string {
  const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
  if (code === "nothing_to_send") return "There's nothing to send for this one any more.";
  return watchVersionWhy(code as WatchVersionDto["why"]) ?? "That didn't go through — try again.";
}

export function WatchVersion({ workoutId, choice }: { workoutId: string; choice: WatchVersionDto | undefined }) {
  const qc = useQueryClient();
  const settled = () => {
    for (const key of [["sync-status"], ["plan"], ["plan-week"], ["today"], ["workout", workoutId]]) {
      void qc.invalidateQueries({ queryKey: key });
    }
  };
  const send = useMutation({ mutationFn: () => api.sendWatchVersion(workoutId), onSuccess: settled });
  const keep = useMutation({ mutationFn: () => api.keepWatchVersion(workoutId), onSuccess: settled });
  const busy = send.isPending || keep.isPending;
  const why = choice && !choice.send ? watchVersionWhy(choice.why) : null;
  const failed = send.error ?? keep.error;
  return (
    <div className="watch-version">
      <p className="note watch-version-says">
        Your watch has an earlier version of this session.{why ? ` ${why}` : null}
      </p>
      {choice ? (
        <div className="btn-row watch-version-actions">
          {choice.send ? (
            <button className="btn btn-wrap" disabled={busy} onClick={() => send.mutate()}>
              {send.isPending ? "Sending…" : "Send this version to the watch"}
            </button>
          ) : null}
          <button className="btn btn-wrap" disabled={busy} onClick={() => keep.mutate()}>
            {"Keep the watch's version"}
          </button>
        </div>
      ) : null}
      {failed ? (
        <p className="watch-version-error" role="alert">
          {failureText(failed)}
        </p>
      ) : null}
    </div>
  );
}
