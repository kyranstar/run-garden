/** RFC 1321 test vectors — the browser-side COROS password hash must be
 * byte-exact or logins fail mysteriously. */
import { describe, expect, it } from "vitest";
import { md5Hex } from "../src/md5.js";

describe("md5Hex", () => {
  it("matches the RFC 1321 suite", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex("a")).toBe("0cc175b9c0f1b6a831c399e269772661");
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex("message digest")).toBe("f96b697d7cb7938d525a2f31aaf161d0");
    expect(md5Hex("abcdefghijklmnopqrstuvwxyz")).toBe("c3fcd3d76192e4007dfb496cca67e13b");
    expect(md5Hex("12345678901234567890123456789012345678901234567890123456789012345678901234567890")).toBe(
      "57edf4a22be3c955ac49da2e2107b67a",
    );
  });

  it("handles the canonical password vector and multibyte input", () => {
    expect(md5Hex("password")).toBe("5f4dcc3b5aa765d61d8327deb882cf99");
    // 56-63 byte lengths exercise the two-block padding edge.
    expect(md5Hex("x".repeat(56)).length).toBe(32);
    expect(md5Hex("x".repeat(63)).length).toBe(32);
    expect(md5Hex("pässwörd").length).toBe(32); // UTF-8 encoded before hashing
  });
});
