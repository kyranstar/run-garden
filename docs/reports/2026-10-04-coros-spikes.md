# COROS spikes: strength lap payload and unmapped moves (2026-10-04)

Two owner-approved probes run once against the production account from the owner's signed-in browser, after the
Phase 0 deploy. Only key names and our own test strings are recorded here — no values from the account.

## 1. Lap payload (read-only, masked)

`GET /api/coros/debug/lap-keys?days=60` probed the 3 strength activities in the window and returned only the key
skeleton.

**Strength activities carry per-set performance data.** Each `lapList[].lapItemList[]` item has, among others:
`exerciseId`, `exerciseIndex`, `exerciseNameKey`, `exerciseType`, `setIndex`, `sets`, `targetSets`, `reps`,
`weight`, `targetType`, `targetValue`, `intensityType`, `intensityValue`, `intensityValueExtend`,
`intensityMultiplier`, `intensityCustom`, `intensityDisplayUnit`, `lapType`, `lapTrainIndex`,
`programExerciseIndex`, `indexInOriginLap`, `pauseTime`. The activity summary has `exercises`, `sets`,
`totalReps`, `totalWeight`.

**Consequence.** The 2026-09-20 spec's "known ceiling" (no reps or load from COROS) is wrong. `normalizeCorosLaps`
drops these fields today. Phase 3 should (a) store per-set reps/weight/setIndex/exerciseId from laps, (b) prefill the
post-watch quick review from them, and (c) feed logged strength from watch-only sessions. Whether the values are
populated depends on what the athlete enters on the watch; a follow-up probe should report, as counts only, how many
lap items carry non-zero reps and weight.

**What the lap fields mean (Phase 2a+, settled by masked counts-only probe runs, 2026-10-06).** `weight` is kilograms ×
1000 (grams), the program wire's own scale. A weight typed in pounds on the watch arrives as the exact grams of that
many pounds, so a weight within 0.02 lb of a whole pound or a 2.5 lb step that is not a whole kilogram is read as
typed in pounds. `intensityValue` is not the same quantity as `weight`, and the summary's `totalWeight` is not the sum
of reps × weight; neither is used. Every item appears under two `lapType` codes that carry the same sets, so only the
lowest code is read. Within it, items group by (`exerciseIndex`, `setIndex`): each item with reps or weight is one set
(a group can hold two, one per side), a following item with neither is that set's rest, and a group with neither is a
single timed set (a hold) taken from its first item. `time` is in hundredths of a second. `exerciseId` is not an
exercise's identity (one value spans several exercises); `exerciseNameKey`, the COROS i18n key the exercise catalog's
`name` also carries, is.

## 2. Unmapped moves (one stamped test workout, created, read back, deleted)

`POST /api/coros/spike/unmapped-moves` wrote one strength program stamped `RG SPIKE — SAFE TO DELETE <date>` 14 days
out, read it back directly from COROS, and deleted it; a cleanup call afterwards found none remaining.

| Step | Sent | Stored by COROS |
|---|---|---|
| a | `originId "0"`, name "Chin tuck hold", 30 s hold | kept exactly (name, originId, target) |
| b | generic catalog Training step, renamed "Chin tuck hold (generic)", 30 s | kept the custom name |
| c | catalog exercise with overview "cue: long neck", 8 reps | kept the overview |
| d | per-side pair | kept (see the endpoint test for the pair shape) |

**Result: spike outcome A** (programme Phase 3 spec §3). Moves the COROS catalog does not know can go to the watch as
`originId "0"` steps carrying their real names, with cues in the step overview. Still to confirm in Phase 3: what the
watch itself displays for such a step after a phone sync (the owner looks once at a real pushed session).
