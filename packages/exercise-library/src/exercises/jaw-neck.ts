// Jaw care, neck relief, and upper-back posture work.
import { defineExercises } from "../define.js";

export const JAW_NECK = defineExercises([
  {
    id: "chinTuck",
    name: "Chin tucks",
    family: "chinTuck",
    patterns: ["mobility"],
    regions: ["neck"],
    roles: ["jaw-care", "warmup"],
    position: "seated",
    laterality: "bilateral",
    load: "none",
    dose: { type: "reps", range: [8, 12], secsPerRep: 5 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Slide your head straight back, as if making a double chin, then release.",
      setup: ["Sit tall with your back supported, eyes level.", "Rest the tongue on the palate, teeth apart."],
      steps: [
        "Glide your head straight back, keeping your eyes on the horizon.",
        "Hold for 2–3 seconds as the back of the neck lengthens.",
        "Slowly return to neutral.",
        "Repeat smoothly."
      ],
      focus: ["Straight back, not down — the chin doesn't drop to the chest.", "Feel length at the base of the skull."],
      mistakes: ["Nodding the head down instead of gliding back.", "Pushing hard enough to strain the throat."],
      breathing: "Exhale as you tuck, inhale as you release.",
      conditions: { tmj: "Keep the throat and jaw soft; the tuck comes from the deep neck muscles, not from clenching." },
      why: "Trains the neck position that counters forward-head posture, which loads the jaw."
    }
  },
  {
    id: "jawOpen",
    name: "Controlled jaw opening",
    family: "jawMobility",
    patterns: ["mobility"],
    regions: ["jaw"],
    roles: ["jaw-care"],
    position: "seated",
    laterality: "bilateral",
    load: "none",
    dose: { type: "reps", range: [6, 10], secsPerRep: 5 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    harder: ["jawIsoOpen"],
    text: {
      summary: "Open the mouth slowly with the tongue on the palate, only as far as it's smooth.",
      setup: ["Sit tall, head level.", "Place the tip of the tongue on the roof of the mouth just behind the front teeth."],
      steps: [
        "Keeping the tongue in place, slowly open the mouth.",
        "Stop before the tongue leaves the palate or anything clicks or hurts.",
        "Pause for a second, then close slowly until the teeth are just apart.",
        "Repeat with the same smooth speed."
      ],
      focus: [
        "A straight path — watch in a mirror so the chin doesn't drift sideways.",
        "Small, smooth range beats a big forced one."
      ],
      mistakes: [
        "Letting the tongue drop to open wider.",
        "Pushing through clicking or pain.",
        "Snapping the teeth together on the way up."
      ],
      breathing: "Breathe through the nose throughout.",
      conditions: { tmj: "The tongue position limits the opening to a joint-friendly range; stay pain-free." },
      why: "Restores easy, controlled jaw motion without jamming the joint."
    }
  },
  {
    id: "lateralExcursion",
    name: "Side-to-side jaw glides",
    family: "jawMobility",
    patterns: ["mobility"],
    regions: ["jaw"],
    roles: ["jaw-care"],
    position: "seated",
    laterality: "alternating",
    load: "none",
    dose: { type: "reps", range: [6, 10], secsPerRep: 4 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "With teeth slightly apart, glide the lower jaw gently side to side.",
      setup: [
        "Sit tall and part the teeth a few millimetres.",
        "Optionally rest a finger or a thin object between the front teeth as a guide."
      ],
      steps: [
        "Slide the lower jaw slowly to one side as far as is comfortable.",
        "Return to the middle.",
        "Slide to the other side.",
        "Keep alternating at an even pace."
      ],
      focus: ["Tiny, even movements to each side.", "Head and neck stay still."],
      mistakes: ["Opening the mouth wide while gliding.", "Forcing the end range on the stiffer side."],
      breathing: "Normal nasal breathing.",
      conditions: { tmj: "If one side feels tighter, keep the range on both sides matched to the easier one for now." },
      why: "Restores side-to-side jaw movement, which often stiffens with TMJ problems."
    }
  },
  {
    id: "tongueRest",
    name: "Tongue-up rest position",
    family: "jawRest",
    patterns: ["breathe"],
    regions: ["jaw"],
    roles: ["jaw-care", "downshift"],
    position: "seated",
    laterality: "bilateral",
    load: "none",
    dose: { type: "time", range: [45, 90] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Practise the jaw's resting position: tongue on the palate, lips together, teeth apart.",
      setup: [
        "Sit comfortably with your head balanced over your shoulders.",
        "Say a soft 'N' and notice where the tongue tip lands — that's the spot."
      ],
      steps: [
        "Rest the tip of the tongue on that spot behind the upper front teeth.",
        "Let the rest of the tongue settle up against the palate.",
        "Close the lips gently and let the teeth separate.",
        "Hold the position while breathing through the nose."
      ],
      focus: ["Light contact — the tongue rests, it doesn't press.", "Teeth never touch."],
      mistakes: ["Pushing the tongue hard.", "Clamping the lips.", "Letting the teeth drift back together."],
      breathing: "Quiet nasal breathing.",
      conditions: { tmj: "This is the position to come back to all day; it takes load off the jaw joints and muscles." },
      why: "Teaches the resting jaw position that counters daytime clenching."
    }
  },
  {
    id: "rocabado",
    name: "Rocabado 6×6",
    family: "jawRoutine",
    patterns: ["mobility"],
    regions: ["jaw", "neck"],
    roles: ["jaw-care"],
    position: "seated",
    laterality: "bilateral",
    load: "none",
    dose: { type: "time", range: [120, 180] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Six gentle jaw and neck exercises, six reps each — a classic TMJ routine.",
      setup: ["Sit tall in front of a mirror if you have one.", "Move slowly; nothing should hurt."],
      steps: [
        "Tongue rest: tongue on the palate, breathe through the nose (6 breaths).",
        "Controlled opening: open only as far as the tongue can stay on the palate (6 reps).",
        "Gentle resisted opening: fingers under the chin, open against light pressure (6 × a few seconds).",
        "Upper-neck nods: small 'yes' nods from the top of the neck (6 reps).",
        "Chin tucks: glide the head straight back (6 reps).",
        "Shoulder-blade squeezes: draw the shoulder blades back and down (6 reps)."
      ],
      focus: ["Gentle, pain-free range in every part.", "Keep the tongue position throughout the jaw parts."],
      mistakes: ["Rushing through the six parts.", "Using force on the resisted opening."],
      breathing: "Breathe through the nose, slow and steady.",
      conditions: { tmj: "Stop any part that causes clicking pain or locking and skip it for the day." },
      why: "A well-known routine that combines jaw rest, control, and posture in a few minutes."
    }
  },
  {
    id: "jawIsoOpen",
    name: "Gentle resisted opening",
    family: "jawMobility",
    patterns: ["mobility"],
    regions: ["jaw"],
    roles: ["jaw-care"],
    position: "seated",
    laterality: "bilateral",
    load: "none",
    dose: { type: "reps", range: [5, 8], secsPerRep: 8 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 2,
    easier: ["jawOpen"],
    text: {
      summary: "Open the mouth slightly against light finger pressure under the chin and hold.",
      setup: ["Sit tall with the tongue on the palate.", "Rest one or two fingers under the chin."],
      steps: [
        "Open the mouth a little, until the teeth are about a finger-width apart.",
        "Press the chin gently down into your fingers while the fingers resist.",
        "Hold for about 5 seconds with steady, light effort.",
        "Relax completely, then repeat."
      ],
      focus: ["Light effort — about a quarter of your strength.", "The jaw stays in the middle, not shifting to a side."],
      mistakes: ["Pushing hard.", "Holding the breath.", "Clenching the back teeth between reps."],
      breathing: "Keep breathing through the nose during the hold.",
      conditions: { tmj: "Opening muscles work here, which helps the closing (clenching) muscles relax afterwards." },
      why: "Builds control of the muscles that open the jaw so the closers can let go."
    }
  },
  {
    id: "jawMassage",
    name: "Masseter + temple massage",
    family: "jawRelease",
    patterns: ["release"],
    regions: ["jaw"],
    roles: ["jaw-care", "cooldown"],
    position: "seated",
    laterality: "bilateral",
    load: "none",
    dose: { type: "time", range: [60, 120] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Light circles over the jaw muscles and temples, staying below pain.",
      setup: [
        "Sit supported with the teeth apart.",
        "Find the masseter: clench very lightly once and feel the muscle bulge at the angle of the jaw, then relax."
      ],
      steps: [
        "Place two or three fingertips on the masseter on both sides.",
        "Make slow, small circles with light pressure.",
        "Move up to the temples and repeat.",
        "Finish with slow strokes from the cheekbone down toward the jaw line."
      ],
      focus: ["Pressure should feel relieving, not aggressive.", "Keep the teeth apart the whole time."],
      mistakes: ["Digging in hard on sore spots.", "Clenching to find the muscle and then forgetting to relax."],
      breathing: "Slow nasal breathing; exhale as you ease into a tight spot.",
      conditions: {
        tmj: "Let the jaw hang slightly open while you work; don't press on the joint itself just in front of the ear."
      },
      why: "Reduces muscle guarding around the jaw and temples."
    }
  },
  {
    id: "suboccipitalRelease",
    name: "Suboccipital release",
    family: "neckRelease",
    patterns: ["release"],
    regions: ["neck"],
    roles: ["jaw-care", "cooldown"],
    position: "supine",
    laterality: "bilateral",
    load: "none",
    dose: { type: "time", range: [60, 120] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Lie back and let the base of your skull rest on your fingertips or a rolled towel.",
      setup: [
        "Lie on your back with knees bent.",
        "Place your fingertips (or a small rolled towel) under the base of the skull, where the head meets the neck."
      ],
      steps: [
        "Let the weight of the head sink onto the support.",
        "Make tiny 'yes' nods of a few millimetres.",
        "Then stay still and let the muscles melt for a few breaths.",
        "Repeat the small nods and rests."
      ],
      focus: ["The head is heavy; the neck does nothing.", "Movements are tiny."],
      mistakes: ["Pressing up into the support.", "Making big nodding movements."],
      breathing: "Slow nasal breathing with long exhales.",
      conditions: {
        tmj: "Tension at the base of the skull and in the jaw often go together; let the teeth part as the neck softens."
      },
      why: "Eases the small muscles under the skull that tighten with forward-head posture and headaches."
    }
  },
  {
    id: "upperTrapStretch",
    name: "Upper-trap stretch",
    family: "neckStretch",
    patterns: ["mobility"],
    regions: ["neck", "shoulders"],
    roles: ["stretch", "jaw-care"],
    position: "seated",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [30, 45] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Tilt the ear toward the shoulder while the other shoulder stays heavy.",
      setup: [
        "Sit tall and hold the seat edge with one hand to anchor that shoulder down.",
        "Tongue on the palate, teeth apart."
      ],
      steps: [
        "Tilt the opposite ear toward its shoulder.",
        "Rest the free hand lightly on the head for a little extra, if comfortable.",
        "Hold and breathe.",
        "Return slowly to upright before switching sides."
      ],
      focus: ["The anchored shoulder stays down.", "A mild stretch along the side of the neck — not pain."],
      mistakes: ["Pulling on the head.", "Rotating the face toward the floor.", "Shrugging the anchored shoulder."],
      breathing: "Slow nasal breaths; lengthen on each exhale.",
      conditions: { tmj: "Keep the jaw loose — the stretch often makes people clench without noticing." },
      why: "Relieves the upper traps, which tighten with desk work and pull on the neck and jaw."
    }
  },
  {
    id: "levatorStretch",
    name: "Levator scapulae stretch",
    family: "neckStretch",
    patterns: ["mobility"],
    regions: ["neck", "upper-back"],
    roles: ["stretch", "jaw-care"],
    position: "seated",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [30, 45] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Turn the nose toward the armpit and let the head drop gently forward.",
      setup: [
        "Sit tall and anchor one hand under the thigh or on the seat.",
        "Turn your head about 45° away from the anchored side."
      ],
      steps: [
        "Look down toward the armpit on the free side.",
        "Let the head drop gently until you feel a stretch at the back of the neck on the anchored side.",
        "Hold and breathe.",
        "Come up slowly and switch sides."
      ],
      focus: ["The stretch is at the back and side of the neck.", "The anchored shoulder stays low."],
      mistakes: ["Pulling the head down hard.", "Rounding the whole upper back to fake the range."],
      breathing: "Easy nasal breathing.",
      conditions: { tmj: "Let the mouth relax slightly; there's no need to hold the face tight." },
      why: "Eases the muscle that runs from neck to shoulder blade — a common source of neck tension."
    }
  },
  {
    id: "scmStretch",
    name: "SCM stretch",
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
    text: {
      summary: "Tilt away, turn slightly back toward the stretched side, and lift the chin a touch.",
      setup: ["Sit tall with the shoulders relaxed.", "Place one hand flat on the collarbone on the side you're stretching."],
      steps: [
        "Tilt the head gently away from the hand.",
        "Turn the face slightly toward the stretched side, then lift the chin a little until you feel the front of the neck lengthen.",
        "Hold and breathe.",
        "Return slowly and switch sides."
      ],
      focus: ["Small movements — the front of the neck is sensitive.", "The hand keeps the collarbone still."],
      mistakes: ["Cranking the head far back.", "Holding the breath."],
      breathing: "Slow nasal breathing.",
      conditions: { tmj: "Keep the lips together and teeth apart; don't let the jaw jut forward as the head tilts." },
      why: "The SCM tightens with forward-head posture and is often involved in jaw and head pain."
    }
  },
  {
    id: "wallAngels",
    name: "Wall angels",
    family: "scapularMobility",
    patterns: ["mobility"],
    regions: ["upper-back", "shoulders", "thoracic"],
    roles: ["warmup", "activation", "mobility"],
    equipment: { all: ["wall"] },
    position: "standing",
    laterality: "bilateral",
    load: "none",
    dose: { type: "reps", range: [6, 10], secsPerRep: 5 },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Slide your arms up and down a wall while your back stays flat against it.",
      setup: [
        "Stand with your back against a wall, feet a small step forward.",
        "Head, upper back, and hips touch the wall; arms in a 'goalpost' shape against it."
      ],
      steps: [
        "Slide the arms up the wall as far as you can without the low back arching.",
        "Pause at the top.",
        "Slide the elbows back down toward your ribs, drawing the shoulder blades down.",
        "Repeat slowly."
      ],
      focus: ["Ribs down — the low back stays near the wall.", "Shoulder blades glide down on the way back."],
      mistakes: ["Arching the back to get the arms higher.", "Shrugging the shoulders to the ears.", "Poking the chin forward."],
      breathing: "Inhale as the arms rise, exhale as they come down.",
      conditions: { tmj: "Keep the back of the head on the wall without pressing, and let the jaw hang loose." },
      why: "Opens a desk-rounded upper back and trains the shoulder blades to sit where the neck doesn't have to compensate."
    }
  },
  {
    id: "doorwayPecStretch",
    name: "Doorway chest stretch",
    family: "chestStretch",
    patterns: ["mobility"],
    regions: ["chest", "shoulders"],
    roles: ["stretch", "mobility"],
    equipment: { all: ["wall"] },
    position: "standing",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [30, 45] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    tags: ["desk-relief"],
    text: {
      summary: "Forearm on a door frame, step through, and let the chest open.",
      setup: [
        "Stand in a doorway or next to a wall corner.",
        "Place your forearm on the frame with the elbow at shoulder height."
      ],
      steps: [
        "Step the same-side foot forward.",
        "Gently turn the chest away from the arm until you feel a stretch across the front of the shoulder.",
        "Hold and breathe.",
        "Step back out and switch sides."
      ],
      focus: ["The stretch is across the chest, not in the shoulder joint.", "Ribs stay down; don't arch the back."],
      mistakes: ["Letting the shoulder roll forward into the stretch.", "Placing the elbow too high."],
      breathing: "Slow nasal breaths into the stretched side.",
      conditions: { tmj: "Chin level and jaw loose — don't push the head forward." },
      why: "Opens the chest, which gets tight from sitting and pulls the shoulders and head forward."
    }
  },
  {
    id: "massageBallTraps",
    name: "Massage-ball trap release",
    family: "neckRelease",
    patterns: ["release"],
    regions: ["neck", "upper-back"],
    roles: ["jaw-care", "cooldown"],
    equipment: { all: ["massage-ball", "wall"] },
    position: "standing",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [30, 45] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Lean into a massage ball on a wall to release the upper traps and shoulder-blade area.",
      setup: [
        "Stand with your back to a wall.",
        "Place the ball between the wall and the muscle between your neck and shoulder blade."
      ],
      steps: [
        "Lean gently into the ball.",
        "Bend your knees slightly to roll it a few centimetres up and down.",
        "Pause on a tender spot and breathe until it eases.",
        "Switch to the other side when the timer says."
      ],
      focus: ["Moderate pressure — you should be able to breathe easily.", "Stay on muscle, never on the spine."],
      mistakes: ["Leaning in so hard you tense up.", "Rolling directly on the neck bones."],
      breathing: "Long exhales on tender spots.",
      conditions: { tmj: "Let the jaw hang; the traps and jaw often let go together." },
      why: "Releases the upper traps and shoulder-blade muscles that feed neck and jaw tension."
    }
  },
  {
    id: "massageBallJaw",
    name: "Massage-ball masseter release",
    family: "jawRelease",
    patterns: ["release"],
    regions: ["jaw"],
    roles: ["jaw-care"],
    equipment: { all: ["massage-ball"] },
    position: "seated",
    laterality: "unilateral",
    load: "none",
    dose: { type: "time", range: [30, 45] },
    conditions: { tmj: { clench: 0, neckLoad: 0, faceDown: false } },
    difficulty: 1,
    text: {
      summary: "Roll a soft massage ball over the masseter with light pressure from your palm.",
      setup: [
        "Sit with the teeth apart and the head supported if possible.",
        "Hold a soft ball against the masseter at the angle of the jaw."
      ],
      steps: [
        "Press the ball lightly into the muscle with your palm.",
        "Make slow, small circles.",
        "Pause on tight spots and let the jaw hang slightly open.",
        "Switch sides when the timer says."
      ],
      focus: [
        "Light pressure — the jaw is sensitive.",
        "Stay on the muscle, below the cheekbone and in front of the ear, not on the joint."
      ],
      mistakes: ["Using a hard ball with heavy pressure.", "Clenching against the ball."],
      breathing: "Slow nasal breathing.",
      conditions: { tmj: "Stop if you feel joint pain, clicking, or numbness." },
      why: "A deeper, steadier version of jaw self-massage for tight masseters."
    }
  },
]);
