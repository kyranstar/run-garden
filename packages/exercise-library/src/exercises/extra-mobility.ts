// Library expansion: more mobility and stretches for hips, spine, and shoulders.
import { defineExercises } from "../define.js";

export const EXTRA_MOBILITY = defineExercises([
  {
    id: "pigeonTArms",
    name: "Pigeon with T-arms",
    family: "pigeon",
    patterns: ["mobility"],
    regions: ["hips", "glutes", "upper-back"],
    roles: ["mobility", "activation"],
    position: "seated",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [20, 30] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    text: {
      summary: "Sit tall in pigeon pose and hold both arms out in a T to open the hip and wake up the upper back.",
      setup: [
        "From hands and knees, slide one knee forward behind the same-side wrist and angle the shin across; stretch the other leg long behind.",
        "Square the hips; put a folded towel or block under the front hip if it floats."
      ],
      steps: [
        "Walk the hands in and sit the chest tall over the hips.",
        "Raise both arms straight out to the sides at shoulder height, thumbs up.",
        "Hold, staying tall the whole time.",
        "Lower the arms and ease out before switching sides."
      ],
      focus: ["Chest tall and hips square.", "Arms at shoulder height, shoulders down."],
      mistakes: [
        "Slumping as the arms tire.",
        "Twisting the hips to make the stretch easier.",
        "Shrugging to hold the arms up."
      ],
      breathing: "Slow nasal breathing; let the hip soften on each exhale.",
      conditions: { tmj: "Holds like this invite gritting; lower the arms for a breath if the jaw starts to tighten." },
      why: "Opens the hip that sitting stiffens while training the upper-back posture muscles."
    }
  },
  {
    id: "couchStretch",
    name: "Couch stretch",
    family: "hipFlexorStretch",
    patterns: ["mobility"],
    regions: ["hips"],
    roles: ["stretch", "mobility"],
    equipment: { oneOf: ["bench", "chair", "wall"] },
    position: "half-kneeling",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [45, 60] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 3,
    easier: ["lowLunge"],
    tags: ["desk-relief"],
    text: {
      summary: "Back shin up a chair, bench, or wall, front foot forward; bring the torso up to stretch the front hip and quad.",
      setup: [
        "Pad the floor, then kneel with the back knee near the chair, bench, or wall and the top of that foot resting up against it.",
        "Step the other foot forward into a lunge; start with the hands on the front thigh."
      ],
      steps: [
        "Tuck the pelvis gently, as if pointing the tailbone down.",
        "Bring the torso upright only as far as the stretch stays moderate.",
        "Hold and breathe.",
        "Ease forward out of it before switching sides."
      ],
      focus: [
        "Pelvis tucked first; the torso rises second.",
        "A strong stretch down the front of the thigh, never knee pain."
      ],
      mistakes: ["Arching the low back to sit up.", "Setting up so close that the knee is jammed.", "Holding the breath."],
      breathing: "Slow nasal breathing; relax into it on the exhale.",
      conditions: { tmj: "This one is intense; if the jaw tightens, move the knee further from the support to back it off." },
      why: "A stronger hip-flexor and quad stretch for tightness from long hours of sitting."
    }
  },
  {
    id: "benchPigeon",
    name: "Bench pigeon stretch",
    family: "gluteStretch",
    patterns: ["mobility"],
    regions: ["glutes", "hips"],
    roles: ["stretch", "cooldown", "mobility"],
    equipment: { oneOf: ["bench", "chair"] },
    position: "standing",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [30, 45] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Lay one shin across a bench or chair seat and hinge forward to stretch the outer hip.",
      setup: [
        "Stand facing a bench or sturdy chair.",
        "Lift one leg and rest the shin across the seat, knee out to the side and ankle toward the far edge."
      ],
      steps: [
        "Step the standing foot back a little and square the hips.",
        "Hinge forward from the hips with a long spine until you feel the outer hip and glute of the bent leg.",
        "Stay and breathe until it starts to feel like rest.",
        "Stand up slowly before switching sides."
      ],
      focus: [
        "Long spine; the hinge comes from the hips.",
        "Knee comfortable — bring the foot closer to you if the knee complains."
      ],
      mistakes: ["Rounding the back to go deeper.", "Twisting the hips open."],
      breathing: "Slow nasal breathing; soften on each exhale.",
      conditions: { tmj: "Let the head hang in line with the spine and the jaw go slack." },
      why: "An easy-to-set-up outer-hip stretch that doesn't need you on the floor."
    }
  },
  {
    id: "reclinedButterfly",
    name: "Reclined butterfly",
    family: "butterfly",
    patterns: ["mobility"],
    regions: ["hips"],
    roles: ["cooldown", "stretch"],
    position: "supine",
    laterality: "bilateral",
    load: "none",
    dose: { type: "time", range: [60, 120] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Lie back with the soles together and let the knees fall open; rest and breathe.",
      setup: [
        "Lie on your back and bring the soles of the feet together, heels a comfortable distance from the hips.",
        "Slide a yoga block, pillow, or folded towel under each knee if the stretch is strong."
      ],
      steps: [
        "Let the knees fall open under their own weight.",
        "Rest the arms wherever they feel heavy.",
        "Breathe slowly and let the inner thighs soften.",
        "Stay for the whole timer."
      ],
      focus: ["Nothing is pushed; gravity does the stretch.", "The low back stays relaxed on the floor."],
      mistakes: ["Pressing the knees down.", "Arching the low back."],
      breathing: "Slow belly breathing with long exhales.",
      conditions: { tmj: "A good place to check the jaw: tongue up, lips closed, teeth apart." },
      why: "A restful hip opener that brings the session back down."
    }
  },
  {
    id: "wallRotation",
    name: "Half-kneeling wall rotations",
    family: "thoracicRotation",
    patterns: ["rotate", "mobility"],
    regions: ["thoracic", "shoulders"],
    roles: ["warmup", "mobility"],
    equipment: { all: ["wall"] },
    position: "half-kneeling",
    laterality: "alternating",
    load: "none",
    dose: { type: "reps", range: [5, 8], secsPerRep: 5 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Half-kneel side-on to a wall and turn the chest toward it and away from it while the hips stay still.",
      setup: [
        "Half-kneel side-on to a wall with the down knee nearest it, lightly touching the wall.",
        "Cross the arms over the chest, or rest the fingertips behind the head without pulling."
      ],
      steps: [
        "Turn the chest toward the wall as far as it goes smoothly.",
        "Turn back through the middle and away from the wall.",
        "Keep the hips square and the pelvis still.",
        "Keep alternating at an even pace."
      ],
      focus: ["The turn comes from the ribs and upper back.", "The head turns with the chest, not ahead of it."],
      mistakes: ["Letting the hips swing with the turn.", "Pulling on the head.", "Rushing to the end range."],
      breathing: "Exhale as you turn, inhale through the middle.",
      conditions: { tmj: "Keep the jaw soft and the teeth apart as you rotate." },
      why: "Restores upper-back rotation, with the wall keeping the hips honest."
    }
  },
  {
    id: "openBook",
    name: "Side-lying open book",
    family: "thoracicRotation",
    patterns: ["rotate", "mobility"],
    regions: ["thoracic", "shoulders"],
    roles: ["warmup", "mobility"],
    position: "side-lying",
    laterality: "unilateral",
    load: "none",
    dose: { type: "reps", range: [5, 8], secsPerRep: 6 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "On your side with knees bent, open the top arm like a book and turn the chest to the ceiling.",
      setup: [
        "Lie on your side with hips and knees bent to about 90° and a folded towel or pillow under the head.",
        "Stretch both arms out in front at shoulder height, palms together."
      ],
      steps: [
        "Keeping the knees together, sweep the top hand up and over, opening the arm toward the floor behind you.",
        "Let the chest turn toward the ceiling and the eyes follow the hand.",
        "Pause where it's comfortable and breathe.",
        "Bring the arm back to close the book; repeat, then switch sides."
      ],
      focus: ["The knees stay stacked so the upper back does the turning.", "Only as far as it opens easily."],
      mistakes: ["Letting the top knee slide back.", "Forcing the hand to the floor.", "Cranking the neck to look further."],
      breathing: "Exhale as you open, inhale as you close.",
      conditions: { tmj: "The head rests on its support throughout; let the jaw go slack as the chest opens." },
      why: "Restores upper-back rotation lost to desk posture, with the head supported the whole time."
    }
  },
  {
    id: "hip9090Lift",
    name: "90/90 back-leg lifts",
    family: "hipRotation",
    patterns: ["mobility"],
    regions: ["hips"],
    roles: ["mobility", "activation"],
    position: "seated",
    laterality: "unilateral",
    load: "none",
    dose: { type: "reps", range: [5, 8], secsPerRep: 5 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    easier: ["hip9090"],
    text: {
      summary: "In a 90/90 sit, turn the back thigh inward to lift the back shin off the floor, hold briefly, and lower.",
      setup: [
        "Sit with both knees bent about 90°, one leg in front and one out to the side behind you.",
        "Lean on your hands and sit as tall as you can."
      ],
      steps: [
        "Turn the back thigh inward and lift the back foot and shin a few centimetres off the floor.",
        "Hold for 2–3 seconds.",
        "Lower with control.",
        "Repeat, then switch sides."
      ],
      focus: ["Lift from the hip, not by leaning away.", "Small lifts are fine; the hold matters more than the height."],
      mistakes: ["Tipping the torso to fake the lift.", "Grinding through a cramp instead of lowering."],
      breathing: "Exhale as you lift, inhale as you lower.",
      conditions: {
        tmj: "Effort in the hip can travel to the jaw; if it does, just press the foot toward lifting without leaving the floor."
      },
      why: "Strengthens hip rotation at the end of its range instead of only stretching it."
    }
  },
  {
    id: "wallHipTurns",
    name: "Wall split-stance hip turns",
    family: "hipRotation",
    patterns: ["mobility", "rotate"],
    regions: ["hips"],
    roles: ["warmup", "mobility"],
    equipment: { all: ["wall"] },
    position: "standing",
    laterality: "unilateral",
    load: "none",
    dose: { type: "reps", range: [6, 8], secsPerRep: 5 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    text: {
      summary: "In a split stance with the back shin against a wall, turn slowly toward the wall to rotate the front hip.",
      setup: [
        "Stand in a split stance right beside a wall, with the outside of the back leg against it.",
        "Bend the back knee toward 90° so the back shin rests on the wall; hands on the hips."
      ],
      steps: [
        "Hinge forward slightly from the hips.",
        "Turn the chest and pelvis slowly toward the wall; the pinned back shin lets the front hip rotate.",
        "Return to the start with the same control.",
        "Repeat, then switch sides."
      ],
      focus: ["Slow, active reps rather than long holds.", "The front knee stays in line with the front foot."],
      mistakes: ["Turning only the shoulders.", "Letting the front knee cave in.", "Rushing."],
      breathing: "Exhale as you turn, inhale as you come back.",
      conditions: { tmj: "Keep the jaw relaxed through the turn; the work is in the hips." },
      why: "Trains inward hip rotation, a range that sitting tends to steal."
    }
  },
  {
    id: "supportedHingeSqueeze",
    name: "Supported hinge with thigh squeeze",
    family: "hingePattern",
    patterns: ["hinge"],
    regions: ["hamstrings", "hips"],
    roles: ["warmup", "mobility"],
    equipment: { all: ["chair"], oneOf: ["yoga-block", "towel", "foam-roller"] },
    position: "standing",
    laterality: "bilateral",
    load: "none",
    dose: { type: "reps", range: [2, 3], secsPerRep: 30 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Hands on a chair back and a block between the thighs, hinge down in small steps, squeezing and breathing.",
      setup: [
        "Place a yoga block, rolled towel, or foam roller between the upper thighs.",
        "Stand about a foot-length from the back of a sturdy chair, knees slightly bent, hands on the backrest with straight arms."
      ],
      steps: [
        "Send the hips back and let the torso tip forward with a long spine until you feel the first mild stretch in the glutes.",
        "Squeeze the block lightly, stay heavy through the whole foot, and take two slow breaths.",
        "Relax the squeeze, go an inch deeper to the next mild stretch, and repeat.",
        "Stop when the back wants to round or arch, then stand up — that's one rep."
      ],
      focus: [
        "Low intensity — the squeeze and the stretch stay around 2–3 out of 10.",
        "Feel it in the glutes more than the hamstrings."
      ],
      mistakes: ["Folding through the low back instead of shifting the hips back.", "Squeezing hard.", "Rushing the breaths."],
      breathing: "Two slow, full breaths at each depth.",
      conditions: { tmj: "Neck long and jaw quiet; the chair takes your weight so nothing needs bracing." },
      why: "Teaches the hips to fold smoothly: a good lead-in to deadlifts and a gentle way to ease a stiff low back."
    }
  },
  {
    id: "cossackSquat",
    name: "Cossack squat",
    family: "cossack",
    patterns: ["squat", "mobility"],
    regions: ["hips", "quads", "glutes"],
    roles: ["warmup", "mobility", "accessory"],
    position: "standing",
    laterality: "alternating",
    load: "bodyweight",
    dose: { type: "reps", range: [4, 6], sets: [2, 3], restSec: 45, secsPerRep: 6 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 3,
    text: {
      summary: "From a wide stance, sit into one leg while the other stays straight, then shift across to the other side.",
      setup: [
        "Stand with the feet wide, toes turned slightly out.",
        "Clasp the hands in front of the chest, or hold a chair back for balance."
      ],
      steps: [
        "Shift your weight into one leg, bending that knee and sitting the hips back and down.",
        "Keep the other leg straight with its toes pointing up.",
        "Go only as deep as stays smooth, then push back through the middle.",
        "Shift into the other leg and keep alternating."
      ],
      focus: ["The heel of the bent leg stays down.", "Chest tall; the knee tracks over the toes."],
      mistakes: ["Dropping deeper than your hips allow and rounding the back.", "Letting the bent knee cave in."],
      breathing: "Inhale as you sit into a side, exhale as you come through the middle.",
      conditions: { tmj: "Balance moves invite gripping with the jaw; hold the chair if you need to so the face can stay soft." },
      why: "Opens the inner thighs and hips while building leg strength side to side."
    }
  },
  {
    id: "shoulderPassThrough",
    name: "Shoulder pass-throughs",
    family: "shoulderMobility",
    patterns: ["mobility"],
    regions: ["shoulders", "chest"],
    roles: ["warmup", "mobility"],
    equipment: { oneOf: ["towel", "band"] },
    position: "standing",
    laterality: "bilateral",
    load: "none",
    dose: { type: "reps", range: [8, 12], secsPerRep: 6 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Hold a towel or band wide and sweep it overhead and back with straight arms.",
      setup: [
        "Stand tall holding a towel or light band with a wide overhand grip, arms straight in front of the hips.",
        "Ribs down, chin level."
      ],
      steps: [
        "Raise the arms overhead, keeping the elbows straight.",
        "If the shoulders allow, continue the arc behind you toward the lower back.",
        "Return the same way to the front.",
        "Repeat slowly; widen the grip if the elbows bend or the ribs flare."
      ],
      focus: ["Straight elbows and a wide grip.", "Only as far back as the shoulders go without the back arching."],
      mistakes: ["Arching the low back to get the arms behind.", "Poking the head forward as the arms pass."],
      breathing: "Inhale as the arms rise, exhale as they come down.",
      conditions: { tmj: "Keep the head still and the jaw soft as the arms pass overhead." },
      why: "Opens the chest and shoulders that desk work rounds forward."
    }
  },
  {
    id: "towelHamstringStretch",
    name: "Hamstring stretch · towel",
    family: "hamstringStretch",
    patterns: ["mobility"],
    regions: ["hamstrings"],
    roles: ["stretch", "cooldown"],
    equipment: { all: ["towel"] },
    position: "supine",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [30, 45] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "On your back, loop a towel around one foot and raise the straight leg until the back of the thigh stretches.",
      setup: [
        "Lie on your back with one knee bent and that foot flat.",
        "Loop a towel around the arch of the other foot and hold an end in each hand."
      ],
      steps: [
        "Straighten the looped leg up toward the ceiling.",
        "Stop at a mild stretch behind the thigh, keeping the knee nearly straight.",
        "Hold and breathe, letting the leg drift a little higher only if it eases.",
        "Lower slowly before switching sides."
      ],
      focus: ["Hips and head stay on the floor.", "The towel holds the leg; the arms stay relaxed."],
      mistakes: ["Lifting the head to reach the foot.", "Pulling the leg past a mild stretch.", "Locking the knee hard."],
      breathing: "Slow nasal breathing with long exhales.",
      conditions: { tmj: "Head down, jaw loose — the towel means you don't have to reach." },
      why: "Eases hamstrings that tighten from sitting, with no load on the neck."
    }
  },
  {
    id: "massageBallGlute",
    name: "Massage-ball glute release",
    family: "gluteRelease",
    patterns: ["release"],
    regions: ["glutes", "hips"],
    roles: ["cooldown", "mobility"],
    equipment: { all: ["massage-ball"] },
    position: "seated",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [45, 60] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Sit on a massage ball under one glute and let tight spots ease with small movements.",
      setup: [
        "Sit on the floor with the knees bent and the hands behind you for support.",
        "Place the ball under one glute and lean slightly toward that side."
      ],
      steps: [
        "Let your weight sink onto the ball until the pressure is moderate.",
        "Roll slowly in small circles.",
        "Pause on a tender spot and let the knee fall gently in and out.",
        "Move off the ball before switching sides."
      ],
      focus: ["Moderate pressure; you can breathe easily.", "Stay on the meaty part of the glute, away from the tailbone."],
      mistakes: [
        "Rolling fast.",
        "Sitting so hard on a spot that you tense up.",
        "Staying on a spot that gives sharp or radiating pain."
      ],
      breathing: "Long exhales on tender spots.",
      conditions: { tmj: "Keep the jaw slack; release work goes better when the face isn't braced." },
      why: "Eases glutes that tighten from long sitting."
    }
  },
]);
