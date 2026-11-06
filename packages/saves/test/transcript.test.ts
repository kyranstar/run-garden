import { describe, expect, it } from "vitest";
import { clock, firstWords, TRANSCRIPT_MAX, transcriptSegments, transcriptText } from "../src/index.js";

describe("the transcript as text", () => {
  it("round-trips, one segment a line, times to a tenth", () => {
    const segs: [number, string][] = [[0, "Zorbex warm-up starts"], [5.25, "now\tthe lift"], [61, "line\none"]];
    const { text, cut } = transcriptText(segs);
    expect(cut).toBe(false);
    expect(text).toBe("0\tZorbex warm-up starts\n5.3\tnow the lift\n61\tline one");
    expect(transcriptSegments(text)).toEqual([[0, "Zorbex warm-up starts"], [5.3, "now the lift"], [61, "line one"]]);
  });

  it("a transcript past the cap is cut at a segment boundary and says so", () => {
    const segs: [number, string][] = Array.from({ length: 9_000 }, (_, i) => [i, `zorbex word ${i} `.repeat(4)]);
    const { text, cut } = transcriptText(segs);
    expect(cut).toBe(true);
    expect(text.length).toBeLessThanOrEqual(TRANSCRIPT_MAX);
    expect(text.endsWith(" ")).toBe(false);
    const back = transcriptSegments(text);
    expect(back.at(-1)![1]).toBe(segs[back.length - 1]![1].trim());
  });

  it("reads clocks and the first words", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(65)).toBe("1:05");
    expect(clock(3_725)).toBe("1:02:05");
    expect(firstWords("a  b\nc d", 3)).toBe("a b c");
    expect(transcriptSegments("garbage\n7\tok\n\n")).toEqual([[7, "ok"]]);
  });
});
