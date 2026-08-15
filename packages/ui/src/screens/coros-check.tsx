import { Link } from "react-router-dom";
import type { CorosCheckState } from "./use-coros-read.js";

/** The app-open pull's visible outcome. Silence is only allowed for
 * success — every other state says what happened and what to do.
 *
 * These are `.note`s, not `.pill`s: every state but "checking" is a short
 * sentence with a "— do this" clause, and a pill is nowrap by contract.
 * Wearing the label primitive is what forced the per-site
 * `white-space: normal` override the screen-title rules used to carry. */
export function CorosCheck({ state }: { state: CorosCheckState }) {
  switch (state) {
    case "checking":
      return <span className="note coros-checking">Checking COROS…</span>;
    case "not_connected":
      return (
        <Link className="note note-warn coros-check-link" to="/settings">
          COROS not connected — connect in Settings
        </Link>
      );
    case "bad_credentials":
      return (
        <Link className="note note-warn coros-check-link" to="/settings">
          COROS rejected the password — fix in Settings
        </Link>
      );
    case "still_syncing":
      return <span className="note">Still syncing with COROS…</span>;
    case "coros_unreachable":
      return <span className="note">COROS unreachable — will retry</span>;
    default:
      return null;
  }
}
