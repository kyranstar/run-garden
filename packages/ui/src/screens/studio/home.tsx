/**
 * THE STUDIO HOME (Stage 2 spec §3), under the search field:
 *
 *   Quick starts   Jaw care 5 min · Desk reset 8 min · Hip opener 10 min · <pinned templates> · ＋ Yours
 *   [ New workout ]         From your saves (1) ›  Templates (4) ›  ← the builder (Task 6); "Continue …" while one is being built;
 *                                                                   the saves' link only while a batch waits (released, or
 *                                                                   saved and not fitted in)
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
import { api, SAVES_BATCHES_QUERY } from "@rg/api-client";
import { label } from "@rg/exercise-library";
import { settling, Spinner } from "../../components.js";
import { IconChevron } from "../../icons.js";
import { TEMPLATES_QUERY } from "./add-sheet.js";
import { BuildEntry } from "./build-entry.js";
import { ChipRow } from "./chip-row.js";
import { browseParts, browseTags, HOME_TAGS, themeCountWord, visibleThemes, type StudioCtx, type StudioFilters } from "./model.js";
import { QuickStarts } from "./quick-starts.js";
import { savesHref, waitingBatches } from "./saves-model.js";
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
  loading = false,
  onBrowse,
}: {
  ctx: StudioCtx;
  /** The context's reads have not answered yet, nor failed (`useStudioReads().loading`). */
  loading?: boolean;
  /** Open the list with these filters (`all`: every move). */
  onBrowse: (filters: StudioFilters | "all") => void;
}) {
  const themes = visibleThemes(ctx).map((t) => ({ t, word: themeCountWord(ctx.library, t.id, ctx) }));
  // The athlete's templates: the count is the templates link's (the quick starts read them too, for the pinned ones).
  // Offline, the link has no count.
  const templates = useQuery({ queryKey: TEMPLATES_QUERY, queryFn: api.templates, staleTime: 30_000 });
  const count = templates.data?.templates.length;
  // A way back to the saves (final review I2; spec §6): while a batch waits — released, or saved and not fitted in. The
  // import off (404) or offline, the read never answers and nothing is drawn; it is not retried (the home waits for it).
  const saves = useQuery({ queryKey: SAVES_BATCHES_QUERY, queryFn: () => api.savesBatches(), retry: false, staleTime: 30_000 });
  const waiting = waitingBatches(saves.data?.batches ?? []);
  // Which quick starts there are is the reads' to say — a switched-on profile's care tile, a pinned template — and a
  // tile that came late would wrap the row and push all of this down under a tap aimed at it (CI's WebKit tapped
  // "Templates" where it had been, 2026-10-19; UX System 4). So nothing is drawn until they have answered — or failed:
  // then it is drawn from what there is, and a read of them again never takes it back (`settling`).
  if (loading || settling(templates, saves)) {
    return (
      <div className="stu-home">
        <Spinner label="Loading the Studio" />
      </div>
    );
  }
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
          {waiting > 0 ? (
            <Link className="linklike stu-tpl-link" to={savesHref()}>
              {`From your saves (${waiting})`}
              <IconChevron size={16} />
            </Link>
          ) : null}
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
          {browseParts(ctx.library, ctx).map((p) => (
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
          chips={browseTags(ctx.library).map((t) => ({ key: t, label: label(t), onClick: () => onBrowse({ tag: t }) }))}
          limit={HOME_TAGS}
          more="More tags"
          less="Fewer tags"
        />
      </Section>
    </div>
  );
}
