// Upper-body strength: rows, scapular work, presses.
import { defineExercises } from "../define.js";

export const UPPER = defineExercises([
  {
    id: "supportedRow",
    name: "Supported one-arm row",
    family: "row",
    patterns: ["pull-h"],
    regions: ["upper-back", "lats", "arms"],
    roles: ["core", "accessory"],
    equipment: { oneOf: ["kettlebell", "dumbbells"] },
    position: "standing",
    laterality: "unilateral",
    load: "external",
    dose: { type: "reps", range: [8, 12], sets: [2, 4], restSec: 60, startKg: 12 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    tags: ["desk-relief"],
    text: {
      summary: "One hand supported on a bench or chair, row the weight toward your hip.",
      setup: [
        "Place one hand on a bench, chair, or your thigh; stagger the feet.",
        "Hold the weight in the other hand, arm long."
      ],
      steps: [
        "Pull the elbow back toward the hip.",
        "Pause with the shoulder blade drawn back.",
        "Lower slowly until the arm is long again.",
        "Finish the reps, then switch sides."
      ],
      focus: ["The shoulder blade moves; the neck doesn't hike.", "Elbow travels toward the hip, not straight up."],
      mistakes: ["Shrugging the shoulder to the ear.", "Twisting the torso to swing the weight."],
      breathing: "Exhale as you row, inhale as you lower.",
      conditions: { tmj: "Keep the head in line with the spine and the teeth apart — rows invite a shrug-and-clench." },
      why: "Strengthens the mid-back so the neck does less postural work."
    }
  },
  {
    id: "chestSupportedRow",
    name: "Chest-supported row",
    family: "row",
    patterns: ["pull-h"],
    regions: ["upper-back", "lats"],
    roles: ["core", "accessory"],
    equipment: { all: ["bench", "dumbbells"] },
    position: "prone",
    laterality: "bilateral",
    load: "external",
    dose: { type: "reps", range: [8, 12], sets: [2, 4], restSec: 60, startKg: 10 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    tags: ["desk-relief"],
    text: {
      summary: "Lie chest-down on an incline bench and row two dumbbells toward your hips.",
      setup: [
        "Set a bench to a low incline and lie chest-down, head past the top edge.",
        "Hold a dumbbell in each hand, arms hanging."
      ],
      steps: [
        "Row both elbows back toward the hips.",
        "Pause with the shoulder blades drawn together.",
        "Lower slowly.",
        "Repeat; the weight shown is per hand."
      ],
      focus: ["Chest stays on the pad.", "Neck stays long, looking at the floor."],
      mistakes: ["Lifting the chest off the pad to heave the weight.", "Craning the head up."],
      breathing: "Exhale as you row.",
      conditions: { tmj: "The bench removes the need to brace, so there's nothing for the jaw to do." },
      why: "The bench takes away all bracing, so the mid-back works without the jaw joining in."
    }
  },
  {
    id: "cableRow",
    name: "Seated cable row",
    family: "row",
    patterns: ["pull-h"],
    regions: ["upper-back", "lats", "arms"],
    roles: ["core", "accessory"],
    equipment: { all: ["cable"] },
    position: "seated",
    laterality: "bilateral",
    load: "external",
    dose: { type: "reps", range: [8, 12], sets: [2, 4], restSec: 60, startKg: 20 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    text: {
      summary: "Sit tall at a cable row and pull the handle to your lower ribs.",
      setup: ["Sit with feet on the platform, knees soft.", "Hold the handle with arms long and chest tall."],
      steps: [
        "Pull the handle toward the lower ribs.",
        "Draw the shoulder blades back and down.",
        "Return slowly until the arms are long.",
        "Repeat without leaning back and forth."
      ],
      focus: ["Torso stays still.", "Shoulders down."],
      mistakes: ["Rocking the torso to move the weight.", "Shrugging at the end of the pull."],
      breathing: "Exhale as you pull.",
      conditions: { tmj: "Keep the chin level and the jaw loose." },
      why: "A steady, supported row for the gym."
    }
  },
  {
    id: "proneYTW",
    name: "Prone Y-T-W raises",
    family: "scapular",
    patterns: ["pull-h"],
    regions: ["upper-back", "shoulders"],
    roles: ["core", "accessory", "activation"],
    position: "prone",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [5, 10], sets: [2, 3], restSec: 30, secsPerRep: 6 },
    conditions: { tmj: { clench: 0, neckLoad: 1, faceDown: true } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Face down, lift the arms into a Y, then a T, then a W — that's one rep.",
      setup: ["Lie face down with the forehead on a folded towel.", "Arms overhead in a Y, thumbs up."],
      steps: [
        "Lift the arms a few centimetres in the Y position and lower.",
        "Move the arms out to a T and lift and lower.",
        "Bend the elbows into a W and squeeze the shoulder blades down and back.",
        "That's one rep; go slowly."
      ],
      focus: ["The shoulder blades move; the neck stays long.", "Small lifts are enough."],
      mistakes: ["Lifting the head off the towel.", "Arching the low back."],
      breathing: "Exhale on each lift.",
      conditions: {
        tmj: "Face-down lying can press on the jaw — keep the forehead on the towel so the jaw hangs free, and skip this on flare days."
      },
      why: "Strengthens the mid-back and lower traps so the neck does less postural work."
    }
  },
  {
    id: "bandPullApart",
    name: "Band pull-apart",
    family: "scapular",
    patterns: ["pull-h"],
    regions: ["upper-back", "shoulders"],
    roles: ["activation", "accessory"],
    equipment: { all: ["band"] },
    position: "standing",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [12, 20], sets: [2, 3], restSec: 30 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Hold a band at shoulder height and pull it apart until it touches your chest.",
      setup: ["Stand tall holding a light band with both hands, shoulder-width, arms straight in front.", "Shoulders down."],
      steps: [
        "Pull the hands apart by drawing the shoulder blades together.",
        "Bring the band toward the chest.",
        "Return slowly.",
        "Repeat."
      ],
      focus: ["Shoulders stay down away from the ears.", "Arms stay nearly straight."],
      mistakes: ["Shrugging.", "Arching the back to finish the rep."],
      breathing: "Exhale as you pull apart.",
      conditions: { tmj: "No effort in the face." },
      why: "A quick, easy posture reset for the upper back between desk sessions."
    }
  },
  {
    id: "bandFacePull",
    name: "Band face pull",
    family: "facePull",
    patterns: ["pull-h"],
    regions: ["upper-back", "shoulders"],
    roles: ["accessory", "activation"],
    equipment: { all: ["band"] },
    position: "standing",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [12, 15], sets: [2, 3], restSec: 45 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Anchor a band at head height and pull it toward your face, elbows high.",
      setup: ["Anchor the band at about head height (door anchor or post).", "Hold the ends with palms facing down."],
      steps: [
        "Pull the band toward your face, elbows high and wide.",
        "Finish with the hands beside the ears, rotating the knuckles back.",
        "Pause.",
        "Return slowly."
      ],
      focus: ["Shoulder blades back and down.", "Elbows at or above shoulder height."],
      mistakes: ["Leaning back to cheat.", "Pulling to the chin with low elbows."],
      breathing: "Exhale as you pull.",
      conditions: { tmj: "Keep the head still and the jaw loose as the hands come toward the face." },
      why: "Strengthens the rear shoulders and rotator cuff that counter forward-rounded posture."
    }
  },
  {
    id: "cableFacePull",
    name: "Cable face pull",
    family: "facePull",
    patterns: ["pull-h"],
    regions: ["upper-back", "shoulders"],
    roles: ["accessory", "activation"],
    equipment: { all: ["cable"] },
    position: "standing",
    laterality: "bilateral",
    load: "external",
    dose: { type: "reps", range: [12, 15], sets: [2, 3], restSec: 45, startKg: 7 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    tags: ["desk-relief"],
    text: {
      summary: "Rope on a high cable, pull toward your face with the elbows high and wide.",
      setup: ["Set a rope attachment at about head height.", "Step back until the arms are straight in front."],
      steps: [
        "Pull the rope toward your face, splitting the ends apart.",
        "Finish with the hands beside the ears.",
        "Pause.",
        "Return slowly."
      ],
      focus: ["Elbows high and wide.", "Shoulder blades back and down."],
      mistakes: ["Using too much weight so the body leans back.", "Shrugging."],
      breathing: "Exhale as you pull.",
      conditions: { tmj: "Head still, jaw loose." },
      why: "Strengthens the rear shoulders and upper back that counter forward-rounded posture."
    }
  },
  {
    id: "floorPress",
    name: "Floor press",
    family: "press",
    patterns: ["push-h"],
    regions: ["chest", "shoulders", "arms"],
    roles: ["core", "accessory"],
    equipment: { oneOf: ["kettlebell", "dumbbells"] },
    position: "supine",
    laterality: "unilateral",
    load: "external",
    dose: { type: "reps", range: [6, 10], sets: [2, 3], restSec: 60, startKg: 8 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    text: {
      summary: "Lying on your back, press the weight up with one arm; the floor limits the range.",
      setup: [
        "Lie on your back, knees bent.",
        "Hold the weight with the upper arm on the floor, elbow at about 45° from your side."
      ],
      steps: [
        "Press the weight straight up over the shoulder.",
        "Lower slowly until the upper arm touches the floor.",
        "Pause lightly, then press again.",
        "Finish the reps, then switch sides."
      ],
      focus: ["Slow lower, smooth press.", "Ribs down, shoulder blade on the floor."],
      mistakes: ["Letting the elbow flare straight out.", "Bouncing the elbow off the floor."],
      breathing: "Exhale as you press.",
      conditions: { tmj: "Head rests on the floor — no need to push it down or brace the face." },
      why: "Builds shoulder stability with the floor protecting range."
    }
  },
  {
    id: "wallPushup",
    name: "Wall push-up",
    family: "pushup",
    patterns: ["push-h"],
    regions: ["chest", "shoulders", "arms"],
    roles: ["core", "accessory"],
    equipment: { all: ["wall"] },
    position: "standing",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [8, 15], sets: [2, 3], restSec: 45 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    harder: ["inclinePushup"],
    text: {
      summary: "Hands on a wall, lower the chest toward it with a straight body and press away.",
      setup: ["Stand an arm's length from a wall.", "Hands on the wall at chest height, a little wider than the shoulders."],
      steps: [
        "Bend the elbows to bring the chest toward the wall.",
        "Keep the body straight from head to heels.",
        "Press back to the start.",
        "Repeat."
      ],
      focus: ["A straight line from head to heels.", "Elbows angled back, not straight out."],
      mistakes: ["Poking the head toward the wall.", "Sagging at the hips."],
      breathing: "Inhale down, exhale as you press.",
      conditions: { tmj: "Lead with the chest, not the chin." },
      why: "The easiest pressing pattern to start building push strength."
    }
  },
  {
    id: "inclinePushup",
    name: "Incline push-up",
    family: "pushup",
    patterns: ["push-h"],
    regions: ["chest", "shoulders", "arms", "core"],
    roles: ["core", "accessory"],
    equipment: { oneOf: ["bench", "chair"] },
    position: "standing",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [6, 12], sets: [2, 3], restSec: 45 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    easier: ["wallPushup"],
    harder: ["pushup"],
    text: {
      summary: "Hands on a bench or braced chair, lower the chest with control and press away.",
      setup: ["Brace the chair against a wall so it can't move.", "Hands on the edge, feet back so the body is straight."],
      steps: ["Lower the chest toward the edge.", "Keep the body in one line.", "Press away to the start.", "Repeat."],
      focus: ["Long line, soft face.", "Elbows about 45° from the body."],
      mistakes: ["Letting the hips sag or pike.", "Dropping the head."],
      breathing: "Inhale down, exhale up.",
      conditions: { tmj: "Keep the teeth apart through the hard part of the press." },
      why: "Builds pressing strength with an easy-to-scale angle."
    }
  },
  {
    id: "pushup",
    name: "Push-up",
    family: "pushup",
    patterns: ["push-h"],
    regions: ["chest", "shoulders", "arms", "core"],
    roles: ["core", "accessory"],
    position: "quadruped",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [5, 12], sets: [2, 3], restSec: 60 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 3,
    easier: ["inclinePushup"],
    text: {
      summary: "A full push-up from the floor with a straight body.",
      setup: ["Hands on the floor a little wider than the shoulders.", "Legs straight behind you, body in one line."],
      steps: ["Lower the chest toward the floor with control.", "Keep the body straight.", "Press back up.", "Repeat."],
      focus: ["Straight line from head to heels.", "Elbows about 45° from the body."],
      mistakes: ["Sagging hips.", "Reaching the chin to the floor."],
      breathing: "Inhale down, exhale up.",
      conditions: { tmj: "Hard push-ups invite clenching — stop the set before the face tightens." },
      why: "The classic bodyweight press, for when incline push-ups get easy."
    }
  },
  {
    id: "halfKneelingPress",
    name: "Half-kneeling one-arm press",
    family: "overheadPress",
    patterns: ["push-v"],
    regions: ["shoulders", "arms", "core"],
    roles: ["core", "accessory"],
    equipment: { oneOf: ["kettlebell", "dumbbells"] },
    position: "half-kneeling",
    laterality: "unilateral",
    load: "external",
    dose: { type: "reps", range: [5, 8], sets: [2, 3], restSec: 60, startKg: 8 },
    conditions: { tmj: { clench: 2, neckLoad: 1, faceDown: false } },
    difficulty: 3,
    text: {
      summary: "Kneeling on one knee, press the weight overhead with the arm on the down-knee side.",
      setup: [
        "Half-kneel with the back knee under the hip.",
        "Hold the weight at the shoulder on the same side as the down knee."
      ],
      steps: [
        "Squeeze the glute of the down leg to stay tall.",
        "Press the weight overhead, finishing with the biceps near the ear.",
        "Lower slowly to the shoulder.",
        "Finish the reps, then switch sides."
      ],
      focus: ["Ribs stay down — no leaning back.", "Head moves 'through the window' at the top."],
      mistakes: ["Arching the low back.", "Pushing the head forward to make room."],
      breathing: "Exhale as you press.",
      conditions: {
        tmj: "Overhead pressing loads the neck and invites clenching; keep it light and only do it on calm-jaw days."
      },
      why: "Builds overhead strength and trunk control with a stable base."
    }
  },
]);
