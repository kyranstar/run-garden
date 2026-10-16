// Athletic moves: a graded plyometric ladder (landings first, the tuck jump last) and ski-specific strength and balance.
// Every plyometric move is accessory work dosed in contacts with generous rest; condition profiles decide when it may
// appear (the jaw profile: never in recovery, otherwise only with an answered, calm check).
import { defineExercises } from "../define.js";

export const ATHLETIC = defineExercises([
  // ---- The plyometric ladder ----
  {
    id: "landingStick",
    name: "Step-off landing stick",
    family: "landing",
    patterns: ["squat"],
    regions: ["quads", "glutes", "calves"],
    roles: ["accessory"],
    position: "standing",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [4, 6], sets: [2, 3], restSec: 60, secsPerRep: 6 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    contraction: ["plyometric"],
    muscles: { primary: ["quads", "glute-max"], secondary: ["soleus", "gastrocnemius", "hamstrings"] },
    purposes: ["power", "balance"],
    tags: ["landing", "deceleration"],
    themes: ["plyoIntro", "skiPrep", "athleticBase"],
    harder: ["dropLanding"],
    text: {
      summary: "Step off a low step, land softly on both feet, and hold the landing still.",
      setup: [
        "Stand on a low, stable step no higher than the bottom stair of a staircase.",
        "No step? Rise onto your toes, hop a few centimetres, and make the same quiet landing."
      ],
      steps: [
        "Step forward off the edge; don't jump.",
        "Land on both feet at once, hip-width apart, and sink into a quarter squat.",
        "Hold the landing still for two seconds.",
        "Step back up and reset before the next one."
      ],
      focus: ["Land quietly through the whole foot.", "Knees track over the toes; the hips sit back a little."],
      mistakes: ["Landing stiff-legged with a loud slap.", "Letting the knees fall inward.", "Rushing into the next rep."],
      breathing: "Breathe out softly as you land, and in as you step back up.",
      conditions: { tmj: "Teeth apart, tongue up, soft landing: a quiet landing keeps the jaw quiet too." },
      why: "The first rung of jump training: absorbing a landing well protects the knees and ankles."
    }
  },
  {
    id: "snapDown",
    name: "Snap-down",
    family: "snapDown",
    patterns: ["squat"],
    regions: ["quads", "glutes", "hamstrings"],
    roles: ["accessory"],
    position: "standing",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [5, 8], sets: [2, 3], restSec: 60, secsPerRep: 4 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    contraction: ["plyometric"],
    muscles: { primary: ["quads", "glute-max"], secondary: ["hamstrings", "soleus"] },
    purposes: ["power", "balance"],
    tags: ["landing", "deceleration"],
    themes: ["plyoIntro", "athleticBase"],
    // Gentlest first: graduation takes the first rung the day allows, so the next step up is the smallest one.
    harder: ["pogoHop", "boxJumpStepDown", "broadJumpStick"],
    text: {
      summary: "Rise tall on your toes, then snap down fast into a still, athletic stance.",
      setup: ["Stand tall with the feet hip-width apart.", "Reach both arms overhead and rise onto the balls of the feet."],
      steps: [
        "Pull the arms down and back as you drop quickly into a quarter squat.",
        "Both feet land flat at the same moment, hip-width apart.",
        "Freeze in that stance for two seconds.",
        "Stand tall, reach up, and go again."
      ],
      focus: ["Fast down, then completely still.", "Chest up; the hips sit back."],
      mistakes: ["Dropping too deep and folding forward.", "Feet landing in a different place each rep.", "Stomping."],
      breathing: "A short, sharp breath out as you snap down; breathe in as you rise.",
      conditions: { tmj: "Teeth apart, tongue up, soft landing: the sharp breath out helps keep the jaw loose." },
      why: "Teaches quick, controlled braking with no jump at all, the gentlest way into landing drills."
    }
  },
  {
    id: "pogoHop",
    name: "Pogo hops",
    family: "pogo",
    patterns: ["squat"],
    regions: ["calves", "ankles", "feet"],
    roles: ["accessory"],
    position: "standing",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [10, 20], sets: [2, 3], restSec: 60, secsPerRep: 1 },
    conditions: { tmj: { clench: 1, neckLoad: 1, faceDown: false } },
    difficulty: 2,
    contraction: ["plyometric"],
    muscles: { primary: ["gastrocnemius", "soleus"], secondary: ["tibialis", "feet-intrinsics", "quads"] },
    purposes: ["power", "warmup"],
    tags: ["elastic", "ankle", "running"],
    themes: ["plyoIntro", "athleticBase"],
    providers: { coros: { key: "T1260", confidence: "exact", method: "curated" } }, // COROS: Straight-Leg Hops
    easier: ["snapDown"],
    harder: ["lineHopForwardBack"],
    text: {
      summary: "Small, quick bounces on the balls of the feet with nearly straight knees.",
      setup: ["Stand tall, feet hip-width apart, arms relaxed.", "Use a firm floor and wear trainers."],
      steps: [
        "Bounce a few centimetres off the floor using the ankles.",
        "Touch down on the balls of the feet and spring straight back up.",
        "Keep the knees nearly straight and the heels just off the floor.",
        "Each touchdown is one contact; stop the set when the bounces get heavy or loud."
      ],
      focus: ["Quick, light contacts.", "Tall body; the ankles do the work."],
      mistakes: ["Bending the knees to jump higher.", "Landing on the heels.", "Chasing height instead of rhythm."],
      breathing: "Easy, rhythmic breathing; don't hold it.",
      conditions: { tmj: "Teeth apart, tongue up, soft landing: if the teeth tap together on each bounce, make the hops smaller." },
      why: "Builds springy ankles and calves for running; the gentlest bouncing drill."
    }
  },
  {
    id: "lineHopForwardBack",
    name: "Line hops · forward and back",
    family: "lineHop",
    patterns: ["squat"],
    regions: ["calves", "ankles"],
    roles: ["accessory"],
    position: "standing",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [10, 20], sets: [2, 3], restSec: 60, secsPerRep: 1 },
    conditions: { tmj: { clench: 1, neckLoad: 1, faceDown: false } },
    difficulty: 2,
    contraction: ["plyometric"],
    muscles: { primary: ["gastrocnemius", "soleus"], secondary: ["quads", "tibialis", "feet-intrinsics"] },
    purposes: ["power", "warmup"],
    tags: ["elastic"],
    themes: ["plyoIntro", "athleticBase"],
    easier: ["pogoHop"],
    harder: ["lineHopLateral"],
    text: {
      summary: "Quick two-footed hops forward and back over a line on the floor.",
      setup: [
        "Use a line on the floor: a floor seam, a crack in the pavement, or a rolled towel.",
        "Stand just behind it, feet together, knees soft."
      ],
      steps: [
        "Hop forward over the line, landing lightly on the balls of both feet.",
        "Hop straight back over it.",
        "Keep the hops small and quick, like skipping rope.",
        "Each landing is one contact."
      ],
      focus: ["Low and quick.", "Eyes forward, not down at your feet."],
      mistakes: ["Hopping high and landing heavily.", "Leaning forward and drifting.", "Feet splitting apart."],
      breathing: "Steady, rhythmic breathing.",
      conditions: { tmj: "Teeth apart, tongue up, soft landing: keep the face loose and the hops small." },
      why: "Adds direction to bouncy footwork: quick feet and stiff, springy ankles."
    }
  },
  {
    id: "lineHopLateral",
    name: "Line hops · side to side",
    family: "lineHop",
    patterns: ["squat"],
    regions: ["calves", "ankles"],
    roles: ["accessory"],
    position: "standing",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [10, 20], sets: [2, 3], restSec: 60, secsPerRep: 1 },
    conditions: { tmj: { clench: 1, neckLoad: 1, faceDown: false } },
    difficulty: 2,
    contraction: ["plyometric"],
    muscles: { primary: ["gastrocnemius", "soleus"], secondary: ["peroneals", "glute-med", "tibialis"] },
    purposes: ["power", "warmup"],
    tags: ["elastic", "lateral", "ski"],
    themes: ["plyoIntro", "skiPrep", "athleticBase"],
    easier: ["lineHopForwardBack"],
    harder: ["skaterBoundLow"],
    text: {
      summary: "Quick two-footed hops sideways over a line and back, light and low.",
      setup: ["Stand beside a line on the floor, such as a floor seam or a rolled towel, feet together.", "Knees soft, arms relaxed."],
      steps: [
        "Hop sideways over the line, landing lightly on the balls of both feet.",
        "Hop straight back across it.",
        "Keep the hips and shoulders facing forward the whole time.",
        "Each landing is one contact."
      ],
      focus: ["Small, quick hops.", "Firm ankles, so the feet don't roll outward."],
      mistakes: ["Hopping too wide.", "Landing on the outside edge of the foot.", "Turning the hips with each hop."],
      breathing: "Steady, rhythmic breathing.",
      conditions: { tmj: "Teeth apart, tongue up, soft landing: keep the hops low so each landing stays light." },
      why: "Quick side-to-side footwork and ankle control, the base of fast edge changes on skis."
    }
  },
  {
    id: "skaterBoundLow",
    name: "Low skater hops",
    family: "skater",
    patterns: ["lunge"],
    regions: ["glutes", "hips", "quads"],
    roles: ["accessory"],
    position: "standing",
    laterality: "alternating",
    load: "bodyweight",
    dose: { type: "reps", range: [6, 10], sets: [2, 3], restSec: 60, secsPerRep: 2 },
    conditions: { tmj: { clench: 1, neckLoad: 1, faceDown: false } },
    difficulty: 2,
    contraction: ["plyometric"],
    muscles: { primary: ["glute-med", "glute-max"], secondary: ["quads", "adductors", "soleus"] },
    purposes: ["power", "balance"],
    tags: ["lateral", "single-leg", "elastic", "ski"],
    themes: ["plyoIntro", "skiPrep", "athleticBase"],
    easier: ["lineHopLateral"],
    harder: ["skaterBoundStick", "lateralHopStick"],
    text: {
      summary: "Small hops sideways from one foot to the other, landing softly each time.",
      setup: ["Stand on one foot, knee soft, the free foot lifted behind you.", "Leave room for a short stride either way."],
      steps: [
        "Push off sideways and land softly on the free foot.",
        "Let the trailing foot swing behind; tap it down lightly if you need balance.",
        "Push straight back the way you came.",
        "Keep the hops small and rhythmic; the reps count per leg."
      ],
      focus: ["Land through the whole foot with a bent knee.", "Hips back, chest over the landing knee."],
      mistakes: ["Hopping too far too soon.", "The knee falling inward on landing.", "Standing up tall between hops."],
      breathing: "Steady breathing in rhythm with the hops.",
      conditions: { tmj: "Teeth apart, tongue up, soft landing: make the hops smaller if you notice the jaw tighten." },
      why: "The skier's side-to-side push and catch at low intensity: hip strength and balance with a little spring."
    }
  },
  {
    id: "skaterBoundStick",
    name: "Skater bound and stick",
    family: "skater",
    patterns: ["lunge"],
    regions: ["glutes", "hips", "quads"],
    roles: ["accessory"],
    position: "standing",
    laterality: "alternating",
    load: "bodyweight",
    dose: { type: "reps", range: [4, 6], sets: [2, 3], restSec: 75, secsPerRep: 4 },
    conditions: { tmj: { clench: 2, neckLoad: 1, faceDown: false } },
    difficulty: 3,
    contraction: ["plyometric"],
    muscles: { primary: ["glute-med", "glute-max", "quads"], secondary: ["adductors", "soleus", "peroneals"] },
    purposes: ["power", "balance"],
    tags: ["lateral", "single-leg", "landing", "deceleration", "ski"],
    themes: ["skiPrep", "athleticBase"],
    easier: ["skaterBoundLow"],
    text: {
      summary: "Bound sideways onto one leg and stick the landing for two seconds.",
      setup: ["Stand on one leg, knee soft, with room to bound a long stride sideways.", "Start with short bounds and lengthen them only while you can stick them."],
      steps: [
        "Push off sideways and land on the free foot.",
        "Sink into the landing: hip back, knee over the toes.",
        "Hold still for two seconds without touching the free foot down.",
        "Bound back the way you came and stick it again."
      ],
      focus: ["Quiet, balanced landings.", "Go only as far as you can stick."],
      mistakes: ["Bounding farther than you can control.", "The knee collapsing inward.", "Wobbling into the next bound without a stick."],
      breathing: "Breathe out as you land, then breathe easily through the hold.",
      conditions: { tmj: "Teeth apart, tongue up, soft landing: balance holds invite clenching, so shorten the bound before you grip." },
      why: "Builds the strength to catch your weight sideways on one leg, as in every ski turn."
    }
  },
  {
    id: "lateralHopStick",
    name: "Single-leg lateral hop and stick",
    family: "lateralHop",
    patterns: ["lunge"],
    regions: ["glutes", "quads", "ankles"],
    roles: ["accessory"],
    position: "standing",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [4, 6], sets: [2, 3], restSec: 75, secsPerRep: 4 },
    conditions: { tmj: { clench: 2, neckLoad: 1, faceDown: false } },
    difficulty: 3,
    contraction: ["plyometric"],
    muscles: { primary: ["glute-med", "quads"], secondary: ["soleus", "peroneals", "glute-max"] },
    purposes: ["power", "balance"],
    tags: ["lateral", "single-leg", "landing", "deceleration", "ski"],
    themes: ["skiPrep", "athleticBase"],
    easier: ["skaterBoundLow"],
    text: {
      summary: "Hop sideways on one leg, land on the same leg, and hold it still.",
      setup: ["Stand on one leg beside a line on the floor, knee soft.", "Hands on the hips or relaxed for balance."],
      steps: [
        "Hop sideways over the line, landing on the same foot.",
        "Sink into the landing and hold still for two seconds.",
        "Hop back across and stick it again.",
        "Finish the reps, then switch legs."
      ],
      focus: ["Small hops you can stick.", "Ankle, knee and hip stack over the foot."],
      mistakes: ["Hopping wider than you can hold.", "Rolling onto the outside of the foot.", "The hip dropping on the free-leg side."],
      breathing: "Breathe out on each landing, then breathe easily through the hold.",
      conditions: { tmj: "Teeth apart, tongue up, soft landing: if you need to grip to stay up, make the hop smaller." },
      why: "Single-leg landing control sideways: ankle and hip stability for skiing and uneven ground."
    }
  },
  {
    id: "broadJumpStick",
    name: "Broad jump and stick",
    family: "broadJump",
    patterns: ["squat", "hinge"],
    regions: ["glutes", "quads", "hamstrings"],
    roles: ["accessory"],
    position: "standing",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [3, 5], sets: [2, 4], restSec: 90, secsPerRep: 8 },
    conditions: { tmj: { clench: 2, neckLoad: 1, faceDown: false } },
    difficulty: 3,
    contraction: ["plyometric"],
    muscles: { primary: ["glute-max", "quads"], secondary: ["hamstrings", "gastrocnemius", "erector-spinae"] },
    purposes: ["power"],
    tags: ["landing", "deceleration"],
    themes: ["athleticBase"],
    easier: ["snapDown"],
    harder: ["tuckJump"],
    text: {
      summary: "Jump forward off both feet and stick a quiet, balanced landing.",
      setup: ["Stand with the feet hip-width apart and two or three metres of clear floor ahead.", "Start with short jumps, about a foot-length."],
      steps: [
        "Swing the arms back as you dip the hips.",
        "Swing the arms forward and jump forward.",
        "Land on both feet at once in a quarter squat and hold for two seconds.",
        "Walk back and reset before the next jump."
      ],
      focus: ["Jump only as far as you can stick.", "Land with the knees over the toes and the chest up."],
      mistakes: ["Chasing distance before the landing is solid.", "Landing on the heels.", "Knees caving in."],
      breathing: "Breathe in as you load, out as you jump and land.",
      conditions: { tmj: "Teeth apart, tongue up, soft landing: a big jump tempts a clench, so keep to a distance you can land quietly." },
      why: "Teaches you to produce force and then absorb it, the core skill of every jump."
    }
  },
  {
    id: "boxJumpStepDown",
    name: "Box jump, step down",
    family: "boxJump",
    patterns: ["squat"],
    regions: ["quads", "glutes", "calves"],
    roles: ["accessory"],
    equipment: { oneOf: ["bench"] },
    position: "standing",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [3, 5], sets: [2, 4], restSec: 90, secsPerRep: 6 },
    conditions: { tmj: { clench: 2, neckLoad: 1, faceDown: false } },
    difficulty: 3,
    contraction: ["plyometric"],
    muscles: { primary: ["quads", "glute-max"], secondary: ["gastrocnemius", "soleus", "hamstrings"] },
    purposes: ["power"],
    tags: ["elastic"],
    themes: ["athleticBase"],
    providers: { coros: { key: "T1014", confidence: "exact", method: "curated" } }, // COROS: Box Jumps
    easier: ["snapDown"],
    harder: ["tuckJump"],
    text: {
      summary: "Jump onto a sturdy box, aerobic step or stair, stand tall, then step down.",
      setup: [
        "Use a sturdy box, an aerobic step or a stair that can't tip or slide, no higher than your knee; start low.",
        "A wide, stable bench works; never a narrow one, where a foot can land half on the edge and the bench can tip.",
        "Stand a short step away, feet hip-width apart."
      ],
      steps: [
        "Dip the hips and swing the arms back.",
        "Jump up and land softly on the whole foot in a quarter squat.",
        "Stand up tall on top.",
        "Step down one foot at a time; never jump down."
      ],
      focus: ["Land on the box as quietly as you'd land on the floor.", "Pick a height you clear easily."],
      mistakes: ["A box so high you land in a deep squat.", "Jumping back down.", "Landing with the heels hanging off the edge."],
      breathing: "Breathe out as you jump, and in as you step down.",
      conditions: { tmj: "Teeth apart, tongue up, soft landing: the effort of the jump is where the jaw braces, so keep the height modest." },
      why: "Trains the jump with a gentle landing, because the box meets you near the top of the jump."
    }
  },
  {
    id: "dropLanding",
    name: "Drop landing",
    family: "landing",
    patterns: ["squat"],
    regions: ["quads", "glutes", "calves"],
    roles: ["accessory"],
    equipment: { oneOf: ["bench"] },
    position: "standing",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [3, 5], sets: [2, 3], restSec: 90, secsPerRep: 8 },
    conditions: { tmj: { clench: 2, neckLoad: 1, faceDown: false } },
    difficulty: 4,
    contraction: ["plyometric"],
    muscles: { primary: ["quads", "glute-max"], secondary: ["hamstrings", "soleus", "gastrocnemius"] },
    purposes: ["power", "balance"],
    tags: ["landing", "deceleration", "ski"],
    themes: ["skiPrep", "athleticBase"],
    easier: ["landingStick"],
    harder: ["tuckJump"],
    text: {
      summary: "Step off a low box, land on both feet, and absorb the landing quietly.",
      setup: [
        "Stand on a sturdy low box, a step, a stair or a wide, stable bench that can't tip; start around mid-shin height and stay below the knee.",
        "Toes at the edge, feet hip-width apart."
      ],
      steps: [
        "Step forward off the edge; don't jump up first.",
        "Land on both feet at once and sink into a half squat to absorb it.",
        "Hold the landing for two seconds.",
        "Step back up and reset before the next one."
      ],
      focus: ["Land softly through the whole foot.", "Knees track over the toes; the hips sit back."],
      mistakes: ["Starting too high.", "Landing stiff-legged or with the knees falling in.", "Bouncing straight out of the landing."],
      breathing: "Breathe out as you land, and in as you step back up.",
      conditions: { tmj: "Teeth apart, tongue up, soft landing: a higher drop lands harder through the jaw and neck, so raise the height slowly." },
      why: "Trains the legs to absorb bigger landings, like dropping off a bump on skis."
    }
  },
  {
    id: "tuckJump",
    name: "Tuck jump",
    family: "tuckJump",
    patterns: ["squat"],
    regions: ["quads", "glutes", "calves", "hips"],
    roles: ["accessory"],
    position: "standing",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [3, 5], sets: [2, 3], restSec: 120, secsPerRep: 4 },
    conditions: { tmj: { clench: 2, neckLoad: 1, faceDown: false } },
    difficulty: 5,
    contraction: ["plyometric"],
    muscles: { primary: ["quads", "glute-max", "gastrocnemius"], secondary: ["hip-flexors", "rectus-abdominis", "soleus"] },
    purposes: ["power"],
    tags: ["elastic", "landing"],
    themes: ["athleticBase"],
    easier: ["broadJumpStick", "dropLanding", "boxJumpStepDown"],
    text: {
      summary: "Jump straight up, draw the knees toward the chest, and land softly.",
      setup: ["Stand with the feet hip-width apart on a firm floor, arms ready to swing.", "Only once the stick and hop drills feel easy."],
      steps: [
        "Dip and swing the arms, then jump straight up.",
        "At the top, bring the knees up toward the chest.",
        "Reach the legs down early and land softly on both feet in a quarter squat.",
        "Reset fully between jumps."
      ],
      focus: ["The knees come up to you; don't fold the chest down to them.", "Head level, eyes forward."],
      mistakes: ["Rounding the back and dropping the chin.", "Landing with straight legs.", "Chaining jumps before each landing is quiet."],
      breathing: "Breathe in as you dip and out as you jump; reset the breath between reps.",
      conditions: { tmj: "Teeth apart, tongue up, soft landing: this is the hardest landing here, so stop if the jaw or head feels jarred." },
      why: "The top of the ladder: full jumping power with a fast, controlled landing."
    }
  },

  // ---- Ski-specific strength and balance ----
  {
    id: "wallSitSingleLegShift",
    name: "Wall sit · single-leg shift",
    family: "wallSit",
    patterns: ["squat"],
    regions: ["quads", "glutes"],
    roles: ["core", "accessory"],
    equipment: { all: ["wall"] },
    position: "standing",
    laterality: "alternating",
    load: "bodyweight",
    dose: { type: "time", range: [30, 45], sets: [2, 3], restSec: 60 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 3,
    contraction: ["isometric"],
    muscles: { primary: ["quads"], secondary: ["glute-max", "glute-med", "adductors"] },
    purposes: ["strength"],
    tags: ["ski", "single-leg"],
    themes: ["skiPrep"],
    easier: ["wallSit"],
    text: {
      summary: "In a wall sit, shift your weight over one foot and lift the other, then alternate.",
      setup: [
        "Back flat against a wall, feet hip-width apart and about a foot-length out, as for a wall sit.",
        "Slide down to a depth you can hold comfortably."
      ],
      steps: [
        "Shift your weight over one foot and lift the other just off the floor.",
        "Hold for three to five slow breaths with the knees level.",
        "Set the foot down, shift across, and lift the opposite foot.",
        "Keep alternating until the time is up, then slide up the wall to finish."
      ],
      focus: ["The working knee stays over the middle toes.", "The hips stay level against the wall."],
      mistakes: ["Sliding lower as you shift.", "Pushing a hand into the thigh.", "Holding the breath while a foot is up."],
      breathing: "Slow nasal breathing; breathe out as you lift the foot.",
      conditions: { tmj: "Long, burning holds invite gritting: keep the teeth apart and come up the wall a little if the jaw tightens." },
      why: "Loads one leg at a time in a ski-like crouch, with the wall looking after your balance."
    }
  },
  {
    id: "singleLegBalanceReach",
    name: "Single-leg balance reach",
    family: "balanceReach",
    patterns: ["lunge"],
    regions: ["glutes", "ankles", "feet"],
    roles: ["activation", "warmup", "accessory"],
    position: "standing",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [3, 6], sets: [2, 3], restSec: 30, secsPerRep: 8 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    contraction: ["isotonic"],
    muscles: { primary: ["glute-med"], secondary: ["quads", "glute-max", "peroneals", "feet-intrinsics"] },
    purposes: ["balance", "activation"],
    tags: ["balance", "single-leg", "ski"],
    themes: ["skiPrep", "athleticBase"],
    text: {
      summary: "Balance on one leg and reach the other foot to the front, the side and behind.",
      setup: ["Stand on one leg with a soft knee, hands on the hips.", "Keep a wall or chair within reach if you need it."],
      steps: [
        "Bend the standing knee a little and reach the free foot forward to tap the floor lightly.",
        "Come back to the middle, then reach out to the side, then behind you.",
        "Front, side and back is one rep; keep the standing foot flat.",
        "Finish the reps, then switch legs."
      ],
      focus: ["The standing knee tracks over the middle toes.", "Reach only as far as you can tap lightly, with no weight on the reaching foot."],
      mistakes: ["Putting weight on the reaching foot.", "Letting the standing hip drop or swing out.", "Rushing the reaches."],
      breathing: "Breathe out as you reach, and in as you come back.",
      conditions: { tmj: "Balance work invites gripping with the jaw; touch the support rather than clenching to stay up." },
      why: "Trains balance and knee control on one leg, the base for skiing and running on uneven ground."
    }
  },
  {
    id: "nordicCurlAssisted",
    name: "Assisted Nordic curl",
    family: "nordicCurl",
    patterns: ["hinge"],
    regions: ["hamstrings", "glutes"],
    roles: ["accessory"],
    equipment: { all: ["mat"] },
    position: "kneeling",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [3, 6], sets: [2, 3], restSec: 90, secsPerRep: 6 },
    conditions: { tmj: { clench: 2, neckLoad: 1, faceDown: false } },
    difficulty: 4,
    contraction: ["eccentric"],
    muscles: { primary: ["hamstrings"], secondary: ["glute-max", "gastrocnemius"] },
    purposes: ["strength"],
    tags: ["eccentric-emphasis", "ski"],
    themes: ["posteriorChain", "skiPrep"],
    easier: ["hamstringBridgeChair"],
    text: {
      summary: "Kneeling with the heels anchored, lower the body forward slowly, then push back up.",
      setup: [
        "Kneel on a padded mat and anchor the heels under something heavy that won't move, such as a heavy sofa, or have a partner hold your ankles.",
        "Body upright from knees to head, hands ready in front of the chest."
      ],
      steps: [
        "Keeping the hips straight, lean forward from the knees as slowly as you can.",
        "Resist all the way down with the backs of the thighs.",
        "When you can't hold any longer, catch yourself on your hands.",
        "Push off the floor just enough to help the hamstrings pull you back up."
      ],
      focus: ["Knees to shoulders in one straight line.", "The slow lowering is the exercise."],
      mistakes: [
        "Bending at the hips to make it easier.",
        "Dropping fast after the first few degrees.",
        "Doing too many the first time; the soreness arrives a day or two later."
      ],
      breathing: "Breathe out slowly as you lower, and in at the bottom.",
      conditions: { tmj: "Hard, slow lowering invites a clench: teeth apart, tongue up, and end the set the moment you notice gritting." },
      why: "Builds hamstring strength at long lengths, which helps protect the knees when skiing and sprinting."
    }
  },
  {
    id: "lateralLungeToBalance",
    name: "Lateral lunge to balance",
    family: "lateralLunge",
    patterns: ["lunge"],
    regions: ["hips", "glutes", "quads"],
    roles: ["accessory", "warmup"],
    position: "standing",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [6, 10], sets: [2, 3], restSec: 45, secsPerRep: 4 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    contraction: ["isotonic"],
    muscles: { primary: ["quads", "glute-max", "adductors"], secondary: ["glute-med", "hamstrings"] },
    purposes: ["strength", "balance"],
    tags: ["lateral", "single-leg", "ski"],
    themes: ["skiPrep", "athleticBase", "hipsPosture"],
    harder: ["cossackSquat"],
    text: {
      summary: "Step wide into a side lunge, push back, and lift that knee into a balance.",
      setup: ["Stand tall with the feet together and room to step wide to one side.", "Hands at the chest or on the hips."],
      steps: [
        "Step wide to the side and sit the hips back over that foot, the other leg long.",
        "Push hard off the bent leg to bring it back toward the middle.",
        "Without setting it down, lift that knee to hip height and balance on the standing leg for one breath.",
        "Finish the reps, then switch sides."
      ],
      focus: ["The bent knee tracks over the toes, heel down.", "Arrive in the balance tall and still."],
      mistakes: ["Stepping so wide the heel lifts.", "Rounding forward in the lunge.", "Rushing through the balance."],
      breathing: "Breathe in as you lunge, and out as you push back to the balance.",
      conditions: { tmj: "Balance moves invite gripping with the jaw; touch a wall if you need to so the face can stay soft." },
      why: "Sideways strength and balance in one move: the push and recovery of a ski turn."
    }
  },
  {
    id: "skaterSquat",
    name: "Skater squat",
    family: "singleLegSquat",
    patterns: ["lunge"],
    regions: ["quads", "glutes"],
    roles: ["accessory"],
    position: "standing",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [4, 8], sets: [2, 3], restSec: 60, secsPerRep: 5 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 4,
    contraction: ["isotonic", "eccentric"],
    muscles: { primary: ["quads", "glute-max"], secondary: ["glute-med", "adductors", "hamstrings"] },
    purposes: ["strength", "balance"],
    tags: ["single-leg", "ski"],
    themes: ["skiPrep", "athleticBase"],
    easier: ["stepDownHeelTap", "bwBulgarianSplitSquat"],
    text: {
      summary: "On one leg, lower until the back knee touches a cushion behind you, then stand.",
      setup: [
        "Stand on one leg with a folded mat or cushion on the floor just behind you.",
        "Bend the free knee so that foot is behind you; arms forward for balance."
      ],
      steps: [
        "Lean slightly forward and bend the standing knee, lowering the free knee toward the cushion.",
        "Touch it lightly; don't rest on it.",
        "Drive through the whole standing foot to stand tall.",
        "Finish the reps, then switch legs."
      ],
      focus: ["Slow on the way down.", "The standing knee tracks over the middle toes."],
      mistakes: ["Dropping onto the back knee.", "Letting the standing knee cave in.", "Lifting the standing heel."],
      breathing: "Breathe in on the way down, and out as you stand.",
      conditions: { tmj: "Single-leg strength invites bracing; reach the arms forward for balance and keep the teeth apart." },
      why: "Builds single-leg strength and control for the deep, one-legged positions skiing asks for."
    }
  },
  {
    id: "stepDownHeelTap",
    name: "Eccentric step-down · heel tap",
    family: "singleLegSquat",
    patterns: ["lunge"],
    regions: ["quads", "glutes"],
    roles: ["accessory"],
    position: "standing",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [6, 10], sets: [2, 3], restSec: 45, secsPerRep: 5 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 3,
    contraction: ["isotonic", "eccentric"],
    muscles: { primary: ["quads", "glute-med"], secondary: ["glute-max", "soleus", "tibialis"] },
    purposes: ["strength", "balance"],
    tags: ["ski", "single-leg"],
    themes: ["skiPrep", "athleticBase"],
    easier: ["stepUp"],
    harder: ["skaterSquat"],
    text: {
      summary: "On a low step, slowly lower the free heel to tap the floor, then stand tall.",
      setup: [
        "Stand on one leg on a low, stable step or the bottom stair, the other foot hanging just off the front edge.",
        "Fingertips on a wall or rail for balance."
      ],
      steps: [
        "Bend the standing knee and lower slowly, about three seconds, until the free heel lightly taps the floor.",
        "Keep the standing knee over the middle toes and the hips level.",
        "Press through the whole standing foot to stand tall again.",
        "Finish the reps, then switch legs."
      ],
      focus: ["The slow lowering is the exercise.", "Tap, don't rest: no weight goes into the heel."],
      mistakes: ["Dropping the last few centimetres.", "Letting the standing knee cave in.", "Pushing off the floor with the tapping heel."],
      breathing: "Breathe in as you lower, and out as you stand.",
      conditions: { tmj: "Slow single-leg lowering invites bracing; keep a hand on the wall so the jaw can stay soft." },
      why: "Trains the knee to stay steady over the foot while the thigh brakes, the control skiing asks for on every turn."
    }
  },
  {
    id: "pallofIsoHoldHalfKneel",
    name: "Half-kneeling Pallof hold",
    family: "pallof",
    patterns: ["anti-rotate"],
    regions: ["core"],
    roles: ["accessory", "activation"],
    equipment: { all: ["band"] },
    position: "half-kneeling",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "time", range: [20, 30], sets: [2, 3], restSec: 30 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    contraction: ["isometric"],
    muscles: { primary: ["obliques", "transverse-abdominis"], secondary: ["glute-max", "glute-med", "serratus-anterior"] },
    purposes: ["strength", "activation"],
    tags: ["anti-rotation", "ski"],
    themes: ["carryDay", "skiPrep", "athleticBase"],
    easier: ["wallPallofHold"],
    harder: ["bandPallofPress"],
    text: {
      summary: "Kneel side-on to a band anchor, press the band out, and hold without turning.",
      setup: [
        "Anchor a band at chest height and kneel side-on to it, the knee nearer the anchor down and the other foot forward.",
        "Hold the band at the middle of the chest, far enough from the anchor that it's taut."
      ],
      steps: [
        "Squeeze the glute of the kneeling leg and stand tall through the hips.",
        "Press the hands straight out from the chest.",
        "Hold, breathing slowly, without letting the band turn you.",
        "Bring the hands in, then turn around and switch sides."
      ],
      focus: ["Hips and shoulders face straight ahead.", "Tall from the knee to the head."],
      mistakes: ["Leaning away from the anchor.", "Arching the low back.", "Shrugging toward the ears."],
      breathing: "Slow nasal breathing through the hold.",
      conditions: { tmj: "Holds invite bracing: tongue up, teeth apart, and step closer to the anchor if the jaw tightens." },
      why: "Kneeling takes the legs out of it, so the trunk does the anti-rotation work skiing asks for."
    }
  },
]);
