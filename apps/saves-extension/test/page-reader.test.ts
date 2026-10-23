import { describe, expect, it, vi } from "vitest";
import { classifyPageResponse, createPageReader, IG_APP_ID, type RawPageResponse, type TabsAdapter } from "../src/page-reader.js";
import { LoginNeededError, PostGoneError, ReaderError } from "../src/errors.js";

const raw = (over: Partial<RawPageResponse> = {}): RawPageResponse => ({
  status: 200,
  contentType: "application/json; charset=utf-8",
  redirected: false,
  finalUrl: "https://www.instagram.com/api/v1/feed/saved/posts/",
  text: '{"items":[],"status":"ok"}',
  ...over,
});

describe("classifyPageResponse", () => {
  it("returns the parsed JSON of a good answer", () => {
    expect(classifyPageResponse(raw(), "feed")).toEqual({ items: [], status: "ok" });
  });

  it("reads 401, 403, a login redirect, an HTML page and a login_required body as LoginNeededError", () => {
    for (const r of [
      raw({ status: 401 }),
      raw({ status: 403 }),
      raw({ redirected: true, finalUrl: "https://www.instagram.com/accounts/login/?next=%2F" }),
      raw({ contentType: "text/html; charset=utf-8", text: "<!DOCTYPE html><html></html>" }),
      raw({ status: 400, text: '{"message":"login_required","status":"fail"}' }),
      raw({ text: '{"require_login":true,"status":"fail"}' }),
    ]) {
      expect(() => classifyPageResponse(r, "feed")).toThrow(LoginNeededError);
    }
  });

  it("reads a single post the site will not give (a 4xx other than a login or a rate limit) as gone, and other failures as a reader error", () => {
    expect(() => classifyPageResponse(raw({ status: 404, text: '{"message":"Media not found"}' }), "post")).toThrow(PostGoneError);
    expect(() => classifyPageResponse(raw({ status: 400, text: '{"message":"Media not found or unavailable","status":"fail"}' }), "post")).toThrow(PostGoneError);
    expect(() => classifyPageResponse(raw({ status: 400, text: '{"message":"something else","status":"fail"}' }), "post")).toThrow(PostGoneError);
    expect(() => classifyPageResponse(raw({ status: 429, text: "" }), "post")).toThrow(ReaderError);
    expect(() => classifyPageResponse(raw({ status: 500, text: "" }), "post")).toThrow(ReaderError);
    expect(() => classifyPageResponse(raw({ status: 400, text: "{}" }), "feed")).toThrow(ReaderError);
    expect(() => classifyPageResponse(raw({ status: 429, text: "" }), "feed")).toThrow(ReaderError);
    expect(() => classifyPageResponse(raw({ status: 0, text: "", error: "TypeError: Failed to fetch" }), "feed")).toThrow(ReaderError);
    expect(() => classifyPageResponse(raw({ text: "not json" }), "feed")).toThrow(ReaderError);
  });
});

function fakeTabs(existing: { id: number; url: string } | null): TabsAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    findTab: vi.fn(async () => existing),
    openTab: vi.fn(async (url: string) => {
      calls.push(`open ${url}`);
      return { id: 7, url };
    }),
    closeTab: vi.fn(async (id: number) => {
      calls.push(`close ${id}`);
    }),
    fetchInTab: vi.fn(async (tabId: number, path: string, appId: string) => {
      calls.push(`fetch ${tabId} ${path} ${appId}`);
      return raw();
    }),
  };
}

describe("createPageReader", () => {
  it("opens a background tab when none exists, reads through it, and closes it afterwards", async () => {
    const tabs = fakeTabs(null);
    const reader = createPageReader(tabs);
    await reader.readSavedPage(null);
    await reader.readSavedPage("cursor 2");
    await reader.readPost("3141592653589793238");
    await reader.close();
    expect(tabs.calls).toEqual([
      "open https://www.instagram.com/",
      `fetch 7 /api/v1/feed/saved/posts/ ${IG_APP_ID}`,
      `fetch 7 /api/v1/feed/saved/posts/?max_id=cursor%202 ${IG_APP_ID}`,
      `fetch 7 /api/v1/media/3141592653589793238/info/ ${IG_APP_ID}`,
      "close 7",
    ]);
    expect(IG_APP_ID).toBe("936619743392459");
  });

  it("uses the owner's open tab and leaves it open", async () => {
    const tabs = fakeTabs({ id: 3, url: "https://www.instagram.com/explore/" });
    const reader = createPageReader(tabs);
    await reader.readSavedPage(null);
    await reader.close();
    expect(tabs.calls).toEqual([`fetch 3 /api/v1/feed/saved/posts/ ${IG_APP_ID}`]);
  });

  it("a tab that landed on the login page is LoginNeededError, before any read", async () => {
    const tabs = fakeTabs(null);
    tabs.openTab = vi.fn(async () => ({ id: 9, url: "https://www.instagram.com/accounts/login/" }));
    const reader = createPageReader(tabs);
    await expect(reader.readSavedPage(null)).rejects.toBeInstanceOf(LoginNeededError);
    expect(tabs.fetchInTab).not.toHaveBeenCalled();
    await reader.close();
    expect(tabs.closeTab).toHaveBeenCalledWith(9);
  });

  it("refuses a pk that is not a number", async () => {
    const reader = createPageReader(fakeTabs(null));
    await expect(reader.readPost("../x")).rejects.toThrow();
  });
});
