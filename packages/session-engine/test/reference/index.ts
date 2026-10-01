// FROZEN REFERENCE — the session engine's build path exactly as it was before the performance work (ruling 2a-R6,
// commit 11d1518): history rescanned per call, no index. It exists ONLY for engine-differential.test.ts, which
// checks that the optimised engine plans byte-identically to it. Never import it from src, never edit it to make
// that test pass; when the engine's behaviour changes on purpose, delete this copy together with the differential.
export { Blocks } from "./blocks.js";
export { Builder } from "./builder.js";
export { Coverage } from "./coverage.js";
export { Hist } from "./hist.js";
export { Planner } from "./planner.js";
export { Prog } from "./prog.js";
export { Proposal } from "./proposal.js";
export { Select } from "./select.js";
