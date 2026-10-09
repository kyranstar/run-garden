/**
 * How many days the hourly cron's garden step may simulate in one invocation — the plain walk forward, a restore's
 * catch-up step and a version upgrade's rebuild alike (cron reliability, part 2). A day costs ~0.8 ms of CPU in node
 * and ~11 D1 statements; a garden 45 days behind cost one invocation 36 ms and 480 statements on a realistic account,
 * several times what the free plan lets an invocation spend. The daily case walks one day; anything longer finishes
 * over the next runs, each persisting where it stopped (and a garden read walks the rest at once, before it renders).
 *
 * It lives here, not in index.ts: every value the Worker's entry module exports is taken as an entrypoint, and workerd
 * refuses to start on one that is not a function or handler (a number here stopped `wrangler dev` cold).
 */
export const CRON_GARDEN_MAX_DAYS = 3;
