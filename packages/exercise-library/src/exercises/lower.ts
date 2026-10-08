// Lower-body strength: squats, lunges, hinges, bridges.
import { defineExercises } from "../define.js";

export const LOWER = defineExercises([
  {
    id: "gobletSquat",
    name: "Goblet squat",
    family: "squat",
    patterns: ["squat"],
    regions: ["quads", "glutes", "hips"],
    roles: ["core", "accessory"],
    equipment: { oneOf: ["kettlebell", "dumbbells"] },
    position: "standing",
    laterality: "bilateral",
    load: "external",
    dose: { type: "reps", range: [5, 8], sets: [2, 4], restSec: 75, startKg: 12 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    providers: { coros: { key: "T1301", confidence: "exact", method: "curated" } }, // COROS: Goblet Squat
    easier: ["boxSquat"],
    text: {
      summary: "Hold the weight at your chest and sit down between your heels.",
      setup: [
        "Feet a little wider than hips, toes slightly out.",
        "Hold the bell by the horns (or a dumbbell by one end) against your chest, elbows pointing down."
      ],
      steps: [
        "Breathe in and sit straight down between your heels.",
        "Pause briefly at the bottom with your chest tall.",
        "Breathe out and stand by pushing the floor away."
      ],
      focus: ["Knees track over your toes.", "Ribs stay stacked over the pelvis.", "Weight spread across the whole foot."],
      mistakes: [
        "Letting the weight pull the shoulders forward.",
        "Rising hips-first so the chest drops.",
        "Holding the breath through the whole rep."
      ],
      breathing: "In on the way down, out on the way up; no breath-holding.",
      conditions: { tmj: "Teeth apart and tongue resting on the palate — if you feel the jaw tighten at the bottom, go lighter." },
      why: "Trains upright posture and strong hips without needing heavy load."
    }
  },
  {
    id: "boxSquat",
    name: "Box squat to bench",
    family: "squat",
    patterns: ["squat"],
    regions: ["quads", "glutes"],
    roles: ["core", "accessory"],
    equipment: { oneOf: ["bench", "chair"] },
    position: "standing",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [8, 12], sets: [2, 3], restSec: 45 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    providers: { coros: { key: "T1291", confidence: "close", method: "curated" } }, // COROS: Box Squat: the barbell lift; ours is bodyweight to a bench
    harder: ["tempoSquat"],
    text: {
      summary: "Sit back to lightly touch a bench or chair, then stand up tall.",
      setup: ["Stand in front of a bench or sturdy chair, feet hip-width or a little wider.", "Arms forward for balance."],
      steps: [
        "Sit the hips back and down until you lightly touch the seat.",
        "Don't flop — keep tension and touch softly.",
        "Stand by pushing the floor away.",
        "Repeat."
      ],
      focus: ["Control the way down.", "Knees follow the toes."],
      mistakes: ["Dropping onto the seat.", "Rocking forward to get up."],
      breathing: "Inhale down, exhale up.",
      conditions: { tmj: "No bracing needed — keep the face relaxed." },
      why: "Teaches a controlled squat with a target, the easiest way to build the pattern."
    }
  },
  {
    id: "tempoSquat",
    name: "Tempo bodyweight squat",
    family: "squat",
    patterns: ["squat"],
    regions: ["quads", "glutes", "hips"],
    roles: ["core", "accessory"],
    position: "standing",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [8, 15], sets: [2, 3], restSec: 45 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    easier: ["boxSquat"],
    harder: ["bwSplitSquat"],
    text: {
      summary: "Three seconds down, a brief pause, then stand up smoothly.",
      setup: ["Feet a little wider than hips.", "Arms forward for balance."],
      steps: [
        "Count three seconds on the way down.",
        "Pause briefly at the bottom with the chest tall.",
        "Stand up smoothly.",
        "Repeat at the same tempo."
      ],
      focus: ["Slow is the load.", "Knees over toes, weight across the whole foot."],
      mistakes: ["Speeding up as you tire.", "Collapsing the chest at the bottom."],
      breathing: "Inhale on the way down, exhale on the way up.",
      conditions: { tmj: "Teeth apart — slow reps are where clenching creeps in." },
      why: "Trains upright squatting and hips when there is nothing to hold."
    }
  },
  {
    id: "splitSquat",
    name: "Supported split squat",
    family: "splitSquat",
    patterns: ["lunge"],
    regions: ["quads", "glutes"],
    roles: ["core", "accessory"],
    equipment: { oneOf: ["kettlebell", "dumbbells"] },
    position: "standing",
    laterality: "unilateral",
    load: "external",
    dose: { type: "reps", range: [6, 10], sets: [2, 3], restSec: 60, startKg: 8 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 3,
    easier: ["bwSplitSquat"],
    text: {
      summary: "Staggered stance with a weight at your chest; lower straight down and rise.",
      setup: [
        "Take a long staggered stance, back heel up.",
        "Hold the weight goblet-style; keep a chair, wall, or block beside you for balance."
      ],
      steps: [
        "Lower straight down until the back knee is just above the floor.",
        "Keep the front heel planted.",
        "Drive up through the front foot.",
        "Finish the reps, then switch sides."
      ],
      focus: ["Straight down, not forward.", "Balance support is allowed."],
      mistakes: ["Letting the front knee cave in.", "Taking too short a stance."],
      breathing: "Inhale down, exhale up.",
      conditions: { tmj: "Balance support is there so you don't have to brace the jaw to stay steady." },
      why: "Builds hips and legs while reducing bracing and neck tension."
    }
  },
  {
    id: "bwSplitSquat",
    name: "Split squat",
    family: "splitSquat",
    patterns: ["lunge"],
    regions: ["quads", "glutes"],
    roles: ["core", "accessory"],
    position: "standing",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [8, 12], sets: [2, 3], restSec: 45 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    harder: ["splitSquat"],
    text: {
      summary: "Staggered stance, lower straight down slowly, then rise — support nearby for balance.",
      setup: ["Take a long staggered stance, back heel up.", "Keep a chair or wall beside you."],
      steps: [
        "Lower straight down until the back knee nearly touches the floor.",
        "Pause briefly.",
        "Drive up through the front foot.",
        "Finish the reps, then switch sides."
      ],
      focus: ["Straight down.", "Front heel stays planted."],
      mistakes: ["Bouncing out of the bottom.", "Leaning forward over the front knee."],
      breathing: "Inhale down, exhale up.",
      conditions: { tmj: "Use the support rather than bracing through the face." },
      why: "Builds single-leg strength with no equipment."
    }
  },
  {
    id: "stepUp",
    name: "Bench step-up",
    family: "stepUp",
    patterns: ["lunge"],
    regions: ["quads", "glutes"],
    roles: ["core", "accessory"],
    equipment: { oneOf: ["bench", "chair"] },
    position: "standing",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [6, 10], sets: [2, 3], restSec: 45 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    providers: { coros: { key: "T1296", confidence: "exact", method: "curated" } }, // COROS: Step-Ups
    text: {
      summary: "Step up onto a bench or sturdy chair, driving through the top foot.",
      setup: ["Stand facing a bench or a chair braced against a wall.", "Place one whole foot on it."],
      steps: [
        "Lean slightly forward and drive through the top foot to stand up.",
        "Bring the back foot up only lightly, or not at all.",
        "Lower slowly with control.",
        "Finish the reps, then switch."
      ],
      focus: ["The top leg does the work — don't push off the bottom foot.", "Slow on the way down."],
      mistakes: ["Launching off the back foot.", "Letting the knee cave in."],
      breathing: "Exhale as you step up.",
      conditions: { tmj: "Keep the teeth apart at the top, where people tend to clench." },
      why: "Strong, joint-friendly single-leg work using furniture you already have."
    }
  },
  {
    id: "deadlift",
    name: "Deadlift",
    family: "deadlift",
    patterns: ["hinge"],
    regions: ["hamstrings", "glutes", "low-back"],
    roles: ["core"],
    equipment: { oneOf: ["kettlebell", "dumbbells"] },
    position: "standing",
    laterality: "bilateral",
    load: "external",
    dose: { type: "reps", range: [6, 10], sets: [2, 4], restSec: 75, startKg: 16 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    providers: { coros: { key: "T1067", confidence: "close", method: "curated" } }, // COROS: Deadlifts: the barbell lift; ours is a kettlebell or dumbbells
    harder: ["rdl"],
    text: {
      summary: "Hinge to the weight between your feet, stand tall, and set it down quietly.",
      setup: ["Stand with the weight between your feet, mid-foot.", "Feet hip-width."],
      steps: [
        "Push the hips back and bend the knees to grip the weight with a long spine.",
        "Pull the shoulders down and take the slack out.",
        "Stand up by driving the floor away.",
        "Hinge back down and set the weight down quietly."
      ],
      focus: ["Hips back, spine long.", "Shoulders away from the ears."],
      mistakes: ["Rounding the back to reach the weight.", "Jerking it off the floor.", "Shrugging at the top."],
      breathing: "Exhale as you stand; don't hold a big breath to brace.",
      conditions: {
        tmj: "Bracing for lifts often means clenching — keep the tongue up and breathe out through the lift instead."
      },
      why: "Rebuilds posterior-chain strength after sitting with low neck demand."
    }
  },
  {
    id: "rdl",
    name: "Romanian deadlift",
    family: "deadlift",
    patterns: ["hinge"],
    regions: ["hamstrings", "glutes"],
    roles: ["core", "accessory"],
    equipment: { oneOf: ["kettlebell", "dumbbells"] },
    position: "standing",
    laterality: "bilateral",
    load: "external",
    dose: { type: "reps", range: [6, 10], sets: [2, 3], restSec: 75, startKg: 12 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 3,
    providers: { coros: { key: "T1305", confidence: "exact", method: "curated" } }, // COROS: Dumbbell Romanian Deadlift (T1287 is the barbell one)
    easier: ["deadlift"],
    text: {
      summary: "Hold the weight, soften the knees, and hinge to mid-shin before standing tall.",
      setup: ["Stand holding the weight in front of your thighs.", "Soften the knees slightly."],
      steps: [
        "Push the hips back, sliding the weight down the thighs.",
        "Stop at mid-shin or when the back would start to round.",
        "Drive the hips forward to stand.",
        "Repeat slowly."
      ],
      focus: ["Hips move back; knees stay soft but mostly still.", "Ribs stacked, spine long."],
      mistakes: ["Turning it into a squat.", "Reaching the floor at the cost of a rounded back."],
      breathing: "Inhale on the way down, exhale up.",
      conditions: { tmj: "Gaze a couple of metres ahead, jaw loose." },
      why: "Builds hamstrings and glutes for better sitting tolerance."
    }
  },
  {
    id: "slRdlReach",
    name: "Single-leg RDL reach",
    family: "singleLegHinge",
    patterns: ["hinge"],
    regions: ["hamstrings", "glutes", "ankles"],
    roles: ["core", "accessory"],
    position: "standing",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [6, 10], sets: [2, 3], restSec: 45 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    providers: { coros: { key: "T1187", confidence: "close", method: "curated" } }, // COROS: Single Leg Deadlift: ours is an unloaded reach
    text: {
      summary: "Hinge on one leg as the other reaches back, then stand tall.",
      setup: ["Stand on one leg with a soft knee.", "Fingertips on a wall or chair if you need balance."],
      steps: [
        "Hinge forward as the free leg reaches straight back.",
        "Keep the hips square to the floor.",
        "Stop when you feel the standing hamstring load.",
        "Stand tall; finish the reps, then switch."
      ],
      focus: ["Hips square.", "Neck follows the spine."],
      mistakes: ["Opening the hip toward the ceiling.", "Rushing."],
      breathing: "Inhale as you hinge, exhale as you stand.",
      conditions: { tmj: "Use the support instead of gritting your teeth for balance." },
      why: "Loads the hamstrings and glutes one side at a time without equipment."
    }
  },
  {
    id: "singleLegBridge",
    name: "Single-leg glute bridge",
    family: "bridge",
    patterns: ["hinge"],
    regions: ["glutes", "hamstrings"],
    roles: ["core", "accessory"],
    position: "supine",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [6, 12], sets: [2, 3], restSec: 45 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    providers: { coros: { key: "T1219", confidence: "exact", method: "curated" } }, // COROS: Single-Leg Hip Bridge
    easier: ["bridge"],
    text: {
      summary: "One foot planted, the other knee pulled in; drive the hips up through the heel.",
      setup: ["Lie on your back with one foot planted.", "Hug the other knee toward your chest."],
      steps: [
        "Press through the planted heel and lift the hips.",
        "Keep the hips level at the top.",
        "Pause, then lower slowly.",
        "Finish the reps, then switch."
      ],
      focus: ["Hips level.", "Glute, not low back."],
      mistakes: ["Letting one hip drop.", "Arching the low back."],
      breathing: "Exhale up, inhale down.",
      conditions: { tmj: "Head heavy on the floor, jaw loose." },
      why: "Posterior-chain strength with the floor supporting the head and neck."
    }
  },
]);
