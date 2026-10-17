/**
 * THE STUDIO HOME (Stage 2 spec §3), under the search field:
 *
 *   Quick starts   Jaw care 5 min · Desk reset 8 min · Hip opener 10 min · <pinned templates> · ＋ Yours
 *   [ New workout ]                              Templates (4) ›  ← the builder (Task 6); "Continue …" while one is being built
 *   Browse         All moves · Warm-up · Activation · Strength · … · Cool-down
 *   Themes         Hips & posture 27 · Ski prep 13 · …          ← one row, scrolled sideways on a phone
 *   Tags           Desk relief · Ski · Single-leg · … More tags  ← the eight most used; the rest one tap down
 *
 * Every browse chip, theme and tag opens the same result list with that one filter applied (a removable chip under
 * the field). A theme's count is what the tap would show — today's fit and the place's gear already counted — so a
 * tile never promises moves the list then hides; with none, it says which default is why ("None fit today"). Nothing
 * condition-specific shows unless a profile is on. Short by design: the whole home fits about two phone screens.
 *
 * Quick starts (Task 7, spec §9) are links to the builder, pre-filled: a built-in one is built there on the device, so a
 * tile and Start now are two taps to a running session; a pinned template opens as itself. "Yours" opens the templates,
 * where one is pinned to join them.
 */
import { useId, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import { EXERCISES, label } from "@rg/exercise-library";
import { IconChevron } from "../../icons.js";
import { TEMPLATES_QUERY } from "./add-sheet.js";
import { BuildEntry } from "./build-entry.js";
import { ChipRow } from "./chip-row.js";
import { browseParts, browseTags, HOME_TAGS, themeCountWord, visibleThemes, type StudioCtx, type StudioFilters } from "./model.js";
import { QuickStarts } from "./quick-starts.js";
import { TEMPLATES_HREF } from "./templates-model.js";

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
}: {
  ctx: StudioCtx;
  /** Open the list with these filters (`all`: every move). */
  onBrowse: (filters: StudioFilters | "all") => void;
}) {
  const themes = visibleThemes(ctx).map((t) => ({ t, word: themeCountWord(EXERCISES, t.id, ctx) }));
  // The athlete's templates: the count is the templates link's (the quick starts read them too, for the pinned ones).
  // Offline or before they are read, the link has no count.
  const templates = useQuery({ queryKey: TEMPLATES_QUERY, queryFn: api.templates, staleTime: 30_000 });
  const count = templates.data?.templates.length;
  // The coach is no longer here (the new shape §5): it is one conversation, opened from the nav.
  return (
    <div className="stu-home">
      <Section title="Quick starts">
        <QuickStarts ctx={ctx} />
      </Section>

      <div className="stu-build-row">
        <BuildEntry />
        {/* The objectives live in Growth now (the new shape §7): its own place in the nav. */}
        <span className="stu-build-links">
          <Link className="linklike stu-tpl-link" to={TEMPLATES_HREF}>
            {count === undefined ? "Templates" : `Templates (${count})`}
            <IconChevron size={16} />
          </Link>
        </span>
      </div>

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
        <ChipRow
          chips={browseTags(EXERCISES).map((t) => ({ key: t, label: label(t), onClick: () => onBrowse({ tag: t }) }))}
          limit={HOME_TAGS}
          more="More tags"
          less="Fewer tags"
        />
      </Section>
    </div>
  );
}
