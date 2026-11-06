import { describe, expect, it } from "vitest";
import { HEALTH_LIGHTS, type HealthColor, type HealthLightDto, type ImportHealthDto, type PostRowDto, type SavesStatusDto } from "@rg/saves";
import { CHECK_DIED, CHECKING, NOT_CONFIGURED, TOKEN_REFUSED, addAnswerLine, appHref, isChecking, isPostKey, linksHeld, popupLinks, popupModel, safeHref } from "../src/status.js";
import type { LinkDto } from "@rg/saves";

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const HOUR = 3_600_000;

const post = (over: Partial<PostRowDto> = {}): PostRowDto => ({
  id: "p1",
  key: "k1",
  url: "https://example.com/p/k1",
  creator: { handle: "someone" },
  status: "matched",
  reason: null,
  errorCode: null,
  error: null,
  updatedAt: "2026-10-23T09:00:00.000Z",
  ...over,
});

const status = (over: Partial<SavesStatusDto> = {}): SavesStatusDto => ({
  state: "ok",
  lastCheckAt: "2026-10-23T10:00:00.000Z",
  lastImportAt: null,
  totals: { moves: 4, posts: 3 },
  checks: [],
  posts: [],
  spend: { spentMicros: 420_000, capMicros: 5_000_000 },
  ...over,
});

const model = (over: Partial<Parameters<typeof popupModel>[0]> = {}) =>
  popupModel({ status: status(), appError: null, queueSize: 0, nextCheckAt: NOW + 3 * HOUR, now: NOW, ...over });

describe("a running check", () => {
  const open = { id: "c9", startedAt: "2026-10-23T11:58:00.000Z", finishedAt: null, found: 0, fresh: 0, filtered: 0, extracted: 0, failed: 0, errorCode: null };
  const done = { ...open, id: "c8", startedAt: "2026-10-23T09:00:00.000Z", finishedAt: "2026-10-23T09:03:00.000Z", found: 12, fresh: 3, filtered: 2 };

  it("by the background's word: the headline is Checking…, the open row in progress, and the model says checking", () => {
    const m = model({ checking: true, status: status({ checks: [open, done] }) });
    expect(m.headline).toBe(CHECKING);
    expect(m.checking).toBe(true);
    expect(m.detail).toBe("");
    expect(m.actions).toContain("check_now");
    expect(m.checks[0]).toMatchObject({ when: "2 min ago", counts: "in progress", error: null });
    expect(m.checks[1]?.counts).toBe("12 found · 3 new · 2 filtered · 0 extracted · 0 failed");
  });

  it("an open check row while no check runs here died with its worker: not checking, a detail says so, Check now stays live", () => {
    // The first live night: a reload mid-check left the app's row open, and the popup read it as running — locked.
    const m = model({ status: status({ checks: [open, done] }) });
    expect(isChecking({ status: status({ checks: [open] }), appError: null, queueSize: 0, nextCheckAt: null, now: NOW })).toBe(false);
    expect(m.checking).toBe(false);
    expect(m.headline).toBe("Up to date");
    expect(m.detail).toBe(CHECK_DIED);
    expect(m.checks[0]?.counts).toBe("did not finish");
    expect(m.actions).toContain("check_now");
  });

  it("a finished check is never in progress and leaves no detail", () => {
    const m = model({ status: status({ checks: [done] }) });
    expect(m.checking).toBe(false);
    expect(m.headline).toBe("Up to date");
    expect(m.detail).toBe("");
  });
});

describe("popupModel headlines", () => {
  it.each([
    ["ok", "Up to date"],
    // Before any check has run (verbatim audit gap 10): a state of its own, not "Up to date".
    ["idle", "No check yet"],
    ["login_needed", "Instagram wants you to log in again"],
    ["feed_changed", "Instagram changed something — the extension needs an update"],
    ["paused_budget", "Paused — import budget"],
  ] as const)("%s reads %s", (state, headline) => {
    expect(model({ status: status({ state }) }).headline).toBe(headline);
  });

  it("an error state reads Error: with the message the extension knows", () => {
    expect(model({ status: status({ state: "error" }), appError: "The app refused the token" }).headline).toBe("Error: The app refused the token");
  });

  it("an error state with no message names the last check's code", () => {
    const check = { id: "c", startedAt: "2026-10-23T10:00:00.000Z", finishedAt: "2026-10-23T10:01:00.000Z", found: 0, fresh: 0, filtered: 0, extracted: 0, failed: 0, errorCode: "unknown" as const };
    expect(model({ status: status({ state: "error", checks: [check] }) }).headline).toBe("Error: unknown");
  });

  it("no status with an app error is App unreachable; so is no status at all", () => {
    expect(model({ status: null, appError: "App unreachable (502)" }).headline).toBe("App unreachable");
    expect(model({ status: null }).headline).toBe("App unreachable");
  });

  it("a problem with a post never changes the headline", () => {
    const m = model({ status: status({ posts: [post({ status: "failed" }), post({ id: "p2", key: "k2", status: "filtered_out" })] }) });
    expect(m.headline).toBe("Up to date");
  });
});

describe("popupModel facts", () => {
  it("spend reads $0.42 of $5.00 this month", () => {
    expect(model().spend).toBe("$0.42 of $5.00 this month");
    expect(model({ status: status({ spend: { spentMicros: 0, capMicros: 5_000_000 } }) }).spend).toBe("$0.00 of $5.00 this month");
  });

  it("last and next check are relative to now", () => {
    const m = model();
    expect(m.lastCheck).toBe("2 h ago");
    expect(m.nextCheck).toBe("in 3 h");
    expect(model({ status: status({ lastCheckAt: null }), nextCheckAt: null }).lastCheck).toBe("never");
    expect(model({ nextCheckAt: null }).nextCheck).toBe("—");
    expect(model({ status: status({ lastCheckAt: "2026-10-23T11:59:30.000Z" }) }).lastCheck).toBe("just now");
  });

  it("the queue shows only when something waits", () => {
    expect(model().queue).toBe("");
    expect(model({ queueSize: 3 }).queue).toBe("3 waiting");
  });

  it("the last 10 checks come as counts — with how many the filter left out (spec §8) — an error check carries its code", () => {
    const c = (id: string, over = {}) => ({ id, startedAt: "2026-10-23T08:00:00.000Z", finishedAt: "2026-10-23T08:01:00.000Z", found: 5, fresh: 2, filtered: 1, extracted: 1, failed: 0, errorCode: null, ...over });
    const m = model({ status: status({ checks: [c("a"), c("b", { errorCode: "login_needed", fresh: 0 }), ...Array.from({ length: 10 }, (_, i) => c(`x${i}`))] }) });
    expect(m.checks).toHaveLength(10);
    expect(m.checks[0]).toEqual({ when: "4 h ago", counts: "5 found · 2 new · 1 filtered · 1 extracted · 0 failed", error: null });
    expect(m.checks[1]!.error).toBe("login_needed");
  });

  it("totals read as moves and posts", () => {
    expect(model().totals).toBe("4 moves from 3 posts");
  });
});

describe("popupModel posts and actions", () => {
  it("a filtered_out post offers process_anyway; a failed one retry; others nothing", () => {
    const m = model({
      status: status({
        posts: [
          post({ id: "a", key: "ka", status: "filtered_out", reason: "not a workout" }),
          post({ id: "b", key: "kb", status: "failed", reason: "media_failed" }),
          post({ id: "c", key: "kc", status: "matched" }),
        ],
      }),
    });
    const byKey = Object.fromEntries(m.posts.map((p) => [p.key, p]));
    expect(byKey.ka).toMatchObject({ actions: ["process_anyway"], status: "filtered out", reason: "not a workout", creator: "someone", url: "https://example.com/p/k1" });
    expect(byKey.kb!.actions).toEqual(["retry"]);
    expect(byKey.kc!.actions).toEqual([]);
  });

  it("a failed post's row says why it failed, not why the filter kept it (audit bug 2)", () => {
    const m = model({
      status: status({
        posts: [post({ id: "b", key: "kb", status: "failed", reason: "training (first capture)", errorCode: "media_failed", error: "The video wouldn't download" })],
      }),
    });
    expect(m.posts[0]).toMatchObject({ status: "failed", reason: "The video wouldn't download" });
  });

  it("the top-level actions are Check now plus the post actions on offer", () => {
    expect(model().actions).toEqual(["check_now"]);
    const m = model({ status: status({ posts: [post({ status: "failed" }), post({ id: "x", key: "kx", status: "filtered_out" })] }) });
    expect(m.actions).toEqual(["check_now", "process_anyway", "retry"]);
  });

  it("posts needing a hand come first, and at most 8 show", () => {
    const many = Array.from({ length: 12 }, (_, i) => post({ id: `m${i}`, key: `m${i}`, status: "matched" }));
    const m = model({ status: status({ posts: [...many, post({ id: "f", key: "f", status: "failed" })] }) });
    expect(m.posts).toHaveLength(8);
    expect(m.posts[0]!.key).toBe("f");
  });

  it("with no status there are no posts, no spend, and only Retry to offer", () => {
    const m = model({ status: null, appError: "App unreachable" });
    expect(m.posts).toEqual([]);
    expect(m.actions).toEqual(["retry"]);
    expect(m.spend).toBe("");
  });
});

describe("popupModel detail and settings", () => {
  it("carries the app error as a detail line under App unreachable", () => {
    const m = model({ status: null, appError: "App unreachable (502)" });
    expect(m.headline).toBe("App unreachable");
    expect(m.detail).toBe("App unreachable (502)");
    expect(m.actions).toEqual(["retry"]);
  });

  it("a missing token heads the popup with what to do, and offers Options", () => {
    const m = model({ status: null, appError: NOT_CONFIGURED });
    expect(m.headline).toBe("Add the app's token in Options");
    expect(m.detail).toBe("");
    expect(m.actions).toEqual(["options"]);
  });

  // The owner, reinstalling (audit 2026-11-06, I1): a wrong token read as "App unreachable" with only Retry.
  it("a token the app refused is not 'App unreachable': it says so, and offers Options, not Retry", () => {
    const m = model({ status: null, appError: TOKEN_REFUSED });
    expect(m.headline).toBe("The app refused the token — paste it in Options");
    expect(m.detail).toBe("");
    expect(m.actions).toEqual(["options"]);
  });

  it("has no detail when the status is read", () => {
    expect(model({ appError: "x" }).detail).toBe("");
  });
});

describe("popup render helpers", () => {
  it("links only https urls", () => {
    expect(safeHref("https://example.com/p/a")).toBe("https://example.com/p/a");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("http://example.com")).toBeNull();
  });

  it("accepts only shortcode-shaped keys, at most 64", () => {
    expect(isPostKey("Abc_-123")).toBe(true);
    expect(isPostKey("")).toBe(false);
    expect(isPostKey("a/b")).toBe(false);
    expect(isPostKey("a".repeat(65))).toBe(false);
    expect(isPostKey(5)).toBe(false);
  });
});

// ── The health row (design 2026-11-05 §3.2; plan Task 14) ──

const APP = "https://app.example.com";
const health = (colors: Partial<Record<HealthLightDto["light"], HealthColor>> = {}, over: Partial<Record<HealthLightDto["light"], Partial<HealthLightDto>>> = {}, worst: string | null = null): ImportHealthDto => ({
  lights: HEALTH_LIGHTS.map((light) => ({ light, color: colors[light] ?? "green", line: null, failures: [], ...over[light] })),
  worst,
});
const grey = () => health(Object.fromEntries(HEALTH_LIGHTS.map((l) => [l, "grey" as const])));
const RED = health(
  { reader: "red" },
  {
    reader: {
      line: "Reader: 3 of 4 failed",
      failures: [
        { postId: "b", title: "Zorbex hip flow", at: "2026-10-23T11:00:00.000Z", why: "The reply didn't match the format" },
        { postId: null, title: "Reader", at: "2026-10-23T10:00:00.000Z", why: "The model gateway answered 402" },
      ],
    },
  },
  "Reader: 3 of 4 failed",
);

describe("popupModel's health row", () => {
  it("seven labelled lights under the headline, each its glyph and word as well as its colour; all green, no line", () => {
    const m = model({ health: health() });
    expect(m.lights.map((l) => l.label)).toEqual(["Instagram", "YouTube", "Screening", "Reader", "Matching", "Coach", "Budget"]);
    expect(m.lights.every((l) => l.color === "green" && l.mark === "✓" && l.word === "working")).toBe(true);
    expect(m.healthLine).toBe("");
    expect(m.headline).toBe("Up to date");
  });

  it("a light that isn't green: the worst line under the row", () => {
    const m = model({ health: health({ budget: "yellow" }, { budget: { line: "Budget: $4.20 of $5.00 this month" } }, "Budget: $4.20 of $5.00 this month") });
    expect(m.healthLine).toBe("Budget: $4.20 of $5.00 this month");
    expect(m.lights.find((l) => l.light === "budget")).toMatchObject({ color: "yellow", mark: "!", word: "needs a look" });
    // Yellow is no reason to stop saying it is up to date.
    expect(m.headline).toBe("Up to date");
  });

  it("the headline never reads Up to date while a light is red (audit bug 7): it says the worst", () => {
    const m = model({ health: RED });
    expect(m.headline).toBe("Reader: 3 of 4 failed");
    expect(m.headline).not.toBe("Up to date");
    // A red light with no line of its own still keeps the headline from saying all is well.
    expect(model({ health: health({ instagram: "red" }) }).headline).not.toBe("Up to date");
    // The states that say what is wrong keep their own words; a running check says so.
    expect(model({ health: RED, status: status({ state: "login_needed" }) }).headline).toBe("Instagram wants you to log in again");
    expect(model({ health: RED, checking: true }).headline).toBe(CHECKING);
  });

  it("no data at all — a new account, a source never used — is grey, never green, and the headline is No check yet (Review Focus 4)", () => {
    const m = model({ health: grey(), status: status({ state: "idle", lastCheckAt: null }) });
    expect(m.headline).toBe("No check yet");
    for (const l of m.lights) {
      expect(l).toMatchObject({ color: "grey", mark: "–", word: "nothing to judge yet" });
      expect(l.word).not.toBe("working");
    }
    expect(m.healthLine).toBe("");
  });

  it("each light carries its failures: the post, when, why, a link to its trail in the app, and Retry where the popup can retry it", () => {
    // A post's failure retries by the post, never by pasting a link (audit 2026-11-06, I3).
    const noLink = { retryLink: null };
    const m = model({ appUrl: APP, health: RED, status: status({ posts: [post({ id: "b", key: "kb", status: "failed", errorCode: "model_failed", error: "The reader's reply didn't work" })] }) });
    const reader = m.lights.find((l) => l.light === "reader")!;
    expect(reader.line).toBe("Reader: 3 of 4 failed");
    expect(reader.failures).toMatchObject([
      { title: "Zorbex hip flow", when: "1 h ago", why: "The reply didn't match the format", href: "https://app.example.com/studio/saves/posts/b", retryKey: "kb", retrySource: null },
      { title: "Reader", when: "2 h ago", why: "The model gateway answered 402", href: null, retryKey: null, retrySource: null },
    ]);
    expect(reader.failures.map((f) => f.retryLink)).toEqual([noLink.retryLink, noLink.retryLink]);
  });

  it("no health read (an older app, a failed call): no lights, nothing said, the headline as before", () => {
    const m = model({ health: null });
    expect(m.lights).toEqual([]);
    expect(m.healthLine).toBe("");
    expect(m.headline).toBe("Up to date");
  });
});

describe("a post row opens its trail in the app", () => {
  it("links to <appUrl>/studio/saves/posts/<id>", () => {
    const m = model({ appUrl: APP, status: status({ posts: [post({ id: "p/1" })] }) });
    expect(m.posts[0]!.trailHref).toBe("https://app.example.com/studio/saves/posts/p%2F1");
    // The post itself is still a link of its own.
    expect(m.posts[0]!.url).toBe("https://example.com/p/k1");
  });

  it("no app URL: no trail link", () => {
    expect(model({ status: status({ posts: [post()] }) }).posts[0]!.trailHref).toBeNull();
  });

  it("appHref links only to the app's https origin (or a local http one)", () => {
    expect(appHref("https://app.example.com/", "/studio/saves")).toBe("https://app.example.com/studio/saves");
    expect(appHref("http://localhost:8787", "/studio/saves")).toBe("http://localhost:8787/studio/saves");
    expect(appHref("http://app.example.com", "/studio/saves")).toBeNull();
    expect(appHref("javascript:alert(1)", "/x")).toBeNull();
    expect(appHref(null, "/x")).toBeNull();
  });
});

describe("pasted links in the popup (design 2026-11-05 §3.1)", () => {
  const S = ["ht", "tps://"].join("");
  const vid = ["Zx", "9_-Qa", "B3cD"].join("");
  const watch = `${S}www.${["you", "tube.com"].join("")}/watch?v=${vid}`;
  const app = (over: Partial<LinkDto> = {}): LinkDto => ({
    id: "l1", source: "youtube", key: vid, url: watch, title: "Zorbex hip flow", addedAt: "2026-11-06T09:00:00.000Z", addedFrom: "extension",
    postId: "p1", state: "moves", words: "3 moves", moves: 3, action: null, ...over,
  });

  it("the app's links, each with its words and its trail; one the app hasn't got yet first, from the extension's own queue", () => {
    const local = [
      { source: "youtube" as const, key: vid, url: watch, addedAt: "x", error: null },
      { source: "instagram" as const, key: "ZorbexPost1", url: `${S}example.com/reel/ZorbexPost1/`, addedAt: "x", error: { code: "gone", message: "The post is gone" } },
    ];
    const rows = popupLinks([app()], local, "https://app.example.com");
    expect(rows).toEqual([
      { title: `${S}example.com/reel/ZorbexPost1/`, words: "Failed: The post is gone", href: null, action: { kind: "add", url: `${S}example.com/reel/ZorbexPost1/`, label: "Retry" } },
      { title: "Zorbex hip flow", words: "3 moves", href: "https://app.example.com/studio/saves/posts/p1", action: null },
    ]);
  });

  it("Retry and Import anyway: a link that failed before the app had it is added again; a post is processed", () => {
    expect(popupLinks([app({ postId: null, state: "failed", words: "Failed: Age-restricted", action: "retry" })], [], null)[0]!.action).toEqual({ kind: "add", url: watch, label: "Retry" });
    expect(popupLinks([app({ state: "not_training", words: "Not training", action: "import_anyway" })], [], null)[0]!.action).toEqual({
      kind: "process", source: "youtube", key: vid, label: "Import anyway",
    });
    expect(popupLinks([app({ state: "failed", words: "Failed: x", action: "retry" })], [], null)[0]!.action).toEqual({ kind: "process", source: "youtube", key: vid, label: "Retry" });
    expect(popupLinks(null, [], null)).toEqual([]);
  });

  it("a link the extension still holds while the app refuses the token, or can't be reached, waits — never 'Reading'", () => {
    const local = [{ source: "youtube" as const, key: vid, url: watch, addedAt: "x", error: null }];
    expect(linksHeld({ status: null, appError: TOKEN_REFUSED })).toBe("Waiting — the app refused the token");
    expect(linksHeld({ status: null, appError: NOT_CONFIGURED })).toBe("Waiting — add the app's token in Options");
    expect(linksHeld({ status: null, appError: "App unreachable (502)" })).toBe("Waiting for the app");
    expect(linksHeld({ status: null, appError: null })).toBe("Waiting for the app");
    expect(popupLinks([], local, null, linksHeld({ status: null, appError: TOKEN_REFUSED }))[0]!.words).toBe("Waiting — the app refused the token");
    expect(popupLinks([], local, null, null)[0]!.words).toBe("Reading");
  });

  it("the answer to Add, in a line", () => {
    expect(addAnswerLine({ ok: true, added: true, waiting: true })).toBe("Kept here — it goes to the app once the app can be reached.");
    expect(addAnswerLine({ ok: true, added: true })).toBe("Added — it'll be waiting in the coach.");
    expect(addAnswerLine({ ok: true, known: { postId: "p1", firstSeenAt: "2026-11-03T15:00:00.000Z" } })).toBe("Already in — imported Tue 3 Nov.");
    expect(addAnswerLine({ ok: false, message: "Only YouTube and Instagram links for now." })).toBe("Only YouTube and Instagram links for now.");
  });
});

describe("a YouTube read that failed before its post, in the popup (audit 2026-11-06, I3)", () => {
  it("its Retry pastes the link again", () => {
    const watch = `${["ht", "tps://www."].join("")}${["you", "tube.com"].join("")}/watch?v=Zx9_-QaB3cD`;
    const health: ImportHealthDto = {
      lights: HEALTH_LIGHTS.map((light) =>
        light === "youtube"
          ? { light, color: "red", line: "Sign in to YouTube in Chrome", failures: [{ postId: null, title: watch, at: "2026-10-23T11:00:00.000Z", why: "Sign in to YouTube in Chrome", retryLink: watch }] }
          : { light, color: "green", line: null, failures: [] },
      ),
      worst: "Sign in to YouTube in Chrome",
    };
    const f = model({ health }).lights.find((l) => l.light === "youtube")!.failures[0]!;
    expect(f).toMatchObject({ title: watch, retryKey: null, retryLink: watch });
  });
});
