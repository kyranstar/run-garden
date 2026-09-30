// Breathing, downshifting, and rest: how every session starts and ends.
import { defineExercises } from "../define.js";

export const BREATH_DOWNSHIFT = defineExercises([
  {
    id: "breath",
    name: "Jaw reset breathing",
    family: "breathing",
    patterns: ["breathe"],
    regions: ["jaw", "neck"],
    roles: ["downshift", "cooldown"],
    position: "seated",
    laterality: "bilateral",
    load: "none",
    dose: { type: "time", range: [60, 120] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Settle the jaw into its rest position and slow the exhale.",
      setup: [
        "Sit tall with your back supported and feet flat.",
        "Let your hands rest on your thighs and drop your shoulders."
      ],
      steps: [
        "Rest the tongue lightly on the roof of your mouth, just behind the front teeth.",
        "Close your lips and let the teeth part slightly.",
        "Inhale through the nose for about four counts.",
        "Exhale slowly through the nose for six to eight counts.",
        "Repeat, softening forehead, temples, throat, and shoulders on each exhale."
      ],
      focus: [
        "Exhale longer than the inhale.",
        "Tongue up, lips together, teeth apart.",
        "Let the belly and lower ribs move, not the shoulders."
      ],
      mistakes: [
        "Pressing the tongue hard into the palate.",
        "Forcing big breaths.",
        "Letting the teeth touch between breaths."
      ],
      breathing: "Nose in for about 4, nose out for 6–8.",
      conditions: { tmj: "This sets the resting position you want all day: tongue up, teeth apart, lips closed." },
      why: "Downshifts clenching and sets the resting jaw position before anything else."
    }
  },
  {
    id: "physiologicalSigh",
    name: "Physiological sigh",
    family: "breathing",
    patterns: ["breathe"],
    regions: ["jaw", "neck"],
    roles: ["downshift"],
    position: "seated",
    laterality: "bilateral",
    load: "none",
    dose: { type: "breaths", range: [5, 8] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Two quick inhales through the nose, then one long, slow exhale.",
      setup: ["Sit or stand comfortably with your shoulders relaxed.", "Tongue resting on the palate, lips closed."],
      steps: [
        "Inhale through the nose until the lungs feel mostly full.",
        "Take a second, shorter sip of air through the nose on top of it.",
        "Exhale slowly and completely through the mouth or nose.",
        "Take one or two normal breaths, then repeat."
      ],
      focus: ["The exhale is the important part: long and unhurried.", "Shoulders stay down on both inhales."],
      mistakes: ["Rushing the exhale.", "Hyperventilating by repeating without normal breaths in between."],
      breathing: "Double inhale through the nose, long exhale.",
      conditions: {
        tmj: "Keep the jaw loose on the exhale; if you breathe out through the mouth, let it hang open rather than pursing the lips hard."
      },
      why: "One of the fastest ways to bring arousal down, which takes pressure off a clenching jaw."
    }
  },
  {
    id: "supine9090Breathing",
    name: "90-90 breathing, feet up",
    family: "breathing",
    patterns: ["breathe"],
    regions: ["core", "low-back", "jaw"],
    roles: ["downshift", "activation"],
    equipment: { oneOf: ["chair", "bench", "wall"] },
    position: "supine",
    laterality: "bilateral",
    load: "none",
    dose: { type: "time", range: [60, 120] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Lie with hips and knees at 90° on a chair or wall and breathe into your back ribs.",
      setup: [
        "Lie on your back with your calves on a chair or bench, or feet flat on a wall, hips and knees bent to about 90°.",
        "Arms relaxed by your sides, head resting on the floor or a folded towel."
      ],
      steps: [
        "Gently flatten your low back toward the floor without squeezing the glutes.",
        "Inhale through the nose and feel the back and sides of the ribs widen.",
        "Exhale slowly, letting the ribs drop down toward the hips.",
        "Pause briefly at the end of each exhale before breathing in again."
      ],
      focus: [
        "Ribs down and heavy on every exhale.",
        "Low back stays in easy contact with the floor.",
        "Neck and face stay soft."
      ],
      mistakes: ["Arching the low back on the inhale.", "Pushing the belly out hard.", "Holding tension in the neck to 'help'."],
      breathing: "Slow nasal breathing with a full, unhurried exhale.",
      conditions: { tmj: "Tongue up, teeth apart; the floor holds your head so the neck and jaw can switch off." },
      why: "Resets rib and pelvis position after sitting and calms the nervous system before or after training."
    }
  },
  {
    id: "legsUp",
    name: "Legs up or constructive rest",
    family: "rest",
    patterns: ["breathe"],
    regions: ["low-back", "hips"],
    roles: ["cooldown", "downshift"],
    position: "supine",
    laterality: "bilateral",
    load: "none",
    dose: { type: "time", range: [60, 120] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Lie back with knees bent or legs up and let the floor hold you.",
      setup: [
        "Lie on your back with knees bent and feet wide, knees resting together — or legs up a wall.",
        "Place a folded towel under your head if your chin pokes up."
      ],
      steps: [
        "Let your arms rest wherever they feel heavy.",
        "Return the tongue to the palate and let the teeth part.",
        "Breathe slowly through the nose, lengthening each exhale.",
        "With each exhale, let one area soften: eyes, temples, jaw, throat, shoulders."
      ],
      focus: ["Nothing is working — let the floor take your weight.", "Long exhales."],
      mistakes: ["Checking your phone or planning the day instead of resting.", "Holding the legs up with effort."],
      breathing: "Easy nasal breathing, exhale a little longer than the inhale.",
      conditions: { tmj: "Finish with the jaw completely loose so it doesn't rebound into tension when you get up." },
      why: "Finishes the session with low arousal so the jaw does not rebound into tension."
    }
  },
  {
    id: "finalJaw",
    name: "Final jaw check",
    family: "breathing",
    patterns: ["breathe"],
    regions: ["jaw"],
    roles: ["cooldown"],
    position: "seated",
    laterality: "bilateral",
    load: "none",
    dose: { type: "time", range: [45, 75] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Scan the face and jaw and lock in the resting position before you get up.",
      setup: ["Sit tall with support, or stay lying down.", "Close your eyes if that helps you notice tension."],
      steps: [
        "Place the tongue on the palate and let the teeth part.",
        "Soften the eyes and forehead.",
        "Let the temples and the muscles in front of the ears relax.",
        "Relax the throat and drop the shoulders.",
        "Take three slow breaths holding that position."
      ],
      focus: ["Teeth apart is the goal — notice if they drift together.", "Remember what this feels like for the next hour."],
      mistakes: ["Opening the mouth wide instead of just parting the teeth.", "Rushing through it."],
      breathing: "Three to five slow nasal breaths.",
      conditions: { tmj: "This is the position to return to whenever you notice clenching during the day." },
      why: "Reinforces the default jaw position you want to carry out of the session."
    }
  },
]);
