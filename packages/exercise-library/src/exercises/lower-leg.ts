// The lower leg (R10): calf stretches with the knee straight and bent, calf raises up to an eccentric heel drop and one
// foot, a tibialis raise for the shin, a calf release and ankle circles — for easing sore calves after a run, for running
// prep, and for calf strength. Appended last, so library order breaks the engine's ties as it did before them.
//
// The raises and the tibialis raise have their own pattern ("ankle-raise"): a calf raise is not a squat, and counting
// it as one would tell the coverage and the balance that squats had been done.
import { defineExercises } from "../define.js";

export const LOWER_LEG = defineExercises([
  // ---- Stretches: the big calf muscle needs a straight knee, the deep one a bent knee ----
  {
    id: "calfStretch",
    name: "Calf stretch · straight knee",
    family: "calfStretch",
    patterns: ["mobility"],
    regions: ["calves"],
    roles: ["stretch", "cooldown"],
    equipment: { all: ["wall"] },
    position: "standing",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [30, 45] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    contraction: ["passive"],
    muscles: { primary: ["gastrocnemius"], secondary: ["soleus"] },
    purposes: ["stretch", "cooldown"],
    tags: [],
    themes: ["gentleMobility"],
    text: {
      summary: "Hands on a wall, back knee straight and heel down: lean in to stretch the calf.",
      setup: [
        "Stand facing a wall with both hands on it at shoulder height.",
        "Step one foot back about a stride, toes pointing straight ahead and the heel on the floor."
      ],
      steps: [
        "Keep the back knee straight and let its heel rest on the floor.",
        "Bend the front knee and move the hips toward the wall until you feel a mild stretch in the back calf.",
        "Hold and breathe, easing a little further only as the calf lets go.",
        "Step the feet together, then switch sides."
      ],
      focus: ["Back knee straight, back heel down.", "The hips move toward the wall; the body stays in one long line."],
      mistakes: ["Letting the back heel lift.", "Turning the back foot out.", "Bouncing into the stretch."],
      breathing: "Slow breaths with long, easy exhales.",
      conditions: { tmj: "Nothing here loads the jaw; keep the face and shoulders soft while the calf lets go." },
      why: "Eases the big calf muscle after running or a long day on your feet, so the ankle bends freely again."
    }
  },
  {
    id: "soleusStretch",
    name: "Calf stretch · bent knee",
    family: "calfStretch",
    patterns: ["mobility"],
    regions: ["calves", "ankles"],
    roles: ["stretch", "cooldown"],
    equipment: { all: ["wall"] },
    position: "standing",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [30, 45] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    contraction: ["passive"],
    // With the knee bent the big calf muscle is slack: the deep one under it takes the stretch.
    muscles: { primary: ["soleus"], secondary: [] },
    purposes: ["stretch", "cooldown"],
    tags: [],
    themes: ["gentleMobility"],
    text: {
      summary: "At a wall, sink the back knee, heel down, to stretch low in the calf near the heel.",
      setup: [
        "Stand facing a wall with both hands on it.",
        "Step one foot back a short step, toes pointing ahead and the heel on the floor."
      ],
      steps: [
        "Bend both knees, sinking the back knee toward the floor while its heel stays down.",
        "Stop at a mild stretch low in the back calf, just above the heel.",
        "Hold and breathe, letting the knee sink a little further as it eases.",
        "Stand up, then switch sides."
      ],
      focus: ["The back heel stays down.", "A short stance: the bend in the knee makes the stretch, not the length of the step."],
      mistakes: ["Lifting the back heel to sink lower.", "Letting the back knee fall inward.", "Stepping back so far that the knee can't bend."],
      breathing: "Slow breaths with long, easy exhales.",
      conditions: { tmj: "No effort in the face or jaw at all; let the hands rest lightly on the wall." },
      why: "The deep calf muscle only stretches with the knee bent, and it takes much of the load of every running stride."
    }
  },

  // ---- Calf strength: both feet, then the eccentric heel drop, then one foot ----
  {
    id: "calfRaise",
    name: "Calf raise",
    family: "calfRaise",
    patterns: ["ankle-raise"],
    regions: ["calves"],
    roles: ["accessory", "warmup"],
    position: "standing",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [12, 20], sets: [2, 3], restSec: 45, secsPerRep: 3 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    contraction: ["isotonic"],
    muscles: { primary: ["gastrocnemius", "soleus"], secondary: ["peroneals", "feet-intrinsics"] },
    purposes: ["strength", "warmup"],
    tags: [],
    themes: [],
    providers: { coros: { key: "T1070", confidence: "exact", method: "curated" } }, // COROS: Standing Calf Raises
    harder: ["eccentricHeelDrop", "singleLegCalfRaise"],
    text: {
      summary: "Stand tall and rise onto the balls of both feet, pause, then lower slowly.",
      setup: [
        "Stand with the feet hip-width apart, toes pointing ahead.",
        "Rest your fingertips on a wall or a chair back for balance."
      ],
      steps: [
        "Press through the balls of the feet and rise as high as you can.",
        "Pause for a moment at the top.",
        "Lower slowly, taking about two seconds, until the heels touch down.",
        "Repeat without bouncing."
      ],
      focus: ["Rise straight up over the big toe and second toe.", "Slow on the way down."],
      mistakes: ["Rolling out onto the little toes.", "Bouncing off the floor.", "Bending the knees to push up."],
      breathing: "Breathe out as you rise, in as you lower.",
      conditions: { tmj: "Little effort for the jaw; if the last reps burn, keep the teeth apart and the face soft." },
      why: "Strong calves take the load of every running stride and steady the ankle on uneven ground."
    }
  },
  {
    id: "bentKneeCalfRaise",
    name: "Bent-knee calf raise",
    family: "calfRaise",
    patterns: ["ankle-raise"],
    regions: ["calves"],
    roles: ["accessory"],
    position: "standing",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [12, 20], sets: [2, 3], restSec: 45, secsPerRep: 3 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    contraction: ["isotonic"],
    // The knee bend slackens the big calf muscle, so the deep one lifts; the thighs only hold the bend.
    muscles: { primary: ["soleus"], secondary: ["gastrocnemius", "peroneals", "quads"] },
    purposes: ["strength"],
    tags: ["running"],
    themes: [],
    text: {
      summary: "Knees softly bent and kept bent, rise onto the balls of both feet, then lower slowly.",
      setup: [
        "Stand with the feet hip-width apart, fingertips on a wall or a chair back.",
        "Bend both knees a little, as if starting to sit, and keep that bend throughout."
      ],
      steps: [
        "Keeping the same knee bend, rise onto the balls of the feet as high as you can.",
        "Pause for a moment at the top.",
        "Lower slowly until the heels touch down.",
        "Repeat, the knees neither straightening nor sinking."
      ],
      focus: ["The same knee bend all the way up and down.", "Weight over the big toe and second toe."],
      mistakes: ["Straightening the knees as you rise.", "Sinking lower to push up with the thighs.", "Rushing the lowering."],
      breathing: "Breathe out as you rise, in as you lower.",
      conditions: { tmj: "Little effort for the jaw; keep the face soft as the deep calf starts to burn." },
      why: "With the knees bent the deep calf muscle does the lifting, and it takes much of the load when you run."
    }
  },
  {
    id: "eccentricHeelDrop",
    name: "Eccentric heel drop",
    family: "calfRaise",
    patterns: ["ankle-raise"],
    regions: ["calves", "ankles"],
    roles: ["accessory"],
    position: "standing",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [8, 15], sets: [2, 3], restSec: 60, secsPerRep: 5 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    // Up on both feet, down on one: the working leg shares the rise and does the slow lowering alone.
    contraction: ["isotonic", "eccentric"],
    muscles: { primary: ["gastrocnemius", "soleus"], secondary: ["peroneals", "feet-intrinsics"] },
    purposes: ["strength"],
    tags: ["eccentric-emphasis", "single-leg", "running"],
    themes: [],
    easier: ["calfRaise"],
    harder: ["singleLegCalfRaise"],
    text: {
      summary: "Rise on both feet at a step's edge, then lower slowly on one until the heel dips below.",
      setup: [
        "Stand with the balls of both feet on the edge of a low, stable step or the bottom stair, heels hanging off.",
        "Fingertips on a wall or rail for balance. No step? Do it on flat floor, lowering until the heel touches down."
      ],
      steps: [
        "Rise onto the balls of both feet.",
        "Lift one foot and lower on the other slowly, about three seconds, until its heel is a little below the step.",
        "Put the other foot back down and rise on both feet again.",
        "Finish the reps, then switch legs."
      ],
      focus: ["The slow lowering is the exercise; the rise is only the way back up.", "Lower to a strong, even stretch, no further."],
      mistakes: [
        "Dropping through the last part of the lowering.",
        "Rising on the working leg alone.",
        "Doing a lot the first time: slow lowering is new work, and calves new to it stay sore for a day or two."
      ],
      breathing: "Breathe in as you rise, and out slowly as you lower.",
      conditions: { tmj: "Slow single-leg lowering invites bracing; keep a hand on the wall so the jaw can stay soft." },
      why: "Slow, loaded lowering toughens the calf and the tendon behind the heel for the miles they carry."
    }
  },
  {
    id: "singleLegCalfRaise",
    name: "Single-leg calf raise",
    family: "calfRaise",
    patterns: ["ankle-raise"],
    regions: ["calves", "ankles"],
    roles: ["accessory"],
    position: "standing",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [8, 15], sets: [2, 3], restSec: 45, secsPerRep: 3 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 3,
    contraction: ["isotonic"],
    muscles: { primary: ["gastrocnemius", "soleus"], secondary: ["peroneals", "feet-intrinsics"] },
    purposes: ["strength"],
    tags: ["single-leg", "running"],
    themes: ["athleticBase"],
    providers: { coros: { key: "T1275", confidence: "exact", method: "curated" } }, // COROS: Single-Leg Calf Raise
    easier: ["eccentricHeelDrop"],
    text: {
      summary: "On one foot, rise as high as you can, then lower slowly: strong calves, one leg at a time.",
      setup: [
        "Stand on one foot, fingertips on a wall or a chair back for balance only.",
        "Lift the other foot just off the floor behind you."
      ],
      steps: [
        "Press through the ball of the standing foot and rise as high as you can.",
        "Pause for a moment at the top.",
        "Lower slowly, taking about two seconds, until the heel touches down.",
        "Finish the reps, then switch legs."
      ],
      focus: ["Full height on every rep.", "The ankle stays straight over the big toe and second toe; the fingertips only steady you."],
      mistakes: ["Pulling yourself up with the hand.", "Rolling out onto the little toes.", "Stopping short of full height as you tire."],
      breathing: "Breathe out as you rise, in as you lower.",
      conditions: { tmj: "One-legged work invites bracing: keep the fingertips on the wall so balance never turns into clenching." },
      why: "Running lands on one leg at a time; this builds the calf strength and ankle control each stride asks for."
    }
  },

  // ---- The shin: the muscles that lift the toes balance the calves ----
  {
    id: "tibialisRaise",
    name: "Tibialis raise",
    family: "tibialisRaise",
    patterns: ["ankle-raise"],
    regions: ["ankles"],
    roles: ["accessory", "warmup"],
    equipment: { all: ["wall"] },
    position: "standing",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [12, 20], sets: [2, 3], restSec: 30, secsPerRep: 2 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    contraction: ["isotonic"],
    muscles: { primary: ["tibialis"], secondary: [] },
    purposes: ["strength", "warmup"],
    tags: ["running"],
    themes: [],
    text: {
      summary: "Back against a wall, heels out in front: lift your toes toward your shins, then lower.",
      setup: [
        "Stand with your back and hips against a wall, then walk the heels out about a foot's length in front of you.",
        "Legs straight, weight resting on the heels."
      ],
      steps: [
        "Pull the toes and the front of the feet up toward the shins as far as they go.",
        "Pause for a moment at the top.",
        "Lower the feet slowly, stopping just before they touch the floor.",
        "Repeat at a steady pace; walk the heels further out to make it harder."
      ],
      focus: ["Lift from the front of the shin.", "Back and hips stay on the wall."],
      mistakes: ["Slapping the feet down.", "Bending the knees to help.", "Pressing the back of the head into the wall."],
      breathing: "Steady, easy breathing.",
      conditions: { tmj: "No load on the jaw; let the head rest lightly on the wall or stay just off it, never pressing back." },
      why: "Strong shins balance strong calves and help the lower leg handle the pounding of running."
    }
  },

  // ---- Gentle work: a release and ankle circles ----
  {
    id: "calfRelease",
    name: "Calf release · roller or ball",
    family: "calfRelease",
    patterns: ["release"],
    regions: ["calves"],
    roles: ["cooldown", "mobility"],
    equipment: { oneOf: ["foam-roller", "massage-ball"] },
    position: "seated",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [45, 60] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    contraction: ["passive"],
    muscles: { primary: ["gastrocnemius", "soleus"], secondary: [] },
    purposes: ["recovery", "cooldown"],
    tags: [],
    themes: [],
    text: {
      summary: "Sit with one calf on a foam roller or massage ball and roll slowly to ease tight spots.",
      setup: [
        "Sit on the floor with your hands behind you and one calf resting on the roller or ball.",
        "Cross the other leg over the top for more pressure, or leave that foot on the floor for less."
      ],
      steps: [
        "Lift the hips a little and roll slowly from just above the ankle to just below the knee.",
        "Pause on a tender spot and point and flex the foot a few times.",
        "Turn the leg a little in and out to reach the inner and outer calf.",
        "Move off the roller or ball before switching sides."
      ],
      focus: ["Moderate pressure: you can breathe easily.", "Slow, small movements."],
      mistakes: ["Rolling fast back and forth.", "Pressing so hard that you tense up.", "Rolling behind the knee, or staying on a spot that gives sharp pain."],
      breathing: "Long exhales on tender spots.",
      conditions: { tmj: "Keep the jaw slack and the shoulders easy while the hands hold you up; release work goes better when the face isn't braced." },
      why: "Eases calves that feel tight or sore after running, and helps the ankle move freely again."
    }
  },
  {
    id: "ankleCircles",
    name: "Ankle circles",
    family: "ankleMobility",
    patterns: ["mobility"],
    regions: ["ankles"],
    roles: ["warmup", "mobility"],
    position: "seated",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [20, 30] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    contraction: ["isotonic"],
    // A lifted foot hangs pointed: lifting it and turning it out work against gravity; pointing it is gravity's.
    muscles: { primary: ["tibialis", "peroneals"], secondary: ["gastrocnemius", "soleus"] },
    purposes: ["mobility", "warmup", "recovery"],
    tags: ["ankle"],
    themes: ["gentleMobility"],
    text: {
      summary: "Seated, lift one foot and draw slow, full circles with it, then circle the other way.",
      setup: ["Sit tall on a chair or on the floor.", "Lift one foot a little off the floor, holding behind the thigh if that helps."],
      steps: [
        "Draw the biggest, slowest circle you can with the toes, moving only at the ankle.",
        "After a few circles, change direction.",
        "Keep the shin still; the foot does the moving.",
        "Lower the foot, then switch sides."
      ],
      focus: ["Slow, and as big as is comfortable.", "Reach every edge of the circle: toes up, out, down and in."],
      mistakes: ["Turning the whole leg instead of the ankle.", "Rushing through small circles."],
      breathing: "Easy, relaxed breathing.",
      conditions: { tmj: "No effort in the face or jaw; sit tall and let the shoulders drop." },
      why: "Takes the ankle gently through its whole range: a calm start before a run, or an easy way to loosen up after."
    }
  },
]);
