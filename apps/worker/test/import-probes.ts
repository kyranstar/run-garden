/** The review-L C1 probes: COROS-imported runs whose structure the rule must not rewrite. Synthetic data only. */
/**
 * COROS-IMPORTED RUNS KEEP THE LENGTH ALONE (review-L C1): the coach session the plan-run path made from an import's
 * stages dropped COROS's own targets, read its distances as times at the session's average pace and its kinds as
 * intensities — and rewrote the athlete's own COROS session with it. The review's probes, each length only.
 */
export const IMPORT_PROBES = (wid: (n: number) => string) => {
  const st = (w: string, sid: string, ord: number, kind: string, o: Record<string, unknown> = {}) => ({
    id: `${w}:${sid}`, parentStageId: null as string | null, ord, kind, repeatCount: null as number | null, durationType: "time", durationSeconds: null as number | null,
    distanceMeters: null as number | null, label: null as string | null, targetType: null as string | null, targetLow: null as number | null, targetHigh: null as number | null,
    hrZone: null as number | null, ...o,
  });
  const time = (s: number) => ({ durationType: "time", durationSeconds: s });
  const dist = (m: number) => ({ durationType: "distance", distanceMeters: m });
  const pace = (lo: number, hi: number) => ({ targetType: "pace", targetLow: lo, targetHigh: hi });
  const w = [1, 2, 3, 4, 5, 6].map(wid);
  return [
    {
      name: "6 × 1 km with 400 m jogs", category: "quality", subtype: "intervals", seconds: 3600,
      stages: [
        st(w[0]!, "1", 1, "warmup", { ...dist(2000), label: "Warm Up" }),
        st(w[0]!, "2", 2, "repeat", { durationType: "none", repeatCount: 6 }),
        st(w[0]!, "3", 3, "work", { ...dist(1000), ...pace(230, 240), parentStageId: `${w[0]}:2`, label: "Run" }),
        st(w[0]!, "4", 4, "recovery", { ...dist(400), parentStageId: `${w[0]}:2`, label: "Recovery" }),
        st(w[0]!, "5", 5, "cooldown", { ...dist(2000), label: "Cool Down" }),
      ],
    },
    {
      name: "12 × 400 m at COROS's 3:30–3:40", category: "quality", subtype: "intervals", seconds: 3540,
      stages: [
        st(w[1]!, "1", 1, "warmup", time(900)),
        st(w[1]!, "2", 2, "repeat", { durationType: "none", repeatCount: 12 }),
        st(w[1]!, "3", 3, "work", { ...dist(400), ...pace(210, 220), parentStageId: `${w[1]}:2` }),
        st(w[1]!, "4", 4, "recovery", { ...time(90), parentStageId: `${w[1]}:2` }),
        st(w[1]!, "5", 5, "cooldown", time(600)),
      ],
    },
    {
      name: "an easy run with strides", category: "easy", subtype: null, seconds: 2160,
      stages: [
        st(w[2]!, "1", 1, "work", { ...time(1800), targetType: "heart_rate", hrZone: 2 }),
        st(w[2]!, "2", 2, "repeat", { durationType: "none", repeatCount: 4 }),
        st(w[2]!, "3", 3, "work", { ...time(15), parentStageId: `${w[2]}:2` }),
        st(w[2]!, "4", 4, "recovery", { ...time(75), parentStageId: `${w[2]}:2` }),
      ],
    },
    {
      name: "a tempo with an easy float", category: "quality", subtype: "tempo", seconds: 3300,
      stages: [
        st(w[3]!, "1", 1, "warmup", time(600)),
        st(w[3]!, "2", 2, "work", { ...time(900), ...pace(280, 290) }),
        st(w[3]!, "3", 3, "work", { ...time(300), ...pace(360, 380) }),
        st(w[3]!, "4", 4, "work", { ...time(900), ...pace(280, 290) }),
        st(w[3]!, "5", 5, "cooldown", time(600)),
      ],
    },
    {
      name: "a 3 × 20 min progression", category: "long", subtype: null, seconds: 3600,
      stages: [
        st(w[4]!, "1", 1, "work", { ...time(1200), ...pace(330, 340) }),
        st(w[4]!, "2", 2, "work", { ...time(1200), ...pace(310, 320) }),
        st(w[4]!, "3", 3, "work", { ...time(1200), ...pace(290, 300) }),
      ],
    },
    {
      // Its one stage keyed as a thread-coach block would be (`<row>:0`, ord 0): the row is an import all the same.
      name: "a single-stage easy run", category: "easy", subtype: null, seconds: 2400,
      stages: [{ ...st(w[5]!, "0", 0, "work", { ...time(2400), targetType: "heart_rate", hrZone: 2 }) }],
    },
  ];
};

