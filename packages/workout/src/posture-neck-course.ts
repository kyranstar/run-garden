/**
 * THE POSTURE AND NECK COURSE: a few minutes of neck and posture work, then a minute of jaw-reset breathing, as a short fixed
 * practice, one workout document per session. Pure. Like TRE's (`tre-course.ts`) its sessions are made here, where a test can
 * hold them to the validator; unlike TRE's they use the library's own moves, which stay general: the day's build may pick them
 * as ever. A session is an ordinary document: Today, Plan, the player and the coach read it as they read any other. Its course
 * keeps it off the watch (`courses.ts`), since it is a few minutes played in the app.
 *
 * WHY THESE MOVES (the condition profile's evidence review, 2026-10-23, in the workout system's principles §12): neck and
 * posture training and breathing are what the review supported, beside the daytime jaw position. So: the deep neck flexors
 * (chin nods), the upper back and shoulders (chair-back thoracic extension, door openers, wall angels), easy neck range (neck
 * rotations), and the jaw-reset breathing. Each needs nothing beyond a wall or a chair, and each is rated clean for the jaw
 * profile: no clench, no neck load, never face down.
 *
 * THE CHOICES HERE
 * - Two sessions take turns for as long as the course runs, odd and even: the shoulders' (door openers) and the wall's (wall
 *   angels). Each is a warm start of neck rotations, the chair-back thoracic extension, its own upper-back move and the chin
 *   nods, then a minute of the breathing: about 7 minutes. The course never counts toward an end.
 * - Doses are the records' own: a reps move plays its record's middle, as a record with no stated amount reads (`deriveDoc`),
 *   so the player's window, the calendar's length and the record agree. Neck rotations alternate, so theirs is each side's. The
 *   breathing is the low end of its record's time, a minute.
 * - Every part runs on a timer (a flow, and the breathing a hold): hands free, lying down for the chin nods and arms up the
 *   wall for the angels. A calm session (`recover`), so a flare day asks nothing different of it.
 * - It counts as mobility: the calm moves (the rotations, the extension, the breathing) outweigh the activation moves in every
 *   session, eased or not, so it is never booked as a lift.
 * - Easing a session plays the short one, about 5 minutes: the warm start, the chin nods and the breathing, the upper-back work
 *   left for the next. The sessions carry no notes: the course's rule is said once, in its plan's brief (`courses.ts`).
 */
import type { WorkoutDoc, WorkoutDose, WorkoutItem, WorkoutPart } from "@rg/domain";

/** The course's name, which its sessions' titles begin with. */
export const POSTURE_NECK_NAME = "Posture & neck";

const move = (libraryId: string, dose: WorkoutDose): WorkoutItem => ({ kind: "exercise", libraryId, dose: { sets: 1, ...dose } });

const NECK_ROTATIONS = move("neckRotations", { reps: 7, perSide: true });
const CHAIR_EXTENSION = move("chairThoracicExtension", { reps: 10 });
const CHIN_NODS = move("chinNodHold", { reps: 7 });
const BREATHING = move("breath", { holdSec: 60 });

/** The two turns: the upper-back move each adds, and what its title and summary call it. */
const TURNS = [
  { name: "door openers", move: move("doorOpeners", { reps: 10 }), where: "open the upper back and shoulders" },
  { name: "wall angels", move: move("wallAngels", { reps: 8 }), where: "open the upper back at the wall" },
] as const;

const warmup: WorkoutPart = { purpose: "warmup", format: "flow", why: "Loosen the neck, in easy range.", items: [NECK_ROTATIONS] };
const cooldown: WorkoutPart = { purpose: "cooldown", format: "holds", why: "Settle the jaw before you get up.", items: [BREATHING] };

/**
 * The document for one session of the course, numbered from 1: the shoulders' turn for an odd one, the wall's for an even one,
 * or the short one when `ease` is set. Throws for anything but a whole number from 1 up.
 */
export function postureNeckSessionDoc(session: number, { ease = false }: { ease?: boolean } = {}): WorkoutDoc {
  if (!Number.isSafeInteger(session) || session < 1) throw new RangeError(`A posture and neck session is numbered from 1 (got ${session}).`);
  const source = { kind: "studio" as const, ref: `posture-neck-course:${session}` };
  if (ease) {
    return {
      version: 1,
      title: `${POSTURE_NECK_NAME} · short`,
      intent: {
        summary: "The short one: loosen the neck and train the deep neck muscles, then a minute of jaw-reset breathing.",
        goals: ["posture", "mobility", "condition-care"],
        focus: ["neck", "jaw"],
        effort: "recover",
      },
      parts: [warmup, { purpose: "main", format: "flow", why: "Train the deep neck muscles.", items: [CHIN_NODS] }, cooldown],
      source,
    };
  }
  const turn = TURNS[(session - 1) % TURNS.length]!;
  return {
    version: 1,
    title: `${POSTURE_NECK_NAME} · ${turn.name}`,
    intent: {
      summary: `Loosen the neck, ${turn.where}, train the deep neck muscles, then a minute of jaw-reset breathing.`,
      goals: ["posture", "mobility", "condition-care"],
      focus: ["neck", "upper-back", "thoracic", "shoulders", "jaw"],
      effort: "recover",
    },
    parts: [
      warmup,
      { purpose: "main", format: "flow", why: "Open the upper back, then train the deep neck muscles.", items: [CHAIR_EXTENSION, turn.move, CHIN_NODS] },
      cooldown,
    ],
    source,
  };
}
