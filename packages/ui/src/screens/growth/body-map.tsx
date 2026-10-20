/**
 * THE BODY MAP (the new shape §7): a figure seen from the front and the back (body-figure.ts), its eleven calm areas each
 * drawn where it is and tinted by how much it was worked over the period (`GET /api/growth/body`, the coach's own
 * exposure computation), one line naming what carried it and one for the area gone quiet, with a button that opens the
 * coach with the request written ("15 minutes for my hips") — the athlete's to send. The tint is never alone: the legend
 * says each level in words, every area says its level on hover, the figure's name lists them, and "By area" (one tap
 * down) lists every area's sets and runs. The quiet area wears a dashed edge on the figure. On a phone the figure sits
 * above the words; from 640 px, beside them.
 */
import { useId, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { BodyArea, BodyAreaExposure, GrowthBodyDto, GrowthPeriod } from "@rg/domain";
import { IconCoachSmall } from "../../icons.js";
import { useCoach } from "../studio/coach-ask.js";
import { AREA_LABEL, areaFacts, carriedLine, figureLabel, LEVEL_WORD, quietLine, quietRequest } from "./body-words.js";
import { BODY_VIEWS, FIGURE, FIGURE_BOX, LINES, SILHOUETTE, VIEW_CAPTION_Y, VIEW_MID, VIEW_X, type BodyView } from "./body-figure.js";

export { FIGURE } from "./body-figure.js";

/** A view's frame placed in the figure: the front where it is, the back moved over beside it. */
const at = (v: BodyView) => (VIEW_X[v] ? `translate(${VIEW_X[v]} 0)` : undefined);

/** The silhouette of one view: its outline under, then its fill over it — one edge round the whole body, none where
 * its parts meet. */
function Silhouette({ view }: { view: BodyView }) {
  const paths = SILHOUETTE[view].map((d, i) => <path key={i} d={d} />);
  return (
    <g transform={at(view)}>
      <g className="body-sil-edge">{paths}</g>
      <g className="body-sil">{paths}</g>
    </g>
  );
}

/** The figure itself (body-figure.ts): the front and the back side by side, every area tinted by its level in each
 * view it is drawn in, over a quiet silhouette; the quiet area's edge dashed. */
export function BodyFigure({ areas, quiet }: { areas: readonly BodyAreaExposure[]; quiet: BodyArea | null }) {
  return (
    <svg className="body-figure" viewBox={`${FIGURE_BOX.x} ${FIGURE_BOX.y} ${FIGURE_BOX.w} ${FIGURE_BOX.h}`} role="img" aria-label={figureLabel(areas)}>
      {BODY_VIEWS.map((v) => (
        <Silhouette key={v} view={v} />
      ))}
      {areas.map((a) => (
        <g key={a.area} className={`body-area body-lvl-${a.level}${quiet === a.area ? " is-quiet" : ""}`} data-area={a.area}>
          <title>{`${AREA_LABEL[a.area]} · ${LEVEL_WORD[a.level].toLowerCase()}`}</title>
          {BODY_VIEWS.map((v) => {
            const paths = FIGURE[a.area][v];
            return paths ? (
              <g key={v} transform={at(v)}>
                {paths.map((d, i) => (
                  <path key={i} d={d} />
                ))}
              </g>
            ) : null;
          })}
        </g>
      ))}
      {BODY_VIEWS.map((v) => (
        <g key={v} className="body-lines" transform={at(v)}>
          {LINES[v].map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>
      ))}
      {BODY_VIEWS.map((v) => (
        <text key={v} className="body-cap" x={VIEW_X[v] + VIEW_MID} y={VIEW_CAPTION_Y} aria-hidden="true">
          {v === "front" ? "Front" : "Back"}
        </text>
      ))}
    </svg>
  );
}

/** The levels in words, each beside its tint. */
function Legend() {
  return (
    <ul className="body-legend" role="list" aria-label="How much">
      {([1, 2, 3] as const).map((l) => (
        <li key={l}>
          <span className={`body-swatch body-lvl-${l}`} aria-hidden="true" />
          {LEVEL_WORD[l]}
        </li>
      ))}
    </ul>
  );
}

/** The body map's card: the figure, its two lines, the quiet area's button, the legend, and "By area" a tap down. */
export function BodyCard({ query, period }: { query: UseQueryResult<GrowthBodyDto>; period: GrowthPeriod }) {
  const coach = useCoach();
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const b = query.data;
  let content;
  if (!b) {
    content = query.isError ? (
      <div className="body-words">
        <p className="muted">Couldn't load your body map.</p>
        <button type="button" className="btn btn-small" onClick={() => void query.refetch()}>
          Try again
        </button>
      </div>
    ) : (
      <p className="muted body-words">Reading your {period}…</p>
    );
  } else {
    const carried = carriedLine(b, period);
    const quiet = quietLine(b.quiet, period);
    content = (
      <div className="body-words">
        {carried ? <p className="body-carried">{carried}</p> : null}
        {quiet ? <p className="body-quiet">{quiet}</p> : null}
        {b.quiet && coach ? (
          <button
            type="button"
            className="btn btn-small body-ask"
            aria-label={`Ask the coach: ${quietRequest(b.quiet.area)}`}
            onClick={() => coach.open({ request: quietRequest(b.quiet!.area), seeing: null })}
          >
            <span className="ask-coach-mark" aria-hidden="true">
              <IconCoachSmall size={16} />
            </span>
            {quietRequest(b.quiet.area)}
          </button>
        ) : null}
        <Legend />
      </div>
    );
  }
  return (
    <section className="growth-sect body-card" aria-labelledby={headingId}>
      <h2 id={headingId} className="rank-item growth-h">
        Your body
      </h2>
      <div className="body-row">
        <div className="body-figure-box">{b ? <BodyFigure areas={b.areas} quiet={b.quiet?.area ?? null} /> : null}</div>
        {content}
      </div>
      {b ? (
        <>
          <button type="button" className="linklike dash-more body-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            By area
            <span className="disclosure-caret" aria-hidden>
              {open ? "▾" : "▸"}
            </span>
          </button>
          {open ? (
            <ul className="body-list" role="list" aria-label="By area">
              {b.areas.map((a) => (
                <li key={a.area} className="body-list-row">
                  <span className={`body-swatch body-lvl-${a.level}`} aria-hidden="true" />
                  <b>{AREA_LABEL[a.area]}</b>
                  <span className="body-list-facts">{areaFacts(a)}</span>
                  <span className="body-list-level">{a.level > 0 ? LEVEL_WORD[a.level] : ""}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
