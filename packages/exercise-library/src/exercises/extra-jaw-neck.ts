// Library expansion: more jaw care, neck work, and desk-posture relief for the upper back.
import { defineExercises } from "../define.js";

export const EXTRA_JAW_NECK = defineExercises([
  {
    id: "goldfishOpening",
    name: "Goldfish opening",
    family: "jawMobility",
    patterns: ["mobility"],
    regions: ["jaw"],
    roles: ["jaw-care"],
    position: "seated",
    laterality: "bilateral",
    load: "none",
    dose: { type: "reps", range: [6, 8], secsPerRep: 5 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    easier: ["jawOpen"],
    text: {
      summary: "Tongue up, one finger on the jaw joint and one on the chin; lower and lift the jaw slowly and evenly.",
      setup: [
        "Sit tall with the tip of the tongue resting on the palate behind the front teeth.",
        "Rest one fingertip lightly just in front of one ear, over the jaw joint, and another on the chin."
      ],
      steps: [
        "Let the lower jaw drop a little way, feeling the joint glide under your finger.",
        "Close slowly until the teeth are just apart.",
        "Keep the openings small for the first few reps.",
        "If everything stays smooth and quiet, let the last few openings go a little wider while the tongue stays up."
      ],
      focus: ["Even, unhurried movement.", "The finger on the joint only feels; it never presses."],
      mistakes: ["Opening wide straight away.", "Letting the chin drift to one side.", "Pressing on the joint."],
      breathing: "Breathe quietly through the nose.",
      conditions: { tmj: "Stop short of any click, catch, or pain; a smaller range is the right range today." },
      why: "A classic TMJ exercise that builds smooth, controlled opening while you feel what the joint is doing."
    }
  },
  {
    id: "jawIsoLateral",
    name: "Side-to-side jaw isometrics",
    family: "jawIsometric",
    patterns: ["mobility"],
    regions: ["jaw"],
    roles: ["jaw-care"],
    position: "seated",
    laterality: "unilateral",
    load: "none",
    dose: { type: "reps", range: [4, 6], secsPerRep: 8 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    easier: ["lateralExcursion"],
    text: {
      summary: "Press the jaw gently sideways into your hand, which doesn't let it move, and hold.",
      setup: [
        "Sit tall, tongue on the palate, teeth a few millimetres apart.",
        "Rest the palm or fingers against the side of the lower jaw, below the cheekbone and away from the joint."
      ],
      steps: [
        "Gently push the jaw toward your hand while the hand holds it still.",
        "Hold for about 5 seconds at light effort.",
        "Relax completely for a breath.",
        "Repeat; the timer then moves you to the other side."
      ],
      focus: [
        "About a quarter of your strength — this is control, not strength.",
        "Nothing moves: the head and the jaw stay put."
      ],
      mistakes: ["Pushing hard.", "Letting the teeth touch.", "Tilting the head into the hand."],
      breathing: "Keep breathing through the nose during each hold.",
      conditions: { tmj: "Light effort only; if the joint aches or clicks, go back to plain side-to-side glides." },
      why: "Builds steady side-to-side jaw control, which often feels uneven with TMJ problems."
    }
  },
  {
    id: "jawIsoClose",
    name: "Gentle resisted closing",
    family: "jawIsometric",
    patterns: ["mobility"],
    regions: ["jaw"],
    roles: ["jaw-care"],
    position: "seated",
    laterality: "bilateral",
    load: "none",
    dose: { type: "reps", range: [5, 8], secsPerRep: 8 },
    conditions: { tmj: { clench: 1, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    easier: ["jawOpen"],
    text: {
      summary: "Close the mouth slowly against light finger pressure on the chin, stopping before the teeth meet.",
      setup: [
        "Sit tall with the tongue on the palate.",
        "Open the mouth slightly and rest two fingers on the front of the chin, just below the lower lip."
      ],
      steps: [
        "Press the fingers down lightly on the chin.",
        "Close the mouth slowly against that light pressure.",
        "Stop while the teeth are still apart and relax the jaw.",
        "Open slightly again and repeat."
      ],
      focus: ["Very light resistance — the fingers guide more than they block.", "Stop well before the teeth touch."],
      mistakes: ["Biting down to finish the rep.", "Pushing hard with the fingers.", "Rushing."],
      breathing: "Breathe through the nose throughout.",
      conditions: {
        tmj: "This works the closing muscles gently; if it brings on clenching or soreness, leave it for a calmer day."
      },
      why: "Teaches the closing muscles to work lightly and smoothly instead of all-or-nothing."
    }
  },
  {
    id: "chinNodHold",
    name: "Chin-nod hold",
    family: "chinTuck",
    patterns: ["mobility"],
    regions: ["neck"],
    roles: ["jaw-care", "activation"],
    position: "supine",
    laterality: "bilateral",
    load: "none",
    dose: { type: "reps", range: [5, 8], secsPerRep: 12 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    easier: ["chinTuck"],
    tags: ["desk-relief"],
    text: {
      summary: "Lying on your back, make a tiny 'yes' nod and hold it for 10 seconds to build deep neck endurance.",
      setup: [
        "Lie on your back with knees bent and your head on the floor or a thin folded towel.",
        "Tongue on the palate, lips closed, teeth apart."
      ],
      steps: [
        "Nod the chin very slightly, as if saying a small 'yes', so the back of the neck lengthens along the floor.",
        "Hold the nod for about 10 seconds with light, steady effort.",
        "Relax fully for a moment.",
        "Repeat for the reps."
      ],
      focus: [
        "A tiny movement — the head stays on the floor.",
        "The big muscles at the front of the neck stay soft; check with your fingertips."
      ],
      mistakes: ["Pushing the back of the head into the floor.", "Lifting the head.", "Tucking so hard the throat tightens."],
      breathing: "Keep breathing quietly through the nose during each hold.",
      conditions: { tmj: "Clenching often sneaks in here; keep the teeth apart so the deep neck muscles do the work." },
      why: "Trains the deep neck flexors to hold the head over the shoulders, taking strain off the neck and jaw."
    }
  },
  {
    id: "neckRotations",
    name: "Neck rotations",
    family: "neckMobility",
    patterns: ["mobility"],
    regions: ["neck"],
    roles: ["jaw-care", "warmup"],
    position: "seated",
    laterality: "alternating",
    load: "none",
    dose: { type: "reps", range: [5, 8], secsPerRep: 5 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Sit tall and slowly turn to look over each shoulder, keeping the chin level.",
      setup: [
        "Sit tall with the head stacked over the shoulders and a very slight chin tuck.",
        "Tongue on the palate, teeth apart."
      ],
      steps: [
        "Turn the head slowly to look over one shoulder, as far as it goes smoothly.",
        "Pause for a breath at the end of the easy range.",
        "Turn back through the middle and look over the opposite shoulder.",
        "Keep alternating at the same slow pace."
      ],
      focus: ["The chin stays level — it doesn't lift or drop.", "Smooth range, not maximum range."],
      mistakes: ["Turning the shoulders along with the head.", "Poking the chin forward.", "Forcing the last few degrees."],
      breathing: "Exhale as you turn, inhale as you come back.",
      conditions: { tmj: "Let the jaw hang loose; it's common to lock the jaw while turning the head." },
      why: "Keeps neck rotation easy after long stretches of looking straight at a screen."
    }
  },
  {
    id: "scaleneStretch",
    name: "Scalene stretch",
    family: "neckStretch",
    patterns: ["mobility"],
    regions: ["neck"],
    roles: ["stretch", "jaw-care"],
    position: "seated",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [30, 45] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Anchor one shoulder, tilt the head away, and lift the chin a touch to stretch low on the side of the neck.",
      setup: [
        "Sit tall and hold the seat edge with one hand to keep that shoulder down.",
        "Tongue on the palate, teeth apart."
      ],
      steps: [
        "Tilt the opposite ear gently toward its shoulder, face looking forward.",
        "Lift the chin slightly until you feel a stretch low on the side of the neck, just above the collarbone.",
        "Hold and breathe low into the belly.",
        "Return slowly to upright before switching sides."
      ],
      focus: ["A gentle stretch above the collarbone, not at the top of the neck.", "The anchored shoulder stays heavy."],
      mistakes: ["Cranking the head back.", "Shrugging the anchored shoulder.", "Breathing high into the chest."],
      breathing: "Slow belly breaths; the scalenes help with breathing, so let them rest.",
      conditions: { tmj: "Keep the lips together and the teeth apart; don't let the jaw jut forward as the chin lifts." },
      why: "The scalenes tighten with forward-head posture and shallow breathing and can feed neck and jaw tension."
    }
  },
  {
    id: "scmPinchRelease",
    name: "SCM pinch release",
    family: "scmRelease",
    patterns: ["release"],
    regions: ["neck"],
    roles: ["jaw-care", "cooldown"],
    position: "seated",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [45, 60] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Gently pinch the rope-like muscle on the side of the neck and hold light pressure until it eases.",
      setup: [
        "Sit supported with the teeth apart.",
        "Turn your head away to find the SCM, the rope-like muscle from behind the ear to the collarbone; then face forward and tilt the head slightly toward it so it softens."
      ],
      steps: [
        "Take hold of the muscle between thumb and fingers, low on the neck, and lift it slightly away from the throat.",
        "Squeeze lightly and hold, breathing slowly, until the tenderness fades a little.",
        "Move a finger-width up or down the muscle and repeat.",
        "Let go slowly before switching sides."
      ],
      focus: [
        "Grip only the muscle — you're holding a rope, not pressing into the neck.",
        "Light pressure, about 3 or 4 out of 10."
      ],
      mistakes: [
        "Pressing inward toward the windpipe.",
        "Squeezing hard on a sore spot.",
        "Working right up under the angle of the jaw."
      ],
      breathing: "Slow nasal breathing with long exhales.",
      conditions: {
        tmj: "Let the jaw hang slightly open. Stop at once if you feel dizzy, tingling, or a pulse under your fingers."
      },
      why: "Jaw and head tension often comes with a tight SCM; a light hold is a gentle way to ease it."
    }
  },
  {
    id: "doorOpeners",
    name: "Door openers with pulses",
    family: "shoulderRotation",
    patterns: ["mobility"],
    regions: ["shoulders", "upper-back"],
    roles: ["warmup", "activation"],
    position: "standing",
    laterality: "bilateral",
    load: "none",
    dose: { type: "reps", range: [8, 12], secsPerRep: 6 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    harder: ["bandPullApart"],
    tags: ["desk-relief"],
    text: {
      summary: "Elbows at your sides, open the forearms out like doors, then add small shoulder-blade squeezes.",
      setup: [
        "Stand tall with the elbows bent to 90° and tucked against your sides, palms up.",
        "Tongue on the palate, teeth apart."
      ],
      steps: [
        "Rotate the forearms outward, keeping the elbows against your sides.",
        "At the open position, pull the arms back a few centimetres, squeezing the shoulder blades together, then release — two or three small pulses.",
        "Bring the forearms back to the front.",
        "Repeat at an easy pace."
      ],
      focus: ["Elbows stay at the ribs.", "Shoulders stay down, away from the ears."],
      mistakes: [
        "Arching the low back to open further.",
        "Letting the elbows drift away from the body.",
        "Pushing the chin forward during the squeeze."
      ],
      breathing: "Exhale as you open, inhale as you return.",
      conditions: { tmj: "Keep the face soft during the squeezes; the effort belongs between the shoulder blades." },
      why: "Counters rounded shoulders so the neck and jaw aren't holding the head up from a slumped base."
    }
  },
  {
    id: "elbowOpeners",
    name: "Seated elbow openers",
    family: "chestOpener",
    patterns: ["mobility"],
    regions: ["chest", "upper-back", "shoulders"],
    roles: ["warmup", "mobility"],
    position: "seated",
    laterality: "bilateral",
    load: "none",
    dose: { type: "reps", range: [15, 25], secsPerRep: 3 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Seated, bring the elbows together in front of your face, then open them wide and back.",
      setup: [
        "Sit tall toward the front of a chair or stool.",
        "Rest the fingertips lightly on the sides of your head, or hold the arms in a goalpost shape at head height."
      ],
      steps: [
        "Bring the elbows together in front of your face.",
        "Open them wide and back, drawing the shoulder blades toward each other.",
        "Pause briefly in the open position.",
        "Repeat at a steady pace."
      ],
      focus: ["The fingertips rest; they never pull the head.", "Chin level and the back of the neck long."],
      mistakes: ["Pulling the head forward with the hands.", "Arching the low back as the elbows open.", "Shrugging."],
      breathing: "Inhale as the elbows open, exhale as they close.",
      conditions: { tmj: "Keep the jaw loose; the upper back does the work." },
      why: "A quick desk-break move for a rounded upper back and tight chest."
    }
  },
  {
    id: "claspedChestOpener",
    name: "Clasped-hands chest opener",
    family: "chestStretch",
    patterns: ["mobility"],
    regions: ["chest", "shoulders"],
    roles: ["stretch", "mobility"],
    position: "seated",
    laterality: "bilateral",
    load: "none",
    dose: { type: "reps", range: [8, 12], secsPerRep: 6 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Seated, interlace the hands behind you, straighten the arms, and draw them back and down.",
      setup: [
        "Sit tall toward the front of a chair.",
        "Interlace the fingers behind your back at hip level, or hold a towel between the hands if they don't meet."
      ],
      steps: [
        "Straighten the arms.",
        "Draw the hands back and down, letting the chest open.",
        "Hold for two or three seconds.",
        "Release and repeat."
      ],
      focus: ["Shoulders roll back and down, not up.", "The chest lifts; the chin stays level."],
      mistakes: ["Poking the chin forward.", "Arching the low back.", "Forcing the arms up behind you."],
      breathing: "Inhale as you open, exhale as you release.",
      conditions: { tmj: "Lips together, teeth apart; don't let the head drift forward as the chest opens." },
      why: "Undoes the rounded-forward shape of sitting, which pulls the head and jaw forward."
    }
  },
  {
    id: "rotationBreathing",
    name: "Foot-up rotation breathing",
    family: "upperBackBreathing",
    patterns: ["breathe", "rotate"],
    regions: ["upper-back", "thoracic"],
    roles: ["mobility", "stretch"],
    equipment: { all: ["chair", "towel"] },
    position: "standing",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [45, 60] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    tags: ["desk-relief"],
    text: {
      summary: "Foot on a chair, towel in the hip crease, turn gently and breathe into the space beside the shoulder blade.",
      setup: [
        "Stand beside a sturdy chair, put one foot on the seat, and wedge a folded towel deep in the crease between that thigh and your lower ribs.",
        "Rest the same-side forearm on a desk, a counter, or the raised knee, and hold the chair seat with the other hand."
      ],
      steps: [
        "Pull up gently on the chair and turn the breastbone toward the raised knee until you feel a mild stretch between the shoulder blade and spine.",
        "Exhale softly for 5–10 seconds, letting the lower ribs sink into the towel.",
        "Pause for a few seconds with the lips closed and the tongue on the palate.",
        "Inhale through the nose for 3–5 seconds and feel the upper back widen; keep cycling until the timer moves you to the other side."
      ],
      focus: ["Keep it gentle — about 4 out of 10.", "The inhale fills the upper back, not the neck."],
      mistakes: ["Cranking the rotation or pulling hard on the chair.", "Lifting the shoulders to breathe in."],
      breathing: "Long, soft exhale; short pause; slow nasal inhale.",
      conditions: { tmj: "Tongue up and teeth apart during the pause; the neck stays quiet on every inhale." },
      why: "Opens a knotted, desk-stiff upper back with breathing rather than force."
    }
  },
  {
    id: "chairThoracicExtension",
    name: "Chair-back thoracic extension",
    family: "thoracicExtension",
    patterns: ["mobility"],
    regions: ["thoracic", "chest"],
    roles: ["mobility", "warmup"],
    equipment: { all: ["chair"] },
    position: "seated",
    laterality: "bilateral",
    load: "none",
    dose: { type: "reps", range: [8, 12], secsPerRep: 6 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Sit back against a chair and extend the upper back over the top of the backrest.",
      setup: [
        "Sit in a sturdy chair whose backrest reaches about the bottom of your shoulder blades.",
        "Cross the arms over the chest, or cradle the back of the head in the hands without pulling."
      ],
      steps: [
        "Lean back over the top of the backrest, letting the upper back arch gently.",
        "Keep the ribs down so the low back stays quiet.",
        "Come back to upright.",
        "Repeat, pausing briefly in each extension."
      ],
      focus: [
        "The bend comes from the upper back, at the backrest.",
        "The head moves with the chest; it doesn't drop back on its own."
      ],
      mistakes: ["Arching from the low back.", "Letting the head fall backward.", "Pulling on the head with the hands."],
      breathing: "Inhale as you extend, exhale as you come up.",
      conditions: { tmj: "Keep the chin gently tucked so the front of the neck doesn't pull the jaw open." },
      why: "A desk-chair reset for an upper back that has rounded forward all day."
    }
  },
  {
    id: "massageBallPec",
    name: "Massage-ball chest release",
    family: "chestRelease",
    patterns: ["release"],
    regions: ["chest", "shoulders"],
    roles: ["cooldown", "mobility"],
    equipment: { all: ["massage-ball", "wall"] },
    position: "standing",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [45, 60] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Pin a massage ball between a wall and your chest muscle and ease it with small movements.",
      setup: [
        "Stand facing a wall or door frame.",
        "Place the ball on the chest muscle below the collarbone, just inside the front of the shoulder."
      ],
      steps: [
        "Lean in gently until you feel moderate pressure.",
        "Make small circles by shifting your body.",
        "Pause on a tender spot and slowly slide the arm up and down the wall.",
        "Ease off before switching sides."
      ],
      focus: [
        "Moderate pressure that lets you breathe easily.",
        "Stay on muscle — off the collarbone and out of the armpit."
      ],
      mistakes: ["Leaning in so hard you tense up.", "Rolling on the collarbone or the front of the shoulder joint."],
      breathing: "Long exhales on tender spots.",
      conditions: { tmj: "Let the jaw hang; a tight chest pulls the head forward, and the jaw tends to follow." },
      why: "Releases a tight chest that pulls the shoulders and head forward at the desk."
    }
  },
]);
