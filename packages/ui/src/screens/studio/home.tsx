/**
 * THE STUDIO HOME (Stage 2 spec §3), under the search field:
 *
 *   [ the coach's composer, or its run view and suggestion — Stage 3 (composer.tsx), with the coach designer on ]
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
import { useId, useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import { EXERCISES, label } from "@rg/exercise-library";
import { coachOn } from "../../features.js";
import { IconChevron, IconClock, IconPlus } from "../../icons.js";
import { TEMPLATES_QUERY } from "./add-sheet.js";
import { BuildEntry } from "./build-entry.js";
import { ChipRow } from "./chip-row.js";
import { StudioCoach } from "./composer.js";
import { browseParts, browseTags, HOME_TAGS, themeCountWord, visibleThemes, type StudioCtx, type StudioFilters } from "./model.js";
import { quickTiles, TEMPLATES_HREF } from "./templates-model.js";

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
  // The athlete's templates: the pinned ones join the quick starts; the count is the templates link's. Offline or
  // before they are read, the built-in quick starts stand alone and the link has no count.
  const templates = useQuery({ queryKey: TEMPLATES_QUERY, queryFn: api.templates, staleTime: 30_000 });
  const count = templates.data?.templates.length;
  // Each built-in tile builds today's workout to say its minutes: once per change of what it is built with.
  const tiles = useMemo(() => quickTiles(ctx, templates.data?.templates), [ctx, templates.data]);
  return (
    <div className="stu-home">
      {/* Stage 3: the coach's composer (What would help today? · Now · Later today · Plan ahead) — or, while the coach
          works, its run view — in this slot, with the coach designer on (`coachOn`); off, the slot takes no room. */}
      <div className="stu-composer-slot" data-slot="coach-composer">
        {coachOn() ? <StudioCoach ctx={ctx} /> : null}
      </div>

      <Section title="Quick starts">
        <div className="stu-quick">
          {tiles.map((qs) => (
            <Link key={qs.key} className="stu-qs" to={qs.href}>
              <span className="stu-qs-name">{qs.title}</span>
              {qs.minutes !== null ? (
                <span className="stu-qs-min">
                  <IconClock />
                  {`${qs.minutes} min`}
                </span>
              ) : null}
            </Link>
          ))}
          <Link className="stu-qs stu-qs--yours" to={TEMPLATES_HREF}>
            <IconPlus size={16} />
            Yours<span className="visually-hidden">: your templates</span>
          </Link>
        </div>
      </Section>

      {/* The objectives board (Stage 3 Task 11), with the coach: one quiet link, sitting with Templates. */}
      {coachOn() ? (
        <Link className="linklike stu-tpl-link stu-obj-link" to="/studio/objectives">
          Objectives
          <IconChevron size={16} />
        </Link>
      ) : null}
      <div className="stu-build-row">
        <BuildEntry />
        <Link className="linklike stu-tpl-link" to={TEMPLATES_HREF}>
          {count === undefined ? "Templates" : `Templates (${count})`}
          <IconChevron size={16} />
        </Link>
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
