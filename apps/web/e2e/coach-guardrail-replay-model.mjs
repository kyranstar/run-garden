/* eslint-disable */
/**
 * A stand-in for the AI gateway that replays FOUR recorded coach replies —
 * one per guardrail the 2026-08-16 audit found missing or silent. Paired
 * with coach-guardrail-replay.spec.ts; see that file's header to run it.
 *
 * Each reply is deliberately BAD in exactly one way, and each is the thing
 * the live coach actually did (or would have done) to a real athlete:
 *
 *   "cold start"   a daily lift block for someone with no strength history
 *   "no rest day"  every remaining day of the week filled
 *   "trip"         the heaviest leg session two days before the ski trip
 *   "double"       an op aimed at the second of two same-category rows
 *
 * The repair round-trip returns the SAME bytes (a real model often does),
 * so each proposal is rejected twice and the pipeline must say so in a
 * receipt the athlete can read. Everything downstream of these bytes is the
 * real worker.
 */
import { createServer } from "node:http";

/** Filled in from the spec via /scenario so dates track "today". */
let scenario = "cold-start";
let D = {};

const lift = (title, minutes, exercises) => ({
  category: "strength",
  title,
  durationMinutes: minutes,
  lift: { exercises },
});
const SKI = [
  { name: "Wall sit", sets: 3, holdSeconds: 45 },
  { name: "Bulgarian split squat", sets: 3, reps: 8, perSide: true, eccentricSeconds: 4 },
  { name: "Single-leg calf raise", sets: 3, reps: 15, perSide: true },
];
const easyRun = (minutes) => ({
  category: "easy",
  title: `Easy ${minutes}`,
  durationMinutes: minutes,
  run: { blocks: [{ kind: "duration", value: minutes, intensity: "easy" }] },
});

const wrap = (briefing, proposal, memoryOps = []) => ({
  briefing,
  proposals: [proposal],
  question: null,
  memoryOps,
  focus: null,
  raceLine: null,
});

function reply() {
  switch (scenario) {
    // 1 · No strength history at all, and a lift every single day. Before
    //     this branch the ramp guard `continue`d on a zero trailing average
    //     and said nothing whatsoever.
    case "cold-start":
      return wrap(
        "Here's the daily lift block you asked for.",
        {
          title: "GUARD-cold-start",
          evidence: "0 strength sessions in 90d",
          rationale: "Daily legs for ten days.",
          expiresAt: D.d1,
          flags: [],
          ops: [D.d1, D.d3, D.d5].map((date) => ({
            kind: "add",
            date,
            session: lift("Leg day", 50, SKI),
          })),
        },
      );

    // 2 · Every remaining day of the week filled — the live reply had zero
    //     rest days across nine days and nothing objected.
    case "no-rest-day":
      return wrap(
        "Filling in the rest of the week.",
        {
          title: "GUARD-no-rest",
          evidence: "wants to train every day",
          rationale: "Something every day.",
          expiresAt: D.d1,
          flags: [],
          ops: D.restOfWeek.map((date) => ({ kind: "add", date, session: easyRun(30) })),
        },
      );

    // 3 · The heaviest unaccustomed leg session two days before the trip it
    //     is preparing them for. The memory note carrying the date is
    //     written by the FIRST wake below, so this proves the round trip:
    //     the coach records the event, the guardrail reads it back.
    case "trip-record":
      return wrap(
        "Noted — I'll plan around it.",
        {
          title: "GUARD-trip-warmup",
          evidence: "ski trip recorded",
          rationale: "One early session, well clear of the trip.",
          expiresAt: D.d1,
          flags: [],
          ops: [{ kind: "add", date: D.d1, session: lift("Ski legs — first bout", 40, SKI) }],
        },
        [{ op: "add", kind: "note", text: `Ski trip ${D.trip} to ${D.tripEnd}.`, expiresAt: D.tripEnd }],
      );
    case "trip-violate":
      return wrap(
        "One last sharpener before you go.",
        {
          title: "GUARD-trip-eve",
          evidence: "ski trip in 2 days",
          rationale: "A final heavy leg session the day before you fly.",
          expiresAt: D.tripEve,
          flags: [],
          ops: [{ kind: "add", date: D.tripEve, session: lift("Ski legs — last sharpener", 45, SKI) }],
        },
      );

    // 4 · Two same-category rows on one day: the op names the SECOND, and
    //     the guardrail must reason about the calendar that actually
    //     results rather than about whichever row came first. The setup
    //     move is how the collision arises in real life.
    case "double-setup":
      return wrap(
        "Moving Thursday's session onto Tuesday.",
        {
          title: "GUARD-double-setup",
          evidence: "you asked to double up on Tuesday",
          rationale: "Same week, same work, one fewer day out.",
          expiresAt: D.setupExpiry,
          flags: [],
          ops: [{ kind: "move", workoutId: D.moveId, toDate: D.collisionDate }],
        },
      );
    case "double":
      return wrap(
        "Easing the second of Tuesday's two runs.",
        {
          title: "GUARD-double",
          evidence: "two runs on one day",
          rationale: "The long one becomes an easy 20.",
          expiresAt: D.setupExpiry,
          flags: [],
          ops: [{ kind: "ease", workoutId: D.secondRowId, session: easyRun(300) }],
        },
      );
    default:
      return { briefing: null, proposals: [], question: null, memoryOps: [], focus: null, raceLine: null };
  }
}

/** Restraint — what an "open" wake gets, so page visits don't re-propose. */
const RESTRAINT = { briefing: null, proposals: [], question: null, memoryOps: [], focus: null, raceLine: null };

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/scenario") {
      const cfg = JSON.parse(body);
      scenario = cfg.scenario;
      D = cfg.dates ?? {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, scenario }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const asked = body.includes("The athlete just said");
    const content = JSON.stringify(asked ? reply() : RESTRAINT);
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
server.listen(8898, "127.0.0.1", () => console.log("guardrail model stub on 8898"));
