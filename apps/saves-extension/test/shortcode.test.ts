import { describe, expect, it } from "vitest";
import { shortcodeToPk } from "../src/shortcode.js";

describe("shortcodeToPk", () => {
  it("reads one character as its place in the alphabet", () => {
    expect(shortcodeToPk("A")).toBe("0");
    expect(shortcodeToPk("B")).toBe("1");
    expect(shortcodeToPk("_")).toBe("63");
    expect(shortcodeToPk("BA")).toBe("64");
  });

  it("decodes a known synthetic pair past the float range, exactly", () => {
    expect(shortcodeToPk("CuZLd-iMknW")).toBe("3141592653589793238");
  });

  it("reads only the first 11 characters of a longer code (a private post's code carries a suffix)", () => {
    expect(shortcodeToPk("CuZLd-iMknWAbCdEfGhIjKlMnOpQrStUvWxYz012")).toBe("3141592653589793238");
  });

  it("refuses a character outside the alphabet", () => {
    expect(() => shortcodeToPk("ab+c")).toThrow();
    expect(() => shortcodeToPk("")).toThrow();
  });
});
