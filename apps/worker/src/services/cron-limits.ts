/**
 * How many days the hourly cron's garden step may simulate in one invocation — the plain walk forward, a restore's
 * catch-up step and a version upgrade's rebuild alike (cron reliability, part 2). A day costs ~0.8 ms of CPU in node
 * and ~11 D1 statements; a garden 45 days behind cost one invocation 36 ms and 480 statements on a realistic account,
 * several times what the free plan lets an invocation spend. The daily case walks one day; anything longer finishes
 * over the next runs, each persisting where it stopped (and each garden read walks REQUEST_REPLAY_MAX_DAYS of it).
 *
 * It lives here, not in index.ts: every value the Worker's entry module exports is taken as an entrypoint, and workerd
 * refuses to start on one that is not a function or handler (a number here stopped `wrangler dev` cold).
 */
export const CRON_GARDEN_MAX_DAYS = 3;

/**
 * How many days the garden's replay may walk in one invocation of the half-hourly COROS sweep — the read's replay
 * after it ingests new activities and the backfill chunk's — and in any read that also ran the six-hourly full
 * schedule import (cron reliability, part 3). The sweep that ingested a new activity replayed from the week's
 * checkpoint to the garden's day uncapped: ~9 days, 123 D1 statements and 9-22 ms of node CPU — the largest step of
 * the heaviest invocation in the cron system. The replay is on record before it purges anything (resimulateFrom), so
 * the rest is safe to leave: the hourly's garden step walks on (CRON_GARDEN_MAX_DAYS a run), and so do the next sweep
 * and any garden read; the rendered garden keeps what it showed until the walk passes it.
 */
export const SWEEP_REPLAY_MAX_DAYS = 3;

/**
 * How many days of garden one REQUEST may walk or replay (cron reliability, part 4): the garden page's walk
 * (buildGardenView), every route that replays after a change (plan.ts skip / unskip / match / unmatch / remove, the
 * coach's approve, the activities repair), the app's session save, and a request's COROS read or backfill chunk. These
 * ran uncapped: with a long replay on record — 69 days, measured — any of them ran all of it in one invocation (~64 ms
 * of node CPU, ~830 D1 statements; several times what the free plan lets one spend), was killed, and the next request
 * did the same; matching a run from three weeks back replayed 24 days (~27 ms). One step of 7 days costs ~5 ms on a
 * busy runner (~3 ms on the reference one) and ~70 statements: within the ~10 ms node budget part 2 kept the crons to,
 * with room for the request's own work. The rest stays on record (account_state.garden_changed_from); the next request
 * or cron walks on from it, and the rendered garden keeps what it showed until the walk passes it — never rewound.
 */
export const REQUEST_REPLAY_MAX_DAYS = 7;
