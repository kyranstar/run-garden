/**
 * HOW OFTEN DOES A PLAUSIBLE PLAN SURVIVE THE PIPELINE?
 *
 * This is a measurement instrument, not a pass/fail suite. It runs a large,
 * seeded population of plans a competent coach would actually write through the
 * four deterministic stages between the model and the athlete —
 *
 *     wakeOutputSchema → resolveOpsExercises → validateOps → applyOps
 *
 * — and prints a survival rate, a ranked table of what killed the rest, the
 * refusals that look wrong, and the failures nobody is told about.
 *
 *   pnpm vitest run packages/domain/test/coach-plan-survival.test.ts
 *
 * Re-run after any change to the schema or the guardrails and compare the two
 * printed rates; `SURVIVAL_SEED` and `SURVIVAL_N` override the defaults, and the
 * seed is printed with every report so a run can be reproduced exactly.
 *
 * WHY GENERATED AND NOT A HAND-BUILT MATRIX: the space is 8 athlete states × 15
 * intents × the dialect a model writes in, and the interesting failures live in
 * the interaction (a 25-minute lift is only "hard" for a detrained athlete; a
 * ramp cap only bites when the ops add to a discipline). A hand matrix big
 * enough to cover that is unmaintainable and biased toward what its author
 * already suspected. A seeded generator gets the coverage and reproduces
 * exactly. The named probes below cover the specific neighbours that generation
 * would only reach by luck.
 */
import { describe, expect, it } from "vitest";
import { addDays } from "../src/time.js";
import {
  addOpDates,
  formatExercise,
  sessionExercises,
  sessionSport,
  strippedPaths,
  wakeOutputSchema,
  type CoachOp,
} from "../src/coach.js";
import { GUARDRAIL_LIMITS, HARD_LIMITS_PROMPT, validateOps, type GuardrailCtx } from "../src/coach-guardrails.js";
import { schema } from "../../database/src/index.js";
import { D1_BIND_LIMIT, makeTestDb, makeTestUser } from "../../../apps/worker/test/helpers.js";
import { applyOps } from "../../../apps/worker/src/services/coach-apply.js";
import { buildExerciseIndex, resolveExerciseOriginId } from "../../../apps/worker/src/services/exercise-catalog.js";
import { guardrailCtx } from "../../../apps/worker/src/services/coach-wake.js";
import {
  athletes,
  nextMonday,
  today as harnessToday,
  TZ,
  type AthleteState,
} from "./coach-survival/athletes.js";
import { englishName, liveExerciseCatalog } from "./coach-survival/catalog.js";
import { INTENTS, REGISTER_B, rngFor, wakeEnvelope, mobilitySession, runSession } from "./coach-survival/plans.js";
import { dossierHandles, runSample, seedAthlete, type SampleResult } from "./coach-survival/pipeline.js";

const SEED = Number(process.env.SURVIVAL_SEED ?? 20260817);
const N = Number(process.env.SURVIVAL_N ?? 800);
/** Share of plans written in register B — one model-natural variation on an
 * otherwise clean plan. Stated, not hidden, so the blended rate can be
 * reweighted; the report gives A and B separately either way. */
const REGISTER_B_RATE = Number(process.env.SURVIVAL_B_RATE ?? 0.34);
const INDEX = buildExerciseIndex(liveExerciseCatalog());

const pct = (a: number, b: number): string => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
const pad = (s: string, w: number): string => (s.length >= w ? s : s + " ".repeat(w - s.length));

/** A plan, in one line, so a refusal can be quoted. */
function describePlan(ops: CoachOp[]): string {
  return ops
    .map((op) => {
      switch (op.kind) {
        case "add": {
          const dates = addOpDates(op);
          const body = op.session.lift ? "lift" : op.session.mobility ? "mobility" : "run";
          return `add ${body} ${op.session.durationMinutes}min ×${dates.length} (${dates[0]}${dates.length > 1 ? `…${dates.at(-1)}` : ""})`;
        }
        case "ease":
          return `ease ${op.workoutId} → ${op.session.category} ${op.session.durationMinutes}min`;
        case "skip":
          return `skip ${op.workoutId}`;
        case "move":
          return `move ${op.workoutId} → ${op.toDate}`;
        case "swap":
          return `swap ${op.dayA}/${op.dayB}`;
        case "reshapeWeek":
        case "firmUp":
        case "windDown":
          return `${op.kind} ${"weekStart" in op ? op.weekStart : ""} ×${op.sessions.length}`;
        case "createPlan":
          return `createPlan ${op.name} ×${op.firmSessions.length}`;
        case "extendPlan":
          return `extendPlan ×${op.shapeWeeks.length}`;
        default:
          return op.kind;
      }
    })
    .join(" · ");
}

interface Sample extends SampleResult {
  plan: string;
}

/* ==================================================================== *
 * The instrument, checked before its output is believed. A measurement
 * that cannot report a failure and cannot reproduce itself is a
 * decoration.
 * ==================================================================== */

describe("the instrument itself", () => {
  it("reports an apply that does nothing, and says whether anyone was told", async () => {
    // retirePlan against a plan id the guardrail context trusts but
    // `coach_plans` does not hold: no throw, no violation, no effect. If the
    // apply verifier cannot catch this, an `apply 0` in the report means
    // nothing.
    //
    // Since 2026-08-17 the apply DISCLOSES it (`ApplyResult.missed` → the
    // receipt), so this case proves two things at once: the verifier still
    // catches an apply that did nothing, and the silent column below is empty
    // because the class was fixed rather than because the instrument is blind.
    const s = athletes().find((x) => x.key === "build-coached")!;
    const ghost: AthleteState = { ...s, ctx: { ...s.ctx, coachPlanIds: [...s.ctx.coachPlanIds, "cp-ghost"] } };
    const env = wakeEnvelope(rngFor(99), [{ kind: "retirePlan", planId: "cp-ghost" }], addDays(TODAY, 1));
    const r = await runSample(ghost, "instrument-check", env, { index: INDEX });
    expect(r.survived).toBe(false);
    expect(r.failedAt).toBe("apply");
    expect(r.causes).toEqual(["apply:retirePlan: no such plan, nothing retired"]);
    expect(r.disclosed).toEqual(["the plan it retires isn't there any more, so nothing was retired"]);
    expect(r.silent).toEqual([]);
  });

  it("reproduces exactly from its seed", async () => {
    const run = async (): Promise<string> => {
      const states = athletes();
      const rng = rngFor(777);
      const out: string[] = [];
      for (let i = 0; i < 24; i++) {
        const s = states[i % states.length]!;
        const usable = INTENTS.filter((x) => x.applies(s));
        const intent = usable[Math.floor(rng() * usable.length)]!;
        const ops = intent.ops(rng, s);
        const env = wakeEnvelope(rng, ops, addDays(TODAY, 2));
        const r = await runSample(s, intent.key, env, { index: INDEX });
        out.push(`${s.key}/${intent.key}/${r.survived}/${r.causes.join(",")}/${r.advisories.map((a) => a.rule).join(",")}`);
      }
      return out.join("\n");
    };
    expect(await run()).toBe(await run());
  });
});

describe("coach plan survival rate", () => {
  it(`runs ${N} generated plans end to end and reports`, { timeout: 600_000 }, async () => {
    const states = athletes();
    const rng = rngFor(SEED);
    const results: Sample[] = [];
    const started = Date.now();

    // The real dossier, once per athlete state, scraped for the `[wo:...]`
    // handles it offers. Register B's "ease a completed session" takes its
    // target from the LEAKED ones — handles the dossier prints beside sessions
    // `validateOps` refuses — so the generator can only make the mistake the
    // context still invites. See `dossierHandles`.
    const leaks = new Map<string, string[]>();
    for (const s of states) leaks.set(s.key, (await dossierHandles(s)).leaked);

    for (let i = 0; i < N; i++) {
      const s = states[i % states.length]!;
      const usable = INTENTS.filter((x) => x.applies(s));
      const intent = usable[Math.floor(rng() * usable.length)]!;
      const ops = intent.ops(rng, s);
      if (ops.length === 0) continue;
      const envelope = wakeEnvelope(rng, ops, addDays(TODAY, 2)) as Record<string, unknown>;
      // Register B: exactly one model-natural variation, or none.
      let register: "A" | "B" = "A";
      let variation = "";
      if (rng() < REGISTER_B_RATE) {
        const v = REGISTER_B[Math.floor(rng() * REGISTER_B.length)]!;
        const vctx = {
          leakedIds: leaks.get(s.key) ?? [],
          ...(s.importedPlanIds[0] ? { importedPlanId: s.importedPlanIds[0] } : {}),
          weekStart: s.A,
          // The date this sample will be JUDGED against, not a fresh read of
          // the clock: `s.ctx.today` is what `validateOps` holds, so a
          // variation that writes "today" writes the same today.
          today: s.ctx.today,
        };
        if (v.apply(rng, ops, envelope, vctx)) {
          register = "B";
          variation = v.key;
        }
      }
      const r = await runSample(s, intent.key, envelope, { index: INDEX, register, variation });
      // Re-parse purely so a refusal can be quoted in the athlete's terms.
      const reparsed = wakeOutputSchema.safeParse(envelope);
      results.push({
        ...r,
        plan: reparsed.success ? describePlan(reparsed.data.proposals[0]?.ops ?? []) : JSON.stringify(ops).slice(0, 200),
      });
    }

    /* ------------------------------------------------------------ report */
    const survived = results.filter((r) => r.survived).length;
    const survivedPreSplit = results.filter((r) => r.survived && !r.diedPreSplit).length;
    const byStage = new Map<string, number>();
    const byCause = new Map<string, { n: number; example: Sample }>();
    const byAdvisory = new Map<string, { n: number; example: Sample; detail: string }>();
    for (const r of results) {
      for (const a of r.advisories) {
        const cur = byAdvisory.get(a.rule);
        byAdvisory.set(a.rule, { n: (cur?.n ?? 0) + 1, example: cur?.example ?? r, detail: cur?.detail ?? a.detail });
      }
      if (r.survived) continue;
      byStage.set(r.failedAt!, (byStage.get(r.failedAt!) ?? 0) + 1);
      for (const c of r.causes) {
        const cur = byCause.get(c);
        byCause.set(c, { n: (cur?.n ?? 0) + 1, example: cur?.example ?? r });
      }
    }
    const rankedCauses = [...byCause.entries()].sort((a, b) => b[1].n - a[1].n);
    const rankedAdvisories = [...byAdvisory.entries()].sort((a, b) => b[1].n - a[1].n);

    const lines: string[] = [];
    const say = (s = ""): void => void lines.push(s);

    say("");
    say("═".repeat(96));
    say(`COACH PLAN SURVIVAL — seed ${SEED}, ${results.length} plans, ${((Date.now() - started) / 1000).toFixed(1)}s`);
    say(`catalog ${INDEX.ids.size} exercises · anchor Monday ${nextMonday()} · today ${TODAY}`);
    say(`register A obeys the three FATAL rules by construction (real handles, future dates, own plans) —`);
    say(`that is what "a competent coach reading the dossier" means. Register B breaks them the way a model does.`);
    say("═".repeat(96));
    say("");
    const inA = results.filter((r) => r.register === "A");
    const inB = results.filter((r) => r.register === "B");
    say(`  SURVIVAL RATE   ${pct(survived, results.length)}   (${survived}/${results.length} reach the athlete)`);
    say("");
    say(`    register A — the JSON dialect the schema documents:   ${pad(pct(inA.filter((r) => r.survived).length, inA.length), 8)} (${inA.filter((r) => r.survived).length}/${inA.length})`);
    say(`    register B — one model-natural variation on top:      ${pad(pct(inB.filter((r) => r.survived).length, inB.length), 8)} (${inB.filter((r) => r.survived).length}/${inB.length})`);
    say(`    the blend above assumes ${(REGISTER_B_RATE * 100).toFixed(0)}% of plans are written in register B. Reweight with SURVIVAL_B_RATE.`);
    say("");
    say(`  …before tonight's fatal/advisory split, the same ${results.length} plans would have been ${pct(survivedPreSplit, results.length)} (${survivedPreSplit}) —`);
    say(`     every advisory used to reject the whole proposal. The split is worth ${survived - survivedPreSplit} plans out of ${results.length}.`);
    say("");
    say(`  by stage:  parse ${byStage.get("parse") ?? 0} · resolve ${byStage.get("resolve") ?? 0} · guardrail(fatal) ${byStage.get("guardrail") ?? 0} · apply ${byStage.get("apply") ?? 0}`);
    say("");
    say("  RANKED FAILURE CAUSES — what actually stops a plan reaching the athlete");
    say(`  ${pad("cause", 88)} ${pad("count", 7)} share`);
    say(`  ${"-".repeat(104)}`);
    if (rankedCauses.length === 0) say("  (none)");
    for (const [cause, { n }] of rankedCauses) {
      say(`  ${pad(cause.slice(0, 87), 88)} ${pad(String(n), 7)} ${pct(n, results.length)}`);
    }
    say("");
    // The same failures rolled up by WHAT KIND of clause refused them — the
    // answer to "which clause is eating the most legitimate plans" is a family,
    // not a line number.
    const family = (cause: string): string => {
      if (cause.startsWith("fatal:")) return "guardrail (fatal)";
      if (cause.startsWith("apply:")) return "apply";
      if (cause.startsWith("resolve:")) return "exercise resolution";
      if (/Unrecognized key/.test(cause)) return "schema: .strict() — an extra key";
      if (/Invalid enum value/.test(cause)) return "schema: enum — a word not in the list";
      if (/at most \d+ element/.test(cause)) return "schema: array cap — the list is too long";
      if (/at least \d+ element/.test(cause)) return "schema: array floor — the list is empty";
      if (/Number must be/.test(cause)) return "schema: numeric range";
      if (/needs reps or holdSeconds/.test(cause)) return "schema: refine — reps or holdSeconds";
      return "schema: other";
    };
    const byFamily = new Map<string, number>();
    for (const r of results) {
      if (r.survived) continue;
      byFamily.set(family(r.causes[0]!), (byFamily.get(family(r.causes[0]!)) ?? 0) + 1);
    }
    say("  ROLLED UP BY CLAUSE FAMILY — the ranked answer, one level up");
    say(`  ${pad("family", 46)} ${pad("plans killed", 14)} share`);
    say(`  ${"-".repeat(80)}`);
    for (const [f, n] of [...byFamily.entries()].sort((a, b) => b[1] - a[1])) {
      say(`  ${pad(f, 46)} ${pad(String(n), 14)} ${pct(n, results.length)}`);
    }
    say("");
    // SILENT failures: the class that is worse than a rejection, because the
    // athlete taps approve and is told it worked.
    const silent = results.filter((r) => r.silent.length > 0);
    say("  SILENT FAILURES — approved, reported as applied, and nothing happened");
    if (silent.length === 0) {
      say(`  none in ${results.length} plans. Every apply either did what the op promised or threw.`);
      say(`  (The apply stage runs the real applyOps against real SQLite with D1's ${D1_BIND_LIMIT}-bound-variable`);
      say(`   ceiling installed, and the verifier is proved able to catch one — see "the instrument itself".`);
      say(`   The three silent classes that DID exist are now fatal rules; the probe matrix below has the rest.)`);
    }
    for (const r of silent.slice(0, 10)) say(`  ${pad(r.athlete, 16)} ${pad(r.intent, 20)} ${r.silent.join("; ")}`);
    say("");
    // The same failure, said out loud. An op that promised a mutation and
    // performed none still costs the plan, but since 2026-08-17 `applyOps`
    // reports it and the receipt carries it — so it belongs in a column of its
    // own rather than hidden inside "survived" or inside "silent".
    const disclosed = results.filter((r) => r.disclosed.length > 0);
    say(`  DISCLOSED SHORTFALLS — an op did nothing, and the receipt says so: ${disclosed.length} of ${results.length}`);
    for (const r of disclosed.slice(0, 6)) say(`  ${pad(r.athlete, 16)} ${pad(r.intent, 20)} ${r.disclosed.join("; ")}`);
    say("");
    say("  RANKED ADVISORIES — no longer fatal; each is a trade-off line on the card");
    say(`  ${pad("rule", 62)} ${pad("count", 7)} share of all plans`);
    say(`  ${"-".repeat(90)}`);
    for (const [rule, { n }] of rankedAdvisories) {
      say(`  ${pad(rule, 62)} ${pad(String(n), 7)} ${pct(n, results.length)}`);
    }
    say("");
    // WHAT THE DOSSIER STILL INVITES. A `[wo:...]` handle printed beside a
    // session `validateOps` refuses is a fatal proposal the context asked for,
    // and it is the reason `fatal:touch_resolved` was the top cause on
    // 2026-08-17. Printed as a count per athlete so a regression here shows up
    // as a number rather than as a variation that quietly starts firing again.
    const totalLeaks = [...leaks.values()].reduce((a, ids) => a + ids.length, 0);
    say(`  DOSSIER HANDLE LEAKS — [wo:...] ids the dossier offers that the guardrails would refuse: ${totalLeaks} across ${states.length} athletes`);
    if (totalLeaks === 0) {
      say(`  Every handle in the dossier names a session that can still be eased, moved or skipped, so the`);
      say(`  "ref: ease a completed session" variation below has nothing to copy and cannot fire. Finished work is`);
      say(`  still fully printed — it is the evidence for everything the coach says — it simply carries no handle.`);
    }
    for (const [key, ids] of leaks) if (ids.length) say(`  ${pad(key, 16)} ${ids.join(", ")}`);
    say("");
    say("  REGISTER B — each variation, and whether the plan survived writing it that way");
    say(`  ${pad("variation", 32)} ${pad("n", 5)} ${pad("survived", 10)} killed by`);
    say(`  ${"-".repeat(90)}`);
    for (const v of REGISTER_B) {
      const mine = results.filter((r) => r.variation === v.key);
      if (mine.length === 0) continue;
      const ok = mine.filter((r) => r.survived).length;
      const cause = [...new Set(mine.filter((r) => !r.survived).flatMap((r) => r.causes))][0] ?? "";
      say(`  ${pad(v.key, 32)} ${pad(String(mine.length), 5)} ${pad(pct(ok, mine.length), 10)} ${cause.slice(0, 44)}`);
    }
    say("");

    // Survival per athlete state and per intent — where a rate of 0% hides
    // inside a global 60%.
    say("  BY ATHLETE STATE");
    for (const s of states) {
      const mine = results.filter((r) => r.athlete === s.key);
      const ok = mine.filter((r) => r.survived).length;
      say(`  ${pad(s.key, 16)} ${pad(pct(ok, mine.length), 8)} (${ok}/${mine.length})  ${s.label}`);
    }
    say("");
    say("  BY INTENT");
    for (const intent of INTENTS) {
      const mine = results.filter((r) => r.intent === intent.key);
      if (mine.length === 0) continue;
      const ok = mine.filter((r) => r.survived).length;
      const top = [...new Map(mine.filter((r) => !r.survived).flatMap((r) => r.causes.map((c) => [c, c]))).keys()];
      say(`  ${pad(intent.key, 22)} ${pad(pct(ok, mine.length), 8)} (${ok}/${mine.length})  ${top.slice(0, 3).join(", ")}`);
    }
    say("");
    say("  WORKED EXAMPLES OF EACH CAUSE (the plan, then the refusal the athlete reads)");
    for (const [cause, { n, example }] of rankedCauses.slice(0, 12)) {
      say("");
      say(`  ▸ ${cause}  ×${n}`);
      say(`      athlete: ${example.athlete} · intent: ${example.intent}`);
      say(`      plan:    ${example.plan.slice(0, 300)}`);
      say(`      told:    ${example.detail.slice(0, 300)}`);
    }
    say("");
    say("  WORKED EXAMPLES OF EACH ADVISORY (what the athlete now reads above the approve button)");
    for (const [rule, { n, example, detail }] of rankedAdvisories.slice(0, 8)) {
      say("");
      say(`  ▸ ${rule}  ×${n}`);
      say(`      athlete: ${example.athlete} · intent: ${example.intent}`);
      say(`      plan:    ${example.plan.slice(0, 280)}`);
      say(`      told:    ${detail.slice(0, 300)}`);
    }
    say("");
    const exercises = results.reduce((a, r) => a + r.exercises, 0);
    const off = results.reduce((a, r) => a + r.offCatalog, 0);
    const offCounts = new Map<string, number>();
    for (const r of results) for (const nm of r.offCatalogNames) offCounts.set(nm, (offCounts.get(nm) ?? 0) + 1);
    say(`  EXERCISE RESOLUTION  ${exercises - off}/${exercises} matched the watch catalog (${pct(off, exercises)} off-catalog).`);
    say(`  Off-catalog is NOT a failure — the session persists and shows, it just cannot be written to the watch.`);
    say(`  Most-written movements the catalog has no row for:`);
    for (const [nm, c] of [...offCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
      say(`      ${pad(nm, 30)} ×${c}`);
    }
    say("═".repeat(96));
    console.log(lines.join("\n"));

    // The instrument itself is what is asserted: every sample got a verdict,
    // and the population is big and varied enough for the rate to mean
    // something. The RATE is reported, never asserted — a threshold here would
    // turn a measurement back into a pass/fail suite.
    expect(results.length).toBeGreaterThan(N * 0.9);
    expect(new Set(results.map((r) => r.intent)).size).toBeGreaterThanOrEqual(12);
    expect(new Set(results.map((r) => r.athlete)).size).toBe(states.length);
    expect(results.every((r) => r.survived || r.causes.length > 0)).toBe(true);
  });
});

/* ==================================================================== *
 * NAMED PLANS — hand-written, obviously reasonable, quotable. The
 * generator gives the rate; these give the sentences.
 * ==================================================================== */

describe("plans a good coach would write, one at a time", () => {
  it("runs each and prints the verdict", async () => {
    const states = athletes();
    const S = (k: string): AthleteState => states.find((x) => x.key === k)!;
    const rng = rngFor(4242);
    const named: Array<{ ask: string; state: AthleteState; ops: unknown[] }> = [
      {
        ask: `"Add two 30-minute leg sessions before the ski trip"`,
        state: S("ski-prep"),
        ops: [
          { kind: "add", date: addDays(S("ski-prep").A, 0), session: { category: "strength", title: "Ski legs A", durationMinutes: 30, lift: { exercises: [{ name: "Wall sit", sets: 3, holdSeconds: 45 }, { name: "Split squat", sets: 3, reps: 8, perSide: true, eccentricSeconds: 4 }, { name: "Single-leg calf raise", sets: 3, reps: 12, perSide: true }] } } },
          { kind: "add", date: addDays(S("ski-prep").A, 3), session: { category: "strength", title: "Ski legs B", durationMinutes: 30, lift: { exercises: [{ name: "Step up", sets: 3, reps: 10, perSide: true }, { name: "Copenhagen plank", sets: 3, holdSeconds: 30, perSide: true }, { name: "Skater bound", sets: 3, reps: 10, perSide: true }] } } },
        ],
      },
      {
        ask: `"Ten minutes of mobility every day for the next fortnight"`,
        state: S("build-coached"),
        ops: [
          {
            kind: "add",
            date: addDays(S("build-coached").A, 0),
            dates: Array.from({ length: 13 }, (_, i) => addDays(S("build-coached").A, i + 1)),
            session: { category: "yoga", title: "Daily mobility", durationMinutes: 10, mobility: { rounds: 2, exercises: [{ name: "90/90 hip switch", sets: 1, reps: 8, perSide: true }, { name: "Couch stretch", sets: 1, holdSeconds: 45, perSide: true }, { name: "Ankle dorsiflexion drill", sets: 1, reps: 10, perSide: true }] } },
          },
        ],
      },
      {
        ask: `"Same thing, but for three weeks"`,
        state: S("build-coached"),
        ops: [
          {
            kind: "add",
            date: addDays(S("build-coached").A, 0),
            dates: Array.from({ length: 20 }, (_, i) => addDays(S("build-coached").A, i + 1)),
            session: { category: "yoga", title: "Daily mobility", durationMinutes: 10, mobility: { exercises: [{ name: "Couch stretch", sets: 1, holdSeconds: 45, perSide: true }] } },
          },
        ],
      },
      {
        ask: `"Ease Tuesday's intervals, I slept badly"`,
        state: S("build-coached"),
        ops: [{ kind: "ease", workoutId: `[wo:${S("build-coached").rows.find((r) => r.category === "quality")!.id}]`, session: { category: "easy", title: "Easy 40", durationMinutes: 40, run: { blocks: [{ kind: "duration", value: 40, intensity: "easy" }] } } }],
      },
      {
        ask: `"Give me 12×400m on Thursday"`,
        state: S("build-coached"),
        ops: [
          {
            kind: "add",
            date: addDays(S("build-coached").A, 3),
            session: {
              category: "quality",
              title: "12×400m",
              durationMinutes: 55,
              run: {
                blocks: [
                  { kind: "duration", value: 15, intensity: "easy" },
                  ...Array.from({ length: 24 }, (_, i) => ({ kind: "duration", value: i % 2 === 0 ? 2 : 1, intensity: i % 2 === 0 ? "interval" : "easy" })),
                  { kind: "duration", value: 10, intensity: "easy" },
                ],
              },
            },
          },
        ],
      },
      {
        ask: `"Put a mobility day in on Sunday" (written as category "mobility")`,
        state: S("lifter"),
        ops: [{ kind: "add", date: addDays(S("lifter").A, 6), session: { category: "mobility", title: "Sunday reset", durationMinutes: 20, mobility: { exercises: [{ name: "Pigeon pose", sets: 1, holdSeconds: 60, perSide: true }] } } }],
      },
      {
        ask: `"A tempo run on Wednesday" (intensity written as "tempo")`,
        state: S("build-coached"),
        ops: [{ kind: "add", date: addDays(S("build-coached").A, 2), session: { category: "quality", title: "Tempo 20", durationMinutes: 45, run: { blocks: [{ kind: "duration", value: 15, intensity: "easy" }, { kind: "duration", value: 20, intensity: "tempo" }, { kind: "duration", value: 10, intensity: "easy" }] } } }],
      },
      {
        ask: `"Strength on Friday — we'll choose the movements on the day"`,
        state: S("lifter"),
        ops: [{ kind: "add", date: addDays(S("lifter").A, 4), session: { category: "strength", title: "Lower body, athlete's choice", durationMinutes: 40, lift: { exercises: [] } } }],
      },
      {
        ask: `"Take Sunday completely off"`,
        state: S("seven-day"),
        ops: [{ kind: "add", date: addDays(S("seven-day").A, 6), session: { category: "rest", title: "Full rest", durationMinutes: 0 } }],
      },
      {
        ask: `"Three ramping sets of squats, stop when it gets heavy"`,
        state: S("lifter"),
        ops: [{ kind: "add", date: addDays(S("lifter").A, 2), session: { category: "strength", title: "Squat wave", durationMinutes: 40, lift: { exercises: [{ name: "Back squat", sets: 3, note: "ramp to a hard triple" }] } } }],
      },
      {
        ask: `"Restructure next week" (the athlete's only plan came off the watch)`,
        state: S("build-imported"),
        ops: [
          {
            kind: "reshapeWeek",
            planId: "imported-2",
            weekStart: addDays(S("build-imported").A, 7),
            sessions: [1, 3, 5].map((day) => ({ date: addDays(S("build-imported").A, 7 + day), session: { category: day === 5 ? "long" : "easy", title: "Run", durationMinutes: day === 5 ? 75 : 40, run: { blocks: [{ kind: "duration", value: day === 5 ? 75 : 40, intensity: "easy" }] } } })),
          },
        ],
      },
      {
        ask: `"Eight-to-twelve reps of everything, heavy"`,
        state: S("lifter"),
        ops: [{ kind: "add", date: addDays(S("lifter").A, 2), session: { category: "strength", title: "Hypertrophy day", durationMinutes: 45, lift: { exercises: [{ name: "Goblet squat", sets: 4, reps: "8-12", weight: "heavy" }, { name: "Romanian deadlift", sets: 4, reps: "8-12", weight: "heavy" }] } } }],
      },
    ];

    const lines = ["", "─".repeat(104), "NAMED PLANS — a good coach's request, and what the pipeline does with it", "─".repeat(104)];
    let refused = 0;
    for (const c of named) {
      const env = wakeEnvelope(rng, c.ops, addDays(TODAY, 2));
      const r = await runSample(c.state, "named", env, { index: INDEX });
      if (!r.survived) refused++;
      lines.push("");
      lines.push(`  ${r.survived ? "✓ reaches the athlete" : "✗ REFUSED"}  ${c.ask}`);
      lines.push(`      athlete: ${c.state.key}`);
      if (!r.survived) lines.push(`      killed at ${r.failedAt}: ${r.causes.join(" · ").slice(0, 220)}`);
      if (r.advisories.length) lines.push(`      trade-offs shown: ${r.advisories.map((a) => a.rule).join(", ")}`);
      if (r.offCatalog > 0) lines.push(`      off-catalog (app-only, never reaches the watch): ${r.offCatalogNames.join(", ")}`);
    }
    lines.push("");
    lines.push(`  ${named.length - refused}/${named.length} of these reach the athlete.`);
    lines.push("─".repeat(104));
    console.log(lines.join("\n"));
    expect(named.length).toBeGreaterThan(10);
  });
});

/* ==================================================================== *
 * PROBES — the neighbours generation only reaches by luck, plus the five
 * failures fixed tonight. Each records how the pipeline behaves, and the
 * ones that are supposed to be REFUSED are checked for being refused
 * LOUDLY (a violation with a reason) rather than silently.
 * ==================================================================== */

const A = nextMonday();
/** The harness's single read of the clock, borrowed from the fixtures so the
 * report, the probes and every athlete's `ctx.today` cannot disagree about the
 * day (see the note on `today()` in coach-survival/athletes.ts). */
const TODAY = harnessToday();

function skiCtx(over: Partial<GuardrailCtx> = {}): GuardrailCtx {
  const base = athletes().find((x) => x.key === "ski-prep")!;
  return { ...base.ctx, ...over };
}

function parseOps(ops: unknown[]): { ok: boolean; ops: CoachOp[]; issue: string } {
  const parsed = wakeOutputSchema.safeParse({
    briefing: "b",
    proposals: [{ title: "t", evidence: "e", rationale: "r", expiresAt: TODAY, flags: [], ops }],
    question: null,
    memoryOps: [],
  });
  if (parsed.success) return { ok: true, ops: parsed.data.proposals[0]!.ops, issue: "" };
  const i = parsed.error.issues[0]!;
  return { ok: false, ops: [], issue: `${i.path.join(".") || "(root)"}: ${i.message}` };
}

interface ProbeRow {
  name: string;
  verdict: string;
  note: string;
}
const probeRows: ProbeRow[] = [];
const record = (name: string, verdict: string, note: string): void => void probeRows.push({ name, verdict, note });

describe("probes: the neighbours", () => {
  it("an op referencing a workout that does not exist", async () => {
    const s = athletes().find((x) => x.key === "ski-prep")!;
    const { ok, ops } = parseOps([
      { kind: "ease", workoutId: "wo-does-not-exist", session: runSession(rngFor(1), "easy", 30) },
      { kind: "skip", workoutId: "also-not-real", reason: "travelling" },
    ]);
    expect(ok).toBe(true);
    const { fatal } = validateOps(ops, s.ctx);
    // What apply WOULD do if this ever slipped past — the reason the rule has
    // to be fatal rather than advisory.
    const h = await seedAthlete(s);
    const out = await applyOps(h.db, h.userId, h.prefs, "probe-ghost", ops);
    const changed = (await h.db.select().from(schema.plannedWorkouts)).filter((r) => r.completionState === "skipped").length;
    record(
      "op targets a workout id that does not exist",
      fatal.length ? "REFUSED (fatal)" : "ACCEPTED",
      `${fatal.map((x) => x.rule).join(", ")}; unguarded, apply reports updated=[${out.updated.join(", ")}] and changes ${changed} rows`,
    );
    expect(fatal.map((x) => x.rule)).toEqual(["unknown_workout", "unknown_workout"]);
    expect(out.updated).toEqual(["wo-does-not-exist", "also-not-real"]);
    expect(changed).toBe(0);
  });

  it("an add on a date in the past", async () => {
    const s = athletes().find((x) => x.key === "ski-prep")!;
    const past = addDays(TODAY, -3);
    const { ok, ops } = parseOps([{ kind: "add", date: past, session: mobilitySession(rngFor(2), 10) }]);
    expect(ok).toBe(true);
    const { fatal } = validateOps(ops, s.ctx);
    const h = await seedAthlete(s);
    await applyOps(h.db, h.userId, h.prefs, "probe-past-add", ops);
    const landed = (await h.db.select().from(schema.plannedWorkouts)).filter((r) => r.effectiveDate === past).length;
    record(
      "add on a date already in the past",
      fatal.length ? "REFUSED (fatal)" : "ACCEPTED",
      `${fatal.map((x) => x.rule).join(", ") || "nothing"}; unguarded, apply writes ${landed} session(s) into the past`,
    );
    expect(fatal.map((x) => x.rule)).toEqual(["past_date"]);
    expect(landed).toBe(1);
  });

  it("a move onto a date in the past", () => {
    const s = athletes().find((x) => x.key === "ski-prep")!;
    const row = s.rows[0]!;
    const { ops } = parseOps([{ kind: "move", workoutId: row.id, toDate: addDays(TODAY, -2) }]);
    const { fatal } = validateOps(ops, s.ctx);
    record("move a session onto a past date", fatal.length ? "REFUSED (fatal)" : "ACCEPTED", fatal.map((x) => x.rule).join(", ") || "no rule reads the destination date");
    expect(fatal.map((x) => x.rule)).toEqual(["past_date"]);
  });

  it("a swap of two days that have already gone", () => {
    const s = athletes().find((x) => x.key === "ski-prep")!;
    const { ops } = parseOps([{ kind: "swap", dayA: addDays(TODAY, -3), dayB: addDays(TODAY, -1) }]);
    const { fatal } = validateOps(ops, s.ctx);
    record("swap two days already in the past", fatal.length ? "REFUSED (fatal)" : "ACCEPTED", fatal.map((x) => x.rule).join(", ") || "unguarded");
    expect(fatal.map((x) => x.rule)).toEqual(["past_date"]);
  });

  it("an empty dates array on an add", () => {
    const day = addDays(A, 1);
    const r = parseOps([{ kind: "add", date: day, dates: [], session: mobilitySession(rngFor(3), 10) }]);
    expect(r.ok).toBe(true);
    const dates = addOpDates(r.ops[0] as Extract<CoachOp, { kind: "add" }>);
    record("add with `dates: []` (means the same as omitting it)", "accepted", `reads as ${dates.length} session on ${dates[0]}`);
    expect(dates).toEqual([day]);
  });

  it("duplicate dates on an add", () => {
    const day = addDays(A, 1);
    const r = parseOps([{ kind: "add", date: day, dates: [day, day, addDays(A, 2)], session: mobilitySession(rngFor(4), 10) }]);
    expect(r.ok).toBe(true);
    const dates = addOpDates(r.ops[0] as Extract<CoachOp, { kind: "add" }>);
    record("add with duplicate dates", "accepted", `de-duplicated to ${dates.length} sessions`);
    expect(dates).toEqual([day, addDays(A, 2)]);
  });

  it("a multi-date add spanning a month boundary and a DST change", () => {
    // Anchored to real dates, not to the fixture: 2026-11-01 is the US
    // fall-back, and Oct→Nov is a month boundary in the same span.
    const start = "2026-10-28";
    const dates = Array.from({ length: 8 }, (_, i) => addDays(start, i + 1));
    const r = parseOps([{ kind: "add", date: start, dates, session: mobilitySession(rngFor(5), 10) }]);
    expect(r.ok).toBe(true);
    const all = addOpDates(r.ops[0] as Extract<CoachOp, { kind: "add" }>);
    const ctx = skiCtx({
      today: "2026-10-27",
      workouts: [],
      firmHorizonEnd: "2026-12-01",
      datedEvents: [],
      raceDates: [],
      weeklyMinutesByDiscipline: { run: [200, 200, 200, 200], yoga: [60, 60, 60, 60] },
    });
    const { fatal } = validateOps(r.ops, ctx);
    record(
      "9-day add across the month boundary and the DST fall-back",
      fatal.length === 0 ? "accepted" : "REFUSED",
      `dates ${all[0]}…${all.at(-1)} (${all.length} distinct, no repeats, no skips)${fatal.length ? ` — ${fatal[0]!.rule}` : ""}`,
    );
    expect(all).toEqual(["2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]);
    expect(fatal).toEqual([]);
  });

  it("a session with an empty exercise list", () => {
    const r = parseOps([
      { kind: "add", date: addDays(A, 1), session: { category: "strength", title: "Legs — details to follow", durationMinutes: 30, lift: { exercises: [] } } },
    ]);
    expect(r.ok).toBe(true);
    const empty = (r.ops[0] as Extract<CoachOp, { kind: "add" }>).session;
    record(
      "strength session with `lift: { exercises: [] }`",
      "accepted",
      `files as ${sessionSport(empty)} — the duration is the prescription`,
    );

    // …and the same session with no body at all agrees with it, which is the
    // whole point: two spellings of one intention cannot have opposite fates.
    const bodyless = parseOps([
      { kind: "add", date: addDays(A, 1), session: { category: "strength", title: "Legs — details to follow", durationMinutes: 30 } },
    ]);
    expect(bodyless.ok).toBe(true);
    const none = (bodyless.ops[0] as Extract<CoachOp, { kind: "add" }>).session;
    record("the same session with the `lift` key omitted entirely", "accepted", `also files as ${sessionSport(none)}`);
    expect(sessionSport(empty)).toBe(sessionSport(none));
  });

  it("a circuit with rounds: 1", () => {
    const r = parseOps([
      { kind: "add", date: addDays(A, 1), session: { category: "strength", title: "Circuit", durationMinutes: 20, lift: { rounds: 1, exercises: [{ name: "Wall sit", sets: 1, holdSeconds: 45 }] } } },
    ]);
    record("circuit with `rounds: 1`", r.ok ? "accepted" : "REFUSED", r.issue || "parses; formats as a 1-round circuit");
    expect(r.ok).toBe(true);
  });

  it("fifteen ops landing on one day", async () => {
    const s = athletes().find((x) => x.key === "offseason")!;
    const day = addDays(A, 2);
    const ops = Array.from({ length: 15 }, () => ({ kind: "add", date: day, session: mobilitySession(rngFor(6), 8) }));
    const r = parseOps(ops);
    expect(r.ok).toBe(true);
    const { fatal, advisory } = validateOps(r.ops, s.ctx);
    const h = await seedAthlete(s);
    await applyOps(h.db, h.userId, h.prefs, "probe-15", r.ops);
    const rows = await h.db.select().from(schema.plannedWorkouts);
    record(
      "fifteen separate 8-minute adds on the same day (2h of mobility)",
      fatal.length === 0 ? "ACCEPTED" : "refused",
      `${rows.filter((x) => x.effectiveDate === day).length} rows written on ${day}; fatal ${fatal.length}, advisory ${advisory.length}`,
    );
    expect(rows.filter((x) => x.effectiveDate === day).length).toBe(15);
  });

  it("an ease that targets an already-eased session", async () => {
    const s = athletes().find((x) => x.key === "build-coached")!;
    const row = s.rows.find((x) => x.category === "quality")!;
    const eased = { kind: "ease", workoutId: row.id, session: runSession(rngFor(7), "easy", 30) };
    const r = parseOps([eased]);
    const h = await seedAthlete(s);
    await applyOps(h.db, h.userId, h.prefs, "probe-ease-1", r.ops);
    const mid = (await h.db.select().from(schema.plannedWorkouts)).find((x) => x.id === row.id)!;
    // Second ease of the same row, now already easy — the ctx the guardrails
    // hold is the PRE-ease one, which is the real second-wake situation.
    const r2 = parseOps([{ kind: "ease", workoutId: row.id, session: runSession(rngFor(8), "easy", 30) }]);
    const { fatal } = validateOps(r2.ops, s.ctx);
    await applyOps(h.db, h.userId, h.prefs, "probe-ease-2", r2.ops);
    const after = (await h.db.select().from(schema.plannedWorkouts)).find((x) => x.id === row.id)!;
    record(
      "ease a session that is already eased",
      fatal.length === 0 ? "accepted" : "refused",
      `category ${mid.category} → ${after.category}; idempotent rewrite, no duplicate row`,
    );
    expect(after.category).toBe("easy");
  });

  it("an add one day past the firm horizon", () => {
    const s = athletes().find((x) => x.key === "ski-prep")!;
    const r = parseOps([{ kind: "add", date: addDays(s.ctx.firmHorizonEnd, 1), session: mobilitySession(rngFor(9), 10) }]);
    const { fatal, advisory } = validateOps(r.ops, s.ctx);
    record(
      "add one day past the firm horizon",
      fatal.length ? "REFUSED (fatal)" : "accepted + disclosed",
      advisory.map((x) => x.rule).join(", ") || "nothing said",
    );
    expect(fatal).toEqual([]);
    expect(advisory.map((x) => x.rule)).toContain("beyond_horizon");
  });

  it("an athlete with a blank calendar, where firmHorizonEnd is today", () => {
    const s = athletes().find((x) => x.key === "offseason")!;
    const ctx = { ...s.ctx, workouts: [], firmHorizonEnd: TODAY };
    const r = parseOps([{ kind: "add", date: addDays(TODAY, 3), session: runSession(rngFor(12), "easy", 30) }]);
    const { fatal, advisory } = validateOps(r.ops, ctx);
    record(
      "add for an athlete whose firmHorizonEnd == today (empty calendar)",
      fatal.length ? "REFUSED" : "accepted",
      advisory.length ? advisory.map((x) => x.rule).join(", ") : "no horizon noise",
    );
    expect(fatal).toEqual([]);
    expect(advisory.map((x) => x.rule)).not.toContain("beyond_horizon");
  });

  it("a structural op on an imported COROS plan", () => {
    const s = athletes().find((x) => x.key === "build-imported")!;
    const r = parseOps([{ kind: "reshapeWeek", planId: "imported-2", weekStart: addDays(A, 7), sessions: [] }]);
    const { fatal } = validateOps(r.ops, s.ctx);
    record("reshapeWeek on an imported plan", fatal.length ? "REFUSED (fatal)" : "ACCEPTED", fatal[0]?.detail ?? "");
    expect(fatal.map((x) => x.rule)).toContain("imported_plan_structure");
  });

  it("a skip aimed at race day", () => {
    const s = athletes().find((x) => x.key === "race-soon")!;
    const race = s.rows.find((x) => x.category === "race")!;
    const r = parseOps([{ kind: "skip", workoutId: race.id, reason: "not running it after all" }]);
    const { fatal, advisory } = validateOps(r.ops, s.ctx);
    record(
      "skip the athlete's race day",
      fatal.length ? "REFUSED (fatal)" : "accepted + disclosed",
      advisory.map((x) => x.detail).join("; ") || "nothing said",
    );
    expect(fatal).toEqual([]);
    expect(advisory.map((x) => x.rule)).toContain("never_skip_race");
  });

  it("a plausible but unknown key on a session", () => {
    const raw = [
      { kind: "add", date: addDays(A, 1), session: { category: "strength", title: "Legs", durationMinutes: 30, notes: "keep it snappy", lift: { exercises: [{ name: "Wall sit", sets: 3, holdSeconds: 45 }] } } },
    ];
    const r = parseOps(raw);
    expect(r.ok).toBe(true);
    // Stripped, not silent: the path is reported so a key the coach keeps
    // reaching for reads as a schema gap in the logs.
    const lost = strippedPaths(raw[0], r.ops[0]);
    record("session carrying an extra `notes` key", "accepted (key stripped)", `reported as: ${lost.join(", ")}`);
    expect(lost).toEqual(["session.notes"]);
    expect((r.ops[0] as unknown as { session: Record<string, unknown> }).session.notes).toBeUndefined();
  });

  it("an exercise with neither reps nor holdSeconds", () => {
    const r = parseOps([
      { kind: "add", date: addDays(A, 1), session: { category: "strength", title: "Legs", durationMinutes: 30, lift: { exercises: [{ name: "Back squat", sets: 3 }] } } },
    ]);
    expect(r.ok).toBe(true);
    const ex = sessionExercises((r.ops[0] as Extract<CoachOp, { kind: "add" }>).session)[0]!;
    record("exercise with sets but no reps and no hold", "accepted", `renders as “${formatExercise(ex)}”`);
    expect(formatExercise(ex)).toBe("Back squat 3 sets");
  });

  it("retirePlan against a plan id the guardrails trust but the table lacks", async () => {
    const s = athletes().find((x) => x.key === "build-coached")!;
    const ctx = { ...s.ctx, coachPlanIds: [...s.ctx.coachPlanIds, "cp-ghost"] };
    const r = parseOps([{ kind: "retirePlan", planId: "cp-ghost" }]);
    const { fatal } = validateOps(r.ops, ctx);
    const h = await seedAthlete(s);
    const out = await applyOps(h.db, h.userId, h.prefs, "probe-retire-ghost", r.ops);
    record(
      "retirePlan on a plan id with no coach_plans row",
      out.missed.length ? "does nothing, and SAYS so" : "ACCEPTED SILENTLY",
      `apply returned created=${out.created.length} updated=${out.updated.length} archived=${out.archived.length} · missed: ${out.missed.join("; ") || "(nothing reported)"}`,
    );
    // Still no guardrail violation, and rightly so — the guardrails read the
    // plan ids that existed at WAKE time and this row can go between the wake
    // and the tap. The honesty has to come out of the apply.
    expect(fatal).toEqual([]);
    expect(out.created).toEqual([]);
    expect(out.updated).toEqual([]);
    expect(out.archived).toEqual([]);
    expect(out.missed).toEqual(["the plan it retires isn't there any more, so nothing was retired"]);
  });

  it("a two-word movement name against a three-word catalog entry", () => {
    // The near-miss class, fixed 2026-08-17. Jaccard at MIN_OVERLAP 0.7 scored
    // "cat cow" against "cat cow stretch" at 2/3 = 0.667 and lost the match:
    // ONE extra word on the catalog's side was enough. Now a generic trailing
    // word ("stretch", "pose", "hold") folds away on both sides, and full
    // containment of a ≥2-word name with at most one extra word counts as a
    // match when it is the unique best.
    const cat = liveExerciseCatalog();
    const idx = buildExerciseIndex(cat);
    const hit = resolveExerciseOriginId("Cat cow", idx);
    const catalogHas = [...cat.values()].some((code) => englishName(code) === "Cat-Cow Stretch");
    record(
      "coach writes “Cat cow”, catalog holds “Cat-Cow Stretch”",
      hit ? "matched" : "OFF-CATALOG",
      `catalog contains it: ${catalogHas}; resolves to ${hit ? englishName(cat.get(hit)!) : "nothing"}`,
    );
    expect(catalogHas).toBe(true);
    expect(hit).not.toBeNull();
    expect(englishName(cat.get(hit!)!)).toBe("Cat-Cow Stretch");
    // …and the guesses it must still refuse against this same live catalog:
    // one word cannot claim a family it does not name exactly ("Lunge" has no
    // plain row, only lunge variants), and an ambiguous two-word name where
    // two entries could equally claim it stays off-catalog.
    expect(resolveExerciseOriginId("Lunge", idx)).toBeNull();
    expect(resolveExerciseOriginId("Hamstring curl", idx)).toBeNull();
    expect(resolveExerciseOriginId("Suspended squat", idx)).toBeNull();
  });

  it("a swap of two days where only one carries a session", async () => {
    const s = athletes().find((x) => x.key === "offseason")!;
    const withWork = s.rows[0]!;
    const empty = addDays(withWork.date, 1);
    const r = parseOps([{ kind: "swap", dayA: withWork.date, dayB: empty }]);
    const { fatal } = validateOps(r.ops, s.ctx);
    const h = await seedAthlete(s);
    const out = await applyOps(h.db, h.userId, h.prefs, "probe-swap-half", r.ops);
    const moved = (await h.db.select().from(schema.plannedWorkouts)).find((x) => x.id === withWork.id)!;
    record(
      "swap a day that has work with a day that does not",
      fatal.length ? "refused" : "accepted",
      `the one session moved ${withWork.date} → ${moved.effectiveDate}; a swap with one side empty is a move`,
    );
    expect(moved.effectiveDate).toBe(empty);
    expect(out.updated).toEqual([withWork.id]);
  });
});

/* ==================================================================== *
 * The five failures fixed tonight, checked against inputs that are NOT
 * the ski-prep scenario they were fixed against.
 * ==================================================================== */

describe("tonight's five, against inputs they were not fixed for", () => {
  it("#1 the exercise schema demands nothing a coach cannot know", () => {
    // Every shape across the vocabulary, not just a wall sit: holds, per-side,
    // eccentric tempo, prose loads, quoted numbers, absent everything.
    const cases: Array<Record<string, unknown>> = [
      { name: "Wall sit", sets: 3, holdSeconds: 45 },
      { name: "Copenhagen plank", sets: 3, holdSeconds: "30s", perSide: true },
      { name: "Back squat", sets: 4, reps: "6", eccentricSeconds: 4, weight: "60kg" },
      { name: "Farmer's carry", sets: 3, holdSeconds: 60, weight: "45 lbs", restSeconds: null },
      { name: "Skier hops", sets: 3, holdSeconds: 30, weight: null, note: null },
      { name: "Nordic hamstring curl", sets: "3", reps: 5, eccentricSeconds: "5" },
      { name: "Step up", sets: 3, reps: 10, perSide: true, weight: { type: "bodyweight" } },
    ];
    for (const ex of cases) {
      const r = parseOps([
        { kind: "add", date: addDays(A, 1), session: { category: "strength", title: "x", durationMinutes: 30, lift: { exercises: [ex] } } },
      ]);
      expect(r.ok, `${String(ex.name)}: ${r.issue}`).toBe(true);
    }
    record("#1 exercise schema: 7 vocabulary shapes", "all parse", "no originId, weight or restSeconds required");
  });

  it("#2 the guardrail context never sees an archived row", async () => {
    const db = makeTestDb({ boundVariableCap: D1_BIND_LIMIT });
    const { userId, prefs } = await makeTestUser(db, { timezone: TZ });
    const now = new Date().toISOString();
    const day = addDays(TODAY, 2);
    for (const [id, archiveReason] of [["live", null], ["ghost-a", "absence_confirmed"], ["ghost-b", "duplicate_mirror"]] as const) {
      await db.insert(schema.plannedWorkouts).values({
        id,
        userId,
        planId: "p",
        sourceWorkoutId: `4738:${id}`,
        title: "t",
        category: id === "live" ? "easy" : "quality",
        sport: "run",
        originalPlanDate: day,
        lastVerifiedCorosDate: day,
        effectiveDate: day,
        effectiveTime: "07:00",
        completionState: "scheduled",
        sourceContentFingerprint: "fp",
        calendarBlockDurationSeconds: 3600,
        archivedAt: archiveReason ? now : null,
        archiveReason,
        createdAt: now,
        updatedAt: now,
      });
    }
    const ctx = await guardrailCtx(db, userId, prefs, TODAY);
    record("#2 archived rows in the guardrail calendar", ctx.workouts.length === 1 ? "clean" : "LEAKING", `${ctx.workouts.length} of 3 rows visible`);
    expect(ctx.workouts.map((w) => w.id)).toEqual(["live"]);
  });

  it("#3 D1 binds stay chunked past 90 workouts — on apply, not just on wake", async () => {
    const db = makeTestDb({ boundVariableCap: D1_BIND_LIMIT });
    const { userId, prefs } = await makeTestUser(db, { timezone: TZ });
    const now = new Date().toISOString();
    await db.insert(schema.coachPlans).values({
      id: "cp-big", userId, discipline: "run", name: "Big", status: "active",
      startDate: TODAY, endDate: addDays(TODAY, 200), stampPrefix: "Big", createdAt: now, updatedAt: now,
    });
    for (let i = 0; i < 260; i++) {
      const date = addDays(TODAY, 1 + (i % 180));
      await db.insert(schema.plannedWorkouts).values({
        id: `bw${i}`, userId, planId: "cp-big", sourceWorkoutId: `4738:bw${i}`, title: "t",
        category: "easy", sport: "run", originalPlanDate: date, lastVerifiedCorosDate: date,
        effectiveDate: date, effectiveTime: "07:00", completionState: "scheduled",
        sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 3600, createdAt: now, updatedAt: now,
      });
    }
    // reshapeWeek first (it archives one week in one statement), then
    // retirePlan (which archives every remaining future session at once).
    const monday = addDays(TODAY, -(((new Date(`${TODAY}T12:00:00Z`).getUTCDay() + 6) % 7)) + 7);
    const out2 = await applyOps(db, userId, prefs, "probe-bind-2", [
      { kind: "reshapeWeek", planId: "cp-big", weekStart: monday, sessions: [] } as CoachOp,
    ]);
    const out = await applyOps(db, userId, prefs, "probe-bind", [{ kind: "retirePlan", planId: "cp-big" }]);
    record(
      "#3 D1 bind cap at 260 workouts",
      "survived",
      `reshapeWeek archived ${out2.archived.length} in one week, retirePlan archived the remaining ${out.archived.length}`,
    );
    expect(out2.archived.length + out.archived.length).toBe(260);
    expect(out.archived.length).toBeGreaterThan(D1_BIND_LIMIT);
  });

  it("#4 every enforced number is in the prompt the model reads", () => {
    const missing = Object.entries(GUARDRAIL_LIMITS)
      .filter(([, v]) => typeof v === "number")
      .filter(([, v]) => {
        const n = v as number;
        return !HARD_LIMITS_PROMPT.includes(String(n)) && !HARD_LIMITS_PROMPT.includes(String(Math.round(n * 100)));
      })
      .map(([k]) => k);
    record("#4 enforced numbers visible to the model", missing.length ? "MISSING" : "all present", missing.join(", ") || "8/8");
    expect(missing).toEqual([]);
  });

  it("#5 hard adjacency does not bin a plan for pre-existing adjacency", () => {
    const s = athletes().find((x) => x.key === "build-coached")!;
    // The athlete's OWN plan already has quality Tue and a lift Wed in week 2.
    const inherited: GuardrailCtx = {
      ...s.ctx,
      workouts: [
        ...s.ctx.workouts,
        { id: "pre-a", date: addDays(A, 15), category: "quality", completionState: "scheduled", durationMinutes: 60, discipline: "run" },
        { id: "pre-b", date: addDays(A, 16), category: "quality", completionState: "scheduled", durationMinutes: 60, discipline: "run" },
      ],
    };
    // An op in a DIFFERENT week must not be charged for it.
    const r = parseOps([{ kind: "add", date: addDays(A, 3), session: mobilitySession(rngFor(11), 10) }]);
    const { fatal, advisory } = validateOps(r.ops, inherited);
    record(
      "#5 inherited adjacency in an untouched week",
      [...fatal, ...advisory].some((x) => x.rule === "hard_adjacency") ? "CHARGED" : "not charged",
      "…and adjacency is advisory now: it can no longer bin a plan at all",
    );
    expect([...fatal, ...advisory].filter((x) => x.rule === "hard_adjacency")).toEqual([]);
    expect(fatal).toEqual([]);
  });

  it("prints the probe table", () => {
    const lines = ["", "─".repeat(96), "PROBE MATRIX — the neighbours, and tonight's five off their own test case", "─".repeat(96)];
    for (const p of probeRows) lines.push(`  ${pad(p.verdict, 18)} ${pad(p.name, 52)} ${p.note}`);
    lines.push("─".repeat(96));
    console.log(lines.join("\n"));
    expect(probeRows.length).toBeGreaterThan(10);
  });
});
