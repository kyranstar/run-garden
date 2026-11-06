# Self-release with a firm ball: what the evidence supports

Researched 2026-11-05. Feeds the library's ball moves (`packages/exercise-library/src/exercises/ball-release.ts`), the
cool-down's `lead` (`skeletons.ts`) and the coach's "Release" principle (`design-prompt.ts`).

**How far to trust this.** A research pass read the sources below. Five that decisions rest on were then checked against
the paper or its abstract: Wilke 2020, Konrad 2024, Nakamura 2021, Cheatham 2020 and Schafer 2026. The rest are as that
pass reported them. Nearly all the data are foam rollers in healthy young adults, so most of this extrapolates to a ball.
The site table's no-go zones are largely anatomical reasoning, and no site earns a "strong" grade.

## Bottom line

A ball is a short tool for mobility and soreness, not tissue repair or posture correction.

- **One session:** a large gain in range against doing nothing (SMD 0.74), no better than stretching (−0.02; Wilke 2020).
  It is mostly gone within 10 to 30 minutes (Nakamura 2021; Kelly 2016).
- **Regular use:** keeping range takes more than four weeks (Konrad 2024: about ES 1 beyond four weeks, about 0.2 and not
  significant within them). Stretching gets there sooner, and matches rolling beyond four weeks. The trials ran 60 to 180
  seconds a muscle, two or three times a week (Konrad 2022).
- **Harder isn't better:** pressures of 3.9, 6.2 and 8.2 out of 10 gave equal range (Grabow 2018). Roller density tied
  (Cheatham 2018), and a moderate ball slightly beat a hard one (Cheatham 2020).
- **A real hazard:** a lacrosse ball caused a radial nerve compression injury at the upper arm that needed surgery and had
  only partly recovered at 18 months (Schafer 2026, one case).

## "Fascial release" is the wrong name for it

Modelling puts a 1% change in fascia lata or plantar fascia well outside physiological force (Chaudhry 2008). Range rises
without a change in stiffness (Krause 2019; Nakamura 2021), sham rolling matches real rolling (Warneke 2023), and untreated
limbs gain too (Konrad 2023a). The effect looks mainly perceptual and neural, with thixotropy and hydration unproven as
drivers (Behm & Wilke 2019). Effects on a remote site appear acutely (Grieve 2015) but not after seven weeks' training
(Konrad 2023b), so treat the joint you want. The library says "release" for that reason, and its moves promise easier
range, not changed tissue.

## Rules the system applies

| Rule | Evidence | Where it lives |
|---|---|---|
| About 90 s a site is the working minimum; past 3 min adds nothing | 30 s nil, 90 s d=0.26, 300 s d=0.33 (Nakamura 2021); 2 min equalled 10 min (Hofer 2026); 120 s beat 60 s (Monteiro 2019) | `dose.range` [60, 120]: the engine plays the middle in a cool-down |
| After the work, or on its own | Before training: sprint g=0.28, strength g=0.12, jump −1.9% (Wiewelhove 2019), but later trials conflict (Aragão-Santos 2025; Heinke 2025; Grabow 2018; Chen 2026) | The cool-down's `lead`; only sites allowed before the work carry `mobility` |
| The low end or nothing before quality work | Running cost rose 6.2% (P=.052) and was normal by 3 h (Giovanelli 2018); others found better (Biscardi 2021) or no change (Stroiney 2020) | A release in prep plays the range's low end; coach principle |
| Roll first if both, and don't expect extra range | Rolling plus stretching adds no range over either alone (ES 0.03; Konrad 2021; Mohr 2014 disagrees) | The lead plays first, and the cool-down keeps its own stretches beside it |
| Moderate pressure | See above | Each move's text: 5 out of 10 at most |
| Stop for sharp, radiating, numb, tingling or dizzy | Case reports; Delphi consensus lists wounds and fractures as contraindications, DVT and local inflammation as cautions (Bartsch 2021) | Each move's `mistakes` |

Blood thinners got no consensus (Bartsch 2021), and professionals report hematomas (Bartsch 2025). The practical advice,
which is inference, is no hard ball on thinners without a clinician's say.

## Site by site

"Off" means after a session or on its own. "Warm" means at most 60 s a site, then ramp up.

| Site | Worth it? | When | Caution | Grade |
|---|---|---|---|---|
| Psoas or iliacus through the abdomen | **Skip** | – | Aorta, iliac vessels, bowel, femoral nerve; no self-ball trial found | Expert |
| Top of the thigh (rectus femoris) | Yes | Off | Stay below the hip crease | Moderate: +8.6° (Monteiro 2019) vs +1.9° (Vigotsky 2015), roller |
| TFL | Yes | Off, Warm | Bony front of the pelvis, trochanter | Weak |
| IT band | **Skip** | – | No stiffness change (Pepper 2021); Naderi 2026 disagrees | Weak |
| Glute max and med | Yes | Off, Warm | Sacrum, iliac crest | Weak |
| Piriformis and deep rotators | Yes | Off | Leg tingling: move off (sciatic) | Weak: 6.6 cm ball with a video +8 to 10° rotation, self-guided +1 to 2°, no untreated group (Cheatham 2020) |
| Adductors | Maybe | Off | High inner thigh vessels | Weak |
| QL and low back | **Skip the ball** | – | Kidney, low ribs, spine; renal infarct after deep massage (Truong 2026) | Weak |
| Hamstrings | Yes | Off | Back of the knee, sit bone | Moderate: chronic ES 0.65 (Konrad 2022) |
| Calves | Maybe | Off, Warm | Back of the knee; a hot, swollen calf needs a DVT check | Moderate acutely; chronic ES −0.02, so stretch instead (Konrad 2022) |
| Sole of the foot | Maybe | Off, Warm | Focal bone pain | Weak |
| Upper back, two balls | Yes | Any | Never on the spine | Expert |
| Between the shoulder blades | Yes | Any | Scapular edge | Weak (Amjad 2023) |
| Lats and teres | Maybe | Off | Armpit, back of the upper arm (Schafer 2026) | Expert |
| Chest (pec major) | Maybe | Off | Below the collarbone; a 2-min ball did nothing (Reiner 2023) | Weak |
| Pec minor | Skip | – | Brachial plexus, axillary vessels | Expert |
| Upper traps and levator | Maybe | Off | Muscle belly only | Weak (Niazi 2025) |
| Suboccipitals, two balls | Maybe | Off | Dizziness, vision change, new headache: stop (Bennani 2026) | Expert |
| Front and side of the neck | **No-go** | – | Carotid dissection after self-massage (Shibata 2023) | Case reports |
| Masseter and temporalis | **Skip the ball**; fingertips optional | Any | In front of the ear: an aneurysm linked to self-acupressure (Nagao 2026) | Weak (fingers), no trial (ball) |

## Goals

- **Running economy:** results conflict (see above), and less flexible runners were more economical (r=0.68, correlational;
  Jones 2002). Expect nothing reliable.
- **Race week and skiing:** no trials found. Adding no new sites in a race week is inference.
- **Posture:** corrective exercise moves kyphosis and neck angle (Khorramroo 2026, with self-release bundled in); no trial
  isolates a ball. Rows and extension do the changing.
- **Jaw (TMD):** the guideline favours CBT, postural and jaw exercise, and therapist trigger-point work (Yao 2023; Busse
  2023). Self-massage isn't separately evaluated (Bijelic 2026), and finger massage plus exercises added nothing to
  self-management at 10 weeks (De Nordenflycht 2024).

## Sources

Checked directly:

- Wilke 2020, Sports Med. https://pubmed.ncbi.nlm.nih.gov/31628662/
- Konrad 2024, Sports Med. https://pmc.ncbi.nlm.nih.gov/articles/PMC11393112/
- Nakamura 2021, JSSM. https://pmc.ncbi.nlm.nih.gov/articles/PMC7919347/
- Cheatham 2020, J Hum Kinet. https://pmc.ncbi.nlm.nih.gov/articles/PMC7052706/
- Schafer 2026, Ann Plast Surg. https://pubmed.ncbi.nlm.nih.gov/40600825/

As the research pass reported them:

- Konrad 2022, Sports Med. https://pmc.ncbi.nlm.nih.gov/articles/PMC9474417/
- Konrad 2021, JSSM. https://jssm.org/jssm-20-535.xml-abst
- Konrad 2023a, EJAP. https://pmc.ncbi.nlm.nih.gov/articles/PMC10191906/
- Konrad 2023b, EJAP. https://pmc.ncbi.nlm.nih.gov/articles/PMC10363033/
- Wiewelhove 2019, Front Physiol. https://pmc.ncbi.nlm.nih.gov/articles/PMC6465761/
- Warneke 2023, JSSM. https://pmc.ncbi.nlm.nih.gov/articles/PMC10244996/
- Kelly 2016, IJSPT. https://pmc.ncbi.nlm.nih.gov/articles/PMC4970845/
- Hofer 2026, Sports. https://pubmed.ncbi.nlm.nih.gov/42646892/
- Monteiro 2019, JBMT. https://pubmed.ncbi.nlm.nih.gov/31563372/
- Vigotsky 2015, PeerJ. https://pubmed.ncbi.nlm.nih.gov/26421244/
- Grabow 2018, JSCR. https://pubmed.ncbi.nlm.nih.gov/30152808/
- Cheatham 2018, IJSPT. https://pmc.ncbi.nlm.nih.gov/articles/PMC6044602/
- Aragão-Santos 2025, JSSM. https://pmc.ncbi.nlm.nih.gov/articles/PMC12418186/
- Heinke 2025, PeerJ. https://pmc.ncbi.nlm.nih.gov/articles/PMC12317690/
- Chen 2026, Front Physiol. https://pubmed.ncbi.nlm.nih.gov/42889499/
- Reiner 2023, JSSM. https://pmc.ncbi.nlm.nih.gov/articles/PMC9982538/
- Giovanelli 2018, IJSPP. https://pubmed.ncbi.nlm.nih.gov/29745784/
- Biscardi 2021, Top Exerc Sci Kinesiol. https://oasis.library.unlv.edu/scholarship_kin/vol2/iss1/4
- Stroiney 2020, IJES. https://pmc.ncbi.nlm.nih.gov/articles/PMC7039479/
- Mohr 2014, J Sport Rehabil. https://pubmed.ncbi.nlm.nih.gov/24458506/
- Jones 2002, IJSM. https://pubmed.ncbi.nlm.nih.gov/11774065/
- Khorramroo 2026, BMC Sports Sci Med Rehabil. https://pmc.ncbi.nlm.nih.gov/articles/PMC13326462/
- Yao 2023, BMJ. https://pubmed.ncbi.nlm.nih.gov/38101924/
- Busse 2023, BMJ. https://pubmed.ncbi.nlm.nih.gov/38101929/
- Bijelic 2026, J Oral Rehabil. https://pmc.ncbi.nlm.nih.gov/articles/PMC12705301/
- De Nordenflycht 2024, J Clin Exp Dent. https://pmc.ncbi.nlm.nih.gov/articles/PMC11310976/
- Nagao 2026, Surg Neurol Int. https://pubmed.ncbi.nlm.nih.gov/42232448/
- Chaudhry 2008, JAOA. https://pubmed.ncbi.nlm.nih.gov/18723456/
- Krause 2019, Hum Mov Sci. https://pubmed.ncbi.nlm.nih.gov/31499386/
- Behm & Wilke 2019, Sports Med. https://pubmed.ncbi.nlm.nih.gov/31256353/
- Grieve 2015, JBMT. https://pubmed.ncbi.nlm.nih.gov/26118527/
- Pepper 2021, IJSPT. https://pmc.ncbi.nlm.nih.gov/articles/PMC8169023/
- Naderi 2026, PLoS One. https://pmc.ncbi.nlm.nih.gov/articles/PMC13712515/
- Shibata 2023, Cureus. https://pmc.ncbi.nlm.nih.gov/articles/PMC10585418/
- Bennani 2026, Cureus. https://pubmed.ncbi.nlm.nih.gov/42605464/
- Truong 2026, Front Nephrol. https://pubmed.ncbi.nlm.nih.gov/41727343/
- Bartsch 2021, J Clin Med. https://pmc.ncbi.nlm.nih.gov/articles/PMC8622134/
- Bartsch 2025, Front Physiol. https://pmc.ncbi.nlm.nih.gov/articles/PMC12441024/
- Amjad 2023, J Orthop Surg Res. https://pmc.ncbi.nlm.nih.gov/articles/PMC10668497/
- Niazi 2025, Health Sci Rep. https://pmc.ncbi.nlm.nih.gov/articles/PMC12010563/
