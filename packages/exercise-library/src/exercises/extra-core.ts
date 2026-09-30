// Library expansion: trunk control, side planks, carries, and anti-rotation work.
import { defineExercises } from "../define.js";

export const EXTRA_CORE = defineExercises([
  {
    id: "cablePallofPress",
    name: "Cable Pallof press",
    family: "pallof",
    patterns: ["anti-rotate"],
    regions: ["core"],
    roles: ["accessory"],
    equipment: { all: ["cable"] },
    position: "standing",
    laterality: "unilateral",
    load: "external",
    dose: { type: "reps", range: [8, 12], sets: [2, 3], restSec: 45, startKg: 5 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    easier: ["wallPallofHold"],
    text: {
      summary: "Stand side-on to a cable at chest height, press the handle straight out, and don't let the torso turn.",
      setup: [
        "Set a cable at chest height and stand side-on to it, a step away so the cable is taut.",
        "Hold the handle with both hands at the middle of the chest, feet hip-width, knees soft."
      ],
      steps: [
        "Press the handle straight out in front of the chest.",
        "Pause with the arms long, resisting the pull.",
        "Bring it back to the chest with control.",
        "Finish the reps, then turn around and switch sides."
      ],
      focus: ["Hips and shoulders stay square to the front.", "Slow presses; the pause is the exercise."],
      mistakes: ["Letting the cable twist you.", "Leaning away from the stack.", "Using so much weight that the jaw braces."],
      breathing: "Exhale as you press out, inhale as you bring it in.",
      conditions: { tmj: "Anti-rotation work invites bracing; keep the tongue up and the teeth apart and choose a light weight." },
      why: "Trains the trunk to resist twisting without heavy bracing."
    }
  },
  {
    id: "bandPallofPress",
    name: "Band Pallof press",
    family: "pallof",
    patterns: ["anti-rotate"],
    regions: ["core"],
    roles: ["accessory", "activation"],
    equipment: { all: ["band"] },
    position: "standing",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [8, 12], sets: [2, 3], restSec: 30 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    easier: ["wallPallofHold"],
    text: {
      summary: "Anchor a band at chest height, stand side-on, and press it straight out without twisting.",
      setup: [
        "Anchor a band at chest height to a sturdy post or closed door and stand side-on, a step away so it's taut.",
        "Hold the band with both hands at the middle of the chest."
      ],
      steps: [
        "Press the hands straight out in front of the chest.",
        "Pause, resisting the band's pull.",
        "Bring the hands back with control.",
        "Finish the reps, then turn around and switch sides."
      ],
      focus: ["Hips and shoulders stay square.", "Step further from the anchor to make it harder."],
      mistakes: ["Rotating toward the anchor.", "Shrugging."],
      breathing: "Exhale as you press out, inhale as you bring it in.",
      conditions: { tmj: "Keep the face soft; this should feel steady, not strained." },
      why: "The at-home Pallof press: trunk control without heavy bracing."
    }
  },
  {
    id: "wallPallofHold",
    name: "Wall Pallof hold",
    family: "pallof",
    patterns: ["anti-rotate"],
    regions: ["core"],
    roles: ["accessory", "activation"],
    equipment: { all: ["wall"] },
    position: "standing",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "time", range: [20, 30], sets: [2, 3], restSec: 20 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    harder: ["bandPallofPress"],
    text: {
      summary: "Side-on to a wall with the arms straight out in front, press the hands sideways into it and stay square.",
      setup: [
        "Stand side-on to a wall, close enough that with the arms straight out in front of the chest and palms together, the back of the near hand touches it.",
        "Feet hip-width, knees soft."
      ],
      steps: [
        "Press the hands sideways into the wall at moderate effort.",
        "Keep the hips and shoulders facing forward; don't let the push turn you.",
        "Hold, breathing slowly.",
        "Relax, then turn around before switching sides."
      ],
      focus: ["Moderate pressure, steady breathing.", "The trunk stays still while the arms push."],
      mistakes: ["Turning the chest toward the wall.", "Pushing so hard the breath stops."],
      breathing: "Slow nasal breathing through the hold.",
      conditions: { tmj: "Keep the teeth apart; if you notice bracing, ease the push." },
      why: "Anti-rotation training with no equipment at all."
    }
  },
  {
    id: "kbAroundBody",
    name: "Kettlebell around-the-body pass",
    family: "kbPass",
    patterns: ["anti-rotate"],
    regions: ["core", "shoulders"],
    roles: ["accessory"],
    equipment: { all: ["kettlebell"] },
    position: "standing",
    laterality: "alternating",
    load: "external",
    dose: { type: "reps", range: [5, 10], sets: [2, 3], restSec: 30, startKg: 8 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    text: {
      summary: "Pass a kettlebell around your waist from hand to hand, standing tall and still.",
      setup: ["Stand tall, feet hip-width, knees soft.", "Hold a light kettlebell by the handle in front of the hips."],
      steps: [
        "Hand the bell from one hand to the other behind your back.",
        "Bring it round to the front and hand it across again.",
        "Keep the hips still and the torso tall as the bell circles.",
        "Do the reps circling one way, then the same number circling the opposite way."
      ],
      focus: ["The body stays still; only the bell moves.", "Smooth handoffs, no swinging."],
      mistakes: ["Letting the hips sway with the bell.", "Rushing the handoff behind the back."],
      breathing: "Easy, steady breathing.",
      conditions: { tmj: "Light bell, quiet face — this is about control, not effort." },
      why: "A light, playful way to train the trunk to stay still while the load moves around it."
    }
  },
  {
    id: "copenhagenPlank",
    name: "Short Copenhagen side plank",
    family: "copenhagen",
    patterns: ["anti-lateral"],
    regions: ["core", "hips"],
    roles: ["core", "accessory"],
    equipment: { oneOf: ["bench", "chair"] },
    position: "side-lying",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "time", range: [15, 30], sets: [2, 3], restSec: 45 },
    conditions: { tmj: { clench: 2, neckLoad: 1, faceDown: false } },
    difficulty: 3,
    easier: ["sidePlank"],
    text: {
      summary: "Side plank with the top knee resting on a bench or chair seat, lifting the hips with the inner thigh.",
      setup: [
        "Lie on your side next to a bench or sturdy chair, forearm under the shoulder.",
        "Rest the inside of the top knee on the seat; the bottom leg stays bent underneath."
      ],
      steps: [
        "Press the top knee down into the seat and lift the hips until the body is straight.",
        "Hold, breathing slowly.",
        "Lower the hips with control.",
        "Once holds feel easy, add a few slow hip dips at the end; then switch sides."
      ],
      focus: ["The top inner thigh does the lifting.", "Head in line with the spine."],
      mistakes: ["Letting the hips sag.", "Shrugging into the supporting shoulder.", "Holding the breath."],
      breathing: "Slow breaths; if you can't breathe easily, shorten the hold.",
      conditions: {
        tmj: "This takes real effort; keep the teeth apart, and go back to the knees-down side plank if you catch yourself clenching."
      },
      why: "Strengthens the inner thighs and side body together, which most routines leave out."
    }
  },
  {
    id: "wallSidePlank",
    name: "Wall side plank",
    family: "sidePlank",
    patterns: ["anti-lateral"],
    regions: ["core"],
    roles: ["core", "accessory"],
    equipment: { all: ["wall"] },
    position: "standing",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "time", range: [20, 40], sets: [2, 3], restSec: 30 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    harder: ["sidePlankKnees"],
    text: {
      summary: "Lean your forearm on a wall with the feet stepped out, and hold the body in a straight line.",
      setup: [
        "Stand side-on to a wall and place the forearm on it at shoulder height, elbow under the shoulder.",
        "Step the feet out from the wall, together, so the body leans into the forearm."
      ],
      steps: [
        "Push the forearm into the wall and lift the hips away from it until the body is straight.",
        "Hold, breathing slowly.",
        "Walk the feet back in to finish.",
        "Switch sides when the timer says."
      ],
      focus: ["Tall through the waist on the wall side.", "Step the feet further out to make it harder."],
      mistakes: ["Letting the hips sag toward the wall.", "Shrugging the supporting shoulder."],
      breathing: "Easy nasal breathing.",
      conditions: { tmj: "An easy hold — keep the face completely relaxed." },
      why: "The gentlest side-body strength drill, fine even on a stiff-jaw day."
    }
  },
  {
    id: "sidePlank",
    name: "Side plank",
    family: "sidePlank",
    patterns: ["anti-lateral"],
    regions: ["core"],
    roles: ["core", "accessory"],
    position: "side-lying",
    laterality: "unilateral",
    load: "bodyweight",
    dose: { type: "time", range: [20, 40], sets: [2, 3], restSec: 45 },
    conditions: { tmj: { clench: 1, neckLoad: 1, faceDown: false } },
    difficulty: 3,
    easier: ["sidePlankKnees"],
    harder: ["copenhagenPlank"],
    text: {
      summary: "On your side with the legs straight, lift the hips into a line from head to heels and hold.",
      setup: [
        "Lie on your side, elbow under the shoulder, legs straight and stacked (or the top foot in front for balance).",
        "Rest the free hand on the hip."
      ],
      steps: [
        "Press the forearm and feet into the floor and lift the hips.",
        "Hold the body straight from head to heels, breathing slowly.",
        "Lower with control.",
        "Switch sides when the timer says."
      ],
      focus: ["Hips stay forward and high.", "Head in line — don't let it drop or crane up."],
      mistakes: ["Hips sagging or piking.", "Shrugging into the supporting shoulder."],
      breathing: "Slow breaths; don't hold them.",
      conditions: { tmj: "Keep the jaw quiet — go back to the knees version if you start grimacing." },
      why: "Builds the side-body strength that keeps you tall under a carry, without any load."
    }
  },
  {
    id: "gobletCarry",
    name: "Goblet carry",
    family: "gobletCarry",
    patterns: ["carry"],
    regions: ["core", "upper-back", "arms"],
    roles: ["core", "accessory"],
    equipment: { oneOf: ["kettlebell", "dumbbells"] },
    position: "standing",
    laterality: "bilateral",
    load: "external",
    dose: { type: "carry", range: [30, 60], sets: [2, 3], restSec: 45, startKg: 12 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    harder: ["rackCarry"],
    text: {
      summary: "Hold a weight at your chest and walk tall with short, even steps.",
      setup: [
        "Hold a kettlebell by the horns (or a dumbbell by one end) against the chest, elbows pointing down.",
        "Stand tall with the ribs stacked over the pelvis."
      ],
      steps: [
        "Walk slowly with short, even steps, or march in place if space is tight.",
        "Keep the weight close to the chest.",
        "Stay tall; don't lean back to balance the load.",
        "Set the weight down with a hinge."
      ],
      focus: ["Shoulders down, elbows in.", "Quiet, steady breathing."],
      mistakes: ["Leaning back.", "Letting the weight drift away from the chest.", "Hunching the shoulders."],
      breathing: "Keep breathing through the nose; no breath-holding.",
      conditions: {
        tmj: "The weight sits near your chin — keep the chin level and the teeth apart rather than tucking into the bell."
      },
      why: "The easiest loaded carry: builds a tall, stacked posture with a light weight."
    }
  },
  {
    id: "rackCarry",
    name: "One-arm rack carry",
    family: "rackCarry",
    patterns: ["carry", "anti-lateral"],
    regions: ["core", "shoulders", "upper-back"],
    roles: ["core", "accessory"],
    equipment: { oneOf: ["kettlebell", "dumbbells"] },
    position: "standing",
    laterality: "unilateral",
    load: "external",
    dose: { type: "carry", range: [30, 45], sets: [2, 3], restSec: 60, startKg: 12 },
    conditions: { tmj: { clench: 1, neckLoad: 1, faceDown: false } },
    difficulty: 3,
    easier: ["gobletCarry"],
    text: {
      summary: "Hold one weight at the shoulder in the rack position and walk tall without leaning.",
      setup: [
        "Use both hands to bring the weight up to the rack position: handle in the palm, bell resting on the outside of the forearm, wrist straight.",
        "Tuck the elbow against the ribs and stand tall."
      ],
      steps: [
        "Walk slowly with short, even steps, or march in place.",
        "Keep the shoulders level and the ribs stacked.",
        "Don't lean away from the weight.",
        "Switch hands when the timer moves to the other side."
      ],
      focus: ["Elbow tucked, wrist straight.", "The loaded shoulder stays down, away from the ear."],
      mistakes: ["Shrugging the racked shoulder.", "Leaning back or away.", "Swinging the weight up into the rack."],
      breathing: "Steady nasal breathing throughout.",
      conditions: {
        tmj: "The bell sits close to the jaw — keep the head tall and the teeth apart, and go lighter if the neck tightens."
      },
      why: "Trains the trunk against an off-centre load at shoulder height."
    }
  },
  {
    id: "plankPelvicTilts",
    name: "Plank pelvic tilts",
    family: "plank",
    patterns: ["anti-extend"],
    regions: ["core"],
    roles: ["accessory"],
    position: "quadruped",
    laterality: "bilateral",
    load: "bodyweight",
    dose: { type: "reps", range: [8, 10], sets: [2, 3], restSec: 30, secsPerRep: 4 },
    conditions: { tmj: { clench: 1, neckLoad: 1, faceDown: false } },
    difficulty: 3,
    easier: ["inclinePlank"],
    text: {
      summary: "In a forearm plank, slowly tuck and untuck the pelvis while the ribs and shoulders stay still.",
      setup: [
        "Set up in a forearm plank, elbows under the shoulders (knees down to make it easier).",
        "Head in line with the spine, eyes on the floor."
      ],
      steps: [
        "Tuck the tailbone under, gently rounding the low back.",
        "Let the pelvis return to a slight arch without the hips sagging.",
        "Move slowly between the two.",
        "Keep the chest, shoulders, and head still throughout."
      ],
      focus: ["Only the pelvis moves.", "Slow and small."],
      mistakes: ["Sagging into the low back.", "Rocking the whole body.", "Holding the breath."],
      breathing: "Exhale as you tuck, inhale as you release.",
      conditions: {
        tmj: "Planks invite clenching — keep the tongue up and the teeth apart, and drop the knees if the jaw tightens."
      },
      why: "Builds control of the pelvis under a plank, which carries over to steadier squats and hinges."
    }
  },
]);
