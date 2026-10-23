import { describe, expect, it } from "vitest";
import type { PostRowDto, SavesStatusDto } from "@rg/saves";
import { NOT_CONFIGURED, isPostKey, popupModel, safeHref } from "../src/status.js";

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const HOUR = 3_600_000;

const post = (over: Partial<PostRowDto> = {}): PostRowDto => ({
  id: "p1",
  key: "k1",
  url: "https://example.com/p/k1",
  creator: { handle: "someone" },
  status: "matched",
  reason: null,
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

describe("popupModel headlines", () => {
  it.each([
    ["ok", "Up to date"],
    ["idle", "Up to date"],
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

  it("the newest checks come as counts, an error check carries its code", () => {
    const c = (id: string, over = {}) => ({ id, startedAt: "2026-10-23T08:00:00.000Z", finishedAt: "2026-10-23T08:01:00.000Z", found: 5, fresh: 2, filtered: 1, extracted: 1, failed: 0, errorCode: null, ...over });
    const m = model({ status: status({ checks: [c("a"), c("b", { errorCode: "login_needed", fresh: 0 }), c("c"), c("d"), c("e")] }) });
    expect(m.checks).toHaveLength(3);
    expect(m.checks[0]).toEqual({ when: "4 h ago", counts: "5 found · 2 new · 1 extracted · 0 failed", error: null });
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

  it("a missing app URL or token shows its message and offers Options", () => {
    const m = model({ status: null, appError: NOT_CONFIGURED });
    expect(m.detail).toBe(NOT_CONFIGURED);
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
