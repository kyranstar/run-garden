/**
 * ALSO WAITING (Task 13's fix wave, audit 13c R2; the brief's §2.7): the Studio shows one run's suggestion, and the
 * coach may point the athlete to another still open ("…is still waiting if you want it too"). The current read names
 * the others (`alsoOpen`, newest first, at most five); each is one compact line under the current card — its title, its
 * day and time ("Now" for a now design, "Today" for one today with no time), and how many it holds to decide when more
 * than one — and one tap opens its own card (`GET /api/coach/proposals/:id`, read only once it is opened), where it is
 * approved or declined as any card is.
 *
 * A decision reads the current run again (round 2, Minor 11): the lines and their counts follow at once. One decided
 * whole leaves the list — but not while its card is open: what came of it stays in view until the athlete closes it.
 */
import { useId, useState } from "react";
import type { CoachAlsoOpenDto } from "@rg/api-client";
import { IconChevron } from "../../icons.js";
import { ProposalCard } from "./proposal-card.js";
import { dayAndTime } from "./run-model.js";

/** The heading over the other open suggestions. */
export const ALSO_WAITING = "Also waiting";

/**
 * "Hips and back, gently · Sun 1:05 PM"; "Your next workouts · Tue · 3 to decide"; "Jaw reset · Now" (a now design);
 * "Hips · Today" (today, with no time) — never the bare weekday for today (round 2, Minor 11).
 */
export function alsoLine(a: Pick<CoachAlsoOpenDto, "title" | "date" | "time" | "items" | "atNow">, today: string | null = null): string {
  const when = a.atNow ? "Now" : a.time === null && today !== null && a.date === today ? "Today" : dayAndTime(a.date, a.time);
  return [a.title, when, a.items > 1 ? `${a.items} to decide` : null].filter(Boolean).join(" · ");
}

export function AlsoWaiting({ items, today }: { items: readonly CoachAlsoOpenDto[]; today: string | null }) {
  const headingId = useId();
  /** The ones the athlete opened, as last listed: kept while open, even once decided whole. */
  const [opened, setOpened] = useState<ReadonlyMap<string, CoachAlsoOpenDto>>(new Map());
  const listed = new Set(items.map((a) => a.proposalId));
  // Listed no more (nothing left to decide), but open: kept, with no count.
  const kept = [...opened.values()].filter((a) => !listed.has(a.proposalId)).map((a) => ({ ...a, items: 0 }));
  const shown = [...items, ...kept];
  if (shown.length === 0) return null;
  const toggle = (a: CoachAlsoOpenDto) =>
    setOpened((m) => {
      const next = new Map(m);
      if (next.has(a.proposalId)) next.delete(a.proposalId);
      else next.set(a.proposalId, a);
      return next;
    });
  return (
    <section className="coach-also" aria-labelledby={headingId}>
      <h2 id={headingId} className="eyebrow">
        {ALSO_WAITING}
      </h2>
      <ul className="coach-also-list">
        {shown.map((a) => (
          <AlsoItem key={a.proposalId} item={a} today={today} open={opened.has(a.proposalId)} onToggle={() => toggle(a)} />
        ))}
      </ul>
    </section>
  );
}

function AlsoItem({ item, today, open, onToggle }: { item: CoachAlsoOpenDto; today: string | null; open: boolean; onToggle: () => void }) {
  const cardId = useId();
  return (
    <li className="coach-also-item">
      <button type="button" className="coach-also-line" aria-expanded={open} aria-controls={cardId} onClick={onToggle}>
        {alsoLine(item, today)}
        <span className="coach-also-chev" aria-hidden="true">
          <IconChevron size={14} />
        </span>
      </button>
      <div id={cardId} className="coach-also-card" hidden={!open}>
        {open ? <ProposalCard proposalId={item.proposalId} today={today} /> : null}
      </div>
    </li>
  );
}
