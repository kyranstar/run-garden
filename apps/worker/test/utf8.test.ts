/**
 * `utf8Bytes` — a text's UTF-8 length without encoding it into a buffer of its own size: exactly what
 * `new TextEncoder().encode(text).length` answers, for every text (the coach designer's size checks run on texts up to
 * 200 KB several times a step). Lone surrogates count as U+FFFD (3 bytes), as the encoder writes them.
 */
import { describe, expect, it } from "vitest";
import { Rng } from "@rg/session-engine";
import { utf8Bytes, UTF8_SCRATCH_BYTES } from "../src/services/utf8.js";

const encoded = (text: string): number => new TextEncoder().encode(text).length;

/** A character of each UTF-8 length, and the surrogates alone. */
const ALPHABET = ["a", "Z", "{", '"', "\\", "\n", "\u007f", "é", "—", "\u0080", "߿", "ࠀ", "€", "￿", "😀", "\u{10ffff}", "\ud83d", "\ude00"];

function randomText(rng: () => number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(rng() * ALPHABET.length)]!;
  return out;
}

describe("utf8Bytes", () => {
  it("counts every UTF-8 length as the encoder does: 1 to 4 bytes, and a lone surrogate as U+FFFD", () => {
    for (const text of ["", "a", "é", "—", "😀", "\ud83d", "\ude00", "\ud83d😀", "\ude00\ud83d", "x\ud83d", "\ud83dx", ...ALPHABET]) {
      expect(utf8Bytes(text), JSON.stringify(text)).toBe(encoded(text));
    }
  });

  it("matches the encoder on random texts, short and past its scratch buffer, a character straddling every edge", () => {
    const rng = Rng.create("utf8-bytes");
    for (let n = 0; n < 300; n++) {
      const text = randomText(rng, Math.floor(rng() * 400));
      expect(utf8Bytes(text)).toBe(encoded(text));
    }
    for (const lead of [0, 1, 2, 3]) {
      // ASCII up to the scratch buffer's edge (less `lead`), then multi-byte characters across it.
      for (const tail of ["é", "—", "😀", "\ud83d", "😀\ud83d", "😀😀é—"]) {
        const text = "x".repeat(UTF8_SCRATCH_BYTES - lead) + tail + "y".repeat(lead);
        expect(utf8Bytes(text), `${lead} ${JSON.stringify(tail)}`).toBe(encoded(text));
      }
    }
    for (let n = 0; n < 6; n++) {
      const text = randomText(rng, UTF8_SCRATCH_BYTES + Math.floor(rng() * 3 * UTF8_SCRATCH_BYTES));
      expect(utf8Bytes(text)).toBe(encoded(text));
    }
  });

  it("matches the encoder on JSON the designer stores: a state of ~200 KB with words in several scripts", () => {
    const state = {
      messages: Array.from({ length: 2_000 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", text: `Keeps the jaw soft — the breath slow ${i}; café, Straße, 東京, 😀 ${"x".repeat(i % 50)}` })),
    };
    const text = JSON.stringify(state);
    expect(text.length).toBeGreaterThan(UTF8_SCRATCH_BYTES);
    expect(utf8Bytes(text)).toBe(encoded(text));
  });
});
