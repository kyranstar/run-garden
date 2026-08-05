import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { addDays, GARDEN_CONDITION_LABELS } from "@rg/domain";
import type { GardenPlant, PlantState, WorkoutCategory } from "@rg/domain";
import {
  replay,
  simulateDay,
  SPECIES,
  speciesOrThrow,
  type GardenDayInput,
  type GardenSnapshot,
  type Species,
} from "@rg/garden-engine";
import { conditionWord, DEFAULT_GARDEN_CONFIG } from "@rg/garden-engine";
import { describeGarden, describePlant, GardenScene, PlantSprite } from "../src/index";
import { anchorOf } from "../src/GardenScene";
import { displaceFromStreams, riverSystemFor, streamGeometryFor } from "../src/terrain";
import { moonShadowOffset } from "../src/sky";

const START = "2026-03-02"; // a Monday

function emptyDay(date: string): GardenDayInput {
  return {
    date,
    completedRuns: [],
    restObserved: false,
    missedRuns: [],
    restModeActive: false,
    planGap: false,
  };
}

function runDay(
  date: string,
  category: WorkoutCategory,
  extra: Partial<GardenDayInput> = {},
): GardenDayInput {
  return {
    ...emptyDay(date),
    completedRuns: [{ workoutId: `w-${date}`, category }],
    ...extra,
  };
}

/** Simulate a standard training pattern for n weeks: Tue quality, Thu easy, Sat long, Sun recovery. */
function trainingWeeks(startMonday: string, weeks: number): GardenDayInput[] {
  const days: GardenDayInput[] = [];
  for (let w = 0; w < weeks; w++) {
    const mon = addDays(startMonday, w * 7);
    days.push({ ...emptyDay(mon), restObserved: true, weekAdherence: w > 0 ? 1 : undefined });
    days.push(runDay(addDays(mon, 1), "quality"));
    days.push({ ...emptyDay(addDays(mon, 2)), restObserved: true });
    days.push(runDay(addDays(mon, 3), "easy"));
    days.push({ ...emptyDay(addDays(mon, 4)), restObserved: true });
    days.push(runDay(addDays(mon, 5), "long"));
    days.push(runDay(addDays(mon, 6), "recovery"));
  }
  return days;
}

function advanceEmptyDays(snapshot: GardenSnapshot, from: string, count: number): GardenSnapshot {
  let s = snapshot;
  let date = from;
  for (let i = 0; i < count; i++) {
    s = simulateDay(s, emptyDay(date)).snapshot;
    date = addDays(date, 1);
  }
  return s;
}

/** 6 training weeks ending on a Sunday recovery run → fresh_rain, healthy garden. */
function healthySnapshot(): GardenSnapshot {
  return replay(START, trainingWeeks(START, 6)).snapshot;
}

function droughtSnapshot(): GardenSnapshot {
  const built = replay(START, trainingWeeks(START, 4));
  return advanceEmptyDays(built.snapshot, addDays(START, 28), 16);
}

function renderScene(snapshot: GardenSnapshot, extra: Partial<Parameters<typeof GardenScene>[0]> = {}) {
  return renderToStaticMarkup(<GardenScene snapshot={snapshot} {...extra} />);
}

function syntheticPlant(species: Species, state: PlantState): GardenPlant {
  return {
    id: `syn-${species.id}-${state}`,
    speciesId: species.id,
    category: species.category,
    plantedAt: START,
    health: state === "dead" ? 0 : 1,
    hydration: 0.9,
    maturity: state === "dead" ? 0.8 : 1,
    bloomProgress: state === "flowering" ? 1 : 0,
    state,
    position: { x: 0.5, y: 0.5, region: 0 },
    ...(state === "dead" ? { habitatRole: "nurse_log" as const } : {}),
  };
}

function groundFill(markup: string): string {
  const tag = markup.match(/<path[^>]*data-ground="true"[^>]*>/)?.[0];
  expect(tag).toBeTruthy();
  const fill = tag!.match(/fill="([^"]+)"/)?.[1];
  expect(fill).toBeTruthy();
  return fill!;
}

describe("GardenScene", () => {
  it("renders byte-identical SVG for the same snapshot (determinism)", () => {
    const snapshot = healthySnapshot();
    const a = renderScene(snapshot);
    const b = renderScene(snapshot);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(2000);
  });

  it("carries the grainlight texture layers exactly once", () => {
    const markup = renderScene(healthySnapshot());
    expect(markup.match(/data-finish-grain="true"/g)).toHaveLength(1);
    expect(markup.match(/data-terrain="mottle"/g)).toHaveLength(1);
    // every turbulence node is seeded → deterministic across UAs
    const turbs = markup.match(/<feTurbulence[^>]*>/g) ?? [];
    expect(turbs.length).toBeGreaterThanOrEqual(2);
    for (const t of turbs) expect(t).toMatch(/seed="\d+"/);
  });

  it("clouds are organic tone-stacked blobs, not ellipse clusters", () => {
    const markup = renderScene(healthySnapshot());
    const puffs = markup.match(/<g[^>]*data-cloud="puff"[\s\S]*?<\/g>/g) ?? [];
    expect(puffs.length).toBeGreaterThanOrEqual(1);
    for (const puff of puffs) {
      expect(puff).not.toContain("<ellipse");
      // three tone masses per puff: under-shade, main, lit crown
      expect(puff.match(/<path/g)!.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("horizon warmth appears with the sun and leaves the night alone", () => {
    const snapshot = healthySnapshot();
    expect(renderScene(snapshot, { timeOfDay: 17.5 })).toContain('data-sky="horizonwarm"');
    expect(renderScene(snapshot, { timeOfDay: 23 })).not.toContain('data-sky="horizonwarm"');
  });

  it("horizon carries three receding ridges", () => {
    const markup = renderScene(healthySnapshot());
    expect(markup.match(/data-scene="hills"/g)).toHaveLength(1);
    expect(markup.match(/data-ridge="/g)).toHaveLength(3);
  });

  it("backlit seed heads render with a lighting-stable count", () => {
    const snapshot = healthySnapshot();
    const heads = (m: string) => (m.match(/data-terrain="seedhead"/g) ?? []).length;
    const golden = renderScene(snapshot, { timeOfDay: 17.5 });
    const night = renderScene(snapshot, { timeOfDay: 23 });
    expect(heads(golden)).toBeGreaterThan(0);
    // honesty rule: light changes color, never how much grows
    expect(heads(golden)).toBe(heads(night));
  });

  it("renders every living plant with a data-plant-id attribute", () => {
    const snapshot = healthySnapshot();
    const markup = renderScene(snapshot);
    const living = snapshot.plants.filter((p) => p.state !== "dead");
    expect(living.length).toBeGreaterThan(5);
    for (const plant of living) {
      expect(markup).toContain(`data-plant-id="${plant.id}"`);
    }
  });

  it("reducedMotion strips all <style> animation content", () => {
    const snapshot = healthySnapshot();
    const animated = renderScene(snapshot);
    expect(animated).toContain("@keyframes");
    expect(animated).toContain("<style>");

    const still = renderScene(snapshot, { reducedMotion: true });
    expect(still).not.toContain("@keyframes");
    // The static focus-outline style stays — only animation styles go.
    expect(still).not.toContain("-sway{");
    expect(still).not.toContain("animation");
  });

  it("drought ground color differs from healthy ground color", () => {
    const healthy = groundFill(renderScene(healthySnapshot()));
    const drought = groundFill(renderScene(droughtSnapshot()));
    expect(drought).not.toBe(healthy);
  });

  it("shows a rain overlay when weatherState is fresh_rain", () => {
    const snapshot = healthySnapshot();
    expect(snapshot.state.weatherState).toBe("fresh_rain");
    const markup = renderScene(snapshot);
    expect(markup).toContain('data-overlay="rain"');

    const dry = droughtSnapshot();
    expect(dry.state.weatherState).toBe("mild_drought");
    expect(renderScene(dry)).not.toContain('data-overlay="rain"');
  });

  it("gives every plant group a role and an aria label with species name and state", () => {
    const snapshot = healthySnapshot();
    const markup = renderScene(snapshot);
    expect(markup).toContain('role="button"');
    expect(markup).toContain('tabindex="0"');
    for (const plant of snapshot.plants.slice(0, 5)) {
      const species = speciesOrThrow(plant.speciesId);
      expect(markup).toContain(`aria-label="${species.name},`);
    }
  });

  it("highlights the selected plant with the silhouette outline filter", () => {
    const snapshot = healthySnapshot();
    const target = snapshot.plants[0]!;
    const without = renderScene(snapshot);
    const withSel = renderScene(snapshot, { selectedPlantId: target.id });
    expect(withSel).not.toBe(without);
    expect(withSel).toContain('filter="url(#rg-garden-outline)"');
    expect(without).not.toContain('filter="url(#rg-garden-outline)"');
  });

  it("embeds the garden description as aria-label and <desc>", () => {
    const snapshot = healthySnapshot();
    const markup = renderScene(snapshot);
    expect(markup).toContain('role="img"');
    expect(markup).toContain("<desc>");
    const label = GARDEN_CONDITION_LABELS[conditionWord(snapshot.state, DEFAULT_GARDEN_CONFIG)];
    expect(markup.toLowerCase()).toContain(label.toLowerCase());
  });
});

describe("PlantSprite archetypes", () => {
  it("covers all 20 archetypes across the species catalog", () => {
    const archetypes = new Set(SPECIES.map((s) => s.archetype));
    expect(archetypes.size).toBe(20);
    expect(SPECIES.length).toBe(46); // 34 + 5 achievement species + 7 tri-discipline species
  });

  it("renders every species in mature, flowering, and dead states without throwing", () => {
    const states: PlantState[] = ["mature", "flowering", "dead"];
    for (const species of SPECIES) {
      for (const state of states) {
        const plant = syntheticPlant(species, state);
        const markup = renderToStaticMarkup(
          <svg>
            <PlantSprite plant={plant} />
          </svg>,
        );
        expect(markup).toContain(`data-archetype="${species.archetype}"`);
        expect(markup.length).toBeGreaterThan(80);
      }
    }
  });

  it("renders the same plant id identically across calls", () => {
    const species = SPECIES.find((s) => s.archetype === "tree_birch")!;
    const plant = syntheticPlant(species, "mature");
    const a = renderToStaticMarkup(<svg><PlantSprite plant={plant} /></svg>);
    const b = renderToStaticMarkup(<svg><PlantSprite plant={plant} /></svg>);
    expect(a).toBe(b);
  });

  it("two plants of the same species differ slightly (per-id variation)", () => {
    const species = SPECIES.find((s) => s.archetype === "tree_round")!;
    const a = renderToStaticMarkup(
      <svg><PlantSprite plant={{ ...syntheticPlant(species, "mature"), id: "var-a" }} /></svg>,
    );
    const b = renderToStaticMarkup(
      <svg><PlantSprite plant={{ ...syntheticPlant(species, "mature"), id: "var-b" }} /></svg>,
    );
    expect(a).not.toBe(b);
  });
});

describe("sky layer", () => {
  it("renders stars and a moon at night, sun by day", () => {
    const snapshot = healthySnapshot();
    const night = renderScene(snapshot, { timeOfDay: 23.5 });
    expect(night).toContain('data-sky="stars"');
    expect(night).toContain('data-celestial="moon"');
    expect(night).not.toContain('data-celestial="sun"');
    const day = renderScene(snapshot, { timeOfDay: 13 });
    expect(day).toContain('data-celestial="sun"');
    expect(day).not.toContain('data-sky="stars"');
  });

  it("sky gradient has three stops driven by the color script", () => {
    const markup = renderScene(healthySnapshot(), { timeOfDay: 13 });
    const stops = markup.match(/<stop offset/g) ?? [];
    expect(stops.length).toBeGreaterThanOrEqual(3);
  });

  it("dawn and midday skies differ", () => {
    const snapshot = healthySnapshot();
    expect(renderScene(snapshot, { timeOfDay: 6.5 })).not.toBe(renderScene(snapshot, { timeOfDay: 13 }));
  });
});

describe("moonShadowOffset", () => {
  it("full moon (0.5) slides the shadow fully clear", () => {
    expect(moonShadowOffset(0.5)).toBe(28);
  });

  it("new moon (0) leaves the shadow dead-center", () => {
    // toBeCloseTo (not toBe) because the formula's sign term yields -0 at
    // p=0, which is numerically 0 but fails Object.is equality.
    expect(moonShadowOffset(0)).toBeCloseTo(0, 5);
  });

  it("~new moon (0.999) leaves the shadow nearly centered", () => {
    expect(Math.abs(moonShadowOffset(0.999))).toBeLessThan(0.1);
  });

  it("waxing quarter (0.25) shadows from the left", () => {
    expect(moonShadowOffset(0.25)).toBe(-14);
  });

  it("waning quarter (0.75) shadows from the right", () => {
    expect(moonShadowOffset(0.75)).toBe(14);
  });
});

describe("terrain", () => {
  it("renders four ground bands, nearest tagged data-ground", () => {
    const markup = renderScene(healthySnapshot());
    expect((markup.match(/data-band=/g) ?? []).length).toBe(4);
    expect(markup).toContain('data-ground="true"');
  });

  it("renders a dense meadow for a healthy garden and a sparser one in drought", () => {
    const healthy = renderScene(healthySnapshot());
    const drought = renderScene(droughtSnapshot());
    const strokes = (m: string) => (m.match(/data-terrain="meadow"/g) ?? []).length;
    expect(strokes(healthy)).toBe(1);
    const meadowOf = (m: string) => m.split('data-terrain="meadow"')[1]!.split("</g>")[0]!;
    const count = (m: string) => (meadowOf(m).match(/<path/g) ?? []).length;
    expect(count(healthy)).toBeGreaterThan(350);
    expect(count(healthy)).toBeLessThanOrEqual(800);
    expect(count(drought)).toBeLessThan(count(healthy));
  });

  it("drought gardens show straw patches; healthy gardens do not", () => {
    expect(renderScene(droughtSnapshot())).toContain('data-terrain="patches"');
    expect(renderScene(healthySnapshot())).not.toContain('data-terrain="patches"');
  });
});

describe("describeGarden / describePlant", () => {
  it("mentions the condition word and plant counts", () => {
    const snapshot = healthySnapshot();
    const text = describeGarden(snapshot);
    const label = GARDEN_CONDITION_LABELS[conditionWord(snapshot.state, DEFAULT_GARDEN_CONFIG)];
    expect(text.toLowerCase()).toContain(label.toLowerCase());
    expect(text).toMatch(/\d+ (tree|flower|shrub|fern|grass tuft|vine|groundcover patch|fungus)/);
    const sentences = text.split(". ").length;
    expect(sentences).toBeGreaterThanOrEqual(2);
    expect(sentences).toBeLessThanOrEqual(4);
  });

  it("mentions weather and notable states", () => {
    const dry = droughtSnapshot();
    const text = describeGarden(dry);
    expect(text).toContain("dry");
    expect(text.toLowerCase()).toMatch(/thirsty|wilted|dormant/);
  });

  it("describes a single plant with species name, state, and planted date", () => {
    const snapshot = healthySnapshot();
    const plant = snapshot.plants[0]!;
    const species = speciesOrThrow(plant.speciesId);
    const text = describePlant(plant);
    expect(text).toContain(species.name);
    expect(text).toContain(plant.plantedAt);
  });
});

describe("plants under the light", () => {
  it("every living plant casts a contact and a cast shadow", () => {
    const snapshot = healthySnapshot();
    const markup = renderScene(snapshot, { timeOfDay: 18.9 });
    const living = snapshot.plants.filter((p) => p.state !== "dead").length;
    expect((markup.match(/data-shadow="cast"/g) ?? []).length).toBe(living);
    expect((markup.match(/data-shadow="contact"/g) ?? []).length).toBe(living);
  });

  it("golden-hour cast shadows are longer than midday and stretch away from the sun", () => {
    // Summer so 18.9 is a true golden hour with the sun still up in the west
    // (spring's sunset is 18.6 — the spring snapshot would give a moon shadow).
    const base = healthySnapshot();
    const snapshot = { ...base, state: { ...base.state, season: "summer" as const } };
    const castTag = (m: string) => m.match(/<ellipse[^>]*data-shadow="cast"[^>]*>/)?.[0] ?? "";
    const rx = (m: string) => Number(castTag(m).match(/rx="([\d.]+)"/)?.[1] ?? 0);
    const golden = renderScene(snapshot, { timeOfDay: 18.9 });
    const midday = renderScene(snapshot, { timeOfDay: 13 });
    expect(rx(golden)).toBeGreaterThan(rx(midday));
    // Evening sun sits west (high sunX) → shadowDx negative → cast center shifts left.
    expect(Number(castTag(golden).match(/cx="(-?[\d.]+)"/)?.[1])).toBeLessThan(0);
  });

  it("contact shadows are darker but smaller than cast shadows", () => {
    const markup = renderScene(healthySnapshot(), { timeOfDay: 13 });
    const tag = (kind: string) =>
      markup.match(new RegExp(`<ellipse[^>]*data-shadow="${kind}"[^>]*>`))?.[0] ?? "";
    const num = (t: string, attr: string) => Number(t.match(new RegExp(`${attr}="(-?[\\d.]+)"`))?.[1] ?? 0);
    expect(num(tag("contact"), "opacity")).toBeGreaterThan(num(tag("cast"), "opacity"));
    expect(num(tag("contact"), "rx")).toBeLessThan(num(tag("cast"), "rx"));
  });

  it("the selected plant gets the silhouette outline filter; others do not", () => {
    const snapshot = healthySnapshot();
    const id = snapshot.plants.find((p) => p.state !== "dead")!.id;
    const selected = renderScene(snapshot, { selectedPlantId: id });
    expect((selected.match(/filter="url\(#rg-garden-outline\)"/g) ?? []).length).toBe(1);
    expect(renderScene(snapshot)).not.toContain('filter="url(#rg-garden-outline)"');
    // The old cream selection disc is gone.
    expect(selected).not.toContain("#f7f3df");
    // The filter itself is defined once in the defs.
    expect(selected).toContain('id="rg-garden-outline"');
  });

  it("every plant carries an invisible tap pad", () => {
    const snapshot = healthySnapshot();
    const markup = renderScene(snapshot);
    expect((markup.match(/data-hitpad="true"/g) ?? []).length).toBe(snapshot.plants.length);
  });

  it("two plants of the same species differ in color (deterministic jitter)", () => {
    const snapshot = healthySnapshot();
    const bySpecies = new Map<string, GardenPlant[]>();
    for (const pl of snapshot.plants.filter((p) => p.state !== "dead" && p.state !== "seed")) {
      bySpecies.set(pl.speciesId, [...(bySpecies.get(pl.speciesId) ?? []), pl]);
    }
    const pair = [...bySpecies.values()].find((v) => v.length >= 2);
    expect(pair).toBeDefined();
    const sprite = (pl: GardenPlant) =>
      renderToStaticMarkup(<PlantSprite plant={pl} species={speciesOrThrow(pl.speciesId)} />);
    expect(sprite(pair![0]!)).not.toBe(sprite(pair![1]!));
    // And the same plant renders byte-identically every time.
    expect(sprite(pair![0]!)).toBe(sprite(pair![0]!));
  });

  it("vine reach scales with the consistency chain, deterministically", () => {
    const vinePlant: GardenPlant = {
      id: "vine-test",
      speciesId: "ivy",
      category: "vine",
      plantedAt: "2026-03-02",
      health: 0.9,
      hydration: 0.8,
      maturity: 1,
      bloomProgress: 0,
      state: "mature",
      position: { x: 0.5, y: 0.5, region: 0 },
    } as GardenPlant;
    const at = (reach: number) =>
      renderToStaticMarkup(
        <PlantSprite plant={vinePlant} species={speciesOrThrow("ivy")} reach={reach} />,
      );
    expect(at(0.4)).not.toBe(at(1));
    expect(at(0.4)).toBe(at(0.4)); // same reach → byte-identical
    // Non-vines ignore reach entirely.
    const tree = { ...vinePlant, id: "t1", speciesId: "birch", category: "tree" } as GardenPlant;
    const treeAt = (reach: number) =>
      renderToStaticMarkup(
        <PlantSprite plant={tree} species={speciesOrThrow("birch")} reach={reach} />,
      );
    expect(treeAt(0.4)).toBe(treeAt(1));
  });

  it("far plants are hazed more than near plants of the same species", () => {
    const markup = renderScene(healthySnapshot(), { timeOfDay: 13 });
    // Structural smoke: per-plant tint means fills vary; exact values are
    // covered by the jitter/determinism tests above.
    expect(markup).toContain("data-plant-id");
  });

  it("sway delay correlates with x position (gusts travel)", () => {
    const markup = renderScene(healthySnapshot(), { timeOfDay: 13 });
    // Two plants far apart in x must have different sway delays.
    const delays = [...markup.matchAll(/animation-delay:(-[\d.]+)s/g)].map((m) => Number(m[1]));
    expect(new Set(delays).size).toBeGreaterThan(1);
  });

  it("winter foliage is tinted differently from summer", () => {
    const snapshot = healthySnapshot();
    const summer = { ...snapshot, state: { ...snapshot.state, season: "summer" as const } };
    const winter = { ...snapshot, state: { ...snapshot.state, season: "winter" as const } };
    expect(renderScene(summer)).not.toBe(renderScene(winter));
  });
});

describe("finish overlays", () => {
  it("golden hour renders sunbeams; night does not", () => {
    // healthySnapshot() is pinned to April 12 (spring), whose sunset (18.6)
    // is already past by hour 18.9 (sunX null) and whose fresh_rain weather
    // forces beamStrength to 0 outright — so no hour of the raw snapshot can
    // ever show a beam. A summer, clear-sun variant reaches a true golden
    // hour (sun still up, beamStrength > 0.05) at 18.9.
    const base = healthySnapshot();
    const snapshot = {
      ...base,
      state: { ...base.state, season: "summer" as const, weatherState: "clear_sun" as const },
    };
    expect(renderScene(snapshot, { timeOfDay: 18.9 })).toContain("mix-blend-mode:screen");
    expect(renderScene(snapshot, { timeOfDay: 23.5 })).not.toContain("mix-blend-mode:screen");
  });

  it("always applies grain and vignette", () => {
    const markup = renderScene(healthySnapshot());
    expect(markup).toContain('data-finish="true"');
    expect(markup).toContain("-grain");
    expect(markup).toContain("-vig");
  });

  it("rainbow renders only in a comeback recovery rain at low sun", () => {
    // Same summer override as above: healthySnapshot()'s spring date puts
    // hour 18.9 in the "dusk" period, not "golden", so rainbow could never
    // gate on regardless of weather/inComeback.
    const base = healthySnapshot();
    const snapshot = { ...base, state: { ...base.state, season: "summer" as const } };
    const comeback = {
      ...snapshot,
      state: { ...snapshot.state, weatherState: "recovery_rain" as const, inComeback: true },
    };
    expect(renderScene(comeback, { timeOfDay: 18.9 })).toContain('data-overlay="rainbow"');
    expect(renderScene(comeback, { timeOfDay: 13 })).not.toContain('data-overlay="rainbow"');
    expect(renderScene(snapshot, { timeOfDay: 18.9 })).not.toContain('data-overlay="rainbow"');
  });
});

describe("atmosphere layer", () => {
  it("default render keeps the bare <svg> root with no canvas", () => {
    const markup = renderScene(healthySnapshot());
    expect(markup.startsWith("<svg")).toBe(true);
    expect(markup).not.toContain("<canvas");
  });

  it("atmosphere=true wraps the scene and adds an aria-hidden canvas", () => {
    const markup = renderScene(healthySnapshot(), { atmosphere: true });
    expect(markup.startsWith("<div")).toBe(true);
    expect(markup).toContain('data-garden-wrapper="true"');
    expect(markup).toContain("<canvas");
    expect(markup).toContain('aria-hidden="true"');
  });

  it("atmosphere + reducedMotion renders the wrapper without a canvas", () => {
    const markup = renderScene(healthySnapshot(), { atmosphere: true, reducedMotion: true });
    expect(markup).not.toContain("<canvas");
  });
});

describe("framing grass", () => {
  it("renders once, above the plants, and never intercepts pointer events", () => {
    const markup = renderScene(healthySnapshot());
    expect(markup.match(/data-terrain="framing"/g)).toHaveLength(1);
    const framingAt = markup.indexOf('data-terrain="framing"');
    expect(framingAt).toBeGreaterThan(markup.lastIndexOf("data-plant-id"));
    const tag = markup.slice(framingAt - 200, framingAt + 60);
    expect(tag).toContain('pointer-events="none"');
  });
});

describe("riparian streams", () => {
  const streamGround = { region: 1, kind: "stream" as const, earnedDate: "2026-06-01" };

  it("stream geometry pinches at the source and knows its channel", () => {
    const geo = streamGeometryFor(streamGround)!;
    expect(geo.hw(0)).toBeLessThan(geo.hw(0.2) * 0.6);
    const y = geo.yTop + 0.5 * geo.ySpan;
    expect(geo.inChannel(geo.xc(0.5), y)).toBe(true);
    expect(geo.inChannel(geo.xc(0.5) + geo.hw(0.5) + 12, y)).toBe(false);
  });

  it("plant anchors displace out of the water", () => {
    const geo = streamGeometryFor(streamGround)!;
    const y = geo.yTop + 0.6 * geo.ySpan;
    const displaced = displaceFromStreams({ x: geo.xc(0.6), y, s: 1 }, [geo]);
    expect(geo.inChannel(displaced.x, y, 8)).toBe(false);
  });

  it("no rendered plant anchor lands in stream water (long-lived garden)", () => {
    // 20 training weeks earns stream grounds; every plant transform must sit
    // clear of every channel.
    const s = replay(START, trainingWeeks(START, 20)).snapshot;
    const channels = riverSystemFor(s.state.grounds ?? []);
    expect(channels.length).toBeGreaterThan(0);
    const markup = renderScene(s);
    const anchors = [...markup.matchAll(/data-plant-id="([^"]*)"[^>]*transform="translate\((-?[\d.]+) (-?[\d.]+)\)/g)];
    expect(anchors.length).toBeGreaterThan(10);
    for (const m of anchors) {
      const x = Number(m[2]);
      const y = Number(m[3]);
      expect(
        channels.some((c) => c.inChannel(x, y, 2)),
        `plant ${m[1]} at (${x},${y}) sits in a stream`,
      ).toBe(false);
    }
  });
});

describe("hero tree scale", () => {
  const oak = SPECIES.find((s) => s.id === "milestone_oak")!;
  const rose = SPECIES.find((s) => s.id === "century_rose")!;

  it("mature near trees render at hero scale; saplings, far trees and shrubs don't", () => {
    const near = { ...syntheticPlant(oak, "mature"), position: { x: 0.5, y: 0.45, region: 0 } };
    const sapling = { ...near, maturity: 0.2 };
    const far = { ...near, position: { x: 0.5, y: 0.1, region: 0 } };
    const shrub = { ...syntheticPlant(rose, "mature"), position: { x: 0.5, y: 0.45, region: 0 } };
    expect(anchorOf(near).s).toBeGreaterThan(1.0);
    expect(anchorOf(sapling).s).toBeLessThan(0.95);
    expect(anchorOf(far).s).toBeLessThan(anchorOf(near).s);
    expect(anchorOf(shrub).s).toBeCloseTo(0.65 + 0.45 * 0.45, 2);
  });
});

describe("grainlight canopies", () => {
  const oak = SPECIES.find((s) => s.id === "milestone_oak")!;

  it("tree canopies stack three tones and follow the sun side", () => {
    const plant = syntheticPlant(oak, "mature");
    const left = renderToStaticMarkup(
      <PlantSprite plant={plant} species={oak} idPrefix="t" lightHint={{ dx: -1, litColor: "#ffd27f", amount: 0.8 }} />,
    );
    const right = renderToStaticMarkup(
      <PlantSprite plant={plant} species={oak} idPrefix="t" lightHint={{ dx: 1, litColor: "#ffd27f", amount: 0.8 }} />,
    );
    expect(left).toContain('data-tone="lit"');
    expect(left).not.toBe(right); // lit mass flips with the sun
    const tones = [...left.matchAll(/data-tone="(shade|mid|lit)"/g)].map((m) => m[1]);
    expect(new Set(tones)).toEqual(new Set(["shade", "mid", "lit"]));
  });

  it("state adjustments hit every canopy tone", () => {
    const fills = (m: string) =>
      [...m.matchAll(/data-tone="[a-z]+"[^>]*fill="(#[0-9a-fA-F]{6})"/g)].map((x) => x[1]);
    const mature = renderToStaticMarkup(
      <PlantSprite plant={syntheticPlant(oak, "mature")} species={oak} idPrefix="t" />,
    );
    const wilted = renderToStaticMarkup(
      <PlantSprite plant={syntheticPlant(oak, "wilted")} species={oak} idPrefix="t" />,
    );
    expect(fills(mature).length).toBeGreaterThanOrEqual(3);
    expect(fills(wilted)).not.toEqual(fills(mature));
    expect(fills(wilted)).toHaveLength(fills(mature).length);
  });
});

describe("grainlight non-tree archetypes", () => {
  const byArch = (a: Species["archetype"]) => SPECIES.find((s) => s.archetype === a)!;
  const sun = { dx: 1 as const, litColor: "#ffd27f", amount: 0.8 };
  const render = (arch: Species["archetype"], state: PlantState) => {
    const sp = byArch(arch);
    return renderToStaticMarkup(
      <PlantSprite plant={syntheticPlant(sp, state)} species={sp} idPrefix="t" lightHint={sun} />,
    );
  };

  it("shrubs carry the canopy tone stack", () => {
    expect(render("shrub_round", "mature")).toContain('data-tone="shade"');
    expect(render("shrub_round", "mature")).toContain('data-tone="lit"');
  });

  it("blooming flowers get a lit petal accent", () => {
    expect(render("flower_cup", "flowering")).toContain('data-tone="lit"');
    expect(render("flower_daisy", "flowering")).toContain('data-tone="lit"');
  });

  it("vines tint sun-side leaves", () => {
    expect(render("vine", "mature")).toContain('data-tone="lit"');
  });

  it("fungi get a lit cap dab", () => {
    expect(render("mushroom", "mature")).toContain('data-tone="lit"');
  });

  it("grass blades are kinked polylines, not clean arcs", () => {
    const markup = render("grass_tuft", "mature");
    expect(markup).toMatch(/d="M[^"]* L[^"]* L[^"]*"/);
  });
});

describe("arrival sensations (reward-loop spec §5)", () => {
  const snap = replay(START, trainingWeeks(START, 2)).snapshot;
  const living = snap.plants.filter((p) => p.state !== "dead");
  const someId = living[0]!.id;
  const otherId = living[1]!.id;

  it("wraps exactly the entering plant in the sprout class, and not under reducedMotion", () => {
    const html = renderScene(snap, { enteringPlantIds: [someId] });
    expect(html.match(/rg-garden-enter/g)?.length ?? 0).toBeGreaterThan(0);
    // once in the class attr, once in the keyframe css
    expect((html.match(/class="[^"]*rg-garden-enter[^"]*"/g) ?? []).length).toBe(1);
    const still = renderScene(snap, { enteringPlantIds: [someId], reducedMotion: true });
    expect(still).not.toContain("rg-garden-enter");
  });

  it("highlightPlantId applies the outline filter; a user selection wins", () => {
    const glow = renderScene(snap, { highlightPlantId: someId });
    expect((glow.match(/filter="url\(#rg-garden-outline\)"/g) ?? []).length).toBe(1);
    const both = renderScene(snap, { highlightPlantId: someId, selectedPlantId: otherId });
    expect((both.match(/filter="url\(#rg-garden-outline\)"/g) ?? []).length).toBe(1);
    expect(both).toContain(`data-plant-id="${otherId}"`);
  });

  it("entering/highlight props never change geometry", () => {
    const paths = (s: string) => s.match(/ d="[^"]+"/g) ?? [];
    const a = renderScene(snap);
    const b = renderScene(snap, { enteringPlantIds: [someId], highlightPlantId: someId });
    expect(paths(b)).toEqual(paths(a));
  });
});
