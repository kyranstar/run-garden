// Mobility and stretches: spine, hips, shoulders, ankles.
import { defineExercises } from "../define.js";

export const MOBILITY = defineExercises([
  {
    id: "childBlock",
    name: "Child's pose · forehead on block",
    family: "childPose",
    patterns: ["mobility"],
    regions: ["low-back", "hips", "neck"],
    roles: ["mobility", "downshift", "cooldown"],
    equipment: { all: ["yoga-block"] },
    position: "kneeling",
    laterality: "bilateral",
    load: "none",
    dose: { type: "time", range: [60, 120] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Sit back toward your heels and rest your forehead on the yoga block.",
      setup: [
        "Kneel with knees wide and big toes together.",
        "Place the block in front of you at a height that lets your forehead rest without straining."
      ],
      steps: [
        "Walk the hands forward and sink the hips back toward the heels.",
        "Rest the forehead on the block.",
        "Let the jaw hang heavy behind closed lips.",
        "Breathe into your back ribs and stay."
      ],
      focus: ["The block holds the head; the neck does no work.", "Breathe into the back of the ribcage."],
      mistakes: ["Setting the block too low so the neck bends.", "Forcing the hips down to the heels."],
      breathing: "Slow nasal breaths into the back ribs.",
      conditions: { tmj: "The supported head lets the jaw and neck muscles fully let go — lips closed, teeth apart." },
      why: "The support helps neck and jaw muscles let go while the low back and hips open."
    }
  },
  {
    id: "childHands",
    name: "Child's pose · forehead on stacked hands",
    family: "childPose",
    patterns: ["mobility"],
    regions: ["low-back", "hips", "neck"],
    roles: ["mobility", "downshift", "cooldown"],
    position: "kneeling",
    laterality: "bilateral",
    load: "none",
    dose: { type: "time", range: [60, 120] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Sit back toward your heels and rest your forehead on your stacked hands or fists.",
      setup: ["Kneel with knees wide and big toes together.", "Stack your hands or fists on the floor in front of you."],
      steps: [
        "Sink the hips back toward the heels.",
        "Rest the forehead on your hands.",
        "Let the jaw hang heavy behind closed lips.",
        "Breathe into your back ribs and stay."
      ],
      focus: ["The hands hold the head; the neck does no work.", "Let the back widen with each breath."],
      mistakes: ["Letting the forehead press down hard.", "Holding tension in the shoulders."],
      breathing: "Slow nasal breaths into the back ribs.",
      conditions: { tmj: "Lips closed, teeth apart; the forehead support lets the jaw relax." },
      why: "Support under the forehead helps neck and jaw muscles let go."
    }
  },
  {
    id: "thoracicBlock",
    name: "Supported thoracic opener",
    family: "thoracicExtension",
    patterns: ["mobility"],
    regions: ["thoracic", "chest"],
    roles: ["mobility", "warmup"],
    equipment: { all: ["yoga-block"] },
    position: "supine",
    laterality: "bilateral",
    load: "none",
    dose: { type: "time", range: [60, 120] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Lie back over a yoga block placed under the upper back and let the chest open.",
      setup: [
        "Sit with the block behind you, on its lowest setting to start.",
        "Lie back so the block sits under the shoulder blades, not the low back."
      ],
      steps: [
        "Support the head with your hands or a second prop if it doesn't reach the floor comfortably.",
        "Let the arms rest out to the sides.",
        "Keep the chin gently tucked.",
        "Breathe into the ribs and stay."
      ],
      focus: ["Mild chest opening only.", "The low back stays comfortable — move the block higher if it isn't."],
      mistakes: ["Placing the block under the low back.", "Letting the head hang so the neck compresses."],
      breathing: "Slow breaths into the front and sides of the ribs.",
      conditions: { tmj: "Keep the chin slightly tucked and the jaw soft so the front of the neck doesn't pull on it." },
      why: "Opens a desk-rounded upper back so the jaw and neck stop compensating."
    }
  },
  {
    id: "thoracicTowel",
    name: "Thoracic opener · rolled towel",
    family: "thoracicExtension",
    patterns: ["mobility"],
    regions: ["thoracic", "chest"],
    roles: ["mobility", "warmup"],
    equipment: { all: ["towel"] },
    position: "supine",
    laterality: "bilateral",
    load: "none",
    dose: { type: "time", range: [60, 120] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Lie back over a firmly rolled towel across the upper back and breathe into the chest.",
      setup: ["Roll a towel firmly into a log.", "Lie back so it runs across the upper back under the shoulder blades."],
      steps: [
        "Support your head with your hands if needed.",
        "Let the arms rest out to the sides.",
        "Keep the chin gently tucked.",
        "Breathe and stay."
      ],
      focus: ["Mild chest opening only.", "The low back stays comfortable."],
      mistakes: ["Towel under the low back.", "Letting the head drop back so the neck compresses."],
      breathing: "Slow breaths into the front and sides of the ribs.",
      conditions: { tmj: "Chin slightly tucked, jaw soft." },
      why: "Opens a desk-rounded upper back so the jaw and neck stop compensating."
    }
  },
  {
    id: "catCow",
    name: "Cat-cow",
    family: "spineMobility",
    patterns: ["mobility"],
    regions: ["thoracic", "low-back"],
    roles: ["warmup", "mobility"],
    position: "quadruped",
    laterality: "bilateral",
    load: "none",
    dose: { type: "reps", range: [6, 10], secsPerRep: 6 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "On hands and knees, slowly round and then arch the spine, one segment at a time.",
      setup: ["Hands under shoulders, knees under hips.", "Spread the fingers and press the floor lightly away."],
      steps: [
        "Exhale and round the back from the tailbone up, letting the head follow last.",
        "Inhale and slowly let the belly drop and the chest move forward.",
        "Keep the neck following the spine rather than leading.",
        "Flow between the two at an easy pace."
      ],
      focus: ["Smooth motion through the whole spine.", "The neck follows; it never cranks up."],
      mistakes: ["Throwing the head back in the arch.", "Moving only the low back."],
      breathing: "Exhale to round, inhale to arch.",
      conditions: { tmj: "Keep the jaw quiet — the head follows the spine, so there's no need to brace the face." },
      why: "Restores motion after sitting without loading the neck."
    }
  },
  {
    id: "threadNeedle",
    name: "Thread the needle",
    family: "thoracicRotation",
    patterns: ["rotate", "mobility"],
    regions: ["thoracic", "shoulders"],
    roles: ["mobility", "warmup"],
    position: "quadruped",
    laterality: "unilateral",
    load: "none",
    dose: { type: "reps", range: [5, 8], secsPerRep: 6 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "From hands and knees, reach one arm under the body and rotate through the upper back.",
      setup: ["Start on hands and knees, hips over knees.", "Shift your weight onto one hand."],
      steps: [
        "Slide the free arm under your body, palm up, toward the opposite side.",
        "Let the shoulder and side of the head come toward the floor as far as is comfortable.",
        "Unwind and reach the same arm up toward the ceiling.",
        "Repeat, then switch sides."
      ],
      focus: ["Turn from the ribs, not from the neck.", "Hips stay stacked over the knees."],
      mistakes: ["Twisting from the low back.", "Forcing the head to the floor."],
      breathing: "Exhale as you thread under, inhale as you open.",
      conditions: { tmj: "Keep the jaw and face soft; rest the head lightly if it touches the floor." },
      why: "Improves thoracic rotation that desk posture usually steals."
    }
  },
  {
    id: "lowLungeBlock",
    name: "Low lunge · hands on block",
    family: "hipFlexorStretch",
    patterns: ["mobility"],
    regions: ["hips"],
    roles: ["mobility", "stretch"],
    equipment: { all: ["yoga-block"] },
    position: "half-kneeling",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [45, 60] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Back knee down, hands on a block, and ease the hips forward to open the front hip.",
      setup: [
        "Kneel on one knee with the other foot forward (pad the back knee if needed).",
        "Set the block beside the front foot for your hands."
      ],
      steps: [
        "Rest the hands on the block so the chest can stay long.",
        "Gently tuck the pelvis, as if pointing the tailbone down.",
        "Ease the hips forward until you feel the front of the back hip open.",
        "Hold and breathe, then switch sides."
      ],
      focus: ["Tuck the pelvis first; the stretch comes from that, not from lunging deep.", "Chest long, neck long."],
      mistakes: ["Arching the low back to go deeper.", "Craning the neck forward to look at the floor."],
      breathing: "Slow nasal breathing; soften into it on the exhale.",
      conditions: { tmj: "The block lets the chest stay tall so the head and jaw don't get dragged forward." },
      why: "Opens hip flexors tightened by sitting without dragging the head and jaw into tension."
    }
  },
  {
    id: "lowLunge",
    name: "Low lunge · hands on front thigh",
    family: "hipFlexorStretch",
    patterns: ["mobility"],
    regions: ["hips"],
    roles: ["mobility", "stretch"],
    position: "half-kneeling",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [45, 60] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Back knee down, hands on the front thigh, and ease the hips forward.",
      setup: [
        "Kneel on one knee with the other foot forward (pad the back knee if needed).",
        "Rest both hands on the front thigh."
      ],
      steps: [
        "Stand the chest tall.",
        "Gently tuck the pelvis.",
        "Ease the hips forward until you feel the front of the back hip open.",
        "Hold and breathe, then switch sides."
      ],
      focus: ["Tuck the pelvis first.", "Chest tall, shoulders relaxed."],
      mistakes: ["Arching the low back.", "Leaning the chest forward over the knee."],
      breathing: "Slow nasal breathing.",
      conditions: { tmj: "Keep the head stacked over the ribs rather than jutting forward." },
      why: "Opens hip flexors tightened by sitting."
    }
  },
  {
    id: "puppyBlock",
    name: "Puppy pose · hands on block",
    family: "puppy",
    patterns: ["mobility"],
    regions: ["lats", "shoulders", "thoracic"],
    roles: ["mobility", "stretch"],
    equipment: { all: ["yoga-block"] },
    position: "kneeling",
    laterality: "bilateral",
    load: "none",
    dose: { type: "time", range: [45, 90] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Hands on a block, hips over knees, and let the chest sink to open the lats and shoulders.",
      setup: ["Kneel with hips stacked over knees.", "Place the block in front of you and rest your hands on it."],
      steps: [
        "Walk the hands and block forward.",
        "Let the chest sink toward the floor while the hips stay over the knees.",
        "Keep the back of the neck long.",
        "Breathe and stay."
      ],
      focus: ["Armpits reach long.", "Hips stay high — this isn't child's pose."],
      mistakes: ["Sinking the low back instead of the chest.", "Hanging the head so the neck crunches."],
      breathing: "Breathe into the back and sides of the ribs.",
      conditions: { tmj: "Let the head hang neutrally with the teeth apart." },
      why: "Opens lats and chest, which often feed neck tension."
    }
  },
  {
    id: "puppyFloor",
    name: "Puppy pose · forearms down",
    family: "puppy",
    patterns: ["mobility"],
    regions: ["lats", "shoulders", "thoracic"],
    roles: ["mobility", "stretch"],
    position: "kneeling",
    laterality: "bilateral",
    load: "none",
    dose: { type: "time", range: [45, 90] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "From hands and knees, walk the hands forward and rest on the forearms with hips high.",
      setup: ["Start on hands and knees.", "Keep a folded towel nearby for your forehead."],
      steps: [
        "Walk the hands forward and lower onto the forearms.",
        "Keep the hips over the knees.",
        "Rest the forehead on the floor or towel.",
        "Breathe and let the chest sink."
      ],
      focus: ["Armpits reach long.", "Hips stay stacked over the knees."],
      mistakes: ["Letting the hips drift back.", "Arching the low back."],
      breathing: "Breathe into the back and sides of the ribs.",
      conditions: { tmj: "The forehead rests lightly — the jaw stays free and relaxed." },
      why: "Opens lats and chest, which often feed neck tension."
    }
  },
  {
    id: "blockSideBend",
    name: "Supported side bend",
    family: "sideBend",
    patterns: ["mobility"],
    regions: ["core", "lats"],
    roles: ["mobility", "stretch"],
    equipment: { all: ["yoga-block"] },
    position: "seated",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [30, 45] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Seated, one hand on a block, reach the other arm overhead and lean into a side bend.",
      setup: ["Sit cross-legged or kneel.", "Place the block beside one hip."],
      steps: [
        "Rest one hand on the block.",
        "Reach the other arm up and over toward the block side.",
        "Breathe into the open side of the ribs.",
        "Come back up slowly and switch sides."
      ],
      focus: ["Length through the ribs, not a crunch.", "Both sit bones stay down."],
      mistakes: ["Collapsing onto the block.", "Letting the head drop toward the shoulder."],
      breathing: "Inhale into the stretched side.",
      conditions: { tmj: "Keep the head in line with the spine and the jaw loose." },
      why: "Relieves side-body compression that can pull on the neck."
    }
  },
  {
    id: "seatedSideBend",
    name: "Seated side bend",
    family: "sideBend",
    patterns: ["mobility"],
    regions: ["core", "lats"],
    roles: ["mobility", "stretch"],
    position: "seated",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [30, 45] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Seated, one hand on the floor, reach the other arm overhead into a side bend.",
      setup: ["Sit cross-legged.", "Place one hand on the floor beside you."],
      steps: [
        "Reach the other arm up and over.",
        "Lean toward the grounded hand.",
        "Breathe into the open side.",
        "Come up slowly and switch sides."
      ],
      focus: ["Length through the ribs.", "Both sit bones stay down."],
      mistakes: ["Collapsing into the grounded arm.", "Twisting instead of bending sideways."],
      breathing: "Inhale into the stretched side.",
      conditions: { tmj: "Head in line with the spine, jaw loose." },
      why: "Relieves side-body compression that can pull on the neck."
    }
  },
  {
    id: "supineTwist",
    name: "Supine twist",
    family: "supineTwist",
    patterns: ["rotate", "mobility"],
    regions: ["low-back", "hips", "thoracic"],
    roles: ["stretch", "cooldown", "mobility"],
    position: "supine",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [30, 45] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Lying on your back, let bent knees fall to one side while the shoulders stay heavy.",
      setup: ["Lie on your back, knees bent, feet on the floor.", "Arms out to the sides at shoulder height."],
      steps: [
        "Let both knees fall slowly to one side.",
        "Keep both shoulders heavy on the floor.",
        "Rest there and breathe.",
        "Bring the knees back through the middle and switch sides."
      ],
      focus: ["Easy range only.", "Shoulders stay down."],
      mistakes: ["Forcing the knees to the floor.", "Turning the head hard the other way."],
      breathing: "Slow breathing into the stretched side.",
      conditions: { tmj: "Keep the head neutral or turn it just slightly; the jaw stays quiet." },
      why: "Gently restores rotation and settles the nervous system."
    }
  },
  {
    id: "figureFour",
    name: "Figure-4 glute stretch",
    family: "gluteStretch",
    patterns: ["mobility"],
    regions: ["glutes", "hips"],
    roles: ["stretch", "cooldown"],
    position: "supine",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [30, 45] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "On your back, cross one ankle over the other knee and draw the legs in.",
      setup: ["Lie on your back with knees bent.", "Cross one ankle over the opposite knee."],
      steps: [
        "Lift the bottom foot off the floor.",
        "Hold behind the bottom thigh and draw it gently toward you.",
        "Stop when you feel the stretch in the crossed-leg glute.",
        "Hold and breathe, then switch sides."
      ],
      focus: ["Keep the crossed foot flexed to protect the knee.", "Head and shoulders stay on the floor."],
      mistakes: ["Lifting the head to reach the leg — use a towel instead.", "Pulling too hard."],
      breathing: "Slow nasal breathing.",
      conditions: { tmj: "Keep the head down and the jaw relaxed; if you can't reach, loop a towel around the thigh." },
      why: "Eases tight glutes and outer hips from long sitting."
    }
  },
  {
    id: "hingeDrill",
    name: "Hip hinge drill",
    family: "hingePattern",
    patterns: ["hinge"],
    regions: ["hamstrings", "hips"],
    roles: ["warmup", "activation"],
    position: "standing",
    laterality: "bilateral",
    load: "none",
    dose: { type: "reps", range: [8, 12], secsPerRep: 4 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Hands on hips, push the hips back with a long spine, then stand tall.",
      setup: ["Stand with feet hip-width, knees soft.", "Hands on the hip creases."],
      steps: [
        "Push the hips straight back, letting the chest tip forward with a long spine.",
        "Stop when you feel the hamstrings load.",
        "Drive the hips forward to stand tall.",
        "Repeat smoothly."
      ],
      focus: ["Hips move; the neck stays quiet.", "Shoulders away from the ears."],
      mistakes: ["Squatting down instead of pushing back.", "Looking up and cranking the neck."],
      breathing: "Inhale as you hinge, exhale as you stand.",
      conditions: { tmj: "Keep the gaze a couple of metres ahead on the floor so the neck and jaw stay neutral." },
      why: "Preps deadlifts and other hinges without using the jaw as a brace."
    }
  },
  {
    id: "worldsGreatest",
    name: "World's greatest stretch",
    family: "worldsGreatest",
    patterns: ["mobility", "rotate"],
    regions: ["hips", "thoracic", "hamstrings"],
    roles: ["warmup", "mobility"],
    position: "half-kneeling",
    laterality: "unilateral",
    load: "none",
    dose: { type: "reps", range: [3, 5], secsPerRep: 10 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    text: {
      summary: "Lunge, drop the inside elbow toward the foot, then rotate and reach to the ceiling.",
      setup: [
        "Step into a long lunge, back knee down if you like.",
        "Place the same-side hand as the back leg on the floor inside the front foot."
      ],
      steps: [
        "Drop the other elbow toward the inside of the front foot.",
        "Rotate open and reach that arm to the ceiling, eyes following the hand only as far as comfortable.",
        "Return the hand to the floor.",
        "Repeat, then switch sides."
      ],
      focus: ["Turn from the upper back.", "The back leg stays long."],
      mistakes: ["Rushing the rotation.", "Forcing the head to follow past comfort."],
      breathing: "Exhale as you drop the elbow, inhale as you rotate open.",
      conditions: { tmj: "Let the gaze follow gently — don't crank the neck to look up." },
      why: "Opens hips, hamstrings, and upper back in one move — a good all-round warm-up."
    }
  },
  {
    id: "hip9090",
    name: "90/90 hip switches",
    family: "hipRotation",
    patterns: ["mobility", "rotate"],
    regions: ["hips"],
    roles: ["warmup", "mobility"],
    position: "seated",
    laterality: "alternating",
    load: "none",
    dose: { type: "reps", range: [6, 10], secsPerRep: 5 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    text: {
      summary: "Seated with both knees bent to 90°, rotate the knees from one side to the other.",
      setup: [
        "Sit with both knees bent about 90°, one leg in front, one to the side.",
        "Hands behind you on the floor for support."
      ],
      steps: [
        "Lift both knees and rotate them to the other side.",
        "Settle into the new 90/90 position with a tall chest.",
        "Rotate back.",
        "Keep alternating smoothly."
      ],
      focus: ["Move from the hips, not the low back.", "Chest tall in each position."],
      mistakes: ["Slumping between switches.", "Forcing the knees down to the floor."],
      breathing: "Exhale as you rotate.",
      conditions: { tmj: "Keep the jaw loose; the effort is in the hips." },
      why: "Restores hip rotation in both directions, which sitting steals."
    }
  },
  {
    id: "ankleRocks",
    name: "Knee-to-wall ankle rocks",
    family: "ankleMobility",
    patterns: ["mobility"],
    regions: ["ankles", "calves"],
    roles: ["warmup", "mobility"],
    equipment: { all: ["wall"] },
    position: "half-kneeling",
    laterality: "unilateral",
    load: "none",
    dose: { type: "reps", range: [8, 12], secsPerRep: 3 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Front foot near a wall, rock the knee forward over the toes without lifting the heel.",
      setup: ["Half-kneel facing a wall, front foot a few centimetres from it.", "Hands lightly on the wall."],
      steps: [
        "Rock the front knee forward toward the wall, keeping the heel down.",
        "Pause briefly.",
        "Rock back.",
        "Repeat, then switch sides."
      ],
      focus: ["Heel stays down.", "Knee tracks over the middle toes."],
      mistakes: ["Letting the arch collapse.", "Lifting the heel to reach the wall."],
      breathing: "Easy breathing.",
      conditions: { tmj: "No effort in the face at all." },
      why: "Ankle mobility makes squats and lunges more upright, which keeps the head and jaw stacked."
    }
  },
]);
