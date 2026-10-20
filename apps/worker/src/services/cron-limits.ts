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

/**
 * The coach designer's runs (Stage 3 spec §2) are stepped by the client while its screen is open — one model call a
 * request — and the hourly cron looks after the ones nobody is stepping, without ever calling the model for them: it
 * gives back dead claims, runs a left run's queued tool calls, and expires runs past their window. A step of queued
 * calls runs up to a step's worth of tool statements, so it is a heavy step in the hourly's sense: at most this many
 * runs are stepped per invocation, in the per-account slot no other heavy step took (index.ts).
 */
export const COACH_RUN_SWEEP_MAX = 1;

/**
 * How long a run for a set (this week, the next N workouts) stays open, from when it began: a day. A run for now or
 * later today stays open until the end of the athlete's local day it began on — its context (the date, the time,
 * today's readings) is frozen at its first step, so a design answered tomorrow would be for yesterday. Past its
 * window a run expires with a plain event, waiting on a question or not: when a step, an answer or the sweep finds it.
 */
export const COACH_RUN_SET_WINDOW_HOURS = 24;

/**
 * A step claims its run by setting it `stepping`; a step that died (a killed invocation, a phone sent to the
 * background mid-call) leaves it there. Past this, the next step takes the claim back, and so does the sweep.
 * Longer than a live step can last: the model call alone may take up to ten minutes (llm-messages.ts' overall
 * deadline), and a live claim must never be taken from under it.
 */
export const COACH_RUN_STEP_STALE_MINUTES = 15;

/**
 * An active run nobody has stepped for this long has been left by its client: the client steps again the moment a
 * step answers, so a gap this long means the app closed. The sweep runs such a run's queued tool calls (no model);
 * the rest waits for the athlete to come back.
 */
export const COACH_RUN_LEFT_MINUTES = 2;

/**
 * How many planned rows the hourly cron gives their workout document again in one account's run (Stage 2 batch end):
 * a row reopened from completed, skipped or missed, or repaired, loses its document (`reopenedDocColumns`, the fidelity
 * repair) until something derives it again. The hourly's small backfill (`backfillLiveDocs`) does, through the admin
 * backfill's own converters, a few rows a run, as a heavy step: each row is converted and schema-checked (the CPU),
 * and the run costs at most this many writes plus a handful of reads in one batch. The most recently changed rows go
 * first; anything older the manual backfill still reaches.
 */
export const CRON_DOC_BACKFILL_MAX = 5;

/**
 * How many rows the hourly's backfill keeps set aside: a row whose conversion failed, as it stood (its id and its
 * `updated_at`), is passed over until it changes, so rows that keep failing never take every run's page from the rows
 * behind them. The newest this many are kept, in one value of `provider_cursor_state` (one read a run, one write when a
 * row failed); a row pushed off the end is tried again once, and set aside again if it still fails.
 */
export const CRON_DOC_BACKFILL_SKIP_MAX = 50;

/**
 * How many open content claims the hourly closes as moot per account per pass (`closeMootContentClaims`): claims on
 * sessions whose story is over — archived, done, missed, skipped, or their day gone. One read and at most five writes
 * whatever the number (one per reason); the rest wait for the next pass. An account rarely holds more than a handful.
 */
export const MOOT_CONTENT_CLAIMS_PER_PASS = 40;
