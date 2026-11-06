/**
 * THE TRE COURSE: TRE (Tension and Trauma Releasing Exercises, David Berceli) as a fixed sequence, one workout document
 * per session. Pure. The engine and the coach design from principles; this one is prescribed, so its order and doses
 * live here, where a test can hold them to the validator and to the sources. A session is an ordinary document: Today,
 * Plan, the player, the watch and the coach read it as they read any other.
 *
 * WHAT THE SOURCES SAY (TRE College's FAQ; a TRE provider's home-practice guide)
 * - The whole sequence for the first ten sessions; after that the floor alone is often enough.
 * - Up to three sessions a week when new; about 10 minutes of tremor, 10 to 15 at most; 5 can be plenty at the start.
 * - Calf raises and one-leg squats to about 7 out of 10 effort; a wall sit at about 6 out of 10 for five minutes, then a
 *   minute's forward fold; a minute's rest, a minute's hip lift, a minute's rest, then the tremor; about 5 minutes' rest
 *   after.
 * - Feeling worse more than 48 hours later, above 6 out of 10, means too much: go again with half the tremor.
 *
 * THE CHOICES HERE
 * - The wall sit and the tremor build to those doses over the first four sessions rather than starting there (`dosesOf`).
 * - Past the tenth session the tremor keeps building, to the 15-minute cap, by two sessions a step.
 * - The sources stop the calf raises and squats by effort and give no count: 10 to 15 reps is the screen's number and
 *   the cue carries the real stop. They are straight sets, so the player waits for Done.
 * - The folds run on a timer (holds): hands on the floor and head down, nobody can tap Done.
 * - The main part holds only the tremor, no lift: the session counts as mobility.
 */
import type { WorkoutDoc, WorkoutDose, WorkoutItem, WorkoutPart } from "@rg/domain";

/** The sessions that play the whole sequence. */
export const TRE_WHOLE_SEQUENCE_SESSIONS = 10;

const MINUTE = 60;
const EFFORT_REPS: WorkoutDose = { sets: 1, reps: { min: 10, max: 15 }, perSide: true };

/** The session's wall sit and tremor, in seconds. */
function dosesOf(session: number): { wallSitSec: number; tremorSec: number } {
  if (session <= 2) return { wallSitSec: 3 * MINUTE, tremorSec: 5 * MINUTE };
  if (session <= 4) return { wallSitSec: 4 * MINUTE, tremorSec: 7 * MINUTE };
  if (session <= 12) return { wallSitSec: 5 * MINUTE, tremorSec: 10 * MINUTE };
  if (session <= 14) return { wallSitSec: 5 * MINUTE, tremorSec: 12 * MINUTE };
  return { wallSitSec: 5 * MINUTE, tremorSec: 15 * MINUTE };
}

const move = (libraryId: string, dose: WorkoutDose, cue?: string): WorkoutItem => ({
  kind: "exercise",
  libraryId,
  dose: { sets: 1, ...dose },
  ...(cue ? { cue } : {}),
});

const standingParts = (wallSitSec: number): WorkoutPart[] => [
  {
    purpose: "warmup",
    format: "straight",
    why: "Tire the calves and legs, each to your own 7 out of 10.",
    items: [
      move("footEdgeShifts", { reps: 5, perSide: true }),
      move("singleLegCalfRaise", EFFORT_REPS, "Hold a wall for balance. Stop at about 7 out of 10 effort, then shake the leg out."),
      move("supportedOneLegSquat", EFFORT_REPS, "Stop at about 7 out of 10 effort, then shake the leg out."),
    ],
  },
  {
    purpose: "warmup",
    format: "holds",
    why: "Open the hips, then tire the thighs so the tremor can come.",
    items: [
      move("wideForwardFold", { breaths: 12 }, "Three breaths each: middle, left foot, right foot, then reaching under."),
      move("standingPsoasStretch", { breaths: 9 }, "Three breaths each: middle, turned right, turned left."),
      move("highWallSit", { holdSec: wallSitSec }, "Only as low as about 6 out of 10 effort. Slide higher if it climbs."),
      move("hangingForwardFold", { holdSec: MINUTE }),
    ],
  },
];

const floorParts = (tremorSec: number): WorkoutPart[] => [
  {
    purpose: "activation",
    format: "holds",
    why: "Settle on the floor and wake the tremor.",
    items: [
      move("reclinedButterfly", { holdSec: MINUTE }, "Rest with the soles together. Feet flat is fine too."),
      move("bridge", { holdSec: MINUTE }, "Soles together or feet flat. Lift the hips a little and stay for the whole minute."),
      move("reclinedButterfly", { holdSec: MINUTE }, "Rest again, in whichever position you like."),
    ],
  },
  {
    purpose: "main",
    format: "holds",
    why: "Let the tremor come, and stop whenever you want to.",
    items: [move("floorTremor", { holdSec: tremorSec }, "Let it come; don't make it. Stop any time: legs long and feet flexed, or roll onto your side.")],
  },
  {
    purpose: "cooldown",
    format: "holds",
    why: "Rest before you get up.",
    items: [move("legsUp", { holdSec: 5 * MINUTE }, "Just rest, in whatever position is comfortable.")],
  },
];

const NOTES =
  "A fixed sequence: keep the order. The whole sequence for the first 10 sessions, then the floor alone is often enough. " +
  "Up to 3 sessions a week. If you still feel worse after 48 hours, above 6 out of 10, halve the next tremor.";

/** A public video of a practice: what its link says, and where it goes. */
export interface PracticeVideo {
  label: string;
  url: string;
}

/** To watch instead of playing the session here: David Berceli's official instructions, and a follow-along with him. */
const TRE_VIDEOS: readonly PracticeVideo[] = [
  { label: "Full instructions", url: "https://www.youtube.com/watch?v=FeUioDuJjFI" },
  { label: "Follow-along", url: "https://www.youtube.com/watch?v=QoB9wpuO688" },
];

const TRE_SOURCE = /^tre-course:\d+$/;

/**
 * The videos for a document with this `source.ref`: read from the ref, not stored in the document, so offering them
 * revises no planned session (a new revision would take its copy off the watch and send it again).
 */
export const videosOfSource = (ref: string | undefined): readonly PracticeVideo[] => (ref !== undefined && TRE_SOURCE.test(ref) ? TRE_VIDEOS : []);

/**
 * The document for one session of the course, numbered from 1: the whole sequence through session 10, the floor alone
 * after. Throws for anything but a whole number from 1 up.
 */
export function treSessionDoc(session: number): WorkoutDoc {
  if (!Number.isInteger(session) || session < 1) throw new RangeError(`A TRE session is numbered from 1 (got ${session}).`);
  const { wallSitSec, tremorSec } = dosesOf(session);
  const minutes = tremorSec / MINUTE;
  const whole = session <= TRE_WHOLE_SEQUENCE_SESSIONS;
  const lead = whole ? "Tire the legs and hips, then let them tremor on the floor" : "Straight to the floor: let the legs and hips tremor";
  return {
    version: 1,
    title: whole ? `TRE ${session} of ${TRE_WHOLE_SEQUENCE_SESSIONS}` : "TRE · floor",
    intent: {
      summary: `${lead} for ${minutes} minutes, then rest. For looser hips and adductors and a calmer body.`,
      goals: ["recovery", "mobility", "posture"],
      focus: whole ? ["hips", "adductors", "hip-flexors", "quads", "calves"] : ["hips", "adductors", "hip-flexors"],
      effort: whole ? "maintain" : "recover",
    },
    parts: whole ? [...standingParts(wallSitSec), ...floorParts(tremorSec)] : floorParts(tremorSec),
    source: { kind: "studio", ref: `tre-course:${session}` },
    notes: NOTES,
  };
}
