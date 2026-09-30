import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { restoreStartFresh, type RestoreStatus } from "@rg/api-client";

/**
 * "A restore didn't finish" (audit 1 data finding 8, ruling B2). While the
 * restore marker is set the account is half-wiped and frozen, and every screen
 * says so with the two ways out: restore the file again, or start fresh.
 *
 * Start fresh deletes what the unfinished restore brought back, so it takes a
 * second tap, like "Delete all data".
 */
export function RestorePendingNotice({
  restore,
  onRestoreAgain,
}: {
  restore: RestoreStatus | null | undefined;
  onRestoreAgain: () => void;
}) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const fresh = useMutation({
    mutationFn: restoreStartFresh,
    onSettled: () => {
      setConfirming(false);
      void qc.invalidateQueries();
    },
  });
  if (!restore) return null;
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
      {fresh.isError ? <span>Couldn't start fresh. Try again.</span> : null}
    </div>
  );
}
