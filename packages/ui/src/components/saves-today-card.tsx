/**
 * TODAY'S CARD FOR THE OPEN BATCH (the saves flow redesigned §3.1; §2's anti-goal: the coach's-call path is one tap
 * from Today). At the top of Today while a batch of saved moves is open — server state, open on every device until it
 * is fitted in or put aside:
 *
 *   9 new moves from your saves
 *   4 more were already yours
 *   [ Fit them in ]
 *
 *  - **Fit them in** fits the batch with no choices sent (what the owner chose on the batch page stands, every other
 *    new move on the coach's call) and opens the coach with the fit: the conversation sends the request with its
 *    batch. One tap.
 *  - A tap on the card itself opens the coach (its saves card at the top: Choose first, not now).
 *  - While a fit is at work: "Fitting in… open the coach" in place of the button.
 *  - Nothing without the coach (its sheet isn't in the app) or an open batch.
 */
import { useCoach } from "../screens/studio/coach-ask.js";
import { SAVES_CARD_LABEL, useFitThemIn, useOpenSaves } from "../screens/studio/coach-saves.js";
import { FITTING_LINE, todayHeadline, todaySubline } from "../screens/studio/saves-model.js";

export function SavesTodayCard() {
  const coach = useCoach();
  const { open } = useOpenSaves(coach !== null);
  // Seeing nothing: Today's session is no part of a fit (its focus would steer the coach toward it).
  const { fit, pending, line } = useFitThemIn((batchId, request) => coach?.open({ fit: { batchId, request }, seeing: null }));
  if (!coach || !open) return null;
  const sub = todaySubline(open.counts);
  return (
    <section className="dock-panel saves-today" aria-label={SAVES_CARD_LABEL}>
      <button type="button" className="saves-today-open" onClick={() => coach.open()}>
        <span className="saves-today-head">{todayHeadline(open.counts)}</span>
        {sub ? <span className="saves-today-sub">{sub}</span> : null}
      </button>
      {open.fitting ? (
        <button type="button" className="linklike tap-pad saves-today-fitting" onClick={() => coach.open()}>
          {FITTING_LINE}
        </button>
      ) : (
        <button type="button" className="btn btn-primary" disabled={pending} onClick={() => fit(open.id)}>
          Fit them in
        </button>
      )}
      {line && !open.fitting ? (
        <p className="saves-today-line" role="status">
          {line}
        </p>
      ) : null}
    </section>
  );
}
