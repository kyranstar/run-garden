/**
 * THE COACH, ANYWHERE (coach everywhere, phase A3; the owner: "the coach should be able to do anything from any point").
 * One app-level coach sheet, mounted once beside the run keeper (app.tsx) and opened by `useCoach().open({ focus,
 * request, scope })` from any screen's "Ask" (coach-ask.tsx):
 *
 *  - It holds the Studio's own coach area — the composer, the live run view, the suggestion's card (composer.tsx
 *    `CoachArea`) — in place: asking never leaves the screen asked from. What it was opened from is the composer's chip.
 *  - A bottom sheet on a phone; a panel at the right edge from lg (1024), the page dimmed beside it — over the Plan's
 *    own floating coach window, never beside it fighting for the edge.
 *  - The dialog's contract (`useDialogFocus`): the focus moves into it — the field, once drawn — Tab stays inside,
 *    Escape closes it (a dialog opened inside it first: the stack decides), and closing gives the focus back to the
 *    Ask that opened it. Leaving the screen (a card's Edit, its "On your plan") closes it too. The run view's live
 *    region announces the coach's lines as it does in the Studio.
 *  - Its run goes on when it closes: the app's run keeper steps it on any screen, and the Studio's nav mark says so.
 *
 * With the coach designer off, the app mounts none, and no screen draws an Ask.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useDialogFocus } from "../../components.js";
import { IconClose } from "../../icons.js";
import { CoachOpenContext, CoachSeeingContext, SeeingRegistry, type CoachOpener } from "./coach-ask.js";
import { CoachBoundary } from "./coach-boundary.js";
import type { CoachFocus, CoachOpenArgs } from "./coach-focus.js";
import { CoachArea } from "./composer.js";
import { useStudioCtx } from "./screen.js";
import type { LoopDeps } from "./use-coach-run.js";

/** The sheet's title (its dialog's name). */
export const COACH_SHEET_TITLE = "Coach";

/** What the sheet was opened with: the words for the box, and what it sees (named, else the screen's registration). */
export interface CoachOpened {
  request: string | null;
  seeing: CoachFocus | null;
}

/**
 * The app's coach sheet, the opener every screen reaches (`useCoach`), and the registry of what the screens show
 * (`useCoachSeeing`): mounted once, inside the router and the run keeper.
 */
export function CoachSheetProvider({ children, loopDeps }: { children: ReactNode; loopDeps?: () => LoopDeps }) {
  const [registry] = useState(() => new SeeingRegistry());
  /** What it was opened with; a new open starts a new sheet (`key`), never one left half-typed from before. */
  const [opened, setOpened] = useState<{ args: CoachOpened; key: number } | null>(null);
  const open = useCallback(
    (args: CoachOpenArgs = {}) => {
      // Named (even as null) wins; otherwise what the screen shows now.
      const seeing = args.seeing !== undefined ? args.seeing : registry.current;
      setOpened((o) => ({ args: { request: args.request ?? null, seeing }, key: (o?.key ?? 0) + 1 }));
    },
    [registry],
  );
  const opener = useMemo<CoachOpener>(() => ({ open }), [open]);
  const close = useCallback(() => setOpened(null), []);
  return (
    <CoachSeeingContext.Provider value={registry}>
      <CoachOpenContext.Provider value={opener}>
        {children}
        {opened ? <CoachSheet key={opened.key} args={opened.args} onClose={close} loopDeps={loopDeps} /> : null}
      </CoachOpenContext.Provider>
    </CoachSeeingContext.Provider>
  );
}

/** The sheet itself: the dialog, and the coach's area in it. */
export function CoachSheet({ args, onClose, loopDeps }: { args: CoachOpened; onClose: () => void; loopDeps?: () => LoopDeps }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(ref, true, onClose);
  // Leaving the screen it was opened on closes it (a link inside it — a card's Edit — goes elsewhere).
  const location = useLocation();
  const openedAt = useRef(location.key);
  useEffect(() => {
    if (location.key !== openedAt.current) onClose();
  }, [location.key, onClose]);
  const ctx = useStudioCtx();
  return (
    <div
      className="sheet-backdrop coach-sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className="sheet coach-sheet" tabIndex={-1}>
        <div className="sheet-handle" aria-hidden />
        <div className="row-between sheet-head">
          <h2 id={titleId}>{COACH_SHEET_TITLE}</h2>
          <button type="button" className="btn sheet-close" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>
        <div className="sheet-body scroller">
          {/* A render error stays in the sheet: it says so, and the screen under it goes on (the robustness pass). */}
          <CoachBoundary>
            <CoachArea ctx={ctx} loopDeps={loopDeps} arrival={{ focus: args.seeing, request: args.request, compose: true }} place="sheet" />
          </CoachBoundary>
        </div>
      </div>
    </div>
  );
}
