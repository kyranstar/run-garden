/**
 * THE QUICK STARTS (Stage 2 spec §9; Task 7): links to the builder, pre-filled — a built-in one is built there on the
 * device, so a tile and Start now are two taps to a running session; a pinned template opens as itself; "Yours" opens
 * the templates, where one is pinned to join them. Offline or before the templates are read, the built-in ones stand
 * alone.
 *
 * One component for both places that offer them: the Studio's home and the coach's opening screen ("Or start something
 * yourself", the new shape §5).
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import { IconClock, IconPlus } from "../../icons.js";
import { useAccountLibrary } from "../../library/account-library.js";
import { TEMPLATES_QUERY } from "./add-sheet.js";
import type { StudioCtx } from "./model.js";
import { quickTiles, TEMPLATES_HREF } from "./templates-model.js";

export function QuickStarts({ ctx }: { ctx: StudioCtx }) {
  const templates = useQuery({ queryKey: TEMPLATES_QUERY, queryFn: api.templates, staleTime: 30_000 });
  // A pinned template's moves resolve in the account's whole library (an archived move of the athlete's own too).
  const { all } = useAccountLibrary();
  // Each built-in tile builds today's workout to say its minutes: once per change of what it is built with.
  const tiles = useMemo(() => quickTiles(ctx, templates.data?.templates, all), [ctx, templates.data, all]);
  return (
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
  );
}
