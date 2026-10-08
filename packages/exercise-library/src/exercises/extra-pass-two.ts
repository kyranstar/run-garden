// Library expansion, second pass: floor strength, hip mobility and cool-downs.
import { defineExercises } from "../define.js";

export const EXTRA_PASS_TWO = defineExercises([
  {
    id: "reversePlank",
    name: "Reverse plank",
    family: "reversePlank",
    patterns: ["hinge"],
    regions: ["glutes", "hamstrings", "shoulders"],
    roles: ["accessory", "activation"],
    position: "supine",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "time", range: [15, 30], sets: [2, 3], restSec: 45 },
    conditions: { tmj: { clench: 1, neckLoad: 1, faceDown: false } },
    difficulty: 3,
    easier: ["bridge"],
    text: {
      summary: "Sit with legs long and hands behind you, then lift the hips until the body is one straight line and hold.",
      setup: [
        "Sit with the legs out straight in front of you, feet together.",
        "Put the hands on the floor a little behind the hips, fingers toward the feet or out to the sides — whichever the wrists prefer."
      ],
      steps: [
        "Press through the hands and heels to lift the hips until shoulders, hips and ankles line up.",
        "Squeeze the glutes to hold the hips up rather than arching the low back.",
        "Hold, breathing steadily.",
        "Lower the hips to the floor with control."
      ],
      focus: ["One straight line from shoulders to heels.", "Chest open, shoulders drawn away from the ears."],
      mistakes: ["Letting the hips sag as the hold goes on.", "Dropping the head back.", "Locking the elbows hard."],
      breathing: "Slow breaths through the nose for the whole hold.",
      conditions: {
        tmj: "Keep the head in line with the body (letting it drop back strains the neck) and the teeth apart; bend the knees into a tabletop if you start to grit."
      },
      why: "Works the whole back of the body and opens the front of the shoulders in one simple hold."
    }
  },
  {
    id: "pushupPullThrough",
    name: "Push-up pull-through",
    family: "plankDrag",
    patterns: ["anti-rotate"],
    regions: ["core", "shoulders", "chest"],
    roles: ["accessory"],
    equipment: { oneOf: ["kettlebell", "dumbbells"] },
    position: "quadruped",
    laterality: "alternating",
    load: "bodyweight",
    dose: { type: "reps", range: [6, 10], sets: [2, 3], restSec: 60 },
    conditions: { tmj: { clench: 2, neckLoad: 1, faceDown: false } },
    difficulty: 4,
    text: {
      summary: "From a high plank beside a weight, reach under your body and drag it across, then do a push-up.",
      setup: [
        "Set a light kettlebell or dumbbell on the floor just beside one hand.",
        "Take a high plank with the hands under the shoulders and the feet a little wider than hip-width."
      ],
      steps: [
        "Shift your weight onto one hand without letting the hips turn.",
        "With the free hand, reach beneath your chest, grab the weight and pull it over to the far side.",
        "Put the hand back down, settle the plank and do one push-up.",
        "Drag the weight back with the other hand; each drag is one rep."
      ],
      focus: [
        "Hips stay level, as if balancing a glass on the low back.",
        "Leave out the push-up and just hold the plank between drags if it costs you the level hips."
      ],
      mistakes: ["Twisting the hips up toward the reaching hand.", "Rushing the drag.", "Letting the low back sag."],
      breathing: "Exhale as you reach and drag, inhale as the hand comes back.",
      conditions: {
        tmj: "A three-point plank invites bracing through the face; use a lighter weight or leave out the push-up if the jaw tightens."
      },
      why: "Trains the trunk to resist twisting while the shoulders hold you up."
    }
  },
  {
    id: "seatedHipHinge",
    name: "Seated hip hinge",
    family: "hingePattern",
    patterns: ["hinge", "mobility"],
    regions: ["hips", "hamstrings"],
    roles: ["warmup", "mobility"],
    equipment: { oneOf: ["chair", "bench"] },
    position: "seated",
    laterality: "bilateral",
    load: "none",
    dose: { type: "reps", range: [8, 12], secsPerRep: 6 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    harder: ["hingeDrill"],
    tags: ["desk-relief"],
    text: {
      summary: "Sit near the front of a chair, feet wide, and tip the chest forward from the hips with a long back.",
      setup: [
        "Sit toward the front edge of a sturdy chair or bench with the feet wide and turned out a little.",
        "Cross the arms over the chest or rest the hands on the thighs."
      ],
      steps: [
        "Sit tall, then tip the chest forward by folding at the hips, keeping the back long.",
        "Go until the inner thighs and the backs of the hips stretch, or until the back starts to round.",
        "Pause, then press the feet down and come back to sitting tall.",
        "Repeat slowly."
      ],
      focus: ["The fold happens at the hip creases, not the waist.", "Knees stay out over the feet."],
      mistakes: ["Rounding the back to reach lower.", "Letting the knees fall in.", "Craning the neck to look forward."],
      breathing: "Inhale as you sit tall, exhale as you fold.",
      conditions: { tmj: "Seated and unloaded; let the gaze follow the chest down so the neck stays long and the jaw stays easy." },
      why: "Teaches the hip hinge and opens the hips with no balance demand — a gentle start after hours at a desk."
    }
  },
  {
    id: "kneeToChestSwing",
    name: "Knee-to-chest swing",
    family: "kneeToChest",
    patterns: ["mobility"],
    regions: ["low-back", "hips"],
    roles: ["cooldown", "downshift"],
    position: "supine",
    laterality: "bilateral",
    load: "none",
    dose: { type: "time", range: [60, 120] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "On your back, draw the knees toward the chest and let them sway in small circles or from side to side.",
      setup: [
        "Lie face up on a mat with the head resting; a folded towel under it is fine.",
        "Draw both knees toward the chest and hold them, a hand on each knee or the arms around the shins."
      ],
      steps: [
        "Let the knees drift a little from side to side so the low back rolls gently on the floor.",
        "Change to small circles, one way and then the other, if that feels better.",
        "Keep it small and slow, like rocking to sleep.",
        "Lower the feet to the floor to finish."
      ],
      focus: ["Head and shoulders stay heavy on the floor.", "Tiny is plenty."],
      mistakes: ["Pulling the knees in hard.", "Lifting the head to watch the knees."],
      breathing: "Long, slow exhales; let each one soften the low back.",
      conditions: { tmj: "The head rests the whole time — a good moment to let the tongue rest on the roof of the mouth and the teeth part." },
      why: "Eases a stiff low back and helps the body wind down."
    }
  },
  {
    id: "supineHipShake",
    name: "Supine hip shake · hands under sacrum",
    family: "hipShake",
    patterns: ["mobility"],
    regions: ["hips", "low-back"],
    roles: ["cooldown", "downshift"],
    position: "supine",
    laterality: "bilateral",
    load: "none",
    dose: { type: "time", range: [45, 90] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "On your back with hands under the base of the spine, let the arms jiggle the hips loose while the legs relax.",
      setup: [
        "Lie face up with the legs long, or the knees bent and the feet on the floor.",
        "Slide the hands, palms down, under the sacrum — the flat bone at the base of the spine."
      ],
      steps: [
        "Let the legs go heavy and loose.",
        "Make small, quick movements with the hands and arms so the pelvis rocks and wobbles from side to side.",
        "Let the wobble spread into the hips, belly and thighs without helping it.",
        "Stop, rest the arms by your sides, and notice the hips settle."
      ],
      focus: ["The arms do the work; the hips and legs stay passive.", "Small and loose, not big and forceful."],
      mistakes: ["Tensing the legs to make the movement happen.", "Holding the breath."],
      breathing: "Easy breathing; a sigh out through the mouth is welcome.",
      conditions: { tmj: "Nothing here for the jaw to do: lips softly closed, teeth apart, while the hips shake loose." },
      why: "A quick way to let go of tension held in the hips and belly at the end of a session."
    }
  },
  {
    id: "activePigeonLegLift",
    name: "Active pigeon · back-leg lift",
    family: "pigeon",
    patterns: ["mobility"],
    regions: ["glutes", "hips"],
    roles: ["mobility", "activation"],
    position: "seated",
    laterality: "unilateral",
    load: "none",
    dose: { type: "reps", range: [5, 8], secsPerRep: 5 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    text: {
      summary: "In pigeon pose, lift the straight back leg a little off the floor, hold briefly, and lower.",
      setup: [
        "From hands and knees, bring one knee forward behind the same-side wrist and lay the shin across; reach the other leg straight back.",
        "Stay up on the hands with the chest tall; a folded towel under the front hip helps if it floats."
      ],
      steps: [
        "Tighten the back-leg glute and raise the knee and thigh a few centimetres off the floor.",
        "Hold for 2–3 seconds without twisting the hips.",
        "Lower with control.",
        "Finish the reps, then switch sides."
      ],
      focus: ["The lift comes from the glute, not from arching the low back.", "Small lifts are enough."],
      mistakes: ["Rolling the hips open to get the leg higher.", "Arching the low back.", "Sinking into the hands."],
      breathing: "Exhale as you lift, inhale as you lower.",
      conditions: { tmj: "Effort in the hip can creep into the jaw; keep the lifts small and the face soft." },
      why: "Pairs the hip opening of pigeon with glute work at the end of the range, so the hip gets strong where it stretches."
    }
  }
]);
