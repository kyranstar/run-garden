import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, restoreStartFresh, type RestoreStatus } from "@rg/api-client";

/**
 * "A restore didn't finish" (audit 1 data finding 8, ruling B2). While the
 * restore marker is set the account is half-wiped and frozen, and every screen
 * says so with the two ways out: restore the file again, or start fresh.
 *
 * Start fresh deletes what the unfinished restore brought back, so it takes a
 * second tap, like "Delete all data".
 *
 * A restore that is still RUNNING — a page arrived under two minutes ago, on
 * this device or another (ruling B10) — is not "didn't finish": the notice
 * says it is running and offers nothing that would cut it short. The device
 * that ran a restore which then failed passes its `ownRestoreId`, so it can
 * start fresh at once instead of waiting for the heartbeat to lapse.
 */
export function RestorePendingNotice({
  restore,
  onRestoreAgain,
  ownRestoreId,
}: {
  restore: RestoreStatus | null | undefined;
  onRestoreAgain: () => void;
  ownRestoreId?: string | null;
}) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const own = !!restore && !!ownRestoreId && restore.restoreId === ownRestoreId;
  const fresh = useMutation({
    mutationFn: () => restoreStartFresh(own ? ownRestoreId! : undefined),
    onSettled: () => {
      setConfirming(false);
      void qc.invalidateQueries();
    },
  });
  if (!restore) return null;
  if (restore.running && !own) {
    return (
      <div className="banner banner-info restore-pending" role="status">
        <span>A restore is running — here or on another device. Your account is paused until it finishes.</span>
      </div>
    );
  }
  const refusedRunning =
    fresh.error instanceof ApiError && (fresh.error.body as { error?: string } | null)?.error === "restore_running";
  return (
    <div className="banner banner-warn restore-pending" role="alert">
      <span>A restore didn't finish.</span>
      <div className="btn-row">
        <button type="button" className="btn" disabled={fresh.isPending} onClick={onRestoreAgain}>
          Restore again
        </button>
        {confirming ? (
          <>
            <button
              type="button"
              className="btn btn-danger"
              disabled={fresh.isPending}
              onClick={() => fresh.mutate()}
            >
              Delete everything and start fresh
            </button>
            <button type="button" className="btn" disabled={fresh.isPending} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="btn" onClick={() => setConfirming(true)}>
            Start fresh
          </button>
        )}
      </div>
      {fresh.isError ? (
        <span>
          {refusedRunning
            ? "The restore started running again on another device. Let it finish."
            : "Couldn't start fresh. Try again."}
        </span>
      ) : null}
    </div>
  );
}
