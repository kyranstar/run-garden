/**
 * THE BODY MAP (the new shape §7): a front figure of eleven calm areas, each tinted by how much it was worked over the
 * period (`GET /api/growth/body`, the coach's own exposure computation), one line naming what carried it and one for
 * the area gone quiet, with a button that opens the coach with the request written ("15 minutes for my hips") — the
 * athlete's to send. The tint is never alone: the legend says each level in words, every area says its level on hover,
 * the figure's name lists them, and "By area" (one tap down) lists every area's sets and runs. The quiet area wears a
 * dashed edge on the figure.
 */
import { useId, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { BodyArea, BodyAreaExposure, GrowthBodyDto, GrowthPeriod } from "@rg/domain";
import { IconCoachSmall } from "../../icons.js";
import { useCoach } from "../studio/coach-ask.js";
import { AREA_LABEL, areaFacts, carriedLine, figureLabel, LEVEL_WORD, quietLine, quietRequest } from "./body-words.js";

type Shape = { kind: "rect"; x: number; y: number; w: number; h: number; r: number } | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number } | { kind: "path"; d: string };

const rect = (x: number, y: number, w: number, h: number, r = Math.min(w, h) / 2): Shape => ({ kind: "rect", x, y, w, h, r });
const ellipse = (cx: number, cy: number, rx: number, ry: number): Shape => ({ kind: "ellipse", cx, cy, rx, ry });
/** A shape and its mirror across the figure's middle (x = 60). */
const pair = (s: Shape): Shape[] =>
  s.kind === "rect" ? [s, { ...s, x: 120 - s.x - s.w }] : s.kind === "ellipse" ? [s, { ...s, cx: 120 - s.cx }] : [s];

/** The figure, head to foot, in a 120 × 236 box: simple rounded shapes with a little air between them. */
export const FIGURE: Record<BodyArea, Shape[]> = {
  neck: [rect(54, 31, 12, 9, 4)],
  shoulders: pair(ellipse(39.5, 47, 8.5, 7)),
  chest: pair(rect(46, 42, 13.5, 18, 6)),
  arms: [...pair(rect(30, 55, 8.5, 31)), ...pair(rect(27, 89, 8, 29))],
  // The lats, at the torso's flanks: the back as a front figure can show it.
  back: pair(rect(43, 61, 3.5, 27)),
  core: [rect(47, 62, 26, 34, 7)],
  hips: [{ kind: "path", d: "M47 101 Q47 98 50 98 L70 98 Q73 98 73 101 L69 113 Q60 118 51 113 Z" }],
  glutes: pair(ellipse(42.5, 106, 4.5, 9)),
  quads: pair(rect(47, 119, 11, 46, 5.5)),
  hamstrings: pair(rect(42, 122, 4, 40)),
  calves: [...pair(rect(48, 170, 9, 44)), ...pair(ellipse(52.5, 220, 6, 3))],
};

function ShapeEl({ s }: { s: Shape }) {
  if (s.kind === "rect") return <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={s.r} />;
  if (s.kind === "ellipse") return <ellipse cx={s.cx} cy={s.cy} rx={s.rx} ry={s.ry} />;
  return <path d={s.d} />;
}

/** The figure itself: every area tinted by its level; the quiet one's edge dashed. */
export function BodyFigure({ areas, quiet }: { areas: readonly BodyAreaExposure[]; quiet: BodyArea | null }) {
  return (
    <svg className="body-figure" viewBox="0 0 120 236" role="img" aria-label={figureLabel(areas)}>
      <circle className="body-head" cx={60} cy={17} r={12} />
      {areas.map((a) => (
        <g key={a.area} className={`body-area body-lvl-${a.level}${quiet === a.area ? " is-quiet" : ""}`} data-area={a.area}>
          <title>{`${AREA_LABEL[a.area]} · ${LEVEL_WORD[a.level].toLowerCase()}`}</title>
          {FIGURE[a.area].map((s, i) => (
            <ShapeEl key={i} s={s} />
          ))}
        </g>
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
