/**
 * THE STUDIO HOME (Stage 2 spec §3), under the search field:
 *
 *   [ the coach's composer — Stage 3 fills this slot ]
 *   Quick starts   Jaw care 5 min · Desk reset 8 min · Hip opener 10 min
 *   Browse         All moves · Warm-up · Activation · Strength · … · Cool-down
 *   Themes         Hips & posture 12 moves · Ski prep 9 moves · …
 *   Tags           Posture · Ski · Hip opening · …
 *
 * Every browse chip, theme and tag opens the same result list with that one filter applied (a removable chip under
 * the field). A theme's count is what the tap would show — today's fit and the place's gear already counted — so a
 * card never promises moves the list then hides; with none, it says which default is why ("None fit today"). Nothing
 * condition-specific shows unless a profile is on.
 *
 * Quick starts and the templates row belong to Task 7: a card is a button only once there is something for it to do.
 */
import { useId, type ReactNode } from "react";
import { EXERCISES, label } from "@rg/exercise-library";
import type { QuickStartKind } from "@rg/workout";
import { IconClock } from "../../icons.js";
import {
  browseParts,
  browseTags,
  quickStarts,
  themeCountWord,
  visibleThemes,
  type StudioCtx,
  type StudioFilters,
} from "./model.js";

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="stu-section" aria-labelledby={id}>
      <h2 id={id} className="eyebrow">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function StudioHome({
  ctx,
  onBrowse,
  onQuickStart,
}: {
  ctx: StudioCtx;
  /** Open the list with these filters (`all`: every move). */
  onBrowse: (filters: StudioFilters | "all") => void;
  /** Start a quick start (Task 7 wires it to the builder). */
  onQuickStart?: (kind: QuickStartKind) => void;
}) {
  const themes = visibleThemes(ctx).map((t) => ({ t, word: themeCountWord(EXERCISES, t.id, ctx) }));
  return (
    <div className="stu-home">
      {/* Stage 3: the coach's composer ("What do you want to do?" · Now · Later today) renders in this slot. */}
      <div className="stu-composer-slot" data-slot="coach-composer" />

      <Section title="Quick starts">
        <div className="stu-quick">
          {quickStarts(ctx).map((qs) => {
            const body = (
              <>
                <span className="stu-qs-name">{qs.title}</span>
                <span className="stu-qs-min">
                  <IconClock />
                  {`${qs.minutes} min`}
                </span>
              </>
            );
            return onQuickStart ? (
              <button key={qs.kind} type="button" className="stu-qs" onClick={() => onQuickStart(qs.kind)}>
                {body}
              </button>
            ) : (
              <div key={qs.kind} className="stu-qs">
                {body}
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Browse">
        <div className="stu-chipset">
          <button type="button" className="chip" onClick={() => onBrowse("all")}>
            All moves
          </button>
          {browseParts(EXERCISES, ctx).map((p) => (
            <button key={p} type="button" className="chip" onClick={() => onBrowse({ part: p })}>
              {label(p)}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Themes">
        <div className="stu-themes">
          {themes.map(({ t, word }) => (
            <button key={t.id} type="button" className="stu-theme" onClick={() => onBrowse({ theme: t.id })}>
              <span className="stu-theme-name display">{t.name}</span>
              <span className="stu-theme-n">{word}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Tags">
        <div className="stu-chipset">
          {browseTags(EXERCISES).map((t) => (
            <button key={t} type="button" className="chip" onClick={() => onBrowse({ tag: t })}>
              {label(t)}
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}
