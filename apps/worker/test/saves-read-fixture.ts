/**
 * A run that read its saves (import trail phase 3): read_saves called in the run's context, and its call's trail event
 * written as the step loop writes it (coach-runs.ts `toolResultPayload`, on the main run's trail) — so pin_moves and
 * correct_import find what the run read, as they do in a real run. Test-only.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../src/services/db.js";
import { toolResultPayload } from "../src/services/coach-runs.js";
import { mainRunIdOf } from "../src/services/design-tools/act-common.js";
import { READ_TOOLS } from "../src/services/design-tools/index.js";
import { isToolErr, type ToolContext, type ToolOk } from "../src/services/design-tools/types.js";

export async function readSavesInRun(db: Db, ctx: ToolContext, input: Record<string, unknown> = {}, at: string = ctx.now.toISOString()): Promise<ToolOk & { data: any }> {
  const r = await READ_TOOLS.find((t) => t.name === "read_saves")!.run(ctx, input);
  if (isToolErr(r)) throw new Error(`read_saves refused: ${r.error} — ${r.why}`);
  const root = mainRunIdOf(ctx) ?? ctx.run.id;
  const payload = JSON.stringify(toolResultPayload("read_saves", input, r, true));
  await db.run(sql`insert into coach_run_events (id, user_id, run_id, seq, kind, summary, payload, at)
    select ${root} || ':' || (coalesce(max(seq), 0) + 1), ${ctx.userId}, ${root}, coalesce(max(seq), 0) + 1, 'tool_result', ${r.summary ?? "Read your saves"}, ${payload}, ${at}
    from coach_run_events where run_id = ${root}`);
  return r as ToolOk & { data: any };
}
