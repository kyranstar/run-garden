/**
 * A MOVE, EXPLAINED WHERE IT IS NAMED (the owner, 2026-11-04: "hover over each exercise to see a card showing and
 * explaining each exercise, how to do it, and why we do it, and any key tips"). A move's name in a workout opens a
 * small card: its name and today's dose, the library's one-line summary, the muscles it works on the body figure, why
 * it is done (this workout's own reason first, then the library's), how to do it, and the key tips — what to focus on,
 * what to avoid, how to breathe.
 *
 * Two ways in, by where the name sits:
 *
 *  - `button` (the default): the name is a button. A mouse hovering over it opens the card, and moving onto the card
 *    keeps it open; a tap or click pins it open (a phone has no hover), and a second tap, Escape, a press anywhere
 *    else, or focus moving away closes it. Keyboard focus opens it too. A disclosure, like `Tooltip`: `aria-expanded`
 *    and `aria-controls` name the card.
 *  - `hover`: for a name already inside a control that does something else on a tap — a builder row that opens the
 *    item sheet, a built session's move with its own how-to button. Only a mouse's hover opens it, and the card is
 *    `aria-hidden`: the full how-to is one tap away there already, for every pointer and for a screen reader.
 *
 * THE CARD IS FIXED TO THE VIEWPORT, NOT TO THE LINE. It is portalled into the nearest dialog (so a modal sheet's
 * `aria-modal` still covers it and its focus trap still holds) — or the page's body outside one — and placed by
 * measurement under the name, or above it when there is more room there, shifted back inside the screen's edges and
 * scrolling inside itself when it is taller than the room. A sheet's body clips what overflows it, and a fixed element
 * escapes that clip: the sheet carries no transform once it has landed (styles.css, `.sheet`'s `backwards` fill), so
 * the viewport is the card's containing block. One card is open at a time.
 */
import { useCallback, useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BODY_AREA_REGIONS, BODY_AREAS, type BodyArea, type BodyAreaExposure } from "@rg/domain";
import { label, MUSCLE_REGION, type ExerciseRecord, type MuscleId } from "@rg/exercise-library";
import { useEscapeKey, useIsomorphicLayoutEffect } from "../components.js";
import { BodyFigure } from "../screens/growth/body-map.js";
import { AREA_LABEL } from "../screens/growth/body-words.js";

/** What the card reads of a move: a library record, or a built session's copy of one. */
export type MoveCardMove = Pick<ExerciseRecord, "name" | "text"> & Partial<Pick<ExerciseRecord, "muscles" | "regions">>;

/** The open card's closer, so opening another closes it. */
let closeOpen: (() => void) | null = null;

/** How close to the viewport's edge the card may come, and its gap from the name, in CSS px. */
const EDGE = 12;
const GAP = 6;
/** A hover opens after a beat (a pointer passing over a list opens nothing) and closes after one (time to reach it). */
const OPEN_MS = 120;
const CLOSE_MS = 160;
/** The fewest pixels of room the card is given before it scrolls. */
const MIN_ROOM = 160;

/** Where the usable screen ends: the top of the phone's tab bar when one is drawn, else the window's bottom. */
function screenBottom(): number {
  const nav = document.querySelector(".bottom-nav");
  const top = nav && getComputedStyle(nav).display !== "none" ? nav.getBoundingClientRect().top : 0;
  return top > 0 ? top : window.innerHeight;
}

const AREA_OF_REGION: ReadonlyMap<string, BodyArea> = new Map(
  BODY_AREAS.flatMap((a) => BODY_AREA_REGIONS[a].map((r) => [r, a] as const)),
);

/**
 * The figure's areas a move works: the areas holding its primary muscles, and those holding only its secondary ones —
 * its regions standing in for the primary ones when it names no muscles. The jaw and "full body" are no area.
 */
export function workedAreas(move: MoveCardMove): { primary: BodyArea[]; secondary: BodyArea[] } {
  const areaOf = (m: string) => AREA_OF_REGION.get(MUSCLE_REGION[m as MuscleId] ?? "");
  const primary = new Set<BodyArea>();
  for (const m of move.muscles?.primary ?? []) {
    const a = areaOf(m);
    if (a) primary.add(a);
  }
  if (primary.size === 0) {
    for (const r of move.regions ?? []) {
      const a = AREA_OF_REGION.get(r);
      if (a) primary.add(a);
    }
  }
  const secondary = new Set<BodyArea>();
  for (const m of move.muscles?.secondary ?? []) {
    const a = areaOf(m);
    if (a && !primary.has(a)) secondary.add(a);
  }
  return { primary: BODY_AREAS.filter((a) => primary.has(a)), secondary: BODY_AREAS.filter((a) => secondary.has(a)) };
}

const nonEmpty = (s: string | undefined | null): s is string => !!s && s.trim().length > 0;

/** Areas in a phrase: "glutes, quads and core". */
const words = (areas: readonly BodyArea[]): string => {
  const w = areas.map((a) => AREA_LABEL[a].toLowerCase());
  return w.length > 1 ? `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}` : (w[0] ?? "");
};

/** The card's contents (exported for its tests). */
export function MoveCardBody({ move, dose, why }: { move: MoveCardMove; dose?: string | null; why?: string | null }) {
  const t = move.text;
  const works = (move.muscles?.primary ?? []).map(label);
  const also = (move.muscles?.secondary ?? []).map(label);
  const { primary, secondary } = workedAreas(move);
  const areas: BodyAreaExposure[] = BODY_AREAS.map((area) => ({
    area,
    sets: 0,
    runs: 0,
    level: primary.includes(area) ? 3 : secondary.includes(area) ? 1 : 0,
    last: null,
    daysAgo: null,
  }));
  const whys = [why, t.why].filter(nonEmpty).filter((w, i, all) => all.indexOf(w) === i);
  const steps = [...t.setup, ...t.steps].filter(nonEmpty);
  const focus = t.focus.filter(nonEmpty).slice(0, 3);
  const avoid = t.mistakes.filter(nonEmpty).slice(0, 2);
  const breathing = nonEmpty(t.breathing) ? t.breathing : null;
  return (
    <>
      <div className="move-card-top">
        <b className="move-card-name">{move.name}</b>
        {dose ? <span className="move-card-dose num">{dose}</span> : null}
      </div>
      {nonEmpty(t.summary) ? <p className="move-card-summary">{t.summary}</p> : null}
      {primary.length > 0 ? (
        <div className="move-card-body">
          <div className="move-card-figure">
            <BodyFigure
              areas={areas}
              quiet={null}
              label={`Works the ${words(primary)}${secondary.length ? `; also the ${words(secondary)}` : ""}`}
              areaTitle={() => null}
            />
          </div>
          {works.length > 0 ? (
            <dl className="move-card-works">
              <dt>Works</dt>
              <dd>{works.join(" · ")}</dd>
              {also.length > 0 ? (
                <>
                  <dt>Also</dt>
                  <dd>{also.join(" · ")}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
        </div>
      ) : null}
      {whys.length > 0 ? (
        <section className="move-card-section">
          <h4 className="move-card-label">Why</h4>
          {whys.map((w, i) => (
            <p key={i} className="move-card-text">
              {w}
            </p>
          ))}
        </section>
      ) : null}
      {steps.length > 0 ? (
        <section className="move-card-section">
          <h4 className="move-card-label">How</h4>
          <ol className="move-card-steps">
            {steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </section>
      ) : null}
      {focus.length + avoid.length > 0 || breathing ? (
        <section className="move-card-section">
          <h4 className="move-card-label">Key tips</h4>
          <ul className="move-card-tips">
            {focus.map((f, i) => (
              <li key={`f${i}`}>{f}</li>
            ))}
            {avoid.map((m, i) => (
              <li key={`m${i}`} className="is-avoid">
                <span className="move-card-tip-word">Avoid</span> {m}
              </li>
            ))}
            {breathing ? (
              <li className="is-breath">
                <span className="move-card-tip-word">Breathe</span> {breathing}
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}
    </>
  );
}

export function MoveCard({
  move,
  dose,
  why,
  mode = "button",
  className,
  children,
}: {
  move: MoveCardMove;
  /** Today's dose of it, as the line says it ("3×8/side"). */
  dose?: string | null;
  /** Why this workout holds it, when it says. */
  why?: string | null;
  mode?: "button" | "hover";
  /** Extra classes for the name. */
  className?: string;
  /** The name as the line shows it. */
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [keyed, setKeyed] = useState(false);
  const open = hovered || pinned || keyed;
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const close = useCallback(() => {
    clearTimer();
    setHovered(false);
    setPinned(false);
    setKeyed(false);
  }, []);
  useEscapeKey(open, close);
  useEffect(() => clearTimer, []);

  useEffect(() => {
    if (!open) return;
    if (closeOpen && closeOpen !== close) closeOpen();
    closeOpen = close;
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (wrap.current?.contains(t) || card.current?.contains(t)) return;
      close();
    };
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      if (closeOpen === close) closeOpen = null;
    };
  }, [open, close]);

  // Where it goes: inside the nearest dialog (its modality and focus trap cover the card), else the page.
  const host = open && typeof document !== "undefined" ? (wrap.current?.closest<HTMLElement>('[role="dialog"]') ?? document.body) : null;

  useIsomorphicLayoutEffect(() => {
    const el = card.current;
    if (!open || !el || typeof window === "undefined") return;
    const place = () => {
      const anchor = wrap.current;
      if (!anchor || !card.current) return;
      const a = anchor.getBoundingClientRect();
      el.style.maxHeight = "";
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const below = screenBottom() - EDGE - (a.bottom + GAP);
      const above = a.top - GAP - EDGE;
      const up = h > below && above > below;
      const room = Math.max(MIN_ROOM, up ? above : below);
      if (h > room) el.style.maxHeight = `${Math.round(room)}px`;
      const shown = Math.min(h, room);
      const top = up ? Math.max(EDGE, a.top - GAP - shown) : a.bottom + GAP;
      const right = document.documentElement.clientWidth - EDGE;
      const left = Math.max(EDGE, Math.min(a.left, right - w));
      el.style.top = `${Math.round(top)}px`;
      el.style.left = `${Math.round(left)}px`;
      el.dataset.place = up ? "above" : "below";
    };
    place();
    // Kept beside the name while what holds it scrolls or the window changes size.
    const onMove = (e: Event) => {
      if (e.target instanceof Node && card.current?.contains(e.target)) return;
      place();
    };
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, host]);

  // A mouse's hover only: a touch also sends pointerenter, and a tap is the button's (or the row's) to answer.
  const enter = (e: ReactPointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clearTimer();
    if (!hovered) timer.current = setTimeout(() => setHovered(true), OPEN_MS);
  };
  const leave = (e: ReactPointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clearTimer();
    timer.current = setTimeout(() => setHovered(false), CLOSE_MS);
  };
  const stay = (e: ReactPointerEvent) => {
    if (e.pointerType === "mouse") clearTimer();
  };

  const cardEl =
    open && host
      ? createPortal(
          <div
            ref={card}
            id={id}
            className="move-card"
            data-mode={mode}
            aria-hidden={mode === "hover" ? true : undefined}
            onPointerEnter={stay}
            onPointerLeave={leave}
            // A portal's events still travel the React tree: a press inside the card is not the row's tap.
            onClick={(e) => e.stopPropagation()}
          >
            <MoveCardBody move={move} dose={dose} why={why} />
          </div>,
          host,
        )
      : null;

  if (mode === "hover") {
    return (
      <span ref={wrap} className={className ? `move-hover ${className}` : "move-hover"} onPointerEnter={enter} onPointerLeave={leave}>
        {children}
        {cardEl}
      </span>
    );
  }
  return (
    <span
      ref={wrap}
      className="move-term-wrap"
      onBlur={(e) => {
        // Focus left the name (Tab away): a keyboard's card closes. A pinned one closes on a press elsewhere.
        if (keyed && !wrap.current?.contains(e.relatedTarget as Node | null)) setKeyed(false);
      }}
    >
      <button
        type="button"
        className={className ? `move-term ${className}` : "move-term"}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onPointerEnter={enter}
        onPointerLeave={leave}
        onFocus={(e) => {
          let visible = false;
          try {
            visible = e.currentTarget.matches(":focus-visible");
          } catch {
            visible = false;
          }
          if (visible) setKeyed(true);
        }}
        onClick={() => {
          clearTimer();
          if (pinned) close();
          else setPinned(true);
        }}
      >
        {children}
      </button>
      {cardEl}
    </span>
  );
}
