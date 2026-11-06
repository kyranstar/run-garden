import { describe, expect, it } from "vitest";
import { normalizeLink, postSubmitSchema, type PostSubmit, type WorkItem } from "@rg/saves";
import type { ExtractAnswer, ReadFailure, SubmitAnswer, VideoOpts } from "../src/app-client.js";
import { AppUnreachableError, LoginNeededError, PostGoneError } from "../src/errors.js";
import { LinkQueue, runLinks, sendPastedInstagram, type LinksDeps } from "../src/links.js";
import type { YoutubeRead } from "../src/youtube-reader.js";
import { memoryStore } from "./fixtures.js";

// The link runner (design 2026-11-05 §5.1, §14.4): pasted links one at a time, then the app's video work. Links
// assembled at runtime; a fake video id built here.
const S = ["ht", "tps://"].join("");
const vid = ["Zx", "9_-Qa", "B3cD"].join("");
const ytLink = `${S}${["you", "tu.be"].join("")}/${vid}`;
const igLink = `${S}www.${["insta", "gram.com"].join("")}/reel/ZorbexPost1/`;
const NOW = Date.parse("2026-11-06T10:00:00Z");

const read = (over: Partial<Extract<YoutubeRead, { ok: true }>> = {}): YoutubeRead => ({
  ok: true,
  meta: { id: vid, title: "Zorbex hip flow", channel: { handle: "@zorbexcoach", name: "Zorbex Coach" }, lengthSec: 98, description: "d", publishedAt: null, live: false, tracks: [] },
  transcript: { track: { languageCode: "en", kind: "asr", name: "en" }, segments: [[0, "zorbex"]], via: "captured" },
  chapters: { list: [], from: null },
  ms: 5_000,
  ...over,
});

class FakeApp {
  log: string[] = [];
  submits: PostSubmit[] = [];
  videos: { key: string; opts: VideoOpts }[] = [];
  failures: ReadFailure[] = [];
  workItems: WorkItem[] = [];
  submitAnswer: SubmitAnswer = { status: "queued" };
  videoAnswers: ExtractAnswer[] = [];
  down = { submit: false, failures: false };
  async work(opts?: { links?: boolean }) {
    this.log.push(`work:${opts?.links ? "v2" : "v1"}`);
    return this.workItems;
  }
  async submitPost(p: PostSubmit) {
    this.log.push(`submit:${p.key}`);
    if (this.down.submit) throw new AppUnreachableError();
    this.submits.push(p);
    return this.submitAnswer;
  }
  async extractVideo(key: string, opts: VideoOpts): Promise<ExtractAnswer> {
    this.log.push(`video:${key}`);
    this.videos.push({ key, opts });
    return this.videoAnswers.shift() ?? { ok: true };
  }
  gone: { source: string; key: string; code: string }[] = [];
  async reportFailed(source: string, key: string, code: "gone" | "media_failed" | "too_large") {
    this.log.push(`failed:${key}:${code}`);
    this.gone.push({ source, key, code });
  }
  async reportReadFailed(r: ReadFailure) {
    this.log.push(`read-failed:${r.key}:${r.code}`);
    this.failures.push(r);
    return !this.down.failures;
  }
}

function setup(over: Partial<LinksDeps> = {}) {
  const app = new FakeApp();
  const queue = new LinkQueue(memoryStore());
  const youtubeReads: string[] = [];
  const instagramReads: string[] = [];
  const deps: LinksDeps = {
    app,
    queue,
    now: () => NOW,
    youtube: async (id) => {
      youtubeReads.push(id);
      return read();
    },
    instagram: async (key) => {
      instagramReads.push(key);
    },
    config: { model: "google/gemini-3.6-flash", maxTokens: 32_000, extVersion: "0.3.0" },
    ...over,
  };
  return { app, queue, deps, youtubeReads, instagramReads };
}
const add = (q: LinkQueue, url: string) => q.add(normalizeLink(url)!, new Date(NOW).toISOString());

describe("LinkQueue", () => {
  it("one entry a link; adding again clears its error; next skips a failed one", async () => {
    const q = new LinkQueue(memoryStore());
    expect(await add(q, ytLink)).toBe(true);
    expect(await add(q, ytLink)).toBe(false);
    await q.fail("youtube", vid, { code: "unplayable", message: "Age-restricted" });
    expect(await q.next()).toBeNull();
    expect((await q.all())[0]!.error).toEqual({ code: "unplayable", message: "Age-restricted" });
    await add(q, ytLink);
    expect((await q.next())!.key).toBe(vid);
    await q.done("youtube", vid);
    expect(await q.all()).toEqual([]);
  });
});

describe("runLinks", () => {
  it("a YouTube link: read, submitted as pasted, its reading asked for, and gone from the queue", async () => {
    const { app, queue, deps, youtubeReads } = setup();
    await add(queue, ytLink);
    expect(await runLinks(deps)).toEqual({ read: 1, failed: 0, error: null });
    expect(youtubeReads).toEqual([vid]);
    expect(postSubmitSchema.safeParse(app.submits[0]).success).toBe(true);
    expect(app.submits[0]).toMatchObject({ source: "youtube", key: vid, origin: "pasted", readFacts: { via: "pasted", extVersion: "0.3.0" } });
    expect(app.videos).toEqual([{ key: vid, opts: { model: "google/gemini-3.6-flash", maxTokens: 32_000 } }]);
    expect(await queue.all()).toEqual([]);
  });

  it("a reading the app refuses with issues is asked once more with them", async () => {
    const { app, queue, deps } = setup();
    app.videoAnswers = [{ ok: false, code: "model_failed", issues: ["moves.0.position: must be one of …"] }, { ok: true }];
    await add(queue, ytLink);
    await runLinks(deps);
    expect(app.videos.map((v) => v.opts.retryIssues)).toEqual([undefined, ["moves.0.position: must be one of …"]]);
  });

  it("a screened-out or already-known video is not read for its moves", async () => {
    const { app, queue, deps } = setup();
    app.submitAnswer = { status: "filtered_out", verdict: "not" };
    await add(queue, ytLink);
    await runLinks(deps);
    expect(app.videos).toEqual([]);
    expect(await queue.all()).toEqual([]);
  });

  it("a video that can't be read is told to the app and leaves the queue; kept with its reason when the app couldn't be told", async () => {
    const { app, queue, deps } = setup({ youtube: async () => ({ ok: false, code: "unplayable", message: "Age-restricted" }) });
    await add(queue, ytLink);
    expect(await runLinks(deps)).toEqual({ read: 0, failed: 1, error: null });
    expect(app.failures).toEqual([{ source: "youtube", key: vid, code: "unplayable", message: "Age-restricted" }]);
    expect(await queue.all()).toEqual([]);
    app.down.failures = true;
    await add(queue, ytLink);
    await runLinks(deps);
    expect((await queue.all())[0]).toMatchObject({ key: vid, error: { code: "unplayable", message: "Age-restricted" } });
  });

  it("the app unreachable: the link stays (no error of its own) and the run ends", async () => {
    const { app, queue, deps } = setup();
    app.down.submit = true;
    await add(queue, ytLink);
    await add(queue, igLink);
    const out = await runLinks(deps);
    expect(out.error).toBe("app_unreachable");
    expect((await queue.all()).map((l) => [l.key, l.error])).toEqual([[vid, null], ["ZorbexPost1", null]]);
  });

  it("an Instagram link is read and sent through the queue; a gone post is told; a login ends the run and keeps the link", async () => {
    const { queue, deps, instagramReads } = setup();
    await add(queue, igLink);
    expect(await runLinks(deps)).toEqual({ read: 1, failed: 0, error: null });
    expect(instagramReads).toEqual(["ZorbexPost1"]);
    expect(await queue.all()).toEqual([]);

    const gone = setup({ instagram: async () => { throw new PostGoneError(); } });
    await add(gone.queue, igLink);
    await runLinks(gone.deps);
    expect(gone.app.failures).toEqual([{ source: "instagram", key: "ZorbexPost1", code: "gone", message: "A saved post is gone" }]);
    expect(await gone.queue.all()).toEqual([]);

    const login = setup({ instagram: async () => { throw new LoginNeededError(); } });
    await add(login.queue, igLink);
    expect((await runLinks(login.deps)).error).toBe("login_needed");
    expect((await login.queue.all())[0]).toMatchObject({ key: "ZorbexPost1", error: null });
  });

  it("the app's work: a link pasted on the phone is read; a video to read again is asked for with no page read; one to screen again is read and sent", async () => {
    const { app, deps, youtubeReads, instagramReads } = setup();
    app.workItems = [
      { source: "instagram", key: "ZorbexPost1", url: igLink, action: "read" },
      { source: "youtube", key: "Yt0000000ab", url: `${S}example.com/v`, action: "extract" },
      { source: "youtube", key: vid, url: `${S}example.com/v`, action: "filter" },
      { source: "instagram", key: "theirown", url: `${S}example.com/p`, action: "extract" },
    ];
    await runLinks(deps);
    expect(app.log[0]).toBe("work:v2");
    expect(instagramReads).toEqual(["ZorbexPost1"]);
    expect(app.videos.map((v) => v.key)).toEqual(["Yt0000000ab", vid]);
    expect(youtubeReads).toEqual([vid]);
    expect(app.submits.map((s) => s.key)).toEqual([vid]);
  });
});

describe("runLinks: a video the app holds that can't be read any more (final review F3)", () => {
  it("is marked gone, so the work list stops handing it out; a pasted link's failure is only told", async () => {
    const { app, deps } = setup({ youtube: async () => ({ ok: false, code: "unplayable", message: "Age-restricted" }) });
    app.workItems = [{ source: "youtube", key: vid, url: `${S}example.com/v`, action: "filter" }];
    await runLinks(deps);
    expect(app.gone).toEqual([{ source: "youtube", key: vid, code: "gone" }]);
    expect(app.failures).toEqual([{ source: "youtube", key: vid, code: "unplayable", message: "Age-restricted" }]);

    const pasted = setup({ youtube: async () => ({ ok: false, code: "unplayable", message: "Age-restricted" }) });
    await add(pasted.queue, ytLink);
    await runLinks(pasted.deps);
    expect(pasted.app.gone).toEqual([]);
  });

  it("a passing failure (the player didn't load) is told but not marked gone", async () => {
    const { app, deps } = setup({ youtube: async () => ({ ok: false, code: "unknown", message: "The player didn't load" }) });
    app.workItems = [{ source: "youtube", key: vid, url: `${S}example.com/v`, action: "filter" }];
    await runLinks(deps);
    expect(app.gone).toEqual([]);
    expect(app.failures).toHaveLength(1);
  });
});

describe("a pasted Instagram post the app can't take (final audit G11)", () => {
  const summary = (over = {}) => ({ checkId: "c", startedAt: "", finishedAt: "", pages: 0, found: 0, fresh: 0, submitted: 1, filtered: 0, extracted: 1, failed: 0, error: null, ...over });

  it("a submit that couldn't be queued or that the app refused is a failure with its reason, so the link reaches an end", async () => {
    await expect(sendPastedInstagram(async () => false, async () => summary())).rejects.toThrow("The post's details didn't fit");
    await expect(sendPastedInstagram(async () => true, async () => summary({ submitted: 0, failed: 1 }))).rejects.toThrow("The app refused the post");
    await expect(sendPastedInstagram(async () => true, async () => summary({ submitted: 0, error: { code: "app_unreachable", message: "App unreachable" } }))).rejects.toBeInstanceOf(AppUnreachableError);
    await expect(sendPastedInstagram(async () => true, async () => summary())).resolves.toBeUndefined();
  });

  it("the runner tells the app, which marks the link failed", async () => {
    const { app, queue, deps } = setup({ instagram: () => sendPastedInstagram(async () => false, async () => summary()) });
    await add(queue, igLink);
    await runLinks(deps);
    expect(app.failures).toEqual([{ source: "instagram", key: "ZorbexPost1", code: "unknown", message: "The post's details didn't fit" }]);
    expect(await queue.all()).toEqual([]);
  });
});
