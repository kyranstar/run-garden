// Library curation, Task 13 (A9, R9): the lower-limb stretches the library lacked (hamstrings standing and
// half-kneeling, the quads standing and side-lying, the inner thighs), slow-lowering strength (a bent-knee heel drop, a
// push-up, a single-leg sit to a box, a hamstring slide-out, a pull-up), and the gym's barbell, machine and pull-up-bar
// moves. Each is rated for the jaw profile with a note; the heavy lifts are rated for the bracing they invite.
import { defineExercises } from "../define.js";

export const LOWER_LIMB_GYM = defineExercises([
  // ── Lower-limb stretches ────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "standingHamstringStretch",
    name: "Standing hamstring stretch",
    family: "hamstringStretch",
    patterns: ["mobility"],
    regions: ["hamstrings"],
    roles: ["stretch", "cooldown"],
    position: "standing",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [30, 45] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    contraction: ["passive"],
    muscles: { primary: ["hamstrings"], secondary: ["gastrocnemius"] },
    purposes: ["stretch", "cooldown"],
    themes: ["gentleMobility"],
    text: {
      summary: "Heel forward and toes up, fold from the hips until the back of the thigh stretches.",
      setup: [
        "Stand tall and put one foot a short step forward, heel on the floor and toes lifted.",
        "Soften the back knee and rest both hands on the back thigh, or a hand on a wall or chair for balance."
      ],
      steps: [
        "Keeping the back long, fold forward from the hips until the back of the front thigh stretches.",
        "Stop at a mild, even stretch, the front knee straight but not locked.",
        "Hold and breathe slowly, letting the hips sit back a little further only if it eases.",
        "Come up tall, then switch legs."
      ],
      focus: ["The fold comes from the hip crease, not from rounding the back.", "Toes stay lifted so the stretch runs up from the knee."],
      mistakes: ["Rounding the back to reach lower.", "Pressing down on the front knee.", "Bouncing into the stretch."],
      breathing: "Long, slow breaths, a little longer out than in.",
      conditions: { tmj: "Standing and unloaded: let the head follow the spine as you fold, so the neck isn't craned, and keep the jaw loose." },
      why: "Eases hamstrings tight from running or sitting, anywhere, with nothing to lie on."
    }
  },
  {
    id: "halfKneelingHamstringStretch",
    name: "Half-kneeling hamstring stretch",
    family: "hamstringStretch",
    patterns: ["mobility"],
    regions: ["hamstrings"],
    roles: ["stretch", "mobility", "cooldown"],
    position: "half-kneeling",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [30, 45] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    contraction: ["passive"],
    muscles: { primary: ["hamstrings"], secondary: ["gastrocnemius"] },
    purposes: ["stretch", "mobility", "cooldown"],
    themes: ["gentleMobility"],
    text: {
      summary: "Kneel on one knee with the front leg straight, heel down, and fold forward over it.",
      setup: [
        "Kneel on one knee, with a folded towel under it if the floor is hard.",
        "Straighten the other leg out in front, heel on the floor and toes up; rest the hands on the floor beside it or on the thigh."
      ],
      steps: [
        "Sit the hips back toward the back heel until the front leg is straight.",
        "With a long back, fold forward from the hips until the back of the front thigh stretches.",
        "Hold and breathe, easing a little deeper only as the stretch lets go.",
        "Come back up, then switch legs."
      ],
      focus: ["Hips stay square to the front leg.", "The back stays long; the stretch comes from tipping the pelvis forward."],
      mistakes: ["Rounding the back to bring the head down.", "Letting the front foot fall out to the side.", "Forcing the front knee straight."],
      breathing: "Slow breaths, longer out than in.",
      conditions: { tmj: "Low and unloaded: keep the gaze down past the front knee so the neck stays long and the jaw easy." },
      why: "A steady hamstring stretch to sink into after a run, with the floor holding you up."
    }
  },
  {
    id: "standingQuadStretch",
    name: "Standing quad stretch",
    family: "quadStretch",
    patterns: ["mobility"],
    regions: ["quads", "hips"],
    roles: ["stretch", "cooldown"],
    position: "standing",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [30, 45] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    contraction: ["passive"],
    muscles: { primary: ["quads"], secondary: ["hip-flexors"] },
    purposes: ["stretch", "cooldown"],
    themes: ["gentleMobility"],
    text: {
      summary: "Stand tall, hold one ankle behind you and draw the heel toward your seat.",
      setup: [
        "Stand beside a wall or a chair back and rest one hand on it for balance.",
        "Bend one knee and hold that ankle or the top of the foot behind you; a towel round the foot helps if you can't reach."
      ],
      steps: [
        "Bring the bent knee down beside the standing knee, pointing at the floor.",
        "Tuck the tailbone slightly under and draw the heel toward your seat until the front of the thigh stretches.",
        "Hold and breathe, standing tall.",
        "Lower the foot with control, then switch legs."
      ],
      focus: ["Knees side by side: the stretch comes from tucking the hips, not from pulling hard.", "Standing knee soft, ribs over the hips."],
      mistakes: ["Arching the low back.", "Letting the bent knee drift forward or out to the side.", "Yanking the heel into the seat."],
      breathing: "Easy breaths; let each breath out settle the stretch.",
      conditions: { tmj: "Standing and unloaded: keep the head level and the teeth apart rather than gritting to balance." },
      why: "Eases the front of the thigh after a run or a long day on your feet, in a minute, anywhere."
    }
  },
  {
    id: "sideLyingQuadStretch",
    name: "Side-lying quad stretch",
    family: "quadStretch",
    patterns: ["mobility"],
    regions: ["quads", "hips"],
    roles: ["stretch", "cooldown"],
    position: "side-lying",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [30, 60] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    contraction: ["passive"],
    muscles: { primary: ["quads"], secondary: ["hip-flexors"] },
    purposes: ["stretch", "cooldown", "recovery"],
    themes: ["gentleMobility"],
    text: {
      summary: "Lie on your side, hold the top ankle and draw the heel back until the thigh stretches.",
      setup: [
        "Lie on your side with the head resting on the lower arm or a folded towel.",
        "Bend the bottom knee forward a little to keep you steady."
      ],
      steps: [
        "Bend the top knee and hold that ankle or foot behind you, or loop a towel round it.",
        "Keep the knees level and gently draw the heel back toward your seat until the front of the thigh stretches.",
        "Ease the top hip forward a little to deepen it; hold and breathe.",
        "Let go slowly, then turn over to switch legs."
      ],
      focus: ["Top knee level with the bottom one, not lifted.", "The pelvis tips forward a little; the back doesn't arch."],
      mistakes: ["Arching the low back to reach the foot.", "Letting the top knee float up toward the ceiling.", "Pulling into pain at the knee."],
      breathing: "Slow breaths, letting the thigh soften on each breath out.",
      conditions: {
        tmj: "Rest the head on a folded towel or the arm so the neck stays level and nothing presses on the jaw; if lying on one side bothers it, keep that side short."
      },
      why: "A gentler quad stretch than the kneeling ones, with the floor carrying you: right for an easy day."
    }
  },
  {
    id: "adductorRockBack",
    name: "Adductor rock-back",
    family: "adductorMobility",
    patterns: ["mobility"],
    // The straight leg out to the side stretches the inner hamstrings as well as the adductors.
    regions: ["hips", "hamstrings"],
    roles: ["warmup", "mobility"],
    position: "quadruped",
    laterality: "unilateral",
    load: "none",
    dose: { type: "reps", range: [8, 12], secsPerRep: 4 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["hip-opening"],
    contraction: ["isotonic"],
    muscles: { primary: ["adductors"], secondary: ["hamstrings", "glute-max"] },
    purposes: ["mobility", "warmup", "stretch"],
    themes: ["hipsPosture", "gentleMobility"],
    harder: ["frogStretch"],
    text: {
      summary: "On hands and knees with one leg out to the side, rock the hips back and forward.",
      setup: [
        "Start on hands and knees, with something soft under the knees if the floor is hard.",
        "Straighten one leg out to the side, foot flat and toes pointing forward, in line with the kneeling knee."
      ],
      steps: [
        "With a long, flat back, rock the hips back toward the kneeling heel until the inner thigh of the straight leg stretches.",
        "Pause for a breath, then rock forward to the start.",
        "Go a little further back each time as the hip loosens.",
        "Finish the reps, then switch legs."
      ],
      focus: ["The back stays flat; the movement is at the hips.", "The straight leg's foot stays flat on the floor."],
      mistakes: ["Rounding the low back at the end of the rock.", "Rolling the straight leg's foot onto its edge.", "Rushing the rocks."],
      breathing: "Breathe out as you rock back, in as you come forward.",
      conditions: { tmj: "On hands and knees, let the head hang in line with the spine rather than looking up, and keep the jaw soft." },
      why: "Loosens the inner thighs and hips for running, squats and lunges, a little more with each rock."
    }
  },
  {
    id: "frogStretch",
    name: "Frog stretch",
    family: "adductorMobility",
    patterns: ["mobility"],
    regions: ["hips"],
    roles: ["stretch", "mobility", "cooldown"],
    position: "quadruped",
    laterality: "bilateral",
    load: "none",
    dose: { type: "time", range: [45, 90] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    tags: ["hip-opening"],
    contraction: ["passive"],
    muscles: { primary: ["adductors"], secondary: ["deep-hip-rotators"] },
    purposes: ["stretch", "mobility"],
    themes: ["hipsPosture", "gentleMobility"],
    easier: ["adductorRockBack"],
    text: {
      summary: "Knees wide and forearms down, let the hips sink back to open the inner thighs.",
      setup: [
        "Kneel on a mat or something soft and walk the knees out wide, ankles in line with the knees and the insides of the feet on the floor.",
        "Lower onto the forearms."
      ],
      steps: [
        "Let the hips ease back toward the heels until the inner thighs stretch.",
        "Stay where the stretch is strong but still easy to breathe in.",
        "Hold, letting the hips sink a little only as they soften.",
        "Come out by walking the hands back toward the knees and bringing the knees in."
      ],
      focus: ["Low back long, not sagging.", "Ankles stay in line with the knees."],
      mistakes: ["Forcing the knees wider than they want to go.", "Letting the low back sag toward the floor.", "Holding the breath."],
      breathing: "Slow belly breaths; each breath out lets the hips drop a little.",
      conditions: { tmj: "Rest the forehead on stacked hands if the neck tires, never the chin on the floor, and let the jaw hang loose." },
      why: "Opens the inner thighs and hips deeply after runs or long sitting, with no load at all."
    }
  },

  // ── Slow-lowering strength ──────────────────────────────────────────────────────────────────────────────────────
  {
    id: "bentKneeHeelDrop",
    name: "Eccentric heel drop · bent knee",
    family: "calfRaise",
    patterns: ["calf-raise"],
    regions: ["calves", "ankles"],
    roles: ["accessory"],
    position: "standing",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [8, 15], sets: [2, 3], restSec: 60, secsPerRep: 5 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    // Up on both feet, down on one, the knee bent throughout: the bend slackens the big calf muscle, so the deep one
    // does the slow lowering.
    contraction: ["isotonic", "eccentric"],
    muscles: { primary: ["soleus"], secondary: ["gastrocnemius", "peroneals", "quads"] },
    purposes: ["strength"],
    tags: ["eccentric-emphasis", "single-leg", "running"],
    themes: [],
    easier: ["bentKneeCalfRaise"],
    text: {
      summary: "Knees bent, rise on both feet at a step's edge and lower slowly on one.",
      setup: [
        "Stand with the balls of both feet on the edge of a low, stable step or the bottom stair, heels hanging off, fingertips on a wall or rail.",
        "Bend both knees about 30–45° and keep that bend for every rep. No step? Do it on flat floor, lowering until the heel touches down."
      ],
      steps: [
        "Keeping the knee bend, rise onto the balls of both feet.",
        "Lift one foot and lower on the other slowly, about three seconds, until its heel is a little below the step.",
        "Put the other foot back down and rise on both feet again.",
        "Finish the reps, then switch legs."
      ],
      focus: [
        "The knee stays bent the whole way: that is what works the deep calf muscle.",
        "The slow lowering is the exercise; the rise is only the way back up.",
        "Mild discomfort that settles by the next morning is fine; with sharp pain, or soreness at the back of the heel bone, lower only to step level or flat floor, never below."
      ],
      mistakes: [
        "Straightening the knee as you lower.",
        "Dropping through the last part of the lowering.",
        "Doing a lot the first time: slow lowering is new work, and calves new to it stay sore for a day or two."
      ],
      breathing: "Breathe in as you rise, and out slowly as you lower.",
      conditions: { tmj: "The jaw braces as the bent-knee heel sinks slowest, near the bottom: breathe out through soft lips there and keep the teeth apart." },
      why: "Slow lowering with a bent knee toughens the deep calf muscle and the tendon above the heel for hills and long runs."
    }
  },
  {
    id: "eccentricPushup",
    name: "Slow-lowering push-up",
    family: "pushup",
    patterns: ["push-h"],
    regions: ["chest", "shoulders", "arms", "core"],
    roles: ["accessory"],
    position: "quadruped",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [4, 8], sets: [2, 3], restSec: 60, secsPerRep: 6 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 3,
    contraction: ["eccentric", "isotonic"],
    muscles: { primary: ["pecs", "triceps"], secondary: ["deltoids", "serratus-anterior", "rectus-abdominis"] },
    purposes: ["strength"],
    tags: ["eccentric-emphasis"],
    themes: ["fullBody"],
    easier: ["kneelingPushup"],
    text: {
      summary: "From a plank, lower your chest to the floor over four seconds; knees down to come up.",
      setup: ["Start in a high plank: hands under the shoulders and the body in one line from head to heels."],
      steps: [
        "Bend the elbows and lower the chest toward the floor slowly, counting four.",
        "Keep the body in one line all the way down until the chest nearly touches.",
        "Drop the knees and push back up from there.",
        "Step the feet back into the plank for the next rep."
      ],
      focus: ["Elbows angle back about 45°, not flared wide.", "The slow lowering is the work; the way back up is the easy part."],
      mistakes: ["Letting the hips sag first.", "Speeding up through the bottom half.", "Reaching for the floor with the head."],
      breathing: "Breathe out slowly as you lower; breathe in as you reset.",
      conditions: { tmj: "A plank invites bracing through the face: keep the teeth apart and the neck long, and lower from the knees if the jaw tightens." },
      why: "Builds push-up strength through the lowering, the part you're strongest in, until full push-ups come."
    }
  },
  {
    id: "singleLegBoxSit",
    name: "Single-leg sit to box",
    family: "singleLegSquat",
    // One leg's squat is filed as the library's other single-leg squats are (the skater squat): a lunge.
    patterns: ["lunge"],
    regions: ["quads", "glutes"],
    roles: ["accessory"],
    equipment: { oneOf: ["bench", "chair"] },
    position: "standing",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [4, 8], sets: [2, 3], restSec: 60, secsPerRep: 6 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 3,
    contraction: ["eccentric", "isotonic"],
    muscles: { primary: ["quads", "glute-max"], secondary: ["glute-med", "adductors"] },
    purposes: ["strength", "balance"],
    tags: ["eccentric-emphasis", "single-leg"],
    themes: ["skiPrep", "athleticBase"],
    easier: ["boxSquat"],
    text: {
      summary: "Stand on one leg in front of a bench and lower slowly to sit; stand up on both.",
      setup: [
        "Stand with your back to a sturdy bench or chair, a short step in front of it.",
        "Shift your weight onto one foot and lift the other just off the floor in front of you, arms reaching forward for balance."
      ],
      steps: [
        "Bend the standing knee and sit back slowly, counting four, until you sit on the seat.",
        "Keep the knee over the middle of the foot all the way down.",
        "Put the other foot down and stand up on both feet.",
        "Finish the reps, then switch legs."
      ],
      focus: ["Lower under control right to the seat: no dropping the last part.", "The chest leans forward a little as the hips go back."],
      mistakes: ["Letting the knee cave inward.", "Collapsing onto the seat at the end.", "Using a seat so low you can't control the lowering: pick a higher one."],
      breathing: "Breathe out slowly as you lower; breathe in as you stand.",
      conditions: { tmj: "One-legged work invites bracing: keep the teeth apart and breathe out through the lowering; a fingertip on a wall takes the balance off the jaw." },
      why: "Slow single-leg lowering builds the thighs and hips that brake every downhill stride and landing."
    }
  },
  {
    id: "hamstringSlideOut",
    name: "Slow hamstring slide-out",
    family: "hamstringBridge",
    patterns: ["hinge"],
    regions: ["hamstrings", "glutes"],
    roles: ["accessory"],
    equipment: { all: ["towel"] },
    position: "supine",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [5, 8], sets: [2, 3], restSec: 60, secsPerRep: 6 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 3,
    contraction: ["eccentric", "isotonic"],
    muscles: { primary: ["hamstrings"], secondary: ["glute-max", "gastrocnemius"] },
    purposes: ["strength"],
    tags: ["eccentric-emphasis"],
    themes: ["posteriorChain"],
    easier: ["hamstringBridgeChair"],
    harder: ["nordicCurlAssisted"],
    text: {
      summary: "Heels on a towel, hips up in a bridge, slide the feet away slowly; hips down to reset.",
      setup: [
        "Lie on your back on a smooth floor with the knees bent and both heels on a folded towel.",
        "Arms rest by your sides, palms down."
      ],
      steps: [
        "Press through the heels and lift the hips into a bridge.",
        "Keeping the hips up, slide the heels away slowly, counting four, until the legs are nearly straight or the hips start to drop.",
        "Lower the hips to the floor, pull the heels back in and lift again for the next rep."
      ],
      focus: ["Hips stay high for as long as the slide lasts.", "Slow and even all the way out."],
      mistakes: ["Letting the hips sag early to make it easier.", "Arching the low back instead of squeezing the glutes.", "Rushing the last part of the slide."],
      breathing: "Breathe out slowly as the heels slide away; breathe in as you reset.",
      conditions: { tmj: "On your back with the head down: let it rest rather than press into the floor, and keep the jaw loose as the legs work." },
      why: "Slow lowering strengthens the hamstrings the way fast running and downhills load them, a step toward Nordic curls."
    }
  },
  {
    id: "eccentricPullUp",
    name: "Slow-lowering pull-up",
    family: "pullUp",
    patterns: ["pull-v"],
    regions: ["lats", "upper-back", "arms"],
    roles: ["accessory"],
    equipment: { all: ["pull-up-bar"] },
    position: "hanging",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [3, 5], sets: [2, 3], restSec: 90, secsPerRep: 6 },
    conditions: { tmj: { clench: 2, neckLoad: 1, faceDown: false } },
    difficulty: 3,
    contraction: ["eccentric", "isometric"],
    muscles: { primary: ["lats", "biceps"], secondary: ["rhomboids", "middle-traps", "lower-traps", "forearms"] },
    purposes: ["strength"],
    tags: ["eccentric-emphasis", "grip"],
    themes: ["upperBackNeck"],
    text: {
      summary: "Step up to the top of a pull-up, then lower yourself slowly until the arms are straight.",
      setup: [
        "Put a sturdy step or bench under the bar, high enough that you can stand with your chin over the bar.",
        "Grip the bar a little wider than the shoulders, palms facing away."
      ],
      steps: [
        "Step up so your chin is over the bar, elbows bent and shoulders drawn down.",
        "Hold for a moment, then lower yourself slowly, counting four or five, until the arms are straight.",
        "Put your feet back on the step and climb to the top again for the next rep."
      ],
      focus: ["Shoulders stay drawn down away from the ears all the way.", "An even speed: no dropping through the last part."],
      mistakes: ["Dropping fast once the arms pass halfway.", "Kicking or swinging the legs.", "Jumping up so hard the shoulders jerk."],
      breathing: "Breathe out slowly as you lower; breathe in as you climb back up.",
      conditions: {
        tmj: "Hanging and pulling make many people grit their teeth and push the chin forward: keep the teeth apart and the neck long, and end the set if the jaw tightens."
      },
      why: "Builds the strength to pull your own weight up, starting with the part of the move you're strongest in."
    }
  },

  // ── The gym: barbell, machine and pull-up bar ───────────────────────────────────────────────────────────────────
  {
    id: "barbellBackSquat",
    name: "Barbell back squat",
    family: "squat",
    patterns: ["squat"],
    regions: ["quads", "glutes", "hips"],
    roles: ["core", "accessory"],
    equipment: { all: ["barbell"] },
    position: "standing",
    laterality: "bilateral",
    load: "external",
    dose: { type: "reps", range: [5, 8], sets: [3, 4], restSec: 120, startKg: 20 },
    // Heavy squats invite a hard brace that travels to the jaw, and the bar sits close to the neck.
    conditions: { tmj: { clench: 2, neckLoad: 1, faceDown: false } },
    difficulty: 4,
    contraction: ["isotonic"],
    muscles: { primary: ["quads", "glute-max"], secondary: ["adductors", "erector-spinae", "hamstrings"] },
    purposes: ["strength"],
    tags: [],
    themes: ["fullBody", "hipsPosture"],
    providers: { coros: { key: "T1061", confidence: "exact", method: "curated" } }, // COROS: Squats
    easier: ["gobletSquat"],
    text: {
      summary: "With the bar across your upper back, sit down between your heels and stand back up.",
      setup: [
        "Set the bar in a rack at about chest height, with the safety bars just below the bottom of your squat.",
        "Step under it so it rests across the meaty part of the upper back, not the neck, hands a little wider than the shoulders; stand to lift it out and step back, feet a little wider than the hips."
      ],
      steps: [
        "Breathe in, brace the trunk, and sit down between your heels as deep as you can keep the back long.",
        "Pause briefly at the bottom without bouncing.",
        "Breathe out and stand by pushing the floor away, hips and chest rising together.",
        "After the last rep, walk the bar forward into the rack."
      ],
      focus: [
        "Knees track over the toes.",
        "Weight spread across the whole foot.",
        "Start with the empty bar, and add weight only while every rep looks the same."
      ],
      mistakes: ["Resting the bar on the bony top of the spine.", "Letting the hips shoot up first so the chest drops.", "Holding the breath through the whole set."],
      breathing: "In at the top, out as you stand; never hold the breath for the whole set.",
      conditions: {
        tmj: "Heavy squats invite a hard brace through the face: brace the trunk, not the teeth, with the tongue resting on the palate and the lips soft, and keep the load one you can breathe out under. The bar sits close to the neck, so keep the head in line, not pushed forward."
      },
      why: "The classic leg-strength lift: thighs, hips and trunk working together under a load you can grow for years."
    }
  },
  {
    id: "barbellRdl",
    name: "Barbell Romanian deadlift",
    family: "deadlift",
    patterns: ["hinge"],
    regions: ["hamstrings", "glutes"],
    roles: ["core", "accessory"],
    equipment: { all: ["barbell"] },
    position: "standing",
    laterality: "bilateral",
    load: "external",
    dose: { type: "reps", range: [6, 10], sets: [3, 4], restSec: 120, startKg: 20 },
    // A heavy bar in the hands loads the upper traps and invites clenching.
    conditions: { tmj: { clench: 2, neckLoad: 1, faceDown: false } },
    difficulty: 4,
    contraction: ["isotonic"],
    muscles: { primary: ["hamstrings", "glute-max"], secondary: ["erector-spinae", "forearms", "upper-traps"] },
    purposes: ["strength"],
    tags: [],
    themes: ["posteriorChain", "fullBody"],
    providers: { coros: { key: "T1287", confidence: "exact", method: "curated" } }, // COROS: Romanian Deadlift
    easier: ["rdl"],
    text: {
      summary: "Holding a bar at your hips, push the hips back and slide it down the legs, then stand.",
      setup: [
        "Take the bar from a rack at hip height, or lift it from the floor, hands just outside the thighs.",
        "Stand tall with the feet hip-width apart and the knees soft."
      ],
      steps: [
        "Push the hips back and let the bar slide down the front of the thighs, keeping it close.",
        "Go until the backs of the thighs are strongly stretched or the back would start to round, usually just past the knees.",
        "Drive the hips forward to stand tall, squeezing the glutes at the top."
      ],
      focus: [
        "The bar stays close to the legs the whole way.",
        "Back long and the neck in line: the hips move, not the spine.",
        "Start with the empty bar and add weight only while the back stays long."
      ],
      mistakes: ["Rounding the back to reach lower.", "Bending the knees into a squat.", "Leaning back at the top."],
      breathing: "In as you hinge down, out as you stand.",
      conditions: {
        tmj: "A heavy bar in the hands loads the upper traps and invites clenching: let the shoulders hang down away from the ears, keep the teeth apart, and choose a weight you can breathe through."
      },
      why: "Builds strong hamstrings and glutes for running and lifting, and teaches the hips to carry load instead of the low back."
    }
  },
  {
    id: "latPulldown",
    name: "Lat pulldown",
    family: "pullDown",
    patterns: ["pull-v"],
    regions: ["lats", "upper-back", "arms"],
    roles: ["accessory"],
    equipment: { oneOf: ["machine", "cable"] },
    position: "seated",
    laterality: "bilateral",
    load: "external",
    dose: { type: "reps", range: [8, 12], sets: [2, 4], restSec: 75, startKg: 20 },
    conditions: { tmj: { clench: 1, neckLoad: 1, faceDown: false } },
    difficulty: 2,
    contraction: ["isotonic"],
    muscles: { primary: ["lats"], secondary: ["biceps", "rhomboids", "middle-traps", "lower-traps", "forearms"] },
    purposes: ["strength"],
    tags: ["posture"],
    themes: ["upperBackNeck", "fullBody"],
    providers: { coros: { key: "T1342", confidence: "exact", method: "curated" } }, // COROS: Lat Pulldowns
    harder: ["bandAssistedPullUp"],
    text: {
      summary: "Seated at the machine, pull the bar down to your upper chest, then let it rise slowly.",
      setup: [
        "Set the thigh pad so your legs are held snugly with the feet flat.",
        "Stand to take the bar with the hands a little wider than the shoulders, palms facing away, then sit down with the arms straight overhead."
      ],
      steps: [
        "Draw the shoulders down, then pull the bar to the top of the chest, elbows driving down toward the ribs.",
        "Pause briefly with the chest lifted.",
        "Let the bar rise slowly until the arms are straight again."
      ],
      focus: ["Shoulders down and away from the ears before the arms bend.", "Lean back only a little; the trunk stays still."],
      mistakes: ["Pulling the bar behind the neck.", "Swinging the body back to move the weight.", "Letting the bar yank the arms up at the top."],
      breathing: "Out as you pull down, in as the bar rises.",
      conditions: {
        tmj: "Shoulders creeping up toward the ears load the neck and jaw: set them down first, keep the chin level rather than poking it toward the bar, and the teeth apart."
      },
      why: "Strengthens the big back muscles that pull you upright, with a load you can set to suit you."
    }
  },
  {
    id: "bandAssistedPullUp",
    name: "Band-assisted pull-up",
    family: "pullUp",
    patterns: ["pull-v"],
    regions: ["lats", "upper-back", "arms"],
    roles: ["accessory"],
    equipment: { all: ["pull-up-bar", "band"] },
    position: "hanging",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [4, 8], sets: [2, 4], restSec: 90, secsPerRep: 3 },
    // Pulling the body's own weight up invites gritting and a pushed-forward chin, even with the band's help.
    conditions: { tmj: { clench: 2, neckLoad: 1, faceDown: false } },
    difficulty: 3,
    contraction: ["isotonic"],
    muscles: { primary: ["lats", "biceps"], secondary: ["rhomboids", "middle-traps", "lower-traps", "forearms"] },
    purposes: ["strength"],
    tags: ["grip"],
    themes: ["upperBackNeck"],
    // COROS's Pull-ups is the unassisted lift: the band changes the load, so the watch gets this move as free text.
    providers: { coros: { key: "T1002", confidence: "close", method: "curated" } },
    easier: ["latPulldown"],
    text: {
      summary: "A loop band under one foot or knee takes some of your weight as you pull up to the bar.",
      setup: [
        "Loop a long resistance band over the bar and pull one end through the other so it hangs from the bar.",
        "Put a foot or a knee into the bottom of the loop and take the bar with the hands a little wider than the shoulders, palms facing away."
      ],
      steps: [
        "Hang with the arms straight and draw the shoulders down.",
        "Pull until your chin is over the bar, elbows driving down.",
        "Lower slowly until the arms are straight again."
      ],
      focus: ["A thicker band helps more; use less help as you get stronger.", "Shoulders down before the arms bend."],
      mistakes: ["Kicking or swinging to get up.", "Dropping fast on the way down.", "Craning the chin up to reach the bar."],
      breathing: "Out as you pull up, in as you lower.",
      conditions: {
        tmj: "Pulling your own weight makes many people grit their teeth and push the chin forward: keep the teeth apart and the neck long, and use a stronger band if the jaw tightens."
      },
      why: "Builds toward the pull-up step by step: the band gives just enough help for full, clean reps."
    }
  },
  {
    id: "legPress",
    name: "Leg press",
    family: "legPress",
    patterns: ["squat"],
    regions: ["quads", "glutes"],
    roles: ["core", "accessory"],
    equipment: { all: ["machine"] },
    position: "seated",
    laterality: "bilateral",
    load: "external",
    dose: { type: "reps", range: [8, 12], sets: [2, 4], restSec: 90, startKg: 40 },
    // Heavy pressing invites clenching and pushing the head into the pad.
    conditions: { tmj: { clench: 2, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    contraction: ["isotonic"],
    muscles: { primary: ["quads", "glute-max"], secondary: ["adductors", "hamstrings"] },
    purposes: ["strength"],
    tags: [],
    themes: ["fullBody", "skiPrep"],
    providers: { coros: { key: "T1065", confidence: "exact", method: "curated" } }, // COROS: Incline Leg Press
    text: {
      summary: "Seated in the machine, lower the platform toward you with control, then press it away.",
      setup: [
        "Sit with your back and hips flat against the pad and the feet hip-width apart in the middle of the platform.",
        "Release the safety handles with the legs nearly straight, knees soft."
      ],
      steps: [
        "Bend the knees and let the platform come toward you slowly, until just before the hips would lift off the pad.",
        "Press the platform away through the whole foot until the legs are nearly straight.",
        "Keep the knees soft at the top; after the last rep, lock the safety handles before you get out."
      ],
      focus: ["Hips and low back stay on the pad.", "Knees track in line with the toes."],
      mistakes: ["Lowering so far the hips curl off the pad.", "Locking the knees straight at the top.", "Pushing through the toes only."],
      breathing: "In as the platform comes toward you, out as you press.",
      conditions: { tmj: "Heavy presses invite clenching and pushing the head into the pad: let the head rest, keep the teeth apart, and pick a load you can breathe out under." },
      why: "Builds leg strength with the back supported, so the legs can work hard without balancing a bar."
    }
  },
]);
