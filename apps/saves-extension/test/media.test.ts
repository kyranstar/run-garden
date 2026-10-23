import { describe, expect, it } from "vitest";
import { fetchAsBase64, isMediaUrl, MIN_VIDEO_WIDTH, nextSmaller, pickVariant } from "../src/media.js";
import { MediaError } from "../src/errors.js";

const v = (...widths: number[]) => widths.map((width) => ({ width, url: `https://synthetic.cdninstagram.com/${width}.mp4` }));

describe("pickVariant", () => {
  it("defaults to a 480 px floor", () => {
    expect(MIN_VIDEO_WIDTH).toBe(480);
  });

  it("chooses the smallest variant at or above the floor", () => {
    expect(pickVariant(v(360, 480, 720), 480).width).toBe(480);
    expect(pickVariant(v(720, 1080), 480).width).toBe(720);
    expect(pickVariant(v(1080, 360, 720), 480).width).toBe(720);
  });

  it("falls back to the largest when nothing reaches the floor", () => {
    expect(pickVariant(v(240, 360), 480).width).toBe(360);
  });

  it("refuses an empty list", () => {
    expect(() => pickVariant([], 480)).toThrow();
  });
});

describe("nextSmaller", () => {
  it("is the largest variant narrower than the one tried", () => {
    expect(nextSmaller(v(360, 480, 720), 720)?.width).toBe(480);
    expect(nextSmaller(v(720, 360, 480), 480)?.width).toBe(360);
    expect(nextSmaller(v(360, 480), 360)).toBeNull();
  });
});

describe("fetchAsBase64", () => {
  it("reads the body as base64 with its mime type and size", async () => {
    const f = (async () =>
      new Response(new Uint8Array([0, 1, 2, 255]), { headers: { "content-type": "video/mp4; codecs=avc1" } })) as typeof fetch;
    expect(await fetchAsBase64("https://synthetic.cdninstagram.com/a.mp4", f)).toEqual({ mime: "video/mp4", base64: "AAEC/w==", bytes: 4 });
  });

  it("encodes a large body exactly (chunked)", async () => {
    const bytes = new Uint8Array(200_003).map((_, i) => (i * 31) % 256);
    const f = (async () => new Response(bytes, { headers: { "content-type": "image/jpeg" } })) as typeof fetch;
    const out = await fetchAsBase64("https://synthetic.cdninstagram.com/a.jpg", f);
    expect(Uint8Array.from(atob(out.base64), (ch) => ch.charCodeAt(0))).toEqual(bytes);
    expect(out.bytes).toBe(200_003);
  });

  it("uses the fallback type when the response names none", async () => {
    const f = (async () => {
      const r = new Response(new Uint8Array([1]));
      r.headers.delete("content-type");
      return r;
    }) as typeof fetch;
    expect((await fetchAsBase64("https://synthetic.cdninstagram.com/a", f, "video/mp4")).mime).toBe("video/mp4");
  });

  it("fetches only from the manifest's CDN hosts, over https", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg" } });
    }) as typeof fetch;
    for (const url of [
      "https://evil.example.com/a.jpg",
      "http://synthetic.cdninstagram.com/a.jpg",
      "https://cdninstagram.com.evil.example/a.jpg",
      "https://notfbcdn.net/a.jpg",
      "not a url",
    ]) {
      await expect(fetchAsBase64(url, f)).rejects.toBeInstanceOf(MediaError);
    }
    expect(calls).toBe(0);
    expect(isMediaUrl("https://scontent-xx1-1.cdninstagram.com/v/a.mp4")).toBe(true);
    expect(isMediaUrl("https://video.xx.fbcdn.net/v/a.mp4")).toBe(true);
    await fetchAsBase64("https://synthetic.cdninstagram.com/a.jpg", f);
    expect(calls).toBe(1);
  });

  it("throws MediaError on an expired link (403) or a network failure", async () => {
    const forbidden = (async () => new Response("", { status: 403 })) as typeof fetch;
    await expect(fetchAsBase64("https://synthetic.cdninstagram.com/a.mp4", forbidden)).rejects.toBeInstanceOf(MediaError);
    const down = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    await expect(fetchAsBase64("https://synthetic.cdninstagram.com/a.mp4", down)).rejects.toBeInstanceOf(MediaError);
  });
});
