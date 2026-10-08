// Trunk control, glute activation, and loaded carries.
import { defineExercises } from "../define.js";

export const CORE_CARRY = defineExercises([
  {
    id: "bridgeBlock",
    name: "Bridge · block between knees",
    family: "bridge",
    patterns: ["hinge"],
    regions: ["glutes", "hamstrings"],
    roles: ["activation", "accessory"],
    equipment: { all: ["yoga-block"] },
    position: "supine",
    laterality: "bilateral",
    load: "none",
    dose: { type: "reps", range: [10, 15], secsPerRep: 4 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    providers: { coros: { key: "T1132", confidence: "close", method: "curated" } }, // COROS: Lie on Your Back Glute Bridge; ours squeezes a block
    harder: ["singleLegBridge"],
    text: {
      summary: "Squeeze a block between the knees, lift the hips, pause, and lower slowly.",
      setup: ["Lie on your back, knees bent, feet hip-width and flat.", "Place the block between the knees."],
      steps: [
        "Lightly squeeze the block.",
        "Press through the heels and lift the hips until knees, hips, and shoulders line up.",
        "Pause for a breath at the top.",
        "Lower slowly, one segment at a time."
      ],
      focus: ["Glutes do the lifting.", "Ribs stay down at the top."],
      mistakes: ["Arching the low back to get higher.", "Pushing the head into the floor."],
      breathing: "Exhale as you lift, inhale as you lower.",
      conditions: { tmj: "Glutes work; the jaw doesn't. Keep the back of the head resting lightly." },
      why: "Restores glute support after sitting and gives the pelvis a stable reset."
    }
  },
  {
    id: "bridge",
    name: "Glute bridge",
    family: "bridge",
    patterns: ["hinge"],
    regions: ["glutes", "hamstrings"],
    roles: ["activation", "accessory"],
    position: "supine",
    laterality: "bilateral",
    load: "none",
    dose: { type: "reps", range: [10, 15], secsPerRep: 4 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    providers: { coros: { key: "T1132", confidence: "exact", method: "curated" } }, // COROS: Lie on Your Back Glute Bridge (the name computes to Hip Thrust through an alias)
    harder: ["singleLegBridge"],
    text: {
      summary: "Lift the hips from the floor with the glutes, pause, and lower slowly.",
      setup: ["Lie on your back, knees bent, feet hip-width and flat.", "Optionally hold a folded towel between the knees."],
      steps: [
        "Press through the heels and lift the hips.",
        "Stop when knees, hips, and shoulders line up.",
        "Pause at the top.",
        "Lower slowly."
      ],
      focus: ["Knees stay in line with the feet.", "Ribs stay down."],
      mistakes: ["Arching the low back.", "Pushing through the toes."],
      breathing: "Exhale up, inhale down.",
      conditions: { tmj: "Glutes work; the jaw doesn't." },
      why: "Restores glute support after sitting and gives the pelvis a stable reset."
    }
  },
  {
    id: "plankBlock",
    name: "Incline plank on block",
    family: "plank",
    patterns: ["anti-extend"],
    regions: ["core"],
    roles: ["accessory", "activation"],
    equipment: { all: ["yoga-block"] },
    position: "quadruped",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "time", range: [20, 45] },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Hands on a yoga block, body in one long line, breathing slowly.",
      setup: ["Place the block on its tallest setting.", "Hands on the block under the shoulders, feet back."],
      steps: [
        "Walk the feet back until the body forms a straight line.",
        "Press the block away and tuck the ribs slightly.",
        "Hold, breathing slowly.",
        "Stop before you start bracing hard or clenching."
      ],
      focus: ["Quiet face, strong ribs.", "A straight line from head to heels."],
      mistakes: ["Letting the hips sag.", "Holding the breath."],
      breathing: "Slow nasal breathing — if you can't breathe easily, it's too hard.",
      conditions: { tmj: "Planks invite clenching; keep the tongue up and teeth apart, and end the hold if the jaw tightens." },
      why: "Builds trunk endurance without max-effort bracing."
    }
  },
  {
    id: "inclinePlank",
    name: "Incline plank",
    family: "plank",
    patterns: ["anti-extend"],
    regions: ["core"],
    roles: ["accessory", "activation"],
    equipment: { oneOf: ["bench", "chair"] },
    position: "quadruped",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "time", range: [20, 45] },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Hands on a bench or sturdy chair, body in one long line, breathing slowly.",
      setup: ["Brace the chair against a wall so it can't slide.", "Hands on the edge under the shoulders."],
      steps: [
        "Walk the feet back until the body is straight.",
        "Press the bench away and tuck the ribs slightly.",
        "Hold, breathing slowly.",
        "Stop before you start clenching."
      ],
      focus: ["Quiet face, strong ribs.", "Straight line from head to heels."],
      mistakes: ["Sagging hips.", "Holding the breath."],
      breathing: "Slow nasal breathing throughout.",
      conditions: { tmj: "Tongue up, teeth apart; end the hold if the jaw tightens." },
      why: "Builds trunk endurance without max-effort bracing."
    }
  },
  {
    id: "sidePlankKnees",
    name: "Side plank from knees",
    family: "sidePlank",
    patterns: ["anti-lateral"],
    regions: ["core"],
    roles: ["core", "accessory"],
    position: "side-lying",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "time", range: [20, 40], sets: [2, 3], restSec: 30 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    providers: { coros: { key: "T1185", confidence: "close", method: "curated" } }, // COROS: Side Plank: ours is the short lever
    text: {
      summary: "On your side with knees bent, lift the hips into a straight line and hold.",
      setup: ["Lie on your side, elbow under the shoulder, knees bent behind you.", "Stack the hips and shoulders."],
      steps: [
        "Press the forearm and knee into the floor.",
        "Lift the hips until the body is straight from head to knees.",
        "Hold, breathing slowly.",
        "Lower with control and switch sides."
      ],
      focus: ["Tall through the waist.", "Shoulder stays away from the ear."],
      mistakes: ["Letting the hips drop back.", "Shrugging into the supporting shoulder."],
      breathing: "Slow breaths; don't hold them.",
      conditions: { tmj: "Keep the head in line and the jaw quiet — no grimacing." },
      why: "Trains the same side-body strength as a carry without any load."
    }
  },
  {
    id: "deadBug",
    name: "Dead bug",
    family: "deadBug",
    patterns: ["anti-extend"],
    regions: ["core"],
    roles: ["accessory", "activation"],
    position: "supine",
    laterality: "alternating",
    load: "bodyweight",
    dose: { type: "reps", range: [6, 10], sets: [2, 3], restSec: 30, secsPerRep: 4 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    providers: { coros: { key: "T1243", confidence: "exact", method: "curated" } }, // COROS: Dead Bug
    text: {
      summary: "On your back, slowly lower opposite arm and leg while the low back stays heavy.",
      setup: ["Lie on your back, arms reaching to the ceiling.", "Knees bent 90° above the hips."],
      steps: [
        "Exhale and slowly lower one arm overhead and the opposite leg toward the floor.",
        "Stop before the low back lifts.",
        "Return to the start.",
        "Switch sides; count reps per side."
      ],
      focus: ["Low back stays in contact with the floor.", "Slow and controlled."],
      mistakes: ["Arching the back as the leg lowers.", "Rushing."],
      breathing: "Breathe out as you reach.",
      conditions: { tmj: "The head rests on the floor; no need to brace the face." },
      why: "Trains trunk control without bracing hard through the jaw."
    }
  },
  {
    id: "birdDog",
    name: "Bird dog",
    family: "birdDog",
    patterns: ["anti-rotate", "anti-extend"],
    regions: ["core", "low-back"],
    roles: ["activation", "accessory"],
    position: "quadruped",
    laterality: "alternating",
    load: "bodyweight",
    dose: { type: "reps", range: [6, 10], sets: [2, 3], restSec: 30, secsPerRep: 5 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    providers: { coros: { key: "T1150", confidence: "exact", method: "curated" } }, // COROS: Bird Dog
    text: {
      summary: "On hands and knees, reach one arm and the opposite leg long without twisting.",
      setup: ["Hands under shoulders, knees under hips.", "Imagine a cup of water balanced on your low back."],
      steps: [
        "Slowly reach one arm forward and the opposite leg back.",
        "Pause with the body long and level.",
        "Return without letting the hips rock.",
        "Switch sides; count reps per side."
      ],
      focus: ["Hips stay level.", "Reach long rather than high."],
      mistakes: ["Lifting the leg too high and arching.", "Rotating the hips open."],
      breathing: "Exhale as you reach.",
      conditions: { tmj: "Look at the floor just ahead of your hands so the neck stays neutral." },
      why: "Builds trunk stability and back endurance with almost no bracing."
    }
  },
  {
    id: "suitcaseCarry",
    name: "Suitcase carry",
    family: "suitcaseCarry",
    patterns: ["carry", "anti-lateral"],
    regions: ["core", "shoulders"],
    roles: ["core", "accessory"],
    equipment: { oneOf: ["kettlebell", "dumbbells"] },
    position: "standing",
    laterality: "unilateral",
    load: "external",
    dose: { type: "carry", range: [30, 60], sets: [2, 3], restSec: 60, startKg: 12 },
    conditions: { tmj: { clench: 1, neckLoad: 1, faceDown: false } },
    difficulty: 2,
    providers: { coros: { key: "T1310", confidence: "close", method: "curated" } }, // COROS: Farmer's Walk: ours is one-sided
    text: {
      summary: "Walk slowly with a weight in one hand, standing tall without leaning.",
      setup: ["Stand next to the weight and pick it up with a hinge, not a rounded back.", "Hold it at your side, arm long."],
      steps: [
        "Stand tall with the ribs stacked over the pelvis.",
        "Walk slowly, or march in place if space is tight.",
        "Keep the loaded shoulder heavy, away from the ear.",
        "Switch hands when the timer moves to the other side."
      ],
      focus: ["Shoulder heavy, ribs stacked, quiet jaw.", "No leaning toward or away from the weight."],
      mistakes: ["Shrugging the loaded shoulder.", "Leaning away from the weight.", "Gripping so hard the jaw clenches."],
      breathing: "Keep breathing through the nose; don't hold your breath to brace.",
      conditions: { tmj: "Grip effort travels to the jaw — grip only as hard as you need and keep the teeth apart." },
      why: "Builds core and shoulder depression, useful for desk-tight traps."
    }
  },
  {
    id: "suitcaseMarch",
    name: "Suitcase march",
    family: "suitcaseCarry",
    patterns: ["carry", "anti-lateral"],
    regions: ["core", "hips"],
    roles: ["accessory", "core"],
    equipment: { oneOf: ["kettlebell", "dumbbells"] },
    position: "standing",
    laterality: "unilateral",
    load: "external",
    dose: { type: "carry", range: [30, 45], sets: [2, 3], restSec: 60, startKg: 8 },
    conditions: { tmj: { clench: 1, neckLoad: 1, faceDown: false } },
    difficulty: 2,
    text: {
      summary: "March in place with a weight in one hand, moving slowly enough to stay level.",
      setup: ["Hold a weight at your side, arm long.", "Stand tall near a wall if you want a balance reference."],
      steps: [
        "Lift one knee to hip height, slowly.",
        "Lower it and lift the other.",
        "Stay level — no leaning toward the weight.",
        "Switch hands when the timer moves to the other side."
      ],
      focus: ["No leaning, no clenching.", "Slow knee lifts."],
      mistakes: ["Rushing so the body sways.", "Shrugging the loaded shoulder."],
      breathing: "Steady nasal breathing.",
      conditions: { tmj: "Teeth apart, especially on the knee lifts." },
      why: "Adds balance and trunk control without needing more weight."
    }
  },
  {
    id: "farmerCarry",
    name: "Farmer carry",
    family: "farmerCarry",
    patterns: ["carry"],
    regions: ["core", "shoulders", "arms"],
    roles: ["core", "accessory"],
    equipment: { all: ["dumbbells"] },
    position: "standing",
    laterality: "bilateral",
    load: "external",
    dose: { type: "carry", range: [30, 60], sets: [2, 3], restSec: 60, startKg: 16 },
    conditions: { tmj: { clench: 2, neckLoad: 1, faceDown: false } },
    difficulty: 2,
    providers: { coros: { key: "T1310", confidence: "exact", method: "curated" } }, // COROS: Farmer's Walk
    text: {
      summary: "Walk tall holding a dumbbell in each hand, shoulders down and back.",
      setup: ["Pick up a dumbbell in each hand with a hinge.", "Stand tall with the arms long."],
      steps: [
        "Walk slowly with short, even steps.",
        "Keep the shoulders away from the ears.",
        "Stay tall; don't let the weights pull you forward.",
        "Set the weights down with a hinge."
      ],
      focus: ["Tall posture, shoulders down.", "Grip firm but not crushing."],
      mistakes: ["Shrugging.", "Holding the breath.", "Squeezing the grip so hard the jaw joins in."],
      breathing: "Steady breathing; no breath-holding.",
      conditions: { tmj: "Two-handed grip is a strong clench trigger — pick a weight you can carry with the teeth apart." },
      why: "Builds grip, posture, and trunk strength in one simple move."
    }
  },
]);
