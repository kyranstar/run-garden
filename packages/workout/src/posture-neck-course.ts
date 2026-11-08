/**
 * THE POSTURE AND NECK COURSE: a few minutes of neck and posture work, then a minute of jaw-reset breathing, as a short fixed
 * practice, one workout document per session. Pure. Like TRE's (`tre-course.ts`) its sessions are made here, where a test can
 * hold them to the validator; unlike TRE's they use the library's own moves, which stay general: the day's build may pick them
 * as ever. A session is an ordinary document: Today, Plan, the player and the coach read it as they read any other. Its course
 * keeps it off the watch (`courses.ts`), since it is a few minutes played in the app.
 *
 * WHY THESE MOVES (the condition profile's evidence review, 2026-10-23, in the workout system's principles §12): neck and
 * posture training and breathing are what the review supported, beside the daytime jaw position. So: the deep neck flexors
 * (chin nods), easy neck range (neck rotations), the upper back and shoulders (chair-back thoracic extension, door openers,
 * wall angels), and the jaw-reset breathing. Each needs nothing beyond a wall or a chair, which a bare room and the "Mat only"
 * preset both hold, and each is rated clean for the jaw profile: no clench, no neck load, never face down.
 *
 * THE CHOICES HERE
 * - Two sessions take turns for as long as the course runs, odd and even: the shoulders' (door openers) and the wall's (wall
 *   angels). The course never counts toward an end.
 * - The order goes up from the floor and never back down: the chin nods lying down first, where the athlete starts before the
 *   player does; then sitting, for the neck rotations and the chair-back thoracic extension; then standing, for the turn's own
 *   upper-back move; then the breathing.
 * - Every move runs on a timer, hands free, as holds: each but the first changes position, so each has a hold's 8 s get-ready
 *   rather than a flow's 3. In the player the shoulders' turn takes 390 s and the wall's 370 s, about 6 minutes each.
 * - Doses are the records' own: a reps move plays its record's middle, as a record with no stated amount reads (`deriveDoc`),
 *   so the player's window, the calendar's length and the record agree. Neck rotations alternate, so theirs is each side's. The
 *   breathing is the low end of its record's time, a minute.
 * - A calm session (`recover`), so a flare day asks nothing different of it. It counts as mobility: the calm moves (the
 *   rotations, the extension, the breathing) outweigh the activation moves in every session, eased or not, so it is never
 *   booked as a lift.
 * - Easing a session leaves out the turn's standing move, the one with most effort: the short one takes 322 s in the player,
 *   about 5 minutes. The sessions carry no notes: the course's rule is said once, in its plan's brief (`courses.ts`).
 */
import type { WorkoutDoc, WorkoutDose, WorkoutItem, WorkoutPart } from "@rg/domain";

/** The course's name, which its sessions' titles begin with. */
export const POSTURE_NECK_NAME = "Posture & neck";

const move = (libraryId: string, dose: WorkoutDose): WorkoutItem => ({ kind: "exercise", libraryId, dose: { sets: 1, ...dose } });

const CHIN_NODS = move("chinNodHold", { reps: 7 });
const NECK_ROTATIONS = move("neckRotations", { reps: 7, perSide: true });
const CHAIR_EXTENSION = move("chairThoracicExtension", { reps: 10 });
const BREATHING = move("breath", { holdSec: 60 });

/** The two turns: the standing upper-back move each adds, and what its title and summary call it. */
const TURNS = [
  { name: "door openers", move: move("doorOpeners", { reps: 10 }), says: "open the upper back and shoulders" },
  { name: "wall angels", move: move("wallAngels", { reps: 8 }), says: "open the upper back at the wall" },
] as const;

const warmup: WorkoutPart = {
  purpose: "warmup",
  format: "holds",
  why: "Wake the deep neck muscles lying down, then loosen the neck sitting up.",
  items: [CHIN_NODS, NECK_ROTATIONS],
};
const cooldown: WorkoutPart = { purpose: "cooldown", format: "holds", why: "Settle the jaw before you go on with your day.", items: [BREATHING] };

/**
 * The document for one session of the course, numbered from 1: the shoulders' turn for an odd one, the wall's for an even one,
 * or the short one when `ease` is set. Throws for anything but a safe whole number from 1 up.
 */
export function postureNeckSessionDoc(session: number, { ease = false }: { ease?: boolean } = {}): WorkoutDoc {
  if (!Number.isSafeInteger(session) || session < 1) throw new RangeError(`A posture and neck session is numbered from 1 (got ${session}).`);
  const source = { kind: "studio" as const, ref: `posture-neck-course:${session}` };
  if (ease) {
    return {
      version: 1,
      title: `${POSTURE_NECK_NAME} · short`,
      intent: {
        summary: "The short one: wake the deep neck muscles, loosen the neck and the upper back, then a minute of jaw-reset breathing.",
        goals: ["posture", "mobility", "condition-care"],
        focus: ["neck", "upper-back", "thoracic", "jaw"],
        effort: "recover",
      },
      parts: [warmup, { purpose: "main", format: "holds", why: "Open the upper back, sitting.", items: [CHAIR_EXTENSION] }, cooldown],
      source,
    };
  }
  const turn = TURNS[(session - 1) % TURNS.length]!;
  return {
    version: 1,
    title: `${POSTURE_NECK_NAME} · ${turn.name}`,
    intent: {
      summary: `Wake the deep neck muscles, loosen the neck, ${turn.says}, then a minute of jaw-reset breathing.`,
      goals: ["posture", "mobility", "condition-care"],
      focus: ["neck", "upper-back", "thoracic", "shoulders", "jaw"],
      effort: "recover",
    },
    parts: [
      warmup,
      { purpose: "main", format: "holds", why: "Open the upper back sitting, then standing.", items: [CHAIR_EXTENSION, turn.move] },
      cooldown,
    ],
    source,
  };
}
