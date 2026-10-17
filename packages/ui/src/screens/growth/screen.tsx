/**
 * GROWTH (the new shape §7): one of the three places — what Activity was, and the objectives board as quests.
 *
 *   Growth                                   [ Month | Season ]
 *   Your body      the figure, tinted · "Core and hips carried the month." · "Hips quiet for 6 days."
 *                  [ 15 minutes for my hips ]  — opens the coach with the words written
 *   Quests         each objective: its bar, its line ("Best ever this week · Wall sit 95 s")
 *   Records        runs · strength · holds
 *   Activity       the chips, the training chart over the period, the signals, the feed by week
 *
 * The period is the page's address (`?period=season`; the month without one), so a reload or a shared link keeps it.
 * Month is the last 30 days, Season the last 90: the body map and the holds read it, the chart shows its weeks. The
 * quests belong to the coach: with the coach off they are not drawn (their read answers 404). Growth registers nothing
 * for the coach to see; an open activity or quest does.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "@rg/api-client";
import { GROWTH_PERIODS, type GrowthBodyDto, type GrowthPeriod } from "@rg/domain";
import { coachOn } from "../../features.js";
import { CoachBoundary } from "../studio/coach-boundary.js";
import { ObjectivesScreen } from "../studio/objectives.js";
import { GrowthActivity } from "./activity.js";
import { BodyCard } from "./body-map.js";
import { GrowthRecords } from "./records.js";

export const GROWTH_BODY_QUERY = (period: GrowthPeriod) => ["growth", "body", period] as const;

const PERIOD_LABEL: Record<GrowthPeriod, string> = { month: "Month", season: "Season" };

/** The page's period: `?period=season`, else the month. */
export const periodOf = (raw: string | null): GrowthPeriod => (raw === "season" ? "season" : "month");

/** Month / Season: one choice, saved in the address. */
export function PeriodSwitch({ period, onChange }: { period: GrowthPeriod; onChange: (p: GrowthPeriod) => void }) {
  return (
    <div className="program-seg growth-period" role="group" aria-label="Period">
      {GROWTH_PERIODS.map((p) => (
        <button key={p} type="button" aria-pressed={period === p} onClick={() => p !== period && onChange(p)}>
          {PERIOD_LABEL[p]}
        </button>
      ))}
    </div>
  );
}

export function GrowthScreen() {
  const [params, setParams] = useSearchParams();
  const period = periodOf(params.get("period"));
  const body: UseQueryResult<GrowthBodyDto> = useQuery({
    queryKey: GROWTH_BODY_QUERY(period),
    queryFn: () => api.growthBody(period),
    staleTime: 60_000,
  });
  return (
    <div className="stack growth">
      <div className="row-between screen-title growth-title">
        <h1>Growth</h1>
        <PeriodSwitch
          period={period}
          onChange={(p) =>
            setParams(
              (prev) => {
                const next = new URLSearchParams(prev);
                if (p === "month") next.delete("period");
                else next.set("period", p);
                return next;
              },
              { replace: true },
            )
          }
        />
      </div>
      <BodyCard query={body} period={period} />
      {coachOn() ? (
        // A quest that can't be drawn says so in its own place; the rest of Growth goes on.
        <CoachBoundary what="your quests">
          <ObjectivesScreen variant="quests" />
        </CoachBoundary>
      ) : null}
      <GrowthRecords holds={body.data?.holds} period={period} />
      <GrowthActivity period={period} />
    </div>
  );
}
