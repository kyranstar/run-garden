import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import {
  activities,
  coachMemory,
  coachMessages,
  coachPlans,
  coachProposals,
  coachQuestions,
  plannedWorkouts,
  workoutCompletionMatches,
} from "@rg/database";
import {
  addDays,
  datedEventsFromMemory,
  newId,
  nowInstant,
  todayInZone,
  wakeOutputSchema,
  validateOps,
  type CoachOp,
  type GuardrailCtx,
  type UserPreferences,
  type WakeOutput,
} from "@rg/domain";
import type { Env } from "../env.js";
import type { Db } from "./db.js";
import { llmBudgetStatus } from "./llm.js";
import {
  chatCompletion,
  DEFAULT_MODEL_STRONG,
  extractJson,
  recordUsage,
} from "./studio-llm.js";
import { buildDossier } from "./coach-context.js";
import { loadExerciseIndex, resolveOpsExercises } from "./exercise-catalog.js";
import { consumeTriggers, pendingTriggers, recordUnansweredMessage } from "./coach-triggers.js";
import { claimUserLock, releaseUserLock } from "./locks.js";
import { disciplineOf } from "@rg/analytics";

/**
 * One wake = one judgment (spec §§0,3): budget gate → skip-rule → dossier →
 * ONE strong-model call → zod (one repair) → guardrails (one repair) →
 * atomic persistence. Restraint is first-class: an all-empty output that
 * only consumes triggers is a fully successful wake.
 */

export type WakeCause =
  | { kind: "message"; body: string }
  | { kind: "open" }
  | { kind: "manual" }; // user-invoked check-in: never skipped, still budget-gated

export interface WakeResult {
  status: "ok" | "skipped" | "busy" | "resting" | "error";
  coachMessageId?: string;
  proposalIds?: string[];
}

const MAX_OUTPUT_TOKENS_WAKE = 64_000; // a wake may draft a whole plan
const STALE_BRIEFING_HOURS = 20;
/** How long a failed/resting wake counts as "already tried" for the "open"
 * skip rule (audit C4/C14): without this, an "open" cause never sees a
 * role='coach' message while the LLM is down, so wakeAdvised stays true and
 * every Plan visit re-fires (and re-fails) the wake. */
export const WAKE_FAILURE_BACKOFF_MINUTES = 30;

/** A complete, schema-valid example output — embedded in the prompt AND
 * parsed in a test (coach-wake.test.ts) so prompt and schema can never
 * drift apart. Complex ops (add/createPlan sessions) are where live wakes
 * kept failing validation (2026-08-12). */
export const WAKE_EXAMPLE_OUTPUT = JSON.stringify({
  briefing: "Adding a taper shakeout Friday and a recovery block after the race.",
  proposals: [
    {
      title: "Shakeout before race day",
      evidence: "race in 2 days · 7d load 1.1× base",
      rationale: "20 easy minutes with 4 strides keeps legs alive without cost.",
      expiresAt: "2026-10-22",
      flags: [],
      ops: [
        {
          kind: "add",
          date: "2026-10-22",
          session: {
            category: "easy",
            title: "Race-week shakeout",
            durationMinutes: 25,
            run: {
              blocks: [
                { kind: "duration", value: 10, intensity: "easy" },
                { kind: "duration", value: 10, intensity: "steady" },
                { kind: "duration", value: 5, intensity: "easy" },
              ],
            },
          },
        },
      ],
    },
  ],
  question: null,
  memoryOps: [],
  focus: "Race week: everything easy except Saturday's shakeout strides.",
  raceLine: "Two quality sessions left — arrive at Saturday fresh, not fit.",
});

/** A second drift-tested example: createPlan is the op live wakes failed on
 * three times (2026-08-12/13) — models must see its exact working shape. */
export const WAKE_EXAMPLE_CREATE_PLAN = JSON.stringify({
  briefing: "Drafting the post-race recovery block as a proposal.",
  proposals: [
    {
      title: "4-week post-race block",
      evidence: "race 2026-10-23 · plan ends 2026-10-03",
      rationale: "One true recovery week written out; three sketched to shape after the race.",
      expiresAt: "2026-10-25",
      flags: [],
      ops: [
        {
          kind: "createPlan",
          discipline: "run",
          name: "Post-race recovery block",
          startDate: "2026-10-24",
          endDate: "2026-11-20",
          raceDate: null,
          firmSessions: [
            {
              date: "2026-10-26",
              session: {
                category: "recovery",
                title: "Legs-back jog",
                durationMinutes: 25,
                run: { blocks: [{ kind: "duration", value: 25, intensity: "easy" }] },
              },
            },
          ],
          shapeWeeks: [
            {
              weekStart: "2026-11-02",
              volumeTarget: "rebuild easy volume",
              keySessions: ["one long run", "strides midweek"],
            },
          ],
        },
      ],
    },
  ],
  question: null,
  memoryOps: [],
  focus: null,
});

/** The THIRD drift-tested example, and the one this file was missing on
 * 2026-08-16 when a real ski-prep ask ("wall sits and anything else that
 * will get me prepared") produced three exercises the schema could not
 * accept and the whole proposal was dropped. Every op kind the prompt
 * advertises needs an example the schema is asserted against; `add` with a
 * LIFT session had none, so the model had nothing to copy and invented the
 * studio's shape. Exercises one and two carry the two prescriptions the old
 * sets+reps vocabulary could not express at all — a timed hold and a slow
 * eccentric — and the second session is a CIRCUIT (`rounds`), which is what
 * a "12-minute filler" actually is. */
export const WAKE_EXAMPLE_LIFT = JSON.stringify({
  briefing:
    "Ten days out, and you've lifted once in three months — so this is two real leg sessions (Tuesday and Friday) rather than the daily block you asked for, plus ten minutes of ankles and hips on Thursday. Thursday's run drops to 30 easy to pay for Friday's legs. Nothing heavy after the 24th.",
  proposals: [
    {
      title: "Ski-prep legs — two bouts",
      evidence: "ski trip 2026-08-26 (10 days) · 1 strength session in 90d · tight IT band on file",
      rationale:
        "A ski day is eccentric quad work held at length, single-leg lateral control, and hours on your feet in the cold. So: wall sits for isometric endurance, split squats lowered over 4 seconds for the eccentric, single-leg calf raises and Copenhagens for the ankle and the inside of the hip. Ten days buys tissue tolerance and freshness, not strength — and unaccustomed eccentric work is dosed in bouts, not days: Tuesday does most of the protecting, Friday banks it, a third would only buy soreness. Loads are deliberately small because your last strength session was in May. Your IT band is why the lateral work stays slow and small. Thursday's easy run drops 45→30 minutes so Friday's legs are fresh, and the ankle and hip work is a real ten-minute session, not homework.",
      expiresAt: "2026-08-18",
      flags: [],
      ops: [
        {
          kind: "add",
          date: "2026-08-18",
          session: {
            category: "strength",
            title: "Ski legs — holds and eccentrics",
            durationMinutes: 40,
            lift: {
              exercises: [
                { name: "Wall sit", sets: 3, holdSeconds: 45, restSeconds: 60 },
                {
                  name: "Bulgarian split squat",
                  sets: 3,
                  reps: 8,
                  perSide: true,
                  eccentricSeconds: 4,
                  weight: { type: "kg", value: 12 },
                  restSeconds: 90,
                },
                { name: "Single-leg calf raise", sets: 3, reps: 15, perSide: true },
                { name: "Copenhagen plank", sets: 2, holdSeconds: 20, perSide: true, note: "knee-bent version is fine" },
              ],
            },
          },
        },
        {
          kind: "ease",
          workoutId: "wo7c31",
          session: {
            category: "easy",
            title: "Easy 30",
            durationMinutes: 30,
            run: { blocks: [{ kind: "duration", value: 30, intensity: "easy" }] },
          },
        },
        {
          kind: "add",
          date: "2026-08-20",
          session: {
            category: "yoga",
            title: "Ankles and hips",
            durationMinutes: 10,
            mobility: {
              rounds: 2,
              exercises: [
                { name: "Couch stretch", sets: 1, holdSeconds: 45, perSide: true },
                { name: "Ankle rocks", sets: 1, reps: 12, perSide: true, restSeconds: 0 },
              ],
            },
          },
        },
        {
          kind: "add",
          date: "2026-08-21",
          session: {
            category: "strength",
            title: "Ski legs — second bout",
            durationMinutes: 35,
            lift: {
              rounds: 3,
              exercises: [
                { name: "Wall sit", sets: 1, holdSeconds: 60 },
                { name: "Reverse step-down", sets: 1, reps: 8, perSide: true, eccentricSeconds: 3 },
                { name: "Lateral squat", sets: 1, reps: 8, perSide: true, restSeconds: 90 },
              ],
            },
          },
        },
      ],
    },
  ],
  question: null,
  memoryOps: [
    { op: "add", kind: "note", text: "Ski trip 2026-08-26 to 2026-08-30.", expiresAt: "2026-08-31" },
  ],
  focus: "Two leg sessions this week — the runs stay easy around them.",
});

/**
 * Every remaining op kind in its exact working shape. A REFERENCE, not a
 * coaching suggestion — no sane wake proposes all ten at once, and the
 * narrative examples above are the ones to imitate for voice.
 *
 * It exists because the prompt advertises twelve op kinds and, until
 * 2026-08-16, drift-tested exactly two of them; the third (`add` with a lift
 * body) was missing on the day a real ski-prep ask needed it, and the model
 * invented the studio's shape instead. Parsed op-by-op in coach-wake.test.ts
 * against `coachOpSchema`, and asserted to cover the whole discriminated
 * union, so a new op kind cannot be advertised without a shape to copy.
 */
export const WAKE_EXAMPLE_OPS = JSON.stringify([
  { kind: "move", workoutId: "wo7c31", toDate: "2026-08-20" },
  { kind: "swap", dayA: "2026-08-19", dayB: "2026-08-21" },
  { kind: "skip", workoutId: "wo9f02", reason: "you're travelling — this one costs more than it gives" },
  {
    kind: "reshapeWeek",
    planId: "cp1",
    weekStart: "2026-08-24",
    sessions: [
      {
        date: "2026-08-25",
        session: {
          category: "easy",
          title: "Easy 40",
          durationMinutes: 40,
          run: { blocks: [{ kind: "duration", value: 40, intensity: "easy" }] },
        },
      },
    ],
  },
  {
    kind: "firmUp",
    planId: "cp1",
    weekStart: "2026-08-31",
    sessions: [
      {
        date: "2026-09-02",
        session: {
          category: "quality",
          title: "Threshold 4×8",
          durationMinutes: 55,
          run: {
            blocks: [
              { kind: "duration", value: 15, intensity: "easy" },
              { kind: "duration", value: 32, intensity: "threshold" },
              { kind: "duration", value: 8, intensity: "easy" },
            ],
          },
        },
      },
    ],
  },
  {
    kind: "extendPlan",
    planId: "cp1",
    shapeWeeks: [{ weekStart: "2026-09-07", volumeTarget: "hold, one quality", keySessions: ["long run", "threshold"] }],
  },
  {
    kind: "windDown",
    planId: "cp1",
    sessions: [
      {
        date: "2026-09-14",
        session: {
          category: "recovery",
          title: "Legs-back jog",
          durationMinutes: 25,
          run: { blocks: [{ kind: "duration", value: 25, intensity: "easy" }] },
        },
      },
    ],
  },
  { kind: "retirePlan", planId: "cp1" },
  { kind: "resolveRaceConflict", keep: "settings" },
]);

/**
 * The coach's head, in four parts: what it may claim (HONESTY), how it may
 * quote a number, how it reasons about training, and only then the plumbing.
 *
 * Before 2026-08-16 this was fourteen bullets of which thirteen were format,
 * permissions and plumbing — the single line with any physiology in it was
 * the race-terrain rule. Asked to prepare for a ski trip in ten days, the
 * coach answered with three sentences of wall sits and core fillers: work
 * the athlete already had, on the day after their long run and on the day
 * they had told it was their worst, with no rest day in nine, ignoring a
 * stated tight IT band and the fact that they had lifted once in seven
 * months — and then attached none of it, because the ops failed validation
 * and the prose was written in the past tense anyway.
 *
 * Everything below exists because of one of those. The physiology is
 * deliberately written as REASONING (name the demands, then write against
 * them) rather than as facts about skiing: the next ask will be a hike, a
 * wedding, or "get in shape", and a hardcoded ski rule teaches nothing.
 *
 * Dossier dependency (coach-context.ts, same day): this prompt reads
 * EXERCISE CATALOG, STRENGTH PLAN, per-session stageSummary on UPCOMING
 * lines, the 90-day per-discipline HISTORY block, and training load —
 * sections a concurrent change adds. Each is referenced by name and
 * degrades to "the coach looks and finds nothing" if a section is missing.
 */
export const WAKE_SYSTEM_PROMPT = `You are the athlete's running and lifting coach inside Run Garden. You read one dossier and reply with ONE JSON object — nothing else.

HONESTY — this outranks everything below it.
- Your briefing may describe ONLY changes that exist in THIS reply's ops. Not what you intend, not what you would like to add — what is actually in the JSON. If the op is not there, the change is not real, and describing it is the worst thing you can do to this athlete.
- So: no "here's the plan", no "I've added", "I've moved", "I've left Saturday alone", "your week now looks like", and no counting sessions ("three leg sessions and a filler on the run days") unless every one of them is an op in this reply.
- Cannot express it? Say so and offer. One or two sentences of what you would do, then ask to draft it: "I'd put real leg work Tuesday and Friday and keep the runs easy around them — want me to write those two up?" That is a good answer. Confident prose over an empty ops array is not.
- Work the athlete already has is theirs, not yours. Name it as theirs; never re-add it and never take credit for it.

NUMBERS CARRY THEIR MEANING.
- Never hand back a bare dossier figure. The interpretation rides in the same sentence: "recovery reads 100%, but that score hasn't moved since you stopped training and there's no HRV behind it — treat it as no information", never just "recovery reads 100%".
- Name weak evidence as weak: stale, one night, no baseline, unknown. A wellness number that froze when the training stopped is an artefact, not a verdict.
- Prefer the number that carries information over the number that happens to be present. "Nine days since a run" beats a frozen readiness score.
- Every state word you use — taper, rest mode, under_prepared, detrained, threshold, base — gets one plain clause of context in the same sentence. Assume no prior knowledge; this athlete has never read a coaching textbook and will ask.
- Use the dossier's units as given (they are already in the athlete's preference), and never invent a figure it does not contain.

PROGRAMMING — how you answer "get me ready for X", whatever X is.
- DEMANDS FIRST, WORDS SECOND. Before writing a single session, name what the goal actually asks of the body: which tissues, which contraction types (eccentric / isometric / concentric / elastic), which planes and directions, how long one effort lasts and how often it repeats, and the environment (cold, altitude, terrain, all day on your feet). Then write sessions against that list, and put the list in the proposal's rationale — it is how the athlete sees that you thought.
- HONOUR THE INTENT BEHIND A NAMED EXERCISE, not its literal wording. "Wall sits" means "quads that don't quit", not the wall. Keep their choice when it is a good one, then add the higher-leverage options with a plain-words reason ("split squats as well, because a turn happens on one leg"). Prefer the specific movement over the generic one, and controlled tempo over more reps whenever the demand is tissue tolerance rather than fitness.
- READ WHAT THEY ALREADY HAVE, FIRST. Each UPCOMING line carries that session's stageSummary — its actual contents — and STRENGTH PLAN carries their lift sessions and their stated constraints. Read both before adding anything. Never prescribe work that is already prescribed: extend it, load it, or leave it alone and say why.
- DOSE AGAINST THE HORIZON. Count the days and say the count. Under about three weeks buys motor rehearsal, tissue tolerance and freshness — not strength. Say that plainly instead of implying a transformation. A long horizon buys real adaptation, and then progression is the point.
- UNACCUSTOMED ECCENTRIC OR HIGH-TENSION WORK IS DOSED IN BOUTS, NOT DAYS. The first hard exposure does most of the damage and most of the protecting; a second one 48–72h later banks it. Further bouts inside a short block buy soreness, not protection. Two or three, never six.
- "DAILY" IS USUALLY THE WRONG ANSWER, AND SAYING SO IS YOUR JOB. When they ask for daily, give them a daily piece that genuinely costs nothing — a few minutes of mobility, a couple of easy holds — plus two to four real loading sessions, and explain the split warmly in one sentence. Never write a week with no rest day: a day with nothing on it is training.
- TAPER INTO ANYTHING THEY CARE ABOUT, not only races — a trip, a hike, a match, a move. Name the cutoff date: "nothing heavy after the 24th".
- PRESCRIBE AGAINST HISTORY, NOT AGAINST THE PLAN. HISTORY gives 90 days per discipline and states detraining outright. One strength session in seven months means untrained in strength however well the running is going — a fact about tissue, not a judgement about the person. Start light, and say the numbers are deliberately light and why, so it reads as craft rather than as an insult.
- NAME A SPECIFIC RISK ONCE, WITHOUT ALARM. A tight IT band, a knee, a back: name the tissue, say what you did about it, move on. "Your IT band is why the lateral work is slow and small." No disclaimers, no "see a professional", no repeating it in every sentence.
- PROVE INTERFERENCE, DON'T ASSERT IT. Before placing a session, read the day before and the day after it in UPCOMING and count the consecutive loaded days you are creating. The day after a long run is never a free day. A day the athlete has told you is their worst is not where hard work goes.
- ONE BUDGET, ONE BODY. Adding to one discipline inside another's build costs something. Say what you took out to pay for it, and propose the op that takes it out ("Thursday's 50 drops to 30 easy to make room").
- COMPENSATORY WORK IS A SESSION. Mobility, prehab, ankle and hip work: if it matters it is an add with a mobility body on a real date, not a line of advice in the briefing.
- RECORD DATED EVENTS. A trip, a holiday, a week away, an event they are travelling to — write it to memoryOps as a note with the date as YYYY-MM-DD inside the text and an expiresAt just after it. Nothing else in this app remembers it, and next week neither will you. The date in that text is also what stops you scheduling hard work into the day before it.
- If a dossier section named above isn't in front of you, work from what is, and say what you couldn't see. Never invent the contents of a section you weren't given.

Your contract:
- PROPOSE, never act. Every plan change you want is a proposal the athlete taps to approve. Nothing you say changes anything by itself.
- SCOPE — you can fulfil essentially any plan request, and you must never claim otherwise:
  · ease/move/skip/swap work on ANY session in UPCOMING or LAST 14 DAYS via its [wo:...] id, imported COROS sessions included. Approved moves of imported sessions ARE written to the watch and verified.
  · add creates a new session on any date. Approved run sessions built from DURATION blocks are written to the athlete's COROS watch and verified; distance-block runs and lift adds land on the app calendar + Google Calendar only (mention that only when it matters).
  · Imported/studio plan STRUCTURE is edited by COMPOSITION: skip or move its sessions and add your own around them. "Extend the plan" = add sessions (or createPlan a coached block) after it ends; "add a taper" = ease/skip its final sessions and add what's missing. reshapeWeek/firmUp/extendPlan/windDown/retirePlan additionally work on plans you authored.
  · NEVER say a plan is read-only or that you can't restructure it — describe the composition you propose instead.
  · RACE CONFLICT: when the dossier flags two race dates (a plan's race-labeled session vs the athlete's race day in Settings), resolve it — don't coach around it. If the athlete has already said which date is real, propose resolveRaceConflict in the same wake: keep:"settings" makes the plan's mislabeled day a regular hard session; keep:"plan" moves their race-day setting to the plan's date. Only ask which is right if they truly haven't said.
- RESTRAINT IS A COMPLETE ANSWER — until they ask. Unprompted, propose only when a change genuinely beats the current plan; acknowledging a missed workout kindly, or saying nothing (briefing: null), is often correct, and you never invent work for yourself. But a direct request to plan — "replan my week", "get me ready for X", "add lifting" — is not an invitation to summarise. It is the work. Answer it with ops, or with an honest offer to draft them. Restraint there is just a shorter way of not helping.
- NEVER ask what the dossier's ATHLETE section already answers, and never repeat a question listed in OPEN ITEMS. At most ONE question, only when the answer would change your coaching, with short tappable chips.
- MEMORY: when the athlete tells you something durable, record it via memoryOps (kind: fact = who they are, rule = a standing preference, note = time-boxed, with expiresAt). Prefer update over add for near-duplicates; ids are in the dossier.
- FLAGS: if a proposal goes against a standing rule, say so in its flags array ("moves your Saturday long run"). Hard safety limits are enforced outside you and reject the whole proposal — stay inside them: weekly ramp over 10%, a first block in a discipline you have no recent history in, hard days back to back (a strength session counts as hard from 30 minutes, and from the first minute when you haven't lifted in a month), race-week intensity, a week with no rest day left in it, hard work inside the last 48h before a dated event you recorded, and editing the past.
- EVIDENCE: every proposal's evidence cites dossier data ("slept 5h avg · HRV −9%"), and expiresAt is min(end of first affected day, +3 days).
- GARDEN VOICE: MILESTONES carries the garden's state. AT MOST ONE garden reference per briefing, always tied to a concrete action ("an easy 30 tomorrow brings the rain back"), never guilt. Say nothing about the garden during rest mode or taper, or when its forecast stage is already a loss stage — one loss voice at a time.
- SKIP TREATMENT: when proposing a skip, state in the rationale what the garden will see: the first sanctioned skip in a rolling week counts as a genuine rest day; further ones are merely neutral. OPEN ITEMS shows current mercy usage.
- VOICE: brief, warm, specific. A coach, not an app. No headers, no bullet-point walls in briefings; 1–4 sentences by default. A request to plan IS a request for detail — so give the detail, but give it in the proposal's rationale, where every line of it is tied to a session that exists. The briefing stays a few sentences: what changed, why, and the one thing to know. Session-by-session prose in a briefing is how you end up describing work you never wrote.

- FOCUS: one sentence (≤160 chars) naming the week's anchor and at most one adjustment — the plan page shows it as "the coach's line". null when you have nothing genuinely useful to say.

- TERRAIN: when the dossier's RACE line says under_prepared, the athlete is training flatter than their course — say so once and propose hill work (an add with steady/threshold blocks on a hilly route, or easing a flat session into a hill session). Never invent a gradient number; the dossier's m/km figures are the only terrain facts you have.

- RACELINE: only when the dossier has a RACE section — ONE sentence (≤160 chars) on the race build as a whole (the through-line toward race day; focus already covers this week). Cite the dossier's real numbers when they matter. null KEEPS the previous line — write a new one only when the story genuinely moves.

Output JSON exactly matching:
{"briefing": string|null, "proposals": [{"title","evidence","rationale","expiresAt","flags":[],"ops":[...]}], "question": {"text","chips":[]}|null, "memoryOps": [...], "focus": string|null, "raceLine": string|null}

Op kinds: ease{workoutId,session} · move{workoutId,toDate} · swap{dayA,dayB} · skip{workoutId,reason} · add{date,session} · reshapeWeek{planId,weekStart,sessions} · firmUp{planId,weekStart,sessions} · extendPlan{planId,shapeWeeks} · windDown{planId,sessions} · createPlan{discipline,name,startDate,endDate,raceDate?,firmSessions,shapeWeeks} · retirePlan{planId} · resolveRaceConflict{keep:"settings"|"plan"}
A session is {category, title, durationMinutes, and AT MOST ONE body: run? | lift? | mobility?}.
· category ∈ easy|long|quality|recovery|race|rest|strength|yoga. Use "yoga" with a mobility body — a mobility session filed as a run corrupts the athlete's discipline balance.
· run: {blocks:[{kind:"duration"|"distance", value, intensity?}]} — minutes (duration) / meters (distance). Values are INTEGERS; intensity ∈ easy|steady|threshold|interval|rest.
· lift / mobility: {rounds?, exercises:[...]}. Give "rounds" ONLY for a circuit — the whole list cycled that many times, each exercise's "sets" being its work per round. Omit it for straight sets.
· An exercise is {name, sets, and either reps or holdSeconds} plus optional perSide, eccentricSeconds, weight, restSeconds, note, originId. holdSeconds is seconds of work per set (wall sit, plank, 30s skier hops). perSide:true means sets × reps happen on EACH leg/arm. eccentricSeconds is the slow lowering ("4s down"). weight defaults to bodyweight — give a plain number for kilos; restSeconds defaults to 60.
· EXERCISE NAMES: write the movement in plain English. If the dossier has an EXERCISE CATALOG section (id|name), prefer a name from it and you may copy that row's id into originId; otherwise omit originId — the server resolves the name to the watch's library either way. A movement the library doesn't have still works: the session lives in the app and simply can't be pushed to the watch. Never let the catalog stop you prescribing the right thing.
shapeWeeks volumeTarget stays under ~6 words. One add = one date, so a genuinely daily piece is one add per day — write them all; a proposal holds up to 20 ops.
Match these examples' shapes EXACTLY:
${WAKE_EXAMPLE_OUTPUT}
${WAKE_EXAMPLE_CREATE_PLAN}
${WAKE_EXAMPLE_LIFT}
The remaining op kinds, in their exact shapes (a reference, not a suggestion — copy the shape, imitate the examples above for voice):
${WAKE_EXAMPLE_OPS}`;



async function persistMessage(
  db: Db,
  userId: string,
  role: "coach" | "user" | "receipt",
  body: string,
  refs: {
    proposalId?: string;
    memoryIds?: string[];
    questionId?: string;
    wakeFailure?: boolean;
    focus?: string;
    raceLine?: string;
  } = {},
): Promise<string> {
  const id = newId();
  await db.insert(coachMessages).values({ id, userId, role, body, refs, at: nowInstant() });
  return id;
}


/**
 * ONE honest mechanism for the worst outcome this pipeline has: prose that
 * promises plan changes with none attached (live, 2026-08-16 — the coach
 * described three leg sessions and 12-minute fillers, the ops failed
 * validation, and the athlete was told only that something "couldn't be
 * formatted"). Silence about what was lost is what makes it dangerous:
 * you believe you have a plan.
 *
 * So a wake that drops work says exactly what it dropped, by title and by
 * op kind, whether the loss happened at the schema boundary (salvage) or at
 * the guardrail boundary (a proposal rejected twice and filtered out). Both
 * call sites hand it the same shape.
 */
export interface LostProposal {
  title: string;
  ops: string[];
  /** Why it was lost, in the athlete's language. */
  reason: string;
}

function lostWorkBody(lost: LostProposal[]): string {
  const parts = lost.map((l) => {
    const ops = l.ops.length > 0 ? ` (${summarizeOpKinds(l.ops)})` : "";
    return `“${l.title}”${ops} — ${l.reason}`;
  });
  const head = lost.length === 1 ? "One plan change didn't make it" : `${lost.length} plan changes didn't make it`;
  return `${head}: ${parts.join("; ")}. Nothing was applied. Ask again — naming one day at a time helps — and it will come back as a proposal you can approve.`;
}

/** "2 adds, 1 skip" — the shape of the work, not raw op names. */
function summarizeOpKinds(kinds: string[]): string {
  const counts = new Map<string, number>();
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => (n > 1 ? `${n} ${k}s` : `1 ${k}`)).join(", ");
}

/** Read proposal titles/op kinds out of JSON too broken to schema-parse —
 * best effort by design: the whole point is that this object is malformed. */
function salvageLostProposals(raw: unknown, reason: string): LostProposal[] {
  const proposals = (raw as { proposals?: unknown[] } | null)?.proposals;
  if (!Array.isArray(proposals)) return [];
  return proposals.map((p, i) => {
    const o = (p ?? {}) as { title?: unknown; ops?: unknown[] };
    return {
      title: typeof o.title === "string" && o.title.trim() ? o.title.trim().slice(0, 80) : `change ${i + 1}`,
      ops: (Array.isArray(o.ops) ? o.ops : [])
        .map((op) => (op as { kind?: unknown })?.kind)
        .filter((k): k is string => typeof k === "string"),
      reason,
    };
  });
}

/**
 * Persist a wake-failure receipt ("couldn't think" / "resting"), but never
 * as a duplicate of the thread's newest WAKE-FAILURE row (audit C4/C14
 * residual): while the LLM gateway is down, every "open" wake used to
 * append an identical row forever. Compares against the newest failure
 * specifically — not the newest row of any kind — so an unrelated receipt
 * landing in between (e.g. the expiry sweep's "Expired: …" line, or a
 * "Superseded: …" receipt) doesn't defeat the dedupe. Marked `wakeFailure`
 * so `openWakeIsFresh` can back off retries without depending on exact copy.
 */
async function persistWakeFailure(db: Db, userId: string, body: string): Promise<void> {
  const [latest] = await db
    .select()
    .from(coachMessages)
    .where(
      and(
        eq(coachMessages.userId, userId),
        eq(coachMessages.role, "receipt"),
        sql`json_extract(${coachMessages.refs}, '$.wakeFailure') = 1`,
      ),
    )
    .orderBy(desc(coachMessages.at))
    .limit(1);
  if (latest && latest.body === body) return; // already showing this failure
  await persistMessage(db, userId, "receipt", body, { wakeFailure: true });
}

/**
 * Whether a wake failed/rested recently enough that another "open" attempt
 * would just repeat it. This is checked BEFORE triggers (audit C14
 * residual): `consumeTriggers` only runs on a successful wake, so a
 * pending trigger stays pending through every failure — without gating on
 * this first, a single missed-workout trigger during an LLM outage forced
 * every single Plan visit to attempt (and burn) another LLM call, exactly
 * the harm the backoff was meant to prevent.
 */
async function recentWakeFailure(db: Db, userId: string): Promise<boolean> {
  const [lastFailure] = await db
    .select()
    .from(coachMessages)
    .where(
      and(
        eq(coachMessages.userId, userId),
        eq(coachMessages.role, "receipt"),
        sql`json_extract(${coachMessages.refs}, '$.wakeFailure') = 1`,
      ),
    )
    .orderBy(desc(coachMessages.at))
    .limit(1);
  return (
    !!lastFailure &&
    Date.parse(nowInstant()) - Date.parse(lastFailure.at) < WAKE_FAILURE_BACKOFF_MINUTES * 60 * 1000
  );
}

/** Whether the last coach briefing is still fresh enough that an "open"
 * wake with no new trigger would be redundant. Filters out legacy per-effort
 * analyses (refs.kind='analysis') — an ambient read is not a briefing, and
 * counting it silently muted the coach for 20h after every read. */
async function freshBriefing(db: Db, userId: string): Promise<boolean> {
  const [lastCoach] = await db
    .select()
    .from(coachMessages)
    .where(
      and(
        eq(coachMessages.userId, userId),
        eq(coachMessages.role, "coach"),
        sql`json_extract(${coachMessages.refs}, '$.kind') IS NULL`,
      ),
    )
    .orderBy(desc(coachMessages.at))
    .limit(1);
  return (
    !!lastCoach && Date.parse(nowInstant()) - Date.parse(lastCoach.at) < STALE_BRIEFING_HOURS * 3600 * 1000
  );
}

/**
 * Whether an "open" (auto) wake would be redundant right now (audit
 * C4/C14). A recent failure/rest wins over everything, INCLUDING pending
 * triggers — the whole point of the backoff is to stop retrying while the
 * coach just failed, and a trigger alone doesn't get to override that (it
 * stays unconsumed until a wake actually succeeds, so ungating it here
 * would mean the backoff never actually applies whenever anything is
 * pending — the common case during an outage). Short of a recent failure,
 * a pending trigger always makes a wake worth attempting; with no trigger,
 * a fresh existing briefing makes it redundant. Shared by the internal
 * "open" skip rule below and the `wakeAdvised` the client uses to decide
 * whether to bother calling wake at all.
 */
export async function openWakeIsFresh(db: Db, userId: string, triggerCount: number): Promise<boolean> {
  if (await recentWakeFailure(db, userId)) return true;
  if (triggerCount > 0) return false;
  return freshBriefing(db, userId);
}

/** Dates an op touches — for supersede matching. */
function opAffectedDates(op: CoachOp, workoutDates: Map<string, string>): string[] {
  switch (op.kind) {
    case "ease":
    case "skip":
      return [workoutDates.get(op.workoutId) ?? ""].filter(Boolean);
    case "move":
      return [workoutDates.get(op.workoutId) ?? "", op.toDate].filter(Boolean);
    case "swap":
      return [op.dayA, op.dayB];
    case "add":
      return [op.date];
    case "reshapeWeek":
    case "firmUp":
    case "windDown":
      return op.sessions.map((s) => s.date);
    case "createPlan":
      return op.firmSessions.map((s) => s.date);
    default:
      return [];
  }
}

async function guardrailCtx(
  db: Db,
  userId: string,
  prefs: UserPreferences,
): Promise<GuardrailCtx> {
  const today = todayInZone(prefs.timezone);
  const horizon = addDays(today, 60);
  const rows = await db
    .select()
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.userId, userId)));
  const workouts = rows
    .filter((w) => w.effectiveDate >= addDays(today, -35) && w.effectiveDate <= horizon)
    .map((w) => ({
      id: w.id,
      date: w.effectiveDate,
      category: w.category,
      completionState: w.completionState,
      durationMinutes: Math.round((w.calendarBlockDurationSeconds ?? 3600) / 60),
      discipline: disciplineOf(w.category, w.sport) as "run" | "strength" | "yoga",
    }));
  // Trailing 4 weeks of minutes per discipline — what the athlete ACTUALLY
  // did, planned or not.
  //
  // Completed planned workouts alone were a bad proxy the moment anything
  // depended on the ABSENCE of history: someone who lifts three times a week
  // and never plans it reads as zero, and the cold-start guardrail added
  // 2026-08-16 would then reject their perfectly ordinary strength week. So
  // unmatched activities are folded in — matched ones are already counted
  // through their planned row, and counting both would double them.
  const since = addDays(today, -28);
  const acts = await db
    .select()
    .from(activities)
    .where(and(eq(activities.userId, userId), gte(activities.startTime, `${since}T00:00:00Z`)));
  const matched = new Set(
    (
      await db
        .select({ activityId: workoutCompletionMatches.activityId })
        .from(workoutCompletionMatches)
        .where(inArray(workoutCompletionMatches.workoutId, workouts.map((w) => w.id).concat("-")))
    ).map((m) => m.activityId),
  );
  const weekly: Record<string, number[]> = {};
  const bump = (discipline: string, date: string, minutes: number) => {
    for (let k = 4; k >= 1; k--) {
      const start = addDays(today, -7 * k);
      if (date >= start && date <= addDays(start, 6)) {
        const arr = (weekly[discipline] ??= [0, 0, 0, 0]);
        arr[4 - k] = (arr[4 - k] ?? 0) + minutes;
      }
    }
  };
  for (const w of workouts) {
    if (w.completionState === "completed" && w.category !== "rest") bump(w.discipline, w.date, w.durationMinutes);
  }
  for (const a of acts) {
    if (matched.has(a.id)) continue;
    if (!["run", "strength", "yoga"].includes(a.sport)) continue;
    bump(disciplineOf("", a.sport), (a.startTimeLocal ?? a.startTime).slice(0, 10), Math.round(a.durationSeconds / 60));
  }
  // Every coach-authored plan id regardless of status — H7's authorship test.
  const plans = await db.select().from(coachPlans).where(eq(coachPlans.userId, userId));
  const coachPlanIds = plans.map((p) => p.id);
  const raceDates = plans
    .filter((p) => p.status === "active")
    .map((p) => p.raceDate)
    .filter((d): d is string => !!d);
  // Firm horizon: latest scheduled workout date (imported or coached) —
  // beyond it only the structured ops may reach.
  const firmHorizonEnd =
    workouts
      .filter((w) => w.date >= today)
      .map((w) => w.date)
      .sort()
      .at(-1) ?? today;
  const memories = await db
    .select()
    .from(coachMemory)
    .where(and(eq(coachMemory.userId, userId), eq(coachMemory.active, true)));
  const rules = memories
    .filter((r) => r.kind === "rule")
    .flatMap((r) => {
      // Structured matchers for the two v1 rule shapes; prose rules stay
      // model-flagged only.
      const m = r.body.toLowerCase().match(/(long|quality|easy|recovery|strength)[^]*?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
      if (!m) return [];
      const weekday = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].indexOf(m[2]!) + 1;
      return [{ id: r.id, kind: "anchor_day" as const, category: m[1]!, weekday }];
    });
  // Dated things the athlete told the coach about (a trip, a holiday). The
  // coach is instructed to write these as notes carrying a YYYY-MM-DD, and
  // memory is the only place they exist — nothing else in the schema has a
  // slot for "I am skiing on the 26th", which is why the coach happily
  // scheduled its heaviest session two days before one.
  const datedEvents = datedEventsFromMemory(memories);
  return {
    today,
    workouts,
    weeklyMinutesByDiscipline: weekly,
    raceDates,
    firmHorizonEnd,
    rules,
    coachPlanIds,
    datedEvents,
  };
}

export async function wake(
  db: Db,
  env: Env,
  userId: string,
  prefs: UserPreferences,
  cause: WakeCause,
  fetchImpl: typeof fetch = fetch,
): Promise<WakeResult> {
  const today = todayInZone(prefs.timezone);
  // The athlete's words are never lost — persist before anything can fail,
  // and mark the message as awaiting a reply. The marker is a pending
  // trigger consumed only by a successful wake: if THIS request dies
  // mid-call, the next open picks the reply up (user requirement:
  // navigating away must not lose the coach's answer).
  if (cause.kind === "message") {
    await persistMessage(db, userId, "user", cause.body);
    await recordUnansweredMessage(db, userId, cause.body);
  }

  const budget = await llmBudgetStatus(db, userId);
  if (budget.cutoff) {
    await persistWakeFailure(db, userId, "The coach is resting (weekly budget reached) — manual controls all work.");
    return { status: "resting" };
  }

  const triggers = await pendingTriggers(db, userId);
  if (cause.kind === "open") {
    if (await openWakeIsFresh(db, userId, triggers.length)) return { status: "skipped" };
  }

  // Single-flight (rework spec R2): claimed AFTER the cheap gates so quiet
  // opens never touch the lock, and AFTER the user's words are persisted so
  // a lost race can't drop them. A MESSAGE deserves a reply, though — the
  // user is watching (audit finding 16): wait out the holder for up to a
  // minute before giving up with an honest "busy" the client can surface.
  let lock = await claimUserLock(db, userId, "wake");
  if (!lock && cause.kind === "message") {
    for (let i = 0; i < 12 && !lock; i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      lock = await claimUserLock(db, userId, "wake");
    }
  }
  if (!lock) return { status: cause.kind === "message" ? "busy" : "skipped" };

  try {
    const dossier = await buildDossier(db, userId, prefs);
    const causeBlock =
      cause.kind === "message"
        ? `The athlete just said:\n"""${cause.body}"""`
        : cause.kind === "manual"
          ? `The athlete pressed "Check in" — they want your read RIGHT NOW. Give a short, concrete briefing of where they stand today; propose only if genuinely warranted.`
          : `The athlete opened the plan page. Address pending SIGNALS if any; otherwise a short check-in or nothing.`;
    type ChatMsg = { role: "system" | "user" | "assistant"; content: string };
    const messages: ChatMsg[] = [
      { role: "system", content: WAKE_SYSTEM_PROMPT },
      { role: "user", content: `${dossier.text}\n\n---\n${causeBlock}\nToday is ${today}.` },
    ];
    const model = env.AI_STUDIO_MODEL_STRONG || DEFAULT_MODEL_STRONG;

    const attemptParse = async (
      msgs: ChatMsg[],
    ): Promise<{ out: WakeOutput | null; raw: string; issues: string }> => {
      const chat = await chatCompletion(env, fetchImpl, model, MAX_OUTPUT_TOKENS_WAKE, msgs);
      if (!chat.ok) {
        console.error(`[coach-wake] gateway failure: ${chat.reason}`);
        return { out: null, raw: "", issues: "" };
      }
      await recordUsage(db, userId, "coach_wake", model, "strong", chat, `wake:${userId}:${nowInstant()}`);
      const json = extractJson(chat.content);
      const parsed = wakeOutputSchema.safeParse(json);
      if (parsed.success) return { out: parsed.data, raw: chat.content, issues: "" };
      // The repair prompt needs the actual issues — "didn't match" alone
      // reproduces the same mistake (live-observed: two wakes, four calls,
      // zero corrections). Also logged so `wrangler tail` shows ground truth.
      const issues =
        json == null
          ? "no JSON object found in the reply"
          : parsed.error.issues
              .slice(0, 8)
              .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("\n");
      console.error(
        `[coach-wake] schema reject: ${issues.replaceAll("\n", " | ")} · raw head: ${chat.content.slice(0, 1200)}`,
      );
      return { out: null, raw: chat.content, issues };
    };

    let { out, raw, issues } = await attemptParse(messages);
    if (!out && !raw) {
      // Gateway/transport failure (nothing came back) — transient more often
      // than not; one retry before giving up ("the coach never errors" work,
      // 2026-08-12).
      await new Promise((r) => setTimeout(r, 2_000));
      ({ out, raw, issues } = await attemptParse(messages));
    }
    if (!out && raw) {
      ({ out } = await attemptParse([
        ...messages,
        { role: "assistant" as const, content: raw },
        {
          role: "user" as const,
          content: `That did not match the required JSON schema. Problems:\n${issues}\nReply with ONLY the corrected JSON object — same content, valid shape.`,
        },
      ]));
    }
    if (!out && raw) {
      // Salvage: the model twice produced JSON that misses the full schema —
      // usually complex plan ops. The BRIEFING prose is almost always intact;
      // losing it to a "couldn't think" receipt threw away a good answer
      // (live case: the plan-extension ask, 2026-08-12). Keep the words, drop
      // the malformed structure, and say so.
      const loose = extractJson(raw) as { briefing?: unknown } | null;
      const briefing = typeof loose?.briefing === "string" ? loose.briefing.trim() : "";
      if (briefing.length > 0) {
        const coachMessageId = await persistMessage(db, userId, "coach", briefing);
        const lost = salvageLostProposals(loose, "the coach couldn't write it in a form the app accepts");
        await persistMessage(
          db,
          userId,
          "receipt",
          lost.length > 0
            ? lostWorkBody(lost)
            : "The plan changes the coach drafted alongside this couldn't be formatted — ask again (smaller steps help) and it will draft them as proposals.",
          // Diagnosability: the zod issues ride the receipt's refs — three
          // live failures were unexplainable post-hoc without a running tail.
          { schemaIssues: issues.slice(0, 500) } as never,
        );
        await consumeTriggers(db, userId, triggers.map((t) => t.id), nowInstant());
        return { status: "ok", coachMessageId };
      }
    }
    if (!out) {
      await persistWakeFailure(db, userId, "The coach couldn't think just now — try again in a moment.");
      return { status: "error" };
    }

    // Guardrails: hard violations get one repair round-trip, then drop.
    const ctx = await guardrailCtx(db, userId, prefs);
    let proposals = out.proposals;
    const violated = proposals
      .map((p, i) => ({ i, v: validateOps(p.ops, ctx) }))
      .filter((x) => x.v.hard.length > 0);
    if (violated.length > 0) {
      const detail = violated
        .map((x) => `proposal ${x.i} ("${proposals[x.i]!.title}"): ${x.v.hard.map((h) => `${h.rule} — ${h.detail}`).join("; ")}`)
        .join("\n");
      const repair = await attemptParse([
        ...messages,
        { role: "assistant" as const, content: JSON.stringify(out) },
        { role: "user" as const, content: `These proposals violate hard safety rules and were rejected:\n${detail}\nReply with ONLY the corrected full JSON (fix or drop the violating proposals; keep everything else).` },
      ]);
      if (repair.out) {
        out = repair.out;
        proposals = out.proposals;
      }
      const stillBad = proposals
        .map((p, i) => ({ i, p, v: validateOps(p.ops, ctx) }))
        .filter((x) => x.v.hard.length > 0);
      // Dropping a proposal on the floor and saying nothing is the same
      // failure as the salvage path, one stage later — the briefing still
      // promises the change. Same mechanism, same honesty.
      if (stillBad.length > 0) {
        await persistMessage(
          db,
          userId,
          "receipt",
          lostWorkBody(
            stillBad.map((x) => ({
              title: x.p.title,
              ops: x.p.ops.map((o) => o.kind),
              reason: x.v.hard.map((h) => h.detail).join("; "),
            })),
          ),
        );
      }
      const stillBadIdx = new Set(stillBad.map((x) => x.i));
      proposals = proposals.filter((_, i) => !stillBadIdx.has(i));
    }

    // Name → catalog originId, once for the whole wake (2026-08-16). The
    // coach is never handed the catalog, so this is the ONLY place an
    // exercise can acquire its watch identity; doing it here means the
    // stored ops, the apply, and the session sheet all agree. Names with no
    // match keep no originId and are surfaced, never dropped — see
    // `offCatalogExercises`.
    const exerciseIndex = await loadExerciseIndex(db);
    const resolutions = proposals.flatMap((p) => resolveOpsExercises(p.ops, exerciseIndex));
    if (resolutions.length > 0) {
      const missed = resolutions.filter((r) => !r.originId);
      const byModel = resolutions.filter((r) => r.via === "model").length;
      console.log(
        `[coach-wake] exercises resolved ${resolutions.length - missed.length}/${resolutions.length}` +
          ` (${byModel} from the model's own id)` +
          (missed.length > 0 ? ` · off-catalog: ${missed.map((m) => m.name).join(", ")}` : ""),
      );
    }

    // Union validator-found soft flags into each surviving proposal.
    const workoutDates = new Map(ctx.workouts.map((w) => [w.id, w.date]));
    const now = nowInstant();
    const proposalIds: string[] = [];
    for (const p of proposals) {
      const soft = validateOps(p.ops, ctx).soft;
      const ruleBodies = new Map(
        (await db.select().from(coachMemory).where(eq(coachMemory.userId, userId))).map((r) => [r.id, r.body]),
      );
      const flags = [...new Set([...p.flags, ...soft.map((v) => ruleBodies.get(v.rule) ?? v.rule)])];

      // Supersede: at most one live proposal per affected day.
      const affected = new Set(p.ops.flatMap((op) => opAffectedDates(op, workoutDates)));
      const live = await db
        .select()
        .from(coachProposals)
        .where(and(eq(coachProposals.userId, userId), eq(coachProposals.status, "pending")));
      const id = newId();
      for (const old of live) {
        const oldAffected = (old.ops as CoachOp[]).flatMap((op) => opAffectedDates(op, workoutDates));
        if (oldAffected.some((d) => affected.has(d))) {
          await db
            .update(coachProposals)
            .set({ status: "superseded", resolvedAt: now, supersededBy: id })
            .where(eq(coachProposals.id, old.id));
          await persistMessage(db, userId, "receipt", `Superseded: ${old.title}`, { proposalId: old.id });
        }
      }
      const firstDay = [...affected].sort()[0];
      const cappedExpiry = [p.expiresAt, firstDay ?? p.expiresAt, addDays(today, 3)].sort()[0]!;
      await db.insert(coachProposals).values({
        id,
        userId,
        planId: null,
        title: p.title,
        evidence: p.evidence,
        rationale: p.rationale,
        flags,
        ops: p.ops,
        status: "pending",
        createdAt: now,
        expiresAt: cappedExpiry < today ? today : cappedExpiry,
      });
      proposalIds.push(id);
    }

    // Memory ops — user deletions are never resurrected (update/expire of a
    // missing id is a no-op).
    const memoryIds: string[] = [];
    for (const m of out.memoryOps) {
      if (m.op === "add") {
        const id = newId();
        await db.insert(coachMemory).values({
          id,
          userId,
          kind: m.kind,
          body: m.text,
          provenance: { source: cause.kind, at: now },
          learnedAt: now,
          expiresAt: m.expiresAt ?? null,
          active: true,
        });
        memoryIds.push(id);
      } else if (m.op === "update") {
        await db.update(coachMemory).set({ body: m.text }).where(and(eq(coachMemory.id, m.id), eq(coachMemory.userId, userId)));
        memoryIds.push(m.id);
      } else {
        await db.update(coachMemory).set({ active: false }).where(and(eq(coachMemory.id, m.id), eq(coachMemory.userId, userId)));
      }
    }

    // A message-cause wake CLOSES any open question (audit finding 9): the
    // user replied in prose — the coach saw the question in its dossier and
    // captured whatever answer arrived via memoryOps. Before this, only the
    // chip endpoint could close a question, so one free-text reply pinned
    // the chips forever and hasOpen blocked every future question.
    if (cause.kind === "message") {
      await db
        .update(coachQuestions)
        .set({ answeredAt: now })
        .where(and(eq(coachQuestions.userId, userId), isNull(coachQuestions.answeredAt)));
    }

    // Question: at most one open; exact-duplicate defense.
    let questionId: string | undefined;
    if (out.question) {
      const open = await db
        .select()
        .from(coachQuestions)
        .where(and(eq(coachQuestions.userId, userId)));
      const hasOpen = open.some((q) => q.answeredAt === null);
      const dup = open.some((q) => q.body.trim().toLowerCase() === out!.question!.text.trim().toLowerCase());
      if (!hasOpen && !dup) {
        questionId = newId();
        await db.insert(coachQuestions).values({
          id: questionId,
          userId,
          body: out.question.text,
          chips: out.question.chips,
          askedAt: now,
        });
      }
    }

    let coachMessageId: string | undefined;
    // A wake may legitimately return no briefing but still move the race
    // narrative or the week's focus — those must not ride on prose existing
    // (audit#3-b #3: raceLine was silently dropped whenever briefing was
    // null, which the prompt explicitly encourages).
    if (out.briefing || out.raceLine || out.focus) {
      coachMessageId = await persistMessage(db, userId, "coach", out.briefing ?? "", {
        memoryIds: memoryIds.length ? memoryIds : undefined,
        questionId,
        focus: out.focus ?? undefined,
        raceLine: out.raceLine ?? undefined,
      });
    }

    await consumeTriggers(db, userId, triggers.map((t) => t.id), now);
    return { status: "ok", coachMessageId, proposalIds };
  } catch {
    await persistWakeFailure(db, userId, "The coach couldn't think just now — try again in a moment.");
    return { status: "error" };
  } finally {
    await releaseUserLock(db, userId, "wake", lock).catch(() => undefined);
  }
}
