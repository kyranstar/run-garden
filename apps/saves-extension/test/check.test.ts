import { describe, expect, it } from "vitest";
import type { CheckReport, PostSubmit, WorkItem } from "@rg/saves";
import { DEFAULT_CONFIG, runCheck, singleFlight, type CheckDeps } from "../src/check.js";
import type { AppClient, ExtractAnswer, SubmitAnswer } from "../src/app-client.js";
import { AppUnreachableError, LoginNeededError, ReaderError } from "../src/errors.js";
import { ExtQueue } from "../src/queue.js";
import { shortcodeToPk } from "../src/shortcode.js";
import { code, media, mediaFetch, memoryStore, page } from "./fixtures.js";

const NOW = Date.parse("2026-10-23T12:00:00Z");

/** The app's token routes, at the client's interface: remembers keys, answers submits and extracts as scripted. */
class FakeApp implements AppClient {
  log: string[] = [];
  knownKeys = new Set<string>();
  submits: PostSubmit[] = [];
  extracts: { key: string; body: string; opts: { model: string; maxTokens: number } }[] = [];
  reports: CheckReport[] = [];
  workItems: WorkItem[] = [];
  extractAnswers: ExtractAnswer[] = [];
  verdict: (p: PostSubmit) => SubmitAnswer = () => ({ status: "queued", verdict: "training" });
  down = { start: false, submit: false };

  async reportCheck(r: CheckReport) {
    this.log.push(`check:${r.phase}`);
    if (r.phase === "start" && this.down.start) throw new AppUnreachableError("The app answered 503");
    this.reports.push(r);
  }
  async known(_source: string, keys: string[]) {
    this.log.push("known");
    return keys.filter((k) => !this.knownKeys.has(k));
  }
  async submitPost(p: PostSubmit) {
    this.log.push(`submit:${p.key}`);
    if (this.down.submit) throw new AppUnreachableError("The app answered 503");
    this.knownKeys.add(p.key);
    this.submits.push(p);
    return this.verdict(p);
  }
  async work() {
    this.log.push("work");
    return this.workItems;
  }
  async extract(_source: string, key: string, body: string, opts: { model: string; maxTokens: number }) {
    this.log.push(`extract:${key}`);
    this.extracts.push({ key, body, opts });
    return this.extractAnswers.shift() ?? { ok: true as const };
  }
  get finish() {
    return this.reports.find((r) => r.phase === "finish");
  }
}

/** The saved feed as pages of media; page i (from 0) is read with max_id null, then "c<i>". Records every read. */
function fakeReader(pages: Record<string, unknown>[][], extra: Record<string, unknown>[] = []) {
  const reads: (string | null)[] = [];
  const postReads: string[] = [];
  const all = [...pages.flat(), ...extra];
  return {
    reads,
    postReads,
    fail: null as null | ((maxId: string | null) => Error | null),
    async readSavedPage(maxId: string | null) {
      reads.push(maxId);
      const err = this.fail?.(maxId);
      if (err) throw err;
      const i = maxId === null ? 0 : Number(maxId.slice(1));
      return page(pages[i] ?? [], i + 1 < pages.length ? `c${i + 1}` : null);
    },
    async readPost(pk: string) {
      postReads.push(pk);
      return { items: all.filter((m) => m.pk === pk).slice(0, 1), num_results: 1 };
    },
  };
}

function makeDeps(app: FakeApp, reader: ReturnType<typeof fakeReader>, over: Partial<CheckDeps> = {}) {
  const store = memoryStore();
  const deps: CheckDeps = {
    app,
    reader,
    fetchImpl: mediaFetch(),
    queue: new ExtQueue(store),
    store,
    now: () => NOW,
    config: { ...DEFAULT_CONFIG },
    ...over,
  };
  return deps;
}

const bodyText = (body: string): string => {
  const parsed = JSON.parse(body) as { messages: { role: string; content: unknown }[] };
  const user = parsed.messages.find((m) => m.role === "user")!.content as { type: string; text?: string }[];
  return user.find((p) => p.type === "text")!.text!;
};

describe("runCheck", () => {
  it("reports its start, asks /known per page, submits fresh posts newest last with a cover, extracts the queued, reports the counts", async () => {
    const app = new FakeApp();
    const [a, b, c, d, e] = [1, 2, 3, 4, 5].map(code);
    app.knownKeys = new Set([d!, e!]);
    app.verdict = (p) => (p.key === b ? { status: "filtered_out", verdict: "not" } : { status: "queued", verdict: "training" });
    const reader = fakeReader([[media(a!, "video"), media(b!, "image"), media(c!, "carousel")], [media(d!), media(e!)]]);
    const deps = makeDeps(app, reader);

    const summary = await runCheck(deps);

    expect(reader.reads).toEqual([null, "c1"]);
    expect(app.log).toEqual([
      "check:start", "known", "known",
      `submit:${c}`, `submit:${b}`, `submit:${a}`,
      `extract:${c}`, `extract:${a}`,
      "work", "check:finish",
    ]);
    expect(app.submits[2]).toMatchObject({
      source: "instagram",
      key: a,
      url: `https://www.instagram.com/reel/${a}/`,
      mediaType: "video",
      cover: { mime: "image/jpeg", base64: "AQIDBAUG" },
    });
    // The relay body: model first, the 480 px variant as the video.
    const reel = app.extracts.find((x) => x.key === a)!;
    expect(Object.keys(JSON.parse(reel.body))[0]).toBe("model");
    expect(reel.opts).toEqual({ model: DEFAULT_CONFIG.model, maxTokens: DEFAULT_CONFIG.maxTokens });
    expect(reel.body).toContain("data:video/mp4;base64,AQIDBAUG");
    expect((deps.fetchImpl as ReturnType<typeof mediaFetch>).urls).toContain(`https://cdn.example.com/${a}-480.mp4`);
    expect(app.finish).toMatchObject({ phase: "finish", found: 5, fresh: 3, filtered: 1, extracted: 2, failed: 0 });
    expect(app.finish!.error).toBeUndefined();
    expect(app.finish!.checkId).toBe(app.reports[0]!.checkId);
    expect(summary).toMatchObject({ pages: 2, found: 5, fresh: 3, submitted: 3, filtered: 1, extracted: 2, failed: 0, error: null });
    expect(await deps.queue.size()).toBe(0);
  });

  it("a re-saved known post above two new ones doesn't stop the check: it reads on to the next page", async () => {
    const app = new FakeApp();
    const keys = Array.from({ length: 9 }, (_, i) => code(i + 1));
    const [old, n1, n2, n3, k2, k3, k4, k5, k6] = keys as [string, ...string[]];
    app.knownKeys = new Set([old, k2!, k3!, k4!, k5!, k6!]);
    app.verdict = () => ({ status: "filtered_out" });
    const reader = fakeReader([
      [media(old), media(n1!), media(n2!)],
      [media(n3!), media(k2!), media(k3!)],
      [media(k4!), media(k5!), media(k6!)],
      [media(code(99))],
    ]);
    await runCheck(makeDeps(app, reader));
    expect(reader.reads).toEqual([null, "c1", "c2"]);
    expect(app.submits.map((s) => s.key).sort()).toEqual([n1, n2, n3].sort());
  });

  it("a 25-page backlog finishes on the second check, which reads only the top page and the pages it had not reached", async () => {
    const app = new FakeApp();
    app.verdict = () => ({ status: "filtered_out" });
    const pages = Array.from({ length: 25 }, (_, p) => [media(code(p * 2 + 1)), media(code(p * 2 + 2))]);
    const reader = fakeReader(pages);
    const deps = makeDeps(app, reader);

    const first = await runCheck(deps);
    expect(first.pages).toBe(20);
    expect(reader.reads).toEqual([null, ...Array.from({ length: 19 }, (_, i) => `c${i + 1}`)]);
    expect(app.submits).toHaveLength(40);

    reader.reads.length = 0;
    const second = await runCheck(deps);
    expect(reader.reads).toEqual([null, "c20", "c21", "c22", "c23", "c24"]);
    expect(second.error).toBeNull();
    const submitted = app.submits.map((s) => s.key);
    expect(submitted).toHaveLength(50);
    expect(new Set(submitted).size).toBe(50); // nothing already submitted went again

    reader.reads.length = 0;
    await runCheck(deps);
    expect(reader.reads).toEqual([null]);
    expect(app.submits).toHaveLength(50);
  });

  it("a LoginNeededError ends the check with error login_needed and no submits", async () => {
    const app = new FakeApp();
    const reader = fakeReader([[media(code(1))]]);
    reader.fail = () => new LoginNeededError("Instagram wants a login");
    const summary = await runCheck(makeDeps(app, reader));
    expect(summary.error?.code).toBe("login_needed");
    expect(app.submits).toEqual([]);
    expect(app.log).not.toContain("work");
    expect(app.finish).toMatchObject({ phase: "finish", error: { code: "login_needed" } });
  });

  it("a login error on a later page submits nothing from the pages before it (the next check reads them again)", async () => {
    const app = new FakeApp();
    const reader = fakeReader([[media(code(1)), media(code(2))], [media(code(3))]]);
    reader.fail = (maxId) => (maxId === "c1" ? new LoginNeededError("login") : null);
    const deps = makeDeps(app, reader);
    expect((await runCheck(deps)).error?.code).toBe("login_needed");
    expect(app.log.filter((l) => l.startsWith("submit:"))).toEqual([]);
    expect(await deps.queue.size()).toBe(0);
  });

  it("an app 5xx leaves the entries queued, and the next check sends them first", async () => {
    const app = new FakeApp();
    const reader = fakeReader([[media(code(1)), media(code(2)), media(code(3))]]);
    const deps = makeDeps(app, reader);
    app.down.submit = true;

    const first = await runCheck(deps);
    expect(first.error?.code).toBe("app_unreachable");
    expect(await deps.queue.size()).toBe(3);
    expect(app.finish).toMatchObject({ error: { code: "app_unreachable" } });

    app.down.submit = false;
    app.log = [];
    reader.reads.length = 0;
    const second = await runCheck(deps);
    expect(second.error).toBeNull();
    expect(app.log.slice(0, 4)).toEqual(["check:start", `submit:${code(3)}`, `submit:${code(2)}`, `submit:${code(1)}`]);
    expect(app.log.indexOf("known")).toBeGreaterThan(3); // the feed is read only after the replay
    expect(app.submits.map((s) => s.key)).toEqual([code(3), code(2), code(1)]);
    // The replayed posts were queued for extraction: their media come from a fresh single-post read.
    expect(reader.postReads).toEqual([code(3), code(2), code(1)].map(shortcodeToPk));
    expect(app.extracts.map((x) => x.key)).toEqual([code(3), code(2), code(1)]);
    expect(await deps.queue.size()).toBe(0);
  });

  it("a failed read deep in the feed keeps what was read, and the next check resumes at that page (new saves still flow)", async () => {
    const app = new FakeApp();
    app.verdict = () => ({ status: "filtered_out" });
    const reader = fakeReader([[media(code(1))], [media(code(2))], [media(code(3))]]);
    reader.fail = (maxId) => (maxId === "c2" ? new ReaderError("Instagram answered 429") : null);
    const deps = makeDeps(app, reader);

    const first = await runCheck(deps);
    expect(first.error).toMatchObject({ code: "unknown", message: "Instagram answered 429" });
    expect(app.submits.map((p) => p.key)).toEqual([code(2), code(1)]);

    reader.fail = null;
    reader.reads.length = 0;
    const second = await runCheck(deps);
    expect(reader.reads).toEqual([null, "c2"]);
    expect(app.submits.map((p) => p.key)).toEqual([code(2), code(1), code(3)]);
    expect(second.error).toBeNull();
  });

  it("an extract entry that cannot be read is dropped (the app's work list hands it back); only an outage or a login keeps it", async () => {
    const app = new FakeApp();
    const deps = makeDeps(app, fakeReader([[]]));
    await deps.queue.push({ kind: "extract", source: "instagram", key: code(7) });
    const reader = fakeReader([[]]);
    reader.readPost = async () => {
      throw new ReaderError("Instagram answered 400");
    };
    const summary = await runCheck({ ...deps, reader });
    expect(summary.error).toMatchObject({ code: "unknown" });
    expect(await deps.queue.size()).toBe(0);

    await deps.queue.push({ kind: "extract", source: "instagram", key: code(8) });
    reader.readPost = async () => {
      throw new LoginNeededError();
    };
    expect((await runCheck({ ...deps, reader })).error?.code).toBe("login_needed");
    expect(await deps.queue.size()).toBe(1);
  });

  it("an entry that throws something unexpected is dropped and counted, and the queue goes on", async () => {
    const app = new FakeApp();
    app.verdict = () => ({ status: "filtered_out" });
    const deps = makeDeps(app, fakeReader([[]]));
    await deps.queue.push({ kind: "submit", source: "instagram", key: "broken", payload: null });
    await deps.queue.push({ kind: "submit", source: "instagram", key: code(9), payload: { post: { key: code(9) }, coverUrl: null } });
    const summary = await runCheck(deps);
    expect(summary.failed).toBe(1);
    expect(app.log).toContain(`submit:${code(9)}`);
    expect(await deps.queue.size()).toBe(0);
  });

  it("an unreachable app at the start reads nothing", async () => {
    const app = new FakeApp();
    app.down.start = true;
    const reader = fakeReader([[media(code(1))]]);
    const summary = await runCheck(makeDeps(app, reader));
    expect(summary.error?.code).toBe("app_unreachable");
    expect(reader.reads).toEqual([]);
  });

  it("a changed feed ends the check with feed_changed and no submits", async () => {
    const app = new FakeApp();
    const reader = fakeReader([]);
    reader.readSavedPage = async () => ({ status: "ok", something_else: [] });
    const summary = await runCheck(makeDeps(app, reader));
    expect(summary.error?.code).toBe("feed_changed");
    expect(app.submits).toEqual([]);
  });

  describe("extraction", () => {
    const one = () => {
      const app = new FakeApp();
      const reader = fakeReader([[media(code(1), "video")]]);
      return { app, reader };
    };

    it("an extract model_failed is retried once with the issues", async () => {
      const { app, reader } = one();
      app.extractAnswers = [{ ok: false, code: "model_failed", issues: ["moves.0.name: is required"] }, { ok: true }];
      const summary = await runCheck(makeDeps(app, reader));
      expect(app.extracts).toHaveLength(2);
      expect(bodyText(app.extracts[0]!.body)).not.toContain("previous reply had problems");
      expect(bodyText(app.extracts[1]!.body)).toContain("Your previous reply had problems");
      expect(bodyText(app.extracts[1]!.body)).toContain("- moves.0.name: is required");
      expect(summary).toMatchObject({ extracted: 1, failed: 0, error: null });
    });

    it("a second model_failed is not retried again: the post counts as failed", async () => {
      const { app, reader } = one();
      app.extractAnswers = [
        { ok: false, code: "model_failed", issues: ["a"] },
        { ok: false, code: "model_failed", issues: ["b"] },
      ];
      const summary = await runCheck(makeDeps(app, reader));
      expect(app.extracts).toHaveLength(2);
      expect(summary).toMatchObject({ extracted: 0, failed: 1, error: { code: "model_failed" } });
    });

    it("too_large is retried once at the next smaller variant", async () => {
      const { app, reader } = one();
      app.extractAnswers = [{ ok: false, code: "too_large" }, { ok: true }];
      const deps = makeDeps(app, reader);
      const summary = await runCheck(deps);
      const urls = (deps.fetchImpl as ReturnType<typeof mediaFetch>).urls.filter((u) => u.endsWith(".mp4"));
      expect(urls).toEqual([`https://cdn.example.com/${code(1)}-480.mp4`, `https://cdn.example.com/${code(1)}-360.mp4`]);
      expect(app.extracts).toHaveLength(2);
      expect(summary).toMatchObject({ extracted: 1, failed: 0 });
    });

    it("too_large twice, or with nothing smaller, counts the post as failed after at most one retry", async () => {
      const { app, reader } = one();
      app.extractAnswers = [{ ok: false, code: "too_large" }, { ok: false, code: "too_large" }];
      const summary = await runCheck(makeDeps(app, reader));
      expect(app.extracts).toHaveLength(2);
      expect(summary).toMatchObject({ extracted: 0, failed: 1, error: { code: "too_large" } });

      const small = new FakeApp();
      small.extractAnswers = [{ ok: false, code: "too_large" }];
      const onlySmall = fakeReader([[media(code(1), "video", { video_versions: [{ width: 360, height: 640, url: "https://cdn.example.com/only-360.mp4" }] })]]);
      expect(await runCheck(makeDeps(small, onlySmall))).toMatchObject({ failed: 1 });
      expect(small.extracts).toHaveLength(1);
    });

    it("a body over the relay's size limit steps down to a smaller variant before sending anything", async () => {
      const { app, reader } = one();
      const big = (url: string) =>
        url.endsWith("-480.mp4") || url.endsWith("-720.mp4")
          ? new Response(new Uint8Array(400_000), { headers: { "content-type": "video/mp4" } })
          : null;
      const deps = makeDeps(app, reader, { fetchImpl: mediaFetch(big), config: { ...DEFAULT_CONFIG, maxBodyBytes: 200_000 } });
      const summary = await runCheck(deps);
      expect(app.extracts).toHaveLength(1);
      expect(app.extracts[0]!.body.length).toBeLessThan(200_000);
      expect(summary.extracted).toBe(1);

      const none = new FakeApp();
      const allBig = makeDeps(none, fakeReader([[media(code(1), "video")]]), {
        fetchImpl: mediaFetch((u) => (u.endsWith(".mp4") ? new Response(new Uint8Array(400_000), { headers: { "content-type": "video/mp4" } }) : null)),
        config: { ...DEFAULT_CONFIG, maxBodyBytes: 200_000 },
      });
      expect(await runCheck(allBig)).toMatchObject({ extracted: 0, failed: 1, error: { code: "too_large" } });
      expect(none.extracts).toHaveLength(0);
    });

    it("an expired media link fails that post (media_failed) and the check goes on", async () => {
      const app = new FakeApp();
      const reader = fakeReader([[media(code(1), "video"), media(code(2), "video")]]);
      const deps = makeDeps(app, reader, {
        fetchImpl: mediaFetch((u) => (u.includes(`${code(1)}-480`) ? new Response("", { status: 403 }) : null)),
      });
      const summary = await runCheck(deps);
      expect(app.extracts.map((x) => x.key)).toEqual([code(2)]);
      expect(summary).toMatchObject({ extracted: 1, failed: 1, error: { code: "media_failed" } });
      expect(await deps.queue.size()).toBe(0);
    });

    it("budget_paused stops extraction for the rest of the check", async () => {
      const app = new FakeApp();
      app.extractAnswers = [{ ok: false, code: "budget_paused" }];
      const reader = fakeReader([[media(code(1), "video"), media(code(2), "video")]]);
      const deps = makeDeps(app, reader);
      const summary = await runCheck(deps);
      expect(app.extracts).toHaveLength(1);
      expect(summary.error?.code).toBe("budget_paused");
      expect(await deps.queue.size()).toBe(0);
    });

    it("never runs two extractions at once", async () => {
      const app = new FakeApp();
      let inFlight = 0;
      let most = 0;
      const extract = app.extract.bind(app);
      app.extract = async (...args) => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return extract(...args);
      };
      const reader = fakeReader([[media(code(1)), media(code(2)), media(code(3))]]);
      await runCheck(makeDeps(app, reader));
      expect(app.extracts).toHaveLength(3);
      expect(most).toBe(1);
    });
  });

  describe("the work list", () => {
    it("re-reads filter work first and resubmits it with a fresh cover, then fetches extract work by its single-post read", async () => {
      const app = new FakeApp();
      const [x, y] = [code(50), code(51)];
      app.knownKeys = new Set([x, y]);
      app.workItems = [
        { source: "instagram", key: x, url: `https://www.instagram.com/reel/${x}/`, action: "extract" },
        { source: "instagram", key: y, url: `https://www.instagram.com/reel/${y}/`, action: "filter" },
      ];
      const reader = fakeReader([[]], [media(x, "video"), media(y, "video")]);
      const summary = await runCheck(makeDeps(app, reader));
      expect(reader.postReads).toEqual([shortcodeToPk(y), shortcodeToPk(x)]);
      const after = app.log.slice(app.log.indexOf("work"));
      expect(after).toEqual(["work", `submit:${y}`, `extract:${y}`, `extract:${x}`, "check:finish"]);
      expect(app.submits[0]).toMatchObject({ key: y, cover: { mime: "image/jpeg" } });
      expect(summary.extracted).toBe(2);
    });

    it("takes at most 20 work items, and skips a post this check already handled", async () => {
      const app = new FakeApp();
      const fresh = code(1);
      const items = Array.from({ length: 25 }, (_, i) => code(100 + i));
      app.workItems = [fresh, ...items].map((key) => ({ source: "instagram", key, url: `https://www.instagram.com/reel/${key}/`, action: "extract" as const }));
      const reader = fakeReader([[media(fresh)]], items.map((k) => media(k)));
      await runCheck(makeDeps(app, reader));
      // The fresh post was extracted from the feed read; the work list's copy of it is skipped, and 19 more are read.
      expect(app.extracts.filter((x) => x.key === fresh)).toHaveLength(1);
      expect(reader.postReads).toHaveLength(19);
      expect(app.extracts).toHaveLength(20);
    });

    it("a post that is gone counts as failed and the list goes on", async () => {
      const app = new FakeApp();
      const [gone, here] = [code(60), code(61)];
      app.workItems = [gone, here].map((key) => ({ source: "instagram", key, url: `https://www.instagram.com/reel/${key}/`, action: "extract" as const }));
      const reader = fakeReader([[]], [media(here)]);
      const summary = await runCheck(makeDeps(app, reader));
      expect(app.extracts.map((x) => x.key)).toEqual([here]);
      expect(summary).toMatchObject({ extracted: 1, failed: 1, error: { code: "gone" } });
    });
  });
});

describe("singleFlight", () => {
  it("a second call while one runs joins it; checks never overlap", async () => {
    let runs = 0;
    let release!: () => void;
    const once = singleFlight(async () => {
      runs++;
      await new Promise<void>((r) => (release = r));
      return runs;
    });
    const a = once();
    const b = once();
    release();
    expect(await a).toBe(1);
    expect(await b).toBe(1);
    expect(runs).toBe(1);
    const c = once();
    release();
    expect(await c).toBe(2);
  });

  it("a failed run frees the slot", async () => {
    let n = 0;
    const once = singleFlight(async () => {
      n++;
      if (n === 1) throw new Error("boom");
      return n;
    });
    await expect(once()).rejects.toThrow("boom");
    expect(await once()).toBe(2);
  });
});
