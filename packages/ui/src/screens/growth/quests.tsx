/**
 * QUESTS (the new shape §7): the objectives board's objectives, each a quest — its title, its key result's progress bar
 * (from the start to the target, the board's own measure of it), what that is in words ("95 s of 120 s"), and one
 * gentle line: a best ever this week, a streak of weeks, paused or completed, or a quiet nudge when nothing has been done
 * toward it for four weeks. A quest opens its full card in a sheet (the board's card: every measure's trend, the
 * workouts that served it, the coach's line). The board's actions — New objective, Edit, Pause, Mark complete — are
 * the board's own (studio/objectives.tsx, `ObjectivesScreen` with `variant="quests"`).
 *
 * Gentle (§2.10): never red, never a count of what was missed; a best ever only when it is on the trend.
 */
import type { ObjectiveBoardCard } from "@rg/domain";
import { startOfIsoWeek } from "@rg/domain";
import { formatKr, krFraction, stalled, STALL_DAYS, streakWords } from "../studio/objectives-model.js";

type Kr = ObjectiveBoardCard["keyResults"][number];

/** The key result a quest's bar shows: the first that can say how far it has come, else none. */
export function questKr(card: ObjectiveBoardCard): { k: Kr; fraction: number } | null {
  for (const k of card.keyResults) {
    const fraction = krFraction(k.keyResult, k.progress.display.current);
    if (fraction !== null) return { k, fraction };
  }
  return null;
}

/** The bar in words: "96 s of 120 s" — or, where lower is better (a pace, a time), "5:55 /km · target 5:30 /km". */
export function questProgressWords(k: Kr): string | null {
  const { keyResult: kr, progress: p } = k;
  if (p.display.current === null || kr.target === null) return null;
  const fmt = (v: number) => formatKr(v, kr.unit, kr.measure);
  const now = `${p.evidence === "capped" ? "at least " : ""}${fmt(p.display.current)}`;
  return kr.direction === "down" ? `${now} · target ${fmt(kr.target)}` : `${now} of ${fmt(kr.target)}`;
}

/** A key result's best ever, when it came this week (Monday on) and sits on its trend. */
export function bestThisWeek(card: ObjectiveBoardCard, today: string): Kr | null {
  const monday = startOfIsoWeek(today);
  return (
    card.keyResults.find(
      (k) => k.best !== null && k.best.date >= monday && k.best.date <= today && k.progress.series.some((pt) => pt.date === k.best!.date && pt.value === k.best!.value),
    ) ?? null
  );
}

/** The quest's one line: what is worth saying about it now, or nothing. */
export function questLine(card: ObjectiveBoardCard, today: string): string | null {
  const o = card.objective;
  if (o.status === "done") return "Completed";
  if (o.status === "paused") return "Paused";
  const best = bestThisWeek(card, today);
  if (best) return `Best ever this week · ${best.keyResult.label} ${formatKr(best.best!.display, best.keyResult.unit, best.keyResult.measure)}`;
  const streak = streakWords(card.streakWeeks);
  if (streak) return streak;
  if (stalled(card, today)) return `Nothing toward it in ${STALL_DAYS / 7} weeks`;
  return null;
}

/** One quest: its title (opens its card), its bar and its line. */
export function QuestRow({ card, today, onOpen }: { card: ObjectiveBoardCard; today: string; onOpen: () => void }) {
  const o = card.objective;
  const main = questKr(card);
  const words = main ? questProgressWords(main.k) : null;
  const line = questLine(card, today);
  const pct = main ? Math.round(main.fraction * 100) : null;
  const best = line?.startsWith("Best ever") ?? false;
  return (
    <article className={`quest quest--${o.status}`} data-id={o.id}>
      <button type="button" className="quest-open" aria-haspopup="dialog" onClick={onOpen}>
        <span className="quest-title">{o.title}</span>
        <span className="quest-caret" aria-hidden="true">
          ›
        </span>
      </button>
      {main && pct !== null ? (
        <div
          className="quest-bar"
          role="progressbar"
          aria-label={main.k.keyResult.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={words ?? `${pct}%`}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {words || line ? (
        <p className="quest-meta">
          {words ? <span>{words}</span> : null}
          {line ? (
            <span className={best ? "quest-best" : undefined}>
              {best ? (
                <span className="quest-best-glyph" aria-hidden="true">
                  ◎
                </span>
              ) : null}
              {line}
            </span>
          ) : null}
        </p>
      ) : null}
    </article>
  );
}
