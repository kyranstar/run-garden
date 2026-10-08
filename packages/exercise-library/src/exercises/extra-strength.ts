// Library expansion: squat, lunge, hinge, push, and pull strength, loaded and bodyweight.
import { defineExercises } from "../define.js";

export const EXTRA_STRENGTH = defineExercises([
  {
    id: "bulgarianSplitSquat",
    name: "Bulgarian split squat",
    family: "splitSquat",
    patterns: ["lunge"],
    regions: ["quads", "glutes"],
    roles: ["core", "accessory"],
    equipment: { all: ["bench"], oneOf: ["kettlebell", "dumbbells"] },
    position: "standing",
    laterality: "unilateral",
    load: "external",
    dose: { type: "reps", range: [6, 10], sets: [2, 3], restSec: 75, startKg: 8 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 4,
    providers: { coros: { key: "T1164", confidence: "exact", method: "curated" } }, // COROS: Split Bench Squat
    easier: ["bwBulgarianSplitSquat"],
    text: {
      summary: "Back foot on a bench, weight at your chest or sides; lower straight down on the front leg and drive up.",
      setup: [
        "Stand a long stride in front of a bench and rest the top of the back foot on it.",
        "Hold a kettlebell at the chest, or a dumbbell in each hand at your sides (log the weight per hand)."
      ],
      steps: [
        "Lower straight down until the back knee hovers above the floor.",
        "Keep most of the weight in the front foot, heel planted.",
        "Drive up through the front foot to stand.",
        "Finish the reps, then switch sides."
      ],
      focus: ["Straight down, not forward.", "The front knee tracks over the middle toes."],
      mistakes: ["A stance so short the front heel lifts.", "Pushing off the back foot.", "Holding the breath on the way up."],
      breathing: "Inhale down, exhale up.",
      conditions: { tmj: "Hard single-leg work invites gritting; go lighter if the jaw starts to join in on the way up." },
      why: "The strongest single-leg option here: builds legs and hips with modest load."
    }
  },
  {
    id: "bwBulgarianSplitSquat",
    name: "Bulgarian split squat · bodyweight",
    family: "splitSquat",
    patterns: ["lunge"],
    regions: ["quads", "glutes"],
    roles: ["core", "accessory"],
    equipment: { oneOf: ["bench", "chair"] },
    position: "standing",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [6, 10], sets: [2, 3], restSec: 60 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 3,
    providers: { coros: { key: "T1164", confidence: "close", method: "curated" } }, // COROS: Split Bench Squat; the loaded one holds the exact key
    easier: ["bwSplitSquat"],
    harder: ["bulgarianSplitSquat"],
    text: {
      summary: "Back foot on a bench or chair, lower straight down on the front leg and stand back up.",
      setup: [
        "Stand a long stride in front of a bench or sturdy chair and rest the top of the back foot on the seat.",
        "Keep a wall or a second chair within reach for balance."
      ],
      steps: [
        "Lower straight down until the back knee hovers above the floor.",
        "Keep the front heel planted.",
        "Drive up through the front foot.",
        "Finish the reps, then switch sides."
      ],
      focus: ["Most of the weight stays in the front leg.", "Tall chest; balance support is allowed."],
      mistakes: ["Standing too close to the bench.", "Letting the front knee cave in."],
      breathing: "Inhale down, exhale up.",
      conditions: { tmj: "Use the balance support so steadying yourself doesn't turn into bracing the jaw." },
      why: "Builds single-leg strength with no equipment beyond a seat."
    }
  },
  {
    id: "wallSit",
    name: "Wall sit",
    family: "wallSit",
    patterns: ["squat"],
    regions: ["quads", "glutes"],
    roles: ["core", "accessory"],
    equipment: { all: ["wall"] },
    position: "standing",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "time", range: [30, 60], sets: [2, 3], restSec: 45 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    providers: { coros: { key: "T1231", confidence: "exact", method: "curated" } }, // COROS: Wall Sit
    text: {
      summary: "Back against a wall, slide down until the knees are bent, and hold while breathing slowly.",
      setup: [
        "Stand with your back flat against a wall, feet hip-width and about a foot-length in front of you.",
        "For more thigh work, rest the heels on a thin book or folded mat."
      ],
      steps: [
        "Slide down the wall until the knees are bent to a depth you can hold — no lower than thighs level with the floor.",
        "Keep the knees over the toes and the weight across the whole foot.",
        "Hold, breathing slowly.",
        "Slide back up the wall to finish."
      ],
      focus: ["Back and head rest on the wall.", "Pick a depth you can hold with an easy face."],
      mistakes: ["Knees drifting in.", "Pressing the hands into the thighs.", "Holding the breath as it burns."],
      breathing: "Slow nasal breathing; long holds make breath-holding tempting.",
      conditions: { tmj: "Long holds invite clenching — keep the teeth apart, and go shallower if you catch yourself gritting." },
      why: "Builds leg endurance with no load and no balance demand."
    }
  },
  {
    id: "splitSquatHold",
    name: "Split-squat hold",
    family: "splitSquat",
    patterns: ["lunge"],
    regions: ["quads", "glutes"],
    roles: ["core", "accessory"],
    position: "standing",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "time", range: [20, 40], sets: [2, 3], restSec: 30 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    harder: ["bwSplitSquat"],
    text: {
      summary: "Step into a split stance, lower until the back knee hovers, and hold still.",
      setup: [
        "Take a long split stance; pad the floor under the back knee.",
        "Keep a wall or chair within reach for balance."
      ],
      steps: [
        "Lower until the back knee hovers just above the floor and the front knee is bent to about 90°.",
        "Keep the weight in the front foot and the torso tall.",
        "Hold, breathing slowly.",
        "Stand up before switching sides."
      ],
      focus: ["Still and steady.", "The front knee stays over the middle toes."],
      mistakes: ["Leaning the chest forward over the knee.", "Resting the back knee on the floor."],
      breathing: "Slow nasal breathing throughout the hold.",
      conditions: {
        tmj: "Holds make it easy to grit through the burn; keep the teeth apart and come up a little if the jaw tightens."
      },
      why: "Builds single-leg strength with a simple, steady hold that fits in anywhere."
    }
  },
  {
    id: "hamstringBridgeChair",
    name: "Hamstring bridge · heels on chair",
    family: "hamstringBridge",
    patterns: ["hinge"],
    regions: ["hamstrings", "glutes"],
    roles: ["core", "accessory"],
    equipment: { oneOf: ["chair", "bench"] },
    position: "supine",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [8, 12], sets: [2, 3], restSec: 45, secsPerRep: 4 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    easier: ["bridge"],
    text: {
      summary: "Lying on your back with heels on a chair seat, press down through the heels and lift the hips.",
      setup: [
        "Lie on your back with your heels on a chair seat or bench, knees slightly bent; set the chair against a wall so it can't slide.",
        "Arms by your sides, head resting on the floor or a folded towel."
      ],
      steps: [
        "Press the heels down into the seat and lift the hips until knees, hips, and shoulders line up.",
        "Pause at the top.",
        "Lower slowly.",
        "Repeat at the same steady pace."
      ],
      focus: ["The backs of the thighs do the lifting.", "Ribs stay down at the top."],
      mistakes: ["Arching the low back to get higher.", "Pushing the head into the floor.", "Rushing the lowering."],
      breathing: "Exhale as you lift, inhale as you lower.",
      conditions: { tmj: "The head rests; there's nothing for the jaw to do." },
      why: "Strengthens the hamstrings and glutes, which helps the pelvis sit better after long sitting."
    }
  },
  {
    id: "slRdlKneeDrive",
    name: "Single-leg RDL to knee drive",
    family: "singleLegHinge",
    patterns: ["hinge"],
    regions: ["hamstrings", "glutes", "ankles"],
    roles: ["core", "accessory"],
    position: "standing",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [6, 10], sets: [2, 3], restSec: 45, secsPerRep: 4 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 3,
    easier: ["slRdlReach"],
    text: {
      summary: "Hinge forward on one leg as the other reaches back, then stand and drive that knee up to hip height.",
      setup: ["Stand on one leg with a soft knee; keep a wall or chair within reach.", "Arms relaxed by your sides."],
      steps: [
        "Hinge forward from the hip as the free leg reaches straight back, until you feel the standing hamstring load.",
        "Drive the hips forward to stand, bringing the free knee up in front to hip height.",
        "Pause, balanced, for a moment.",
        "Finish the reps, then switch sides."
      ],
      focus: ["Hips stay level through the hinge.", "Tall and still at the top."],
      mistakes: ["Rounding the back to reach lower.", "Rushing so the balance goes."],
      breathing: "Inhale as you hinge, exhale as you drive up.",
      conditions: {
        tmj: "Look at the floor a couple of metres ahead; balance comes from the foot and hip, not from clamping the jaw."
      },
      why: "Builds hamstrings and single-leg balance and finishes in a tall, running posture."
    }
  },
  {
    id: "suitcaseDeadlift",
    name: "Suitcase deadlift",
    family: "deadlift",
    patterns: ["hinge"],
    regions: ["hamstrings", "glutes", "core"],
    roles: ["core", "accessory"],
    equipment: { oneOf: ["kettlebell", "dumbbells"] },
    position: "standing",
    laterality: "unilateral",
    load: "external",
    dose: { type: "reps", range: [6, 10], sets: [2, 3], restSec: 60, startKg: 12 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    text: {
      summary: "Deadlift a single weight held at one side, standing tall without leaning toward it.",
      setup: [
        "Stand with feet hip-width and the weight beside one foot.",
        "Hinge down with soft knees and a long spine to grip the handle."
      ],
      steps: [
        "Push the floor away and stand tall, the weight hanging at your side.",
        "Keep the shoulders level; don't lean toward or away from the weight.",
        "Hinge back down with control and touch the weight lightly to the floor.",
        "Finish the reps, then switch sides."
      ],
      focus: ["Hips back on the way down; the spine stays long.", "The loaded shoulder stays down, away from the ear."],
      mistakes: ["Leaning toward the weight.", "Rounding the back to reach the floor.", "Shrugging at the top."],
      breathing: "Inhale at the bottom, exhale as you stand.",
      conditions: { tmj: "Grip only as hard as you need; a death grip tends to spread to the jaw." },
      why: "A hinge and a side-bend resistance in one, with modest load."
    }
  },
  {
    id: "doorframeRow",
    name: "Doorframe row",
    family: "bodyweightRow",
    patterns: ["pull-h"],
    regions: ["upper-back", "lats", "arms"],
    roles: ["core", "accessory"],
    equipment: { all: ["wall"] },
    position: "standing",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [8, 12], sets: [2, 3], restSec: 30 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    harder: ["towelDoorRow"],
    tags: ["desk-relief"],
    text: {
      summary: "Hold a door frame with one hand, lean back, and row your chest toward it.",
      setup: [
        "Stand facing the edge of an open doorway or a sturdy post, feet close to it.",
        "Grip the frame with one hand at chest height."
      ],
      steps: [
        "Lean back until the arm is straight and the body is at a slight angle.",
        "Row the chest toward the hand, drawing the shoulder blade back.",
        "Lower slowly until the arm is long again.",
        "Finish the reps, then switch sides."
      ],
      focus: ["The closer the feet are to the frame, the harder the row.", "The body stays in one line from head to heels."],
      mistakes: ["Shrugging the shoulder toward the ear.", "Twisting the torso to cheat the rep."],
      breathing: "Exhale as you row, inhale as you lower.",
      conditions: { tmj: "Head in line with the spine and teeth apart — rows invite a shrug-and-clench." },
      why: "A row you can do anywhere with a doorway, so the mid-back gets stronger and the neck does less postural work."
    }
  },
  {
    id: "towelDoorRow",
    name: "Towel door row",
    family: "bodyweightRow",
    patterns: ["pull-h"],
    regions: ["upper-back", "lats", "arms"],
    roles: ["core", "accessory"],
    equipment: { all: ["towel"] },
    position: "standing",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [8, 12], sets: [2, 3], restSec: 45 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    easier: ["doorframeRow"],
    harder: ["tableRow"],
    tags: ["desk-relief"],
    text: {
      summary: "Loop a towel around both handles of an open door, lean back, and row your chest to the door's edge.",
      setup: [
        "Open a solid door and loop a strong towel around both handles so it wraps the door's edge.",
        "Stand facing the edge with a foot on each side of the door and hold one end of the towel in each hand."
      ],
      steps: [
        "Lean back until the arms are straight; test with a gentle lean first.",
        "Row the chest toward the door's edge, drawing the shoulder blades back.",
        "Lower slowly until the arms are long.",
        "Repeat; walk the feet closer to the door to make it harder."
      ],
      focus: ["The body stays in one straight line.", "Elbows travel back past the ribs."],
      mistakes: ["Using a loose handle or a flimsy door.", "Letting the hips sag.", "Shrugging at the top."],
      breathing: "Exhale as you row, inhale as you lower.",
      conditions: { tmj: "Keep the chin tucked and the teeth apart; don't reach toward the door with the head." },
      why: "A two-arm bodyweight row at home, no special equipment needed."
    }
  },
  {
    id: "tableRow",
    name: "Table row",
    family: "invertedRow",
    patterns: ["pull-h"],
    regions: ["upper-back", "lats", "arms"],
    roles: ["core", "accessory"],
    equipment: { all: ["bench"] },
    position: "supine",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [5, 10], sets: [2, 3], restSec: 60 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 3,
    easier: ["towelDoorRow"],
    text: {
      summary: "Lie under a sturdy table, grip its edge, and pull your chest up toward it with the body straight.",
      setup: [
        "Use a heavy, stable table that can't tip — test it first — or at the gym a bar set about hip height in a rack.",
        "Lie underneath with the edge above your chest and grip it shoulder-width; knees bent and feet flat to start."
      ],
      steps: [
        "Lift the hips so the body is straight from knees to head.",
        "Pull the chest up toward the edge, drawing the shoulder blades together.",
        "Lower slowly until the arms are straight.",
        "Repeat; straighten the legs to make it harder."
      ],
      focus: ["The chest leads; the chin stays tucked.", "Hips stay up in line with the body."],
      mistakes: ["Reaching the chin toward the table.", "Letting the hips sag.", "Using a light or wobbly table."],
      breathing: "Exhale as you pull, inhale as you lower.",
      conditions: { tmj: "Keep the head in line with the body; reaching with the chin drags the jaw forward." },
      why: "The hardest bodyweight row here: real pulling strength for the mid-back without weights."
    }
  },
  {
    id: "towelIsoRow",
    name: "Seated towel row hold",
    family: "isoRow",
    patterns: ["pull-h"],
    regions: ["upper-back", "lats"],
    roles: ["activation", "accessory"],
    equipment: { all: ["towel"] },
    position: "seated",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "time", range: [30, 40], sets: [2, 3], restSec: 30 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    harder: ["towelDoorRow"],
    tags: ["desk-relief"],
    text: {
      summary: "Sit with a towel around your feet and row against it, holding a steady squeeze in the upper back.",
      setup: [
        "Sit on the floor with the legs out in front (knees bent if the hamstrings are tight).",
        "Loop a towel around the soles of both feet and hold one end in each hand."
      ],
      steps: [
        "Sit tall and row the elbows back until the hands reach the lower ribs.",
        "Press the feet forward into the towel so nothing moves.",
        "Hold at about half effort, squeezing the shoulder blades together and down.",
        "Relax slowly when the timer ends."
      ],
      focus: ["Steady, moderate effort — never a max pull.", "Shoulders down, away from the ears."],
      mistakes: ["Leaning back to pull harder.", "Shrugging.", "Holding the breath."],
      breathing: "Keep breathing slowly through the nose during the hold.",
      conditions: {
        tmj: "Isometric holds are where clenching hides; keep the tongue up and ease the effort if the jaw tightens."
      },
      why: "A row with no anchor needed: it works the mid-back anywhere you can sit on the floor."
    }
  },
  {
    id: "bandRow",
    name: "Band row",
    family: "row",
    patterns: ["pull-h"],
    regions: ["upper-back", "lats", "arms"],
    roles: ["core", "accessory"],
    equipment: { all: ["band"] },
    position: "seated",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [10, 15], sets: [2, 3], restSec: 45 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    harder: ["supportedRow"],
    tags: ["desk-relief"],
    text: {
      summary: "Seated with a band around your feet, row the ends back to your ribs and return slowly.",
      setup: [
        "Sit tall with the legs out in front and loop the band around the soles of your feet (or anchor it at chest height and stand).",
        "Hold an end in each hand with the arms straight."
      ],
      steps: [
        "Row the elbows back past the ribs, drawing the shoulder blades together.",
        "Pause for a moment.",
        "Return slowly until the arms are long.",
        "Repeat at a steady pace."
      ],
      focus: ["The torso stays still and tall.", "Shoulders down."],
      mistakes: ["Rocking back to move the band.", "Shrugging at the end of the pull."],
      breathing: "Exhale as you row, inhale as you return.",
      conditions: { tmj: "No effort in the face; chin level and jaw loose." },
      why: "An easy, portable row for the mid-back that suits desk days."
    }
  },
  {
    id: "kneelingPushup",
    name: "Kneeling push-up",
    family: "pushup",
    patterns: ["push-h"],
    regions: ["chest", "shoulders", "arms", "core"],
    roles: ["core", "accessory"],
    position: "kneeling",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [6, 12], sets: [2, 3], restSec: 45 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    providers: { coros: { key: "T1184", confidence: "exact", method: "curated" } }, // COROS: Kneeling Push-Ups
    easier: ["wallPushup"],
    harder: ["pushup"],
    text: {
      summary: "Push-up from the knees with the body in one line from knees to head.",
      setup: [
        "Kneel on a mat and place the hands slightly wider than the shoulders.",
        "Walk the hands forward until the body forms a straight line from knees to head."
      ],
      steps: [
        "Lower the chest between the hands, elbows at about 45° from the body.",
        "Pause just above the floor.",
        "Press the floor away to return.",
        "Repeat with the same line each rep."
      ],
      focus: ["Hips stay in line with the body.", "Eyes on the floor a little ahead of the hands."],
      mistakes: ["Piking the hips up.", "Flaring the elbows straight out.", "Dropping the head toward the floor."],
      breathing: "Inhale down, exhale as you press.",
      conditions: { tmj: "Keep the neck long and the jaw quiet; end the set before you start grimacing." },
      why: "The step between incline and full push-ups, doable anywhere with a mat."
    }
  },
  {
    id: "oneArmBenchPress",
    name: "One-arm bench press",
    family: "press",
    patterns: ["push-h"],
    regions: ["chest", "shoulders", "arms"],
    roles: ["core", "accessory"],
    equipment: { all: ["bench"], oneOf: ["kettlebell", "dumbbells"] },
    position: "supine",
    laterality: "unilateral",
    load: "external",
    dose: { type: "reps", range: [6, 10], sets: [2, 3], restSec: 60, startKg: 8 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 3,
    providers: { coros: { key: "T1302", confidence: "close", method: "curated" } }, // COROS: Dumbbell Bench Press: ours is one arm
    easier: ["floorPress"],
    text: {
      summary: "Lie on a bench and press one weight up from the chest while the body stays still.",
      setup: [
        "Lie on a flat bench with feet planted and the head supported.",
        "Hold the weight at the side of the chest, elbow about 45° from the body; the free hand holds the bench."
      ],
      steps: [
        "Press the weight straight up over the shoulder.",
        "Lower slowly to the side of the chest, only as deep as the shoulder is comfortable.",
        "Keep the body from rolling toward the weight.",
        "Finish the reps, then switch sides."
      ],
      focus: ["The shoulder blade stays back against the bench.", "Ribs down; the low back stays quiet."],
      mistakes: ["Letting the hips twist.", "Flaring the elbow straight out.", "Lifting the head off the bench."],
      breathing: "Inhale down, exhale as you press.",
      conditions: { tmj: "The bench holds your head; let it rest there with the teeth apart instead of pushing into it." },
      why: "More range than the floor press, plus a little anti-rotation work."
    }
  },
]);
