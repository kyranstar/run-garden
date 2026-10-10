import { describe, expect, test } from "vitest";
import { CONTRACTIONS, FORMAT_IDS, GLOSSARY, MUSCLES, PURPOSES, REGIONS, TAGS } from "../src/index.js";

// The glossary (Stage 2 spec §5): one plain sentence per vocabulary id, so a tooltip in the Studio and the coach
// explain a term alike. Plain means no technical word in the sentence that explains a term.

/** The words of a workout document the builder shows (part purposes, formats, efforts) that the library lacks. */
const DOC_WORDS = ["arrive", "main", "accessory", "run", "care", "intervals", "steady", "recover", "maintain", "develop", "peak"];

const VOCABULARIES: Record<string, readonly string[]> = {
  contractions: CONTRACTIONS,
  purposes: PURPOSES,
  tags: TAGS,
  regions: REGIONS,
  muscles: MUSCLES,
  formats: FORMAT_IDS,
};

/** Words a tooltip must never lean on to explain something. */
const JARGON =
  /\b(isometric|isotonic|eccentric|concentric|plyometric|propriocept\w*|kinetic|hypertroph\w*|flexion|extension|extensors?|scapula\w*|lumbar|thoracic|fascia\w*|sagittal|transverse|unilateral|bilateral|posterior|anterior|lateral|abduct\w*|adduct\w*|dorsiflex\w*|neuromuscular|rotator|musculature|contraction|tendon\w*|ligament\w*)\b/i;

describe("GLOSSARY", () => {
  test.each(Object.entries(VOCABULARIES))("explains every %s id", (_name, ids) => {
    const missing = ids.filter((id) => !(id in GLOSSARY));
    expect(missing).toEqual([]);
  });

  test("explains the document's own words the builder shows", () => {
    expect(DOC_WORDS.filter((id) => !(id in GLOSSARY))).toEqual([]);
  });

  test("explains nothing outside the vocabularies", () => {
    const known = new Set([...Object.values(VOCABULARIES).flat(), ...DOC_WORDS]);
    expect(Object.keys(GLOSSARY).filter((k) => !known.has(k))).toEqual([]);
  });

  test("each entry is one plain sentence of at most 90 characters", () => {
    for (const [id, sentence] of Object.entries(GLOSSARY)) {
      expect(sentence.length, id).toBeLessThanOrEqual(90);
      expect(sentence, id).toMatch(/^[A-Z].*\.$/);
      expect(sentence.slice(0, -1), `${id}: one sentence`).not.toMatch(/[.!?] /);
      expect(sentence, `${id}: jargon`).not.toMatch(JARGON);
    }
  });

  test("the contraction words, as the Studio's tooltips read them", () => {
    expect(GLOSSARY.isometric).toBe("Holding still against resistance.");
    expect(GLOSSARY.eccentric).toBe("Lowering slowly under control.");
    expect(GLOSSARY.passive).toBe("Letting go: no effort against resistance.");
  });
});
