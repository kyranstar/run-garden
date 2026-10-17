/**
 * Activity became Growth (the new shape §7): its feed, chart and records live in `screens/growth/`. This file only keeps
 * the old names working until the shell routes `/growth` to `GrowthScreen` and the last import moves; then it goes.
 */
export { ActivityDetail, checkValues, efficiencyClause, feedRowBits, feedRowMeta, flaggedSignals, formatLoggedSet, groupByWeek, LoggedSets, PaceShape } from "./growth/feed.js";
export { GrowthScreen as RunsScreen } from "./growth/screen.js";
