/**
 * THE COACH'S SHEET (the new shape §5, 2026-10-17; coach everywhere before it). One app-level sheet, mounted once beside
 * the run keeper (app.tsx), opened by `useCoach().open({ request?, seeing? })` — the nav's Coach button, the Today
 * card's Ask, a screen's action with its words written:
 *
 *  - It holds the coach's one conversation (coach-conversation.tsx): the opening screen for a new one, else the turns,
 *    and the box.
 *  - Its menu (⋯) holds "New conversation": the conversation shown is left — the opening screen, and the next send
 *    starts a new one — and it stays left across opens (kept on this device). Nothing to leave, or the coach at work:
 *    not offered.
 *  - A bottom sheet on a phone; a panel at the right edge from lg (1024), the page dimmed beside it.
 *  - The dialog's contract (`useDialogFocus`): the focus moves into it, Tab stays inside, Escape closes it (a dialog or
 *    the menu opened inside it first), and closing gives the focus back to what opened it. Leaving the screen (a card's
 *    Edit, its "On your plan") closes it too.
 *  - Its run goes on when it closes: the app's run keeper steps it on any screen.
 *
 * With the coach designer off, the app mounts none, and `useCoach()` is null.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useDialogFocus, useEscapeKey } from "../../components.js";
import { IconClose, IconMore } from "../../icons.js";
import { CoachOpenContext, CoachSeeingContext, SeeingRegistry, type CoachOpener } from "./coach-ask.js";
import { CoachBoundary } from "./coach-boundary.js";
import { CoachConversation } from "./coach-conversation.js";
import { CONVERSATION_QUERY, readLeftConversation, turnsShown, writeLeftConversation } from "./coach-conversation-model.js";
import type { CoachFocus, CoachOpenArgs } from "./coach-focus.js";
import { readConversation, readCurrent } from "./coach-tolerance.js";
import { COACH_CURRENT_QUERY, currentRetry } from "./run-keeper.js";
import { isLive } from "./run-model.js";
import { useStudioCtx } from "./screen.js";
import type { LoopDeps } from "./use-coach-run.js";

/** The sheet's title (its dialog's name). */
export const COACH_SHEET_TITLE = "Coach";
/** The menu's one item. */
export const NEW_CONVERSATION = "New conversation";

/** What the sheet was opened with: the words for the box, and what it sees (named, else the screen's registration). */
export interface CoachOpened {
  request: string | null;
  seeing: CoachFocus | null;
  /**
   * The opener named what it sees (even as nothing). Unnamed (the nav's Coach), the sheet follows what the screen
   * registers — a screen still loading its data registers a moment after the tap.
   */
  named: boolean;
}

/**
 * The app's coach sheet, the opener every screen reaches (`useCoach`), and the registry of what the screens show
 * (`useCoachSeeing`): mounted once, inside the router and the run keeper.
 */
export function CoachSheetProvider({ children, loopDeps }: { children: ReactNode; loopDeps?: () => LoopDeps }) {
  const [registry] = useState(() => new SeeingRegistry());
  /** What it was opened with; a new open starts a new sheet (`key`), never one left half-typed from before. */
  const [opened, setOpened] = useState<{ args: CoachOpened; key: number } | null>(null);
  /** The conversation the athlete left ("New conversation"), kept across opens. */
  const [left, setLeftState] = useState<string | null>(readLeftConversation);
  const setLeft = useCallback((id: string | null) => {
    setLeftState(id);
    writeLeftConversation(id);
  }, []);
  const open = useCallback(
    (args: CoachOpenArgs = {}) => {
      // Named (even as null) wins; otherwise what the screen shows now — and then.
      const named = args.seeing !== undefined;
      const seeing = named ? (args.seeing ?? null) : registry.current;
      setOpened((o) => ({ args: { request: args.request ?? null, seeing, named }, key: (o?.key ?? 0) + 1 }));
    },
    [registry],
  );
  const opener = useMemo<CoachOpener>(() => ({ open }), [open]);
  const close = useCallback(() => setOpened(null), []);
  return (
    <CoachSeeingContext.Provider value={registry}>
      <CoachOpenContext.Provider value={opener}>
        {children}
        {opened ? <CoachSheet key={opened.key} args={opened.args} onClose={close} loopDeps={loopDeps} left={left} onLeave={setLeft} /> : null}
      </CoachOpenContext.Provider>
    </CoachSeeingContext.Provider>
  );
}

/** The sheet itself: the dialog, its menu, and the conversation in it. */
export function CoachSheet({
  args,
  onClose,
  loopDeps,
  left = null,
  onLeave,
}: {
  args: CoachOpened;
  onClose: () => void;
  loopDeps?: () => LoopDeps;
  left?: string | null;
  onLeave?: (conversationId: string) => void;
}) {
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
  // What "New conversation" would leave: the conversation shown — none while the coach is at work.
  const conv = useQuery({ queryKey: CONVERSATION_QUERY, queryFn: readConversation, retry: currentRetry, staleTime: 0 });
  const current = useQuery({ queryKey: COACH_CURRENT_QUERY, queryFn: readCurrent, retry: currentRetry, staleTime: 0 });
  const shown = turnsShown(conv.data, left, []);
  const leaving = conv.data?.id ?? shown[0]?.runId ?? null;
  const atWork = shown.some((t) => isLive(t.status)) || (current.data?.run ? isLive(current.data.run.status) : false);
  const canLeave = leaving !== null && shown.length > 0 && !atWork;
  /** A new conversation is a new area (no turn sent from the last one kept); words written for the athlete go once. */
  const [epoch, setEpoch] = useState(0);
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
          <span className="coach-sheet-tools">
            <SheetMenu
              canLeave={canLeave}
              onNewConversation={() => {
                if (!leaving) return;
                onLeave?.(leaving);
                setEpoch((n) => n + 1);
              }}
            />
            <button type="button" className="btn sheet-close" onClick={onClose} aria-label="Close">
              <IconClose size={16} />
            </button>
          </span>
        </div>
        {/* A render error stays in the sheet: it says so, and the screen under it goes on (the robustness pass). */}
        <CoachBoundary>
          <CoachConversation
            key={epoch}
            ctx={ctx}
            loopDeps={loopDeps}
            request={epoch === 0 ? args.request : null}
            seeing={args.seeing}
            followSeen={!args.named}
            left={left}
          />
        </CoachBoundary>
      </div>
    </div>
  );
}

/** The sheet's menu (⋯): "New conversation". Escape and a tap elsewhere close it; the arrows move in it. */
function SheetMenu({ canLeave, onNewConversation }: { canLeave: boolean; onNewConversation: () => void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEscapeKey(open, () => {
    setOpen(false);
    button.current?.focus();
  });
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    wrap.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  return (
    <div className="coach-sheet-menu" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="btn sheet-close"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <IconMore size={16} />
      </button>
      <div id={id} role="menu" aria-label="Coach" className="stu-save-menu coach-sheet-menu-list" hidden={!open}>
        <button
          type="button"
          role="menuitem"
          className="stu-save-item"
          disabled={!canLeave}
          onClick={() => {
            setOpen(false);
            onNewConversation();
          }}
        >
          {NEW_CONVERSATION}
        </button>
      </div>
    </div>
  );
}
