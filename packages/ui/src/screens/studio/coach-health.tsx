/**
 * THE IMPORT'S HEALTH IN THE COACH'S HEADER (audit 2026-11-06, I2; design 2026-11-05 §3.2). The owner checks on their
 * imports "mostly in the coach", but the health row showed only on the saves card, and only while a batch was open.
 * Whenever a light is red or yellow, the coach sheet's header carries one compact chip — the worst light and its word:
 *
 *   Coach                 [✕ Reader failing]  [● 9 new saved moves]  ⋯  ✕
 *
 * A tap opens the health row itself in a sheet: the seven lights, the worst one's line, each light's failures one tap
 * down. Nothing while every light is green or grey (grey is nothing to judge, never a problem), or the health can't be
 * read (the feature off, an older Worker).
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { api, SAVES_HEALTH_QUERY } from "@rg/api-client";
import { HEALTH_LABELS, HEALTH_MARKS, worstLight } from "@rg/saves";
import { Sheet } from "../../components.js";
import { HealthRow, healthOf } from "../saves/health-row.js";

/** The detail sheet's title. */
export const HEALTH_SHEET_TITLE = "Import health";

export function CoachHealthChip() {
  const q = useQuery({ queryKey: SAVES_HEALTH_QUERY, queryFn: api.savesHealth, retry: false });
  const health = healthOf(q.data);
  const [open, setOpen] = useState(false);
  const worst = worstLight(health);
  if (!health || !worst) return null;
  const m = HEALTH_MARKS[worst.color];
  const words = `${HEALTH_LABELS[worst.light]} ${m.word}`;
  return (
    <>
      <button
        type="button"
        className={`chip coach-chip coach-health-chip coach-health-chip--${worst.color}`}
        aria-haspopup="dialog"
        aria-label={`Import health: ${words}`}
        onClick={() => setOpen(true)}
      >
        <span className="health-mark" aria-hidden="true">
          {m.mark}
        </span>
        {words}
      </button>
      {open
        ? createPortal(
            <Sheet open onClose={() => setOpen(false)} title={HEALTH_SHEET_TITLE}>
              <HealthRow health={health} />
            </Sheet>,
            document.body,
          )
        : null}
    </>
  );
}
