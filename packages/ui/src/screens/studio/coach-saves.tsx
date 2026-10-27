/**
 * THE OPEN BATCH, IN THE COACH (the saves flow redesigned §3.1–§3.2, §12.1, §12.3; server: `GET /api/my-saves/open`).
 * While a batch is open — server state, the same on every device — the coach's sheet shows it twice:
 *
 *   Coach                         [● 9 new saved moves] ⋯ ✕     ← the chip, in the header: a tap brings the card into view
 *   🌱 Nine new moves came in from your saves: 5 hip and 4 neck. Want me to fit them into the week, or choose first?
 *      [ Fit them in ]  [ Choose first ]
 *      not now
 *   …whatever conversation is open, under it
 *
 *  - The line is the server's (`savesCardLine`), drawn as the coach's words.
 *  - **Fit them in** fits the batch with every new move on the coach's call (`/fit` with `{}`), then the conversation
 *    sends the request with the batch (`savesBatchId`) — the current conversation, never a new one.
 *  - **Choose first** opens the batch page; its Fit these in comes back here with the fit.
 *  - **not now** asks first (a sheet: where to find it again, and OK); OK puts it aside. Closing that sheet any other way
 *    puts nothing aside.
 *  - While a fit is at work, every button gives way to "Fitting in… open the coach".
 *  - Nothing at all without an open batch, with a read that failed (the feature off: 404), or with a batch every row of
 *    which was removed (0 and 0).
 *
 * The Today card (components/saves-today-card.tsx) reads the same query and fits the same way (`useFitThemIn`).
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError, OPEN_SAVES_QUERY, SAVES_BATCHES_QUERY, savesBatchQuery } from "@rg/api-client";
import type { FitChoice, OpenSavesBatchDto, OpenSavesDto } from "@rg/saves";
import { Sheet } from "../../components.js";
import { PERSONAL_MOVES_QUERY } from "../../library/account-library.js";
import { CoachSays } from "./coach-opening.js";
import { DISMISS_FAILED_LINE, FITTING_LINE, fitRefusal, openShown, PUT_ASIDE_LINE, savesChipLabel, savesHref } from "./saves-model.js";
import { useOneTap } from "./use-one-tap.js";

/** The card's id: the chip brings it into view. */
export const COACH_SAVES_CARD_ID = "coach-saves-card";
/** The card's and the Today card's name. */
export const SAVES_CARD_LABEL = "From your saves";
/** "not now"'s sheet's title. */
export const PUT_ASIDE_TITLE = "Not now";

/**
 * The open batch, as every surface draws it: null for none, a read that failed, or nothing left in it. `known`: the read
 * has answered (or failed), so drawing it now moves nothing later. Off (`enabled` false), nothing is read.
 */
export function useOpenSaves(enabled = true): { open: OpenSavesBatchDto | null; known: boolean } {
  const q = useQuery({ queryKey: OPEN_SAVES_QUERY, queryFn: api.savesOpen, retry: false, staleTime: 0, enabled });
  return { open: q.isError ? null : openShown(q.data), known: !enabled || q.status !== "pending" };
}

/** A fit, a dismissal or a cancellation went through: the open batch, the batches and this batch read again. */
export function savesChanged(qc: QueryClient, batchId: string): void {
  void qc.invalidateQueries({ queryKey: OPEN_SAVES_QUERY });
  void qc.invalidateQueries({ queryKey: SAVES_BATCHES_QUERY });
  void qc.invalidateQueries({ queryKey: savesBatchQuery(batchId) });
}

/** The fit's run could not start (the coach at work, the week's budget, the run already there, no connection): the fit
 * cleared at once, so Fit them in comes back — only ever after a fit of the app's own that the server took. */
export function cancelFit(qc: QueryClient, batchId: string): void {
  void api
    .savesFitCancel(batchId)
    .catch(() => undefined)
    .finally(() => savesChanged(qc, batchId));
}

/**
 * "Fit them in" with every new move on the coach's call (`/fit` with `{}`) — or the batch page's "Fit these in" with
 * the owner's choices — then `then(batchId, request)`: the conversation's send, or the coach opened with the fit. While
 * it is out, `pending`; refused, `line` (`fitRefusal`) and the batch read again (what is true: Fitting in…, or fitted).
 * A fit the server refused is never cancelled: nothing of it started.
 */
export function useFitThemIn(then: (batchId: string, request: string) => void): {
  fit: (batchId: string, choices?: Record<string, FitChoice>) => void;
  pending: boolean;
  line: string | null;
} {
  const qc = useQueryClient();
  const oneTap = useOneTap();
  const [pending, setPending] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const fit = (batchId: string, choices: Record<string, FitChoice> = {}) =>
    oneTap(async () => {
      setPending(true);
      setLine(null);
      try {
        const answer = await api.savesFit(batchId, choices);
        // Fitting at once wherever the open batch is drawn — the read again confirms it.
        qc.setQueryData<OpenSavesDto>(OPEN_SAVES_QUERY, (d) => (d?.open?.id === batchId ? { open: { ...d.open, fitting: true } } : d));
        savesChanged(qc, batchId);
        // The batch saved: its moves are the owner's now.
        void qc.invalidateQueries({ queryKey: PERSONAL_MOVES_QUERY });
        void qc.invalidateQueries({ queryKey: ["library"] });
        then(answer.batchId, answer.request);
      } catch (e) {
        setLine(fitRefusal(e));
        if (e instanceof ApiError) savesChanged(qc, batchId);
      } finally {
        setPending(false);
      }
    });
  return { fit, pending, line };
}

/** The sheet header's chip: "9 new saved moves" — a tap brings the card into view in this same sheet. */
export function CoachSavesChip() {
  const { open } = useOpenSaves();
  if (!open) return null;
  return (
    <button type="button" className="chip coach-chip coach-chip--opening coach-saves-chip" onClick={showCard}>
      <span className="coach-saves-dot" aria-hidden="true" />
      {savesChipLabel(open.counts)}
    </button>
  );
}

/** The card, scrolled into view (never smoothly under reduced motion), and the focus on it. */
function showCard(): void {
  const card = document.getElementById(COACH_SAVES_CARD_ID);
  if (!card) return;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  card.scrollIntoView?.({ block: "start", behavior: still ? "auto" : "smooth" });
  card.focus({ preventScroll: true });
}

/**
 * The saves card, first in the conversation: the server's line as the coach's words, then Fit them in, Choose first
 * and not now — or, while a fit is at work, "Fitting in… open the coach". `busy`: the conversation can't send now (a
 * send out, the coach at work, the week used up) — Fit them in waits. `onFit`: the fit went through; send its request.
 */
export function CoachSavesCard({ busy, onFit }: { busy: boolean; onFit: (batchId: string, request: string) => void }) {
  const { open } = useOpenSaves();
  const { fit, pending, line } = useFitThemIn(onFit);
  const [asking, setAsking] = useState(false);
  if (!open) return null;
  return (
    <section id={COACH_SAVES_CARD_ID} className="coach-saves" aria-label={SAVES_CARD_LABEL} tabIndex={-1}>
      <CoachSays>
        <p>{open.line}</p>
      </CoachSays>
      {open.fitting ? (
        <p className="coach-saves-fitting" role="status">
          {FITTING_LINE}
        </p>
      ) : (
        <div className="coach-saves-actions">
          <div className="btn-row">
            <button type="button" className="btn btn-primary" disabled={busy || pending} onClick={() => fit(open.id)}>
              Fit them in
            </button>
            <Link className="btn" to={savesHref(open.id)}>
              Choose first
            </Link>
          </div>
          <button type="button" className="linklike tap-pad coach-saves-later" onClick={() => setAsking(true)}>
            not now
          </button>
        </div>
      )}
      {line && !open.fitting ? (
        <p className="coach-saves-line" role="status">
          {line}
        </p>
      ) : null}
      {asking ? <PutAside batchId={open.id} onClose={() => setAsking(false)} /> : null}
    </section>
  );
}

/** "not now"'s sheet: where to find it again, and OK — which puts it aside. Closed any other way, nothing is. */
function PutAside({ batchId, onClose }: { batchId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const oneTap = useOneTap();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const ok = () =>
    oneTap(async () => {
      setPending(true);
      setFailed(false);
      try {
        await api.savesDismiss(batchId);
        savesChanged(qc, batchId);
        onClose();
      } catch (e) {
        // No longer open (fitted, put aside or a fit started elsewhere): the read again shows what is.
        if (e instanceof ApiError && (e.status === 409 || e.status === 404)) {
          savesChanged(qc, batchId);
          onClose();
        } else setFailed(true);
      } finally {
        setPending(false);
      }
    });
  return createPortal(
    <Sheet
      open
      centered
      onClose={onClose}
      title={PUT_ASIDE_TITLE}
      footer={
        <div className="btn-row">
          <button type="button" className="btn btn-primary" disabled={pending} onClick={ok}>
            OK
          </button>
        </div>
      }
    >
      <p className="coach-saves-aside">{PUT_ASIDE_LINE}</p>
      {failed ? (
        <p className="coach-saves-line" role="alert">
          {DISMISS_FAILED_LINE}
        </p>
      ) : null}
    </Sheet>,
    document.body,
  );
}
