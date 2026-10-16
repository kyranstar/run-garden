/**
 * ALSO WAITING (Task 13's fix wave, audit 13c R2; the brief's §2.7): the Studio shows one run's suggestion, and the
 * coach may point the athlete to another still open ("…is still waiting if you want it too"). The current read names
 * the others (`alsoOpen`, newest first, at most five); each is one compact line under the current card — its title, its
 * day and time, and how many it holds to decide when more than one — and one tap opens its own card
 * (`GET /api/coach/proposals/:id`, read only once it is opened), where it is approved or declined as any card is.
 */
import { useId, useState } from "react";
import type { CoachAlsoOpenDto } from "@rg/api-client";
import { IconChevron } from "../../icons.js";
import { ProposalCard } from "./proposal-card.js";
import { dayAndTime } from "./run-model.js";

/** The heading over the other open suggestions. */
export const ALSO_WAITING = "Also waiting";

/** "Hips and back, gently · Sun 1:05 PM"; "Your next workouts · Tue · 3 to decide". */
export function alsoLine(a: Pick<CoachAlsoOpenDto, "title" | "date" | "time" | "items">): string {
  return [a.title, dayAndTime(a.date, a.time), a.items > 1 ? `${a.items} to decide` : null].filter(Boolean).join(" · ");
}

export function AlsoWaiting({ items, today }: { items: readonly CoachAlsoOpenDto[]; today: string | null }) {
  const headingId = useId();
  if (items.length === 0) return null;
  return (
    <section className="coach-also" aria-labelledby={headingId}>
      <h2 id={headingId} className="eyebrow">
        {ALSO_WAITING}
      </h2>
      <ul className="coach-also-list">
        {items.map((a) => (
          <AlsoItem key={a.proposalId} item={a} today={today} />
        ))}
      </ul>
    </section>
  );
}

function AlsoItem({ item, today }: { item: CoachAlsoOpenDto; today: string | null }) {
  const [open, setOpen] = useState(false);
  const cardId = useId();
  return (
    <li className="coach-also-item">
      <button type="button" className="coach-also-line" aria-expanded={open} aria-controls={cardId} onClick={() => setOpen((v) => !v)}>
        {alsoLine(item)}
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
