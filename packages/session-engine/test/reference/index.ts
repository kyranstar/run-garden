// FROZEN REFERENCE — the session engine's build path exactly as it was before the performance work (ruling 2a-R6,
// commit 11d1518): history rescanned per call, no index. It exists ONLY for engine-differential.test.ts, which
// checks that the optimised engine plans byte-identically to it. Never import it from src, never edit it to make
// that test pass; when the engine's behaviour changes on purpose, change this copy in the same commit, rule for rule
// and marked where it changed, or delete it together with the differential. Changed in step so far: 2026-10-23, a
// lift rotated out of its block may come back ROTATED_OUT_DAYS later (blocks.ts), and a timed block's minimum item
// takes the best-ranked one that fits its share, or the week's new move when it ranks first (builder.ts). (The condition rules themselves live in
// @rg/exercise-library, which this copy and the engine both read.)
export { Blocks } from "./blocks.js";
export { Builder } from "./builder.js";
export { Coverage } from "./coverage.js";
export { Hist } from "./hist.js";
export { Planner } from "./planner.js";
export { Prog } from "./prog.js";
export { Proposal } from "./proposal.js";
export { Select } from "./select.js";
