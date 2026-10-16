/**
 * A RENDER ERROR IN THE COACH STAYS IN THE COACH (the robustness pass, 2026-10-16). Without a boundary, one throw while
 * drawing the coach's composer, run view or suggestion — a newer server's answer this bundle misreads, say — unmounts
 * the whole app: a blank page. Each piece of the coach sits in one of these, and so does the objectives board: a piece
 * that fails says so plainly, with a reload, and the Studio and the rest of the app go on.
 *
 * `quiet`: a piece too small to say anything (the nav's mark) just disappears.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** What it shows, in the line's words: "the coach" (the default), "your objectives". */
  what?: string;
  /** Show nothing when it fails. */
  quiet?: boolean;
  /** How to reload (the page's own reload; a test passes its own). */
  onReload?: () => void;
}

/** The line a failed piece shows, before its reload. */
export const brokenLine = (what = "the coach"): string => `Something went wrong showing ${what} —`;

export class CoachBoundary extends Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // No telemetry (docs/SECURITY.md): the console is the one sink.
    console.error("The coach failed to render:", error, info.componentStack);
  }

  private readonly reload = (): void => {
    if (this.props.onReload) return this.props.onReload();
    if (typeof window !== "undefined") window.location.reload();
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    if (this.props.quiet) return null;
    return (
      <div className="coach-broken" role="alert">
        <p>
          {brokenLine(this.props.what)}{" "}
          <button type="button" className="linklike tap-pad" onClick={this.reload}>
            reload
          </button>
        </p>
      </div>
    );
  }
}
