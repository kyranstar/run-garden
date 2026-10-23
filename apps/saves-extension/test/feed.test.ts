import { describe, expect, it } from "vitest";
import { postSubmitSchema } from "@rg/saves";
import { FeedChangedError, KNOWN_STREAK_STOP, parseFeedPage, parseMediaInfo, postUrl, shouldStop, toSubmit } from "../src/feed.js";
import { PostGoneError } from "../src/errors.js";
import { media, page } from "./fixtures.js";

describe("parseFeedPage", () => {
  const json = page(
    [media("SynReel0001", "video"), media("SynPhoto001", "image"), media("SynCarou001", "carousel")],
    "cursor-2",
  );

  it("reads each post's key, link, creator, caption, hashtags, type and date", () => {
    const { posts, nextMaxId } = parseFeedPage(json);
    expect(nextMaxId).toBe("cursor-2");
    expect(posts.map((p) => p.key)).toEqual(["SynReel0001", "SynPhoto001", "SynCarou001"]);
    const [reel] = posts;
    expect(reel).toMatchObject({
      key: "SynReel0001",
      url: "https://www.instagram.com/reel/SynReel0001/",
      creator: { handle: "example_coach", name: "Example Coach" },
      caption: "Synthetic drill for SynReel0001 #Mobility #hips #mobility",
      hashtags: ["Mobility", "hips"],
      mediaType: "video",
      postedAt: new Date(1_760_000_000 * 1000).toISOString(),
    });
    expect(posts.map((p) => p.mediaType)).toEqual(["video", "image", "carousel"]);
  });

  it("builds canonical links: /reel/<code>/ for a video, /p/<code>/ for a photo or carousel, no query string", () => {
    const { posts } = parseFeedPage(json);
    expect(posts.map((p) => p.url)).toEqual([
      "https://www.instagram.com/reel/SynReel0001/",
      "https://www.instagram.com/p/SynPhoto001/",
      "https://www.instagram.com/p/SynCarou001/",
    ]);
    expect(postUrl("Abc_-123xyZ", "video")).toBe("https://www.instagram.com/reel/Abc_-123xyZ/");
    expect(postUrl("Abc_-123xyZ", "image")).toBe("https://www.instagram.com/p/Abc_-123xyZ/");
  });

  it("keeps the pk exact: the string, else the id's lead, else derived from the code", () => {
    const { posts } = parseFeedPage(
      page(
        [
          media("CuZLd-iMknW", "video", { pk: "3141592653589793238" }),
          media("CuZLd-iMknW", "video", { pk: 3141592653589793000, id: "3141592653589793238_99" }),
          media("CuZLd-iMknW", "video", { pk: 3141592653589793000, id: undefined }),
        ],
        null,
      ),
    );
    expect(posts.map((p) => p.pk)).toEqual(["3141592653589793238", "3141592653589793238", "3141592653589793238"]);
  });

  it("lists video variants, one image per slide, and a cover near 320 px", () => {
    const { posts } = parseFeedPage(json);
    const [reel, photo, carousel] = posts;
    expect(reel!.videoVariants.map((x) => x.width)).toEqual([720, 480, 360]);
    expect(reel!.images).toEqual([]);
    expect(reel!.coverUrl).toBe("https://synthetic.cdninstagram.com/SynReel0001-320.jpg");
    expect(photo!.videoVariants).toEqual([]);
    expect(photo!.images).toEqual([{ width: 640, url: "https://synthetic.cdninstagram.com/SynPhoto001-640.jpg" }]);
    // A carousel: every slide's image (a video slide by its cover), and the first video slide's variants.
    expect(carousel!.images.map((i) => i.url)).toEqual([
      "https://synthetic.cdninstagram.com/SynCarou001-s1-640.jpg",
      "https://synthetic.cdninstagram.com/SynCarou001-s2-640.jpg",
      "https://synthetic.cdninstagram.com/SynCarou001-s3-640.jpg",
    ]);
    expect(carousel!.videoVariants.map((x) => x.url)).toContain("https://synthetic.cdninstagram.com/SynCarou001-s2-480.mp4");
    expect(carousel!.coverUrl).toBe("https://synthetic.cdninstagram.com/SynCarou001-s1-320.jpg");
  });

  it("reads a missing caption or name as empty, and the last page's cursor as null", () => {
    const { posts, nextMaxId } = parseFeedPage(
      page([media("SynReel0002", "video", { caption: null, user: { username: "example_coach" } })], null),
    );
    expect(nextMaxId).toBeNull();
    expect(posts[0]).toMatchObject({ caption: "", hashtags: [], creator: { handle: "example_coach" } });
    expect(posts[0]!.creator.name).toBeUndefined();
    expect(parseFeedPage({ ...page([], "x"), more_available: false }).nextMaxId).toBeNull();
  });

  it("makes posts the app's submit schema accepts", () => {
    for (const p of parseFeedPage(json).posts) {
      expect(postSubmitSchema.safeParse(toSubmit(p, "instagram")).success).toBe(true);
    }
  });

  it("throws FeedChangedError on a shape without items, or an item without a code", () => {
    expect(() => parseFeedPage({ status: "ok" })).toThrow(FeedChangedError);
    expect(() => parseFeedPage(null)).toThrow(FeedChangedError);
    expect(() => parseFeedPage("<html>")).toThrow(FeedChangedError);
    expect(() => parseFeedPage({ items: [{ media: { pk: "1" } }] })).toThrow(FeedChangedError);
  });
});

describe("parseMediaInfo", () => {
  it("reads one post from the post-details answer", () => {
    expect(parseMediaInfo({ items: [media("SynReel0003", "video")], num_results: 1 })).toMatchObject({
      key: "SynReel0003",
      url: "https://www.instagram.com/reel/SynReel0003/",
    });
  });

  it("an empty answer is a post that is gone; a shapeless one is a changed site", () => {
    expect(() => parseMediaInfo({ items: [], num_results: 0 })).toThrow(PostGoneError);
    expect(() => parseMediaInfo({ status: "ok" })).toThrow(FeedChangedError);
  });
});

describe("shouldStop", () => {
  const fresh = (...keys: string[]) => new Set(keys);

  it("a re-saved known post above two new ones doesn't stop the check", () => {
    expect(shouldStop({ keys: ["old", "n1", "n2"], fresh: fresh("n1", "n2") }, { knownStreak: 0 })).toEqual({
      stop: false,
      knownStreak: 0,
    });
  });

  it("stops on a page where every key is known", () => {
    expect(shouldStop({ keys: ["k1", "k2", "k3"], fresh: fresh() }, { knownStreak: 0 }).stop).toBe(true);
  });

  it(`stops once ${KNOWN_STREAK_STOP} known keys in a row are seen, across pages`, () => {
    expect(KNOWN_STREAK_STOP).toBe(12);
    const first = shouldStop({ keys: ["n1", ...Array.from({ length: 7 }, (_, i) => `a${i}`)], fresh: fresh("n1") }, { knownStreak: 0 });
    expect(first).toEqual({ stop: false, knownStreak: 7 });
    const second = shouldStop({ keys: ["b0", "b1", "b2", "b3", "b4", "n2"], fresh: fresh("n2") }, first);
    expect(second.stop).toBe(true);
  });

  it("a fresh key resets the streak", () => {
    const run = shouldStop({ keys: ["k1", "k2", "n1", "k3"], fresh: fresh("n1") }, { knownStreak: 9 });
    expect(run).toEqual({ stop: false, knownStreak: 1 });
  });

  it("stops on an empty page", () => {
    expect(shouldStop({ keys: [], fresh: fresh() }, { knownStreak: 0 }).stop).toBe(true);
  });
});
