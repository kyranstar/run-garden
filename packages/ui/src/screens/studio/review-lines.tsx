/**
 * THE COACH'S REVIEW, LINE BY LINE (import trail phase 3; design 2026-11-05 §3.3–3.5). A fit's pins card whose lines
 * carry the coach's review:
 *
 *   In
 *   Zorbex hip lift  joins your mobility rotation · 2 × 6 each side      ← the name opens the post's trail at the move
 *   She says it's for stiff hips after easy runs.  [said 1:12] [your history]      Challenge
 *   Left out
 *   Zorbex neck nod
 *   Your neck care already covers it.  [your history]                               Challenge
 *   Corrections
 *   Dose of Zorbex hip lift: 30 s, 2 sets (was 6–10 reps) — the transcript says so.  [said 1:12]
 *   Why: …
 *
 * The most important content first — the decision, the move, where and the dose, one sentence of why — and every claim
 * one tap from its evidence: a quote's chip opens the trail at the quote (said, in the caption, heard — never "said" for
 * what the reader only heard —, on screen, not in the post), the reader's guess at the move, history and a goal are plain
 * words. Challenge (in a conversation) fills the reply box with "About <move>: ". Every word here came from the coach or
 * a stranger's post: drawn as text.
 */
import { useContext, useState } from "react";
import { Link } from "react-router-dom";
import type { DesignCiteDto, DesignCorrectionLineDto, DesignPinsCardLineDto } from "@rg/api-client";
import { TrailSheet, type TrailFocus } from "../saves/trail-sheet.js";
import { CoachReplyContext } from "./coach-reply.js";
import { moveHref } from "./screen.js";

type Open = (postId: string, focus: TrailFocus) => void;

/** One chip: a quote's or the reader's guess opens the trail; history and a goal are words. */
function Chip({ cite, open }: { cite: DesignCiteDto; open: Open }) {
  const opens = cite.postId !== undefined && cite.position !== undefined && (cite.kind === "quote" || cite.kind === "inferred");
  if (!opens) return <span className="coach-cite coach-cite--plain">{cite.label}</span>;
  return (
    <button
      type="button"
      className="coach-cite tap-pad"
      aria-label={`Evidence: ${cite.label} — open it on the post`}
      onClick={() => open(cite.postId!, { position: cite.position!, ...(cite.kind === "quote" && cite.quote !== undefined ? { quote: cite.quote } : {}) })}
    >
      {cite.label}
    </button>
  );
}

function Chips({ cites, open }: { cites: readonly DesignCiteDto[] | undefined; open: Open }) {
  if (!cites?.length) return null;
  return (
    <span className="coach-cites">
      {cites.map((c) => (
        <Chip key={c.id} cite={c} open={open} />
      ))}
    </span>
  );
}

function Line({ line, open }: { line: DesignPinsCardLineDto; open: Open }) {
  const reply = useContext(CoachReplyContext);
  const where = [line.where, line.dose].filter((x): x is string => !!x).join(" · ");
  const name = line.name ?? null;
  return (
    <li className="coach-review-line">
      {name ? (
        <p className="coach-review-head">
          {line.post ? (
            <button type="button" className="linklike coach-review-name tap-pad" onClick={() => open(line.post!.id, { position: line.post!.position })}>
              {name}
            </button>
          ) : line.moveId ? (
            <Link className="coach-review-name" to={moveHref(line.moveId, "")}>
              {name}
            </Link>
          ) : (
            <strong className="coach-review-name">{name}</strong>
          )}
          {where ? <span className="coach-review-where">{where}</span> : null}
        </p>
      ) : null}
      <p className="coach-review-text">
        {line.text} <Chips cites={line.cites} open={open} />
      </p>
      {reply && name ? (
        <button type="button" className="linklike tap-pad coach-challenge" aria-label={`Challenge the line about ${name}`} onClick={() => reply.challenge(`About ${name}: `)}>
          Challenge
        </button>
      ) : null}
    </li>
  );
}

/** The review: In, then Left out (a line with no decision first, as it came), then the corrections, then the why. */
export function ReviewLines({ lines, corrections, why }: { lines: readonly DesignPinsCardLineDto[]; corrections: readonly DesignCorrectionLineDto[]; why: string | null }) {
  const [trail, setTrail] = useState<{ postId: string; focus: TrailFocus } | null>(null);
  const open: Open = (postId, focus) => setTrail({ postId, focus });
  const plain = lines.filter((l) => !l.decision);
  const groups: Array<[string, DesignPinsCardLineDto[]]> = [
    ["In", lines.filter((l) => l.decision === "in")],
    ["Left out", lines.filter((l) => l.decision === "out")],
  ];
  return (
    <div className="coach-review">
      {plain.length ? (
        <ul className="coach-plan-lines coach-review-lines">
          {plain.map((l, i) => (
            <Line key={`p${i}`} line={l} open={open} />
          ))}
        </ul>
      ) : null}
      {groups.map(([title, list]) =>
        list.length ? (
          <section key={title} className="coach-review-section">
            <h4 className="coach-review-group">{title}</h4>
            <ul className="coach-plan-lines coach-review-lines">
              {list.map((l, i) => (
                <Line key={`${title}${i}`} line={l} open={open} />
              ))}
            </ul>
          </section>
        ) : null,
      )}
      {corrections.length ? (
        <section className="coach-review-section">
          <h4 className="coach-review-group">Corrections</h4>
          <ul className="coach-plan-lines coach-review-lines">
            {corrections.map((c) => (
              <li key={c.opId} className="coach-review-line coach-review-fix">
                <p className="coach-review-text">
                  {c.line}
                  {c.why ? ` — ${c.why}` : ""}
                  {c.basis === "owner" ? " (your word)" : ""} <Chips cites={c.cites} open={open} />
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {why ? <p className="coach-review-why">Why: {why}</p> : null}
      {trail ? <TrailSheet postId={trail.postId} focus={trail.focus} onClose={() => setTrail(null)} /> : null}
    </div>
  );
}
