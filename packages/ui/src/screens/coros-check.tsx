import { Link } from "react-router-dom";
import type { CorosCheckState } from "./use-coros-read.js";

/** The app-open pull's visible outcome. Silence is only allowed for
 * success — every other state says what happened and what to do. */
export function CorosCheck({ state }: { state: CorosCheckState }) {
  switch (state) {
    case "checking":
      return <span className="pill pill-neutral coros-checking">Checking COROS…</span>;
    case "not_connected":
      return (
        <Link className="pill pill-warnsoft coros-check-link" to="/settings">
          COROS not connected — connect in Settings
        </Link>
      );
    case "bad_credentials":
      return (
        <Link className="pill pill-warnsoft coros-check-link" to="/settings">
          COROS rejected the password — fix in Settings
        </Link>
      );
    case "still_syncing":
      return <span className="pill pill-neutral">Still syncing with COROS…</span>;
    case "coros_unreachable":
      return <span className="pill pill-neutral">COROS unreachable — will retry</span>;
    default:
      return null;
  }
}
