/* eslint-disable */
/**
 * A stand-in for the AI gateway that replays ONE recorded coach reply.
 * Paired with coach-lift-replay.spec.ts — see that file's header for how to
 * run the three-process stack.
 *
 * No API key is available in this worktree, so the model's bytes are
 * handcrafted to match what the model actually produced live on 2026-08-16
 * — reconstructed from the failure's own evidence:
 *   coach_messages.refs.schemaIssues on receipt 1c04712e recorded
 *     proposals.0.ops.0.session.lift.exercises.{0,1,2}.originId: Required
 *     ...                                              .weight: Required
 *     ...                                              .restSeconds: Required
 * i.e. the model emitted lift exercises carrying ONLY {name, sets, reps}.
 * Every exercise below keeps that exact minimal shape wherever the live
 * model used it, and adds the new primitives only where the coach's own
 * prose promised something the old vocabulary could not hold (a 45-second
 * wall sit; a 12-minute wall-sit-and-core filler).
 *
 * Everything downstream of these bytes is the real worker.
 */
import { createServer } from "node:http";

const REPLY = {
  briefing:
    "Camping happens — you're three days off running and stiff, but recovery reads 100% and nothing about the race build is broken. Here's the ski-prep layer you asked for: three real leg sessions on the days that can carry them, and a 12-minute wall-sit-and-core filler on the run days in between. Ten days is enough to make your quads a lot harder to blow up on day one.",
  proposals: [
    {
      title: "Ski-prep leg block",
      evidence: "ski trip 2026-08-26 · 0 strength sessions in 14d · 3 days off",
      rationale:
        "Skiing is eccentric quad work at length plus lateral control. Wall sits build the isometric endurance a long run of moguls asks for; the slow lowering on the split squats is the part that actually protects the knee.",
      expiresAt: "2026-08-18",
      flags: [],
      ops: [
        {
          kind: "add",
          date: "2026-08-18",
          session: {
            category: "strength",
            title: "Ski legs — holds and eccentrics",
            durationMinutes: 45,
            lift: {
              exercises: [
                { name: "Wall sit", sets: 3, holdSeconds: 45 },
                {
                  name: "Bulgarian split squat",
                  sets: 3,
                  reps: 8,
                  perSide: true,
                  eccentricSeconds: 4,
                  weight: 12,
                },
                { name: "Single-leg calf raise", sets: 3, reps: 15, perSide: true },
                { name: "Copenhagen plank", sets: 2, holdSeconds: 20, perSide: true },
              ],
            },
          },
        },
        {
          kind: "add",
          date: "2026-08-21",
          session: {
            category: "strength",
            title: "Ski legs — lateral and jump",
            durationMinutes: 40,
            lift: {
              exercises: [
                // The EXACT minimal shape the live model emitted and the old
                // schema rejected three times: name, sets, reps. Nothing else.
                { name: "Squats", sets: 4, reps: 10 },
                { name: "Box jumps", sets: 4, reps: 5 },
                // A movement the athlete's COROS library does not have — the
                // deliberate miss. It must survive as a real exercise.
                { name: "Skier hops", sets: 3, holdSeconds: 30 },
                { name: "Single leg bridge", sets: 3, reps: 12, perSide: true },
              ],
            },
          },
        },
        {
          kind: "add",
          date: "2026-08-24",
          session: {
            category: "strength",
            title: "Ski legs — last sharpener",
            durationMinutes: 30,
            lift: {
              exercises: [
                { name: "Wall sit", sets: 4, holdSeconds: 60 },
                { name: "Dumbbell lunges", sets: 3, reps: 10, perSide: true, weight: "10 kg" },
                // Second deliberate miss, with a name COROS has no entry for.
                { name: "Nordic hamstring curl", sets: 3, reps: 5, eccentricSeconds: 5 },
              ],
            },
          },
        },
        {
          kind: "add",
          date: "2026-08-19",
          session: {
            category: "strength",
            title: "Wall-sit + core filler",
            durationMinutes: 12,
            lift: {
              rounds: 3,
              exercises: [
                { name: "Wall sit", sets: 1, holdSeconds: 45 },
                { name: "Plank", sets: 1, holdSeconds: 45 },
                { name: "Side plank", sets: 1, holdSeconds: 30, perSide: true },
                { name: "Bird dog", sets: 1, reps: 10, perSide: true, restSeconds: 30 },
              ],
            },
          },
        },
        {
          kind: "add",
          date: "2026-08-20",
          session: {
            category: "yoga",
            title: "Hips and ankles",
            durationMinutes: 20,
            mobility: {
              exercises: [
                { name: "Couch stretch", sets: 2, holdSeconds: 60, perSide: true },
                { name: "Bridge", sets: 2, holdSeconds: 30 },
              ],
            },
          },
        },
      ],
    },
  ],
  question: null,
  memoryOps: [
    { op: "add", kind: "note", text: "Ski trip 2026-08-26 — ski prep is the priority until then.", expiresAt: "2026-08-27" },
  ],
  focus: "Legs first for ten days — the runs stay easy around them.",
  raceLine: null,
};

/** Restraint — a complete, successful wake that proposes nothing. What the
 * coach should say when an "open" wake follows a message it already
 * answered. Without it every page visit re-proposed the same block. */
const RESTRAINT = { briefing: null, proposals: [], question: null, memoryOps: [], focus: null, raceLine: null };

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const askedByTheAthlete = body.includes("The athlete just said");
    const content = JSON.stringify(askedByTheAthlete ? REPLY : RESTRAINT);
    // Chunked exactly as a real SSE completion arrives.
    for (let i = 0; i < content.length; i += 400) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + 400) } }] })}\n\n`);
    }
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4200, completion_tokens: 900 } })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
server.listen(8899, "127.0.0.1", () => console.log("model stub on 8899"));
