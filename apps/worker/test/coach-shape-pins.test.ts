/**
 * THE NEW SHAPE'S PINS ON THE COACH (stream A, part 6). The conversation, the auto scope, answers, `replaces` and the
 * plan powers added text the model reads on every call — the shared prompt, the main coach's block, the tools — so:
 *  - every word of it stays generic (a public repository: no condition the library's profiles know, nothing personal);
 *  - the cached prefix a main run sends (the tools, the shared prompt, the main coach's block) grew by about 1.5k tokens
 *    at most against the wave's start (2c3d019), measured at the loop's own 3.5 bytes a token — REBASED 2026-10-18 for
 *    §8's two prompt streams (R's designed runs, W's whole plans): against §8's start (5908769) — TIGHTENED after
 *    review-3 to what §8 measured plus a small margin (see GROWTH_MAX_CHARS);
 *  - the opening message's per-run parts (the conversation so far, the auto scope's line) stay what their own tests pin
 *    (coach-conversation.test.ts, coach-auto.test.ts).
 */
import { describe, expect, it } from "vitest";
import { PROFILES } from "@rg/exercise-library";
import { PROMPT_BYTES_PER_TOKEN, RUN_LIMITS } from "../src/services/coach-runs.js";
import { roleBlock, SHARED_PROMPT } from "../src/services/design-prompt.js";
import { allTools } from "../src/services/design-tools/index.js";

/** The cached prefix of a main run at §8's start (5908769; the new shape's own start, 2c3d019, was 33,512 + 20,323 +
 * 3,864), in characters: the tools as sent, the shared prompt, the main coach's block with its turns. */
const BEFORE = { tools: 34_935, shared: 20_450, main: 4_586 };
/**
 * §8's two prompt streams (R's designed runs, W's whole plans), measured after R's review-2 round (HEAD d3d8fae): the
 * prefix grew 5,745 characters (tools 34,935 → 38,001, the shared prompt 20,450 → 22,637, the main block 4,586 →
 * 5,078; W's read_plans and propose_plan with their lines 4,149, R's runs 1,596) — about 1.6k tokens at the loop's 3.5
 * bytes a token. Held there with about 400 characters of margin (review-3: the first rebase's 10,500 left ~4.7k
 * unpinned); a stream that needs more says so here.
 *
 * REBASED 2026-10-18 for the decision guidance (stream D: criteria for every decision the coach makes — time or
 * distance, heart rate, race pace, a run's length, plan_set or propose_plan, what reaches the watch, a programme's
 * settings, when to remember): measured 1,865 more (tools 38,001 → 38,002 — the run target's heart rate, zone and typed
 * text out, a plan session's intensities in; the shared prompt 22,637 → 23,629; the main block 5,078 → 5,950), so
 * 7,610 since §8's start — about 2.2k tokens. Held there with about 290 characters of margin.
 *
 * REBASED 2026-10-19 for the owner's voice (the coach's last words: brisk and direct, one next step the card doesn't
 * show, no apologies, not the card — chosen from production replays): the main block 5,950 → 6,535 and the shared
 * finish line pointing to it 23,641 → 23,564 (the decision guidance's fix round had added 12), so 8,130 since §8's
 * start — the round's own growth 508 characters, about 145 tokens. Held there with about 220 characters of margin.
 *
 * REBASED 2026-10-19 for the coach's programme edits (stream W, §8 §5: change_programme — a programme's days, goal,
 * minutes, block length, modes and care, approved as one card): measured 1,214 more (tools 38,002 → 38,978, the tool's
 * compact schema; the shared prompt 23,564 → 23,729, its Acting line; the main block 6,535 → 6,608, its criteria in
 * place of "change in its settings"), so 9,344 since §8's start — the round's own about 347 tokens. Held there with
 * about 220 characters of margin.
 *
 * NOT REBASED 2026-10-19 for a workout's music (stream M): the document's `music` field in the tools' schema, under 150
 * characters (design-music.test.ts pins it) and inside the margin; the criteria for naming a playlist go with the
 * playlists in the athlete's profile block (`playlistLines`), not in the shared prompt — nothing for an athlete without.
 *
 * NOT REBASED 2026-10-20 for training lines (the coach sees lines and the Studio plan): read_plans' description names the
 * Studio plan, 16 characters (tools 39,125 → 39,141), inside the margin — 9,531 since §8's start; its lines, the Studio
 * plan's entry and how to continue a line are in its answer, not in the prefix.
 *
 * REBASED 2026-10-25 for read_saves (saved-posts import, Task 17: what came in from the athlete's saves): a new read
 * tool, its schema compact (tools 39,141 → 39,746, its `offset` among them since the review's fix round) and one
 * Reading line in the shared prompt (23,729 → 23,833) — 709 characters, so 10,240 since §8's start; held with about the
 * same margin as before. The batch's moves are in the opening message (a main run's, only while a saved batch waits),
 * its posts and routines in the tool's answer.
 *
 * REBASED 2026-10-25 (Task 18): pin_moves acting line + integration guidance (saved-posts import: the coach keeps a
 * saved move in rotation with the athlete's approval, and fits saved moves in selectively) — a new act tool, its schema
 * compact (tools 39,746 → 40,761: the moves, the batch, the card's own words with their caps) and the shared prompt
 * 23,833 → 24,733 (its Acting line, and the integration guidance with its selectivity paragraph, word for word, under
 * "# Integrating saved moves") — 1,915 characters, so 12,155 since §8's start; held with about the same margin as before.
 * REBASED again 2026-10-25 (Task 18 review 1): pin_moves' description says a lines-only card closes its batch (tools
 * 40,761 → 40,802), so 12,196; the same margin.
 * REBASED 2026-10-25 (the saved-posts fix wave, after the coach-context audit): what a pin does (the pool the engine plans
 * from: a core lift stays, other moves become eligible) in pin_moves' description and acting line, a batch's new moves
 * accounted for by id in its lines; read_saves' and get_exercise's descriptions name the notes, insights and a saved
 * move's own id; recall_memory's names the saved-post source (tools 40,802 → 41,104); the integration paragraph's one
 * workout per run and closing the batch, the saved-post sentence under Untrusted text (shared 24,733 → 25,164); pin_moves
 * among the main block's choices (6,632 → 6,667) — 768 characters, so 12,964; held with about the same margin as before.
 * REBASED 2026-10-26 (saves flow redesign): read_saves' description and its batchId's name the run's batch (a fit-in
 * run is told its batch), each move's choice and its near-duplicate (tools 41,104 → 41,131) — measured 12,991; held
 * with 409 characters (~117 tokens) of headroom.
 * REBASED 2026-10-26 (saves flow redesign): pin_moves' lines become objects — a line's moveId (the card names the move,
 * so the model never writes it) and its text at the raised 280 cap — its summary optional with a batch (the card counts),
 * its description naming the fit-in run's batch and the athlete's include and skip (tools 41,131 → 41,455) — measured
 * 13,315; held with 435 characters (~124 tokens) of headroom.
 * REBASED 2026-10-26 (saves flow redesign): the integration paragraph says how the athlete's choices work (include, skip,
 * coach), never both of a near-duplicate pair, and a line's moveId; read_saves' Reading line names a fit-in run's own
 * batch (shared 25,164 → 25,659) — measured 13,810; held with 440 characters (~126 tokens) of headroom.
 */
const GROWTH_MAX_CHARS = 14_250;

const toolsSent = () => JSON.stringify(allTools().map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })));

/** Every word a condition profile owns: its id and label, its check, flag and care words, its rating attributes. */
function profileWords(): string[] {
  return Object.values(PROFILES).flatMap((p) => [
    p.id,
    p.label,
    p.check.label,
    ...(p.setFlag ? [p.setFlag.id, p.setFlag.label, p.setFlag.pastTense] : []),
    ...(p.care ? [p.care.block.label, ...p.care.block.roles] : []),
    ...Object.keys(p.attributes),
    p.quietPhrase,
    ...(p.calmStreakLabel ? [p.calmStreakLabel] : []),
  ]);
}

describe("the coach's cached prefix after the new shape", () => {
  it(`grew by §8's measured 9,344 characters and a small margin at most (${GROWTH_MAX_CHARS}; ~${Math.round(GROWTH_MAX_CHARS / PROMPT_BYTES_PER_TOKEN)} tokens)`, () => {
    const now = { tools: toolsSent().length, shared: SHARED_PROMPT.length, main: roleBlock("main", RUN_LIMITS.main.maxCalls).length };
    const grown = now.tools + now.shared + now.main - (BEFORE.tools + BEFORE.shared + BEFORE.main);
    expect(grown).toBeGreaterThan(0);
    expect(grown, JSON.stringify(now)).toBeLessThanOrEqual(GROWTH_MAX_CHARS);
  });

  it("every word the coach writes for the model stays generic: no condition profile's words in the prompt, a tool's description or a field's", () => {
    // (A schema's enums are the library's own vocabulary — a role such as a care block's — generated, never written here.)
    const descriptions = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.flatMap(descriptions)
        : v && typeof v === "object"
          ? Object.entries(v).flatMap(([k, x]) => (k === "description" && typeof x === "string" ? [x] : descriptions(x)))
          : [];
    const tools = allTools().flatMap((t) => [t.description, ...descriptions(t.inputSchema)]);
    const text = [SHARED_PROMPT, roleBlock("main", 12), roleBlock("designer", 10), roleBlock("reviewer", 3), ...tools].join("\n").toLowerCase();
    for (const w of profileWords()) expect(text, w).not.toContain(w.toLowerCase());
  });
});
