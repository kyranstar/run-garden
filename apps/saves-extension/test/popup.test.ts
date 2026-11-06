// @vitest-environment jsdom
/**
 * The popup, drawn (plan Task 14): the health row under the headline — seven lights, the worst line, a light's failures
 * one tap down with links into the app — and each post's creator opening its trail in the app. Every text is set with
 * textContent: a stranger's words never become markup. The background is a stubbed `chrome.runtime`. Synthetic data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEALTH_LIGHTS, type ImportHealthDto, type SavesStatusDto } from "@rg/saves";
import type { StatusResponse } from "../src/background.js";

const HOSTILE = '<img src=x onerror="alert(1)">maker';
const NOW = Date.parse("2026-10-23T12:00:00.000Z");

const status = (): SavesStatusDto => ({
  state: "ok",
  lastCheckAt: "2026-10-23T10:00:00.000Z",
  lastImportAt: null,
  totals: { moves: 4, posts: 3 },
  checks: [],
  posts: [
    { id: "p1", key: "k1", url: "https://example.com/p/k1", creator: { handle: HOSTILE }, status: "failed", reason: null, errorCode: "model_failed", error: "The reader's reply didn't work", updatedAt: "2026-10-23T09:00:00.000Z" },
  ],
  spend: { spentMicros: 0, capMicros: 5_000_000 },
});
const health = (): ImportHealthDto => ({
  lights: HEALTH_LIGHTS.map((light) =>
    light === "reader"
      ? { light, color: "red", line: "Reader: 3 of 4 failed", failures: [{ postId: "p1", title: "Zorbex hip flow", at: "2026-10-23T11:00:00.000Z", why: "The reply didn't match the format" }] }
      : { light, color: light === "youtube" ? "grey" : "green", line: null, failures: [] },
  ),
  worst: "Reader: 3 of 4 failed",
});

let messages: unknown[];

async function open(answer: Partial<StatusResponse> = {}, replies: Record<string, unknown> = {}) {
  messages = [];
  const full: StatusResponse = {
    status: status(), appError: null, queueSize: 0, nextCheckAt: null, checking: false, health: health(), appUrl: "https://app.example.com",
    links: [], localLinks: [], activeVideo: null, ...answer,
  };
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: vi.fn(async (m: { type: string }) => {
        messages.push(m);
        return m.type === "status" ? full : (replies[m.type] ?? { ok: true });
      }),
      openOptionsPage: vi.fn(),
    },
  });
  document.body.innerHTML = '<main id="root" aria-live="polite"></main>';
  vi.resetModules();
  await import("../src/popup.js");
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

const root = () => document.getElementById("root")!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("the popup", () => {
  it("asks the background once, and draws the health row under the headline: seven lights and the worst line", async () => {
    await open();
    expect(messages).toEqual([{ type: "status" }]);
    const h1 = root().querySelector("h1")!;
    expect(h1.textContent).toBe("Reader: 3 of 4 failed");
    const lights = [...root().querySelectorAll<HTMLButtonElement>("button.light")];
    expect(lights.map((b) => b.textContent)).toEqual([
      "✓Instagram: working", "–YouTube: nothing to judge yet", "✓Screening: working", "✕Reader: failing", "✓Matching: working", "✓Coach: working", "✓Budget: working",
    ]);
    // Under the headline, the row first, then its line.
    expect(h1.compareDocumentPosition(lights[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(root().querySelector(".health-line")!.textContent).toBe("Reader: 3 of 4 failed");
  });

  it("a light opens its failures in place: the post links to its trail in the app, with Retry", async () => {
    await open();
    const reader = [...root().querySelectorAll<HTMLButtonElement>("button.light")].find((b) => b.textContent?.includes("Reader"))!;
    const panel = document.getElementById(reader.getAttribute("aria-controls")!)!;
    expect(panel.hidden).toBe(true);
    reader.click();
    expect(reader.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);
    const a = panel.querySelector("a")!;
    expect(a.textContent).toBe("Zorbex hip flow");
    expect(a.getAttribute("href")).toBe("https://app.example.com/studio/saves/posts/p1");
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener noreferrer");
    expect([...panel.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Retry"]);
    reader.click();
    expect(panel.hidden).toBe(true);
  });

  it("a post's creator opens its trail in the app, the post a link of its own; a stranger's words stay text", async () => {
    await open();
    const row = [...root().querySelectorAll("li.row")].find((li) => li.textContent?.includes("failed"))!;
    const links = [...row.querySelectorAll("a")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      [HOSTILE, "https://app.example.com/studio/saves/posts/p1"],
      ["Open post", "https://example.com/p/k1"],
    ]);
    expect(root().querySelector("img")).toBeNull();
  });

  it("no health read: no lights, and the headline as the status says", async () => {
    await open({ health: null });
    expect(root().querySelectorAll("button.light")).toHaveLength(0);
    expect(root().querySelector("h1")!.textContent).toBe("Up to date");
  });
});

describe("the popup's link field (design 2026-11-05 §3.1)", () => {
  const S = ["ht", "tps://"].join("");
  const vid = ["Zx", "9_-Qa", "B3cD"].join("");
  const watch = `${S}www.${["you", "tube.com"].join("")}/watch?v=${vid}`;
  const field = () => root().querySelector("input") as HTMLInputElement;
  const addButton = () => root().querySelector("form button") as HTMLButtonElement;
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it("sits at the top; on a YouTube video it is filled with the video and reads Import this video", async () => {
    await open({ activeVideo: watch });
    expect(root().firstElementChild!.tagName).toBe("FORM");
    expect(field().placeholder).toBe("Paste a YouTube or Instagram link");
    expect(field().value).toBe(watch);
    expect(addButton().textContent).toBe("Import this video");
    await open();
    expect(field().value).toBe("");
    expect(addButton().textContent).toBe("Add");
  });

  it("Add sends the link to the background and says it was added", async () => {
    await open({}, { "add-link": { ok: true, added: true } });
    field().value = watch;
    addButton().click();
    await settle();
    expect(messages).toContainEqual({ type: "add-link", url: watch });
    expect(root().textContent).toContain("Added — it'll be waiting in the coach.");
  });

  it("a link already in says when, with Open to its trail", async () => {
    await open({}, { "add-link": { ok: true, known: { postId: "p9", firstSeenAt: "2026-11-03T15:00:00.000Z" } } });
    field().value = watch;
    addButton().click();
    await settle();
    expect(root().textContent).toContain("Already in — imported Tue 3 Nov.");
    const openLink = [...root().querySelectorAll("a")].find((a) => a.textContent === "Open")!;
    expect(openLink.getAttribute("href")).toBe("https://app.example.com/studio/saves/posts/p9");
  });

  it("anything else is refused in the popup and nothing is sent", async () => {
    await open();
    field().value = `${S}vimeo.com/1`;
    addButton().click();
    await settle();
    expect(messages.filter((m) => (m as { type: string }).type === "add-link")).toEqual([]);
    expect(root().textContent).toContain("Only YouTube and Instagram links for now.");
  });

  it("recent links: each with its words; Import anyway processes the video by its source", async () => {
    await open({
      links: [{
        id: "l1", source: "youtube", key: vid, url: watch, title: HOSTILE, addedAt: "2026-11-06T09:00:00.000Z", addedFrom: "extension",
        postId: "p1", state: "not_training", words: "Not training", moves: null, action: "import_anyway",
      }],
    });
    expect(root().textContent).toContain("Recent links");
    expect(root().textContent).toContain("Not training");
    expect(root().querySelector("img")).toBeNull();
    const anyway = [...root().querySelectorAll("button")].find((b) => b.textContent === "Import anyway")!;
    anyway.click();
    await settle();
    expect(messages).toContainEqual({ type: "override", key: vid, source: "youtube", action: "process" });
  });
});

describe("a YouTube post's row (final audit G10)", () => {
  it("Process anyway names its source, so the app finds it", async () => {
    const s = status();
    s.posts = [{ ...s.posts[0]!, key: "Zx9_-QaB3cD", source: "youtube", status: "filtered_out", creator: { handle: "@zorbexcoach" } }];
    await open({ status: s });
    const b = [...root().querySelectorAll("button")].find((x) => x.textContent === "Process anyway")!;
    b.click();
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    expect(messages).toContainEqual({ type: "override", key: "Zx9_-QaB3cD", source: "youtube", action: "process" });
  });
});

describe("the popup's field across a re-render (final audit G18)", () => {
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const field = () => root().querySelector("input") as HTMLInputElement;
  const add = () => root().querySelector("form button") as HTMLButtonElement;
  const checkNow = () => [...root().querySelectorAll("button")].find((b) => b.textContent === "Check now")!;

  it("keeps what's typed, the focus and the caret while the status is read again", async () => {
    await open();
    field().value = "youtu.be/Zx9_-QaB3cD";
    field().dispatchEvent(new Event("input"));
    field().focus();
    field().setSelectionRange(3, 5);
    checkNow().click();
    await settle();
    expect(field().value).toBe("youtu.be/Zx9_-QaB3cD");
    expect(document.activeElement).toBe(field());
    expect([field().selectionStart, field().selectionEnd]).toEqual([3, 5]);
  });

  it("Add stays disabled until the add settles, whatever re-renders meanwhile", async () => {
    await open({}, { "add-link": new Promise(() => undefined) });
    field().value = ["ht", "tps://www.", "you", "tube.com/watch?v=Zx9_-QaB3cD"].join("");
    add().click();
    await settle();
    checkNow().click();
    await settle();
    expect(add().disabled).toBe(true);
  });

  it("takes a bare youtu.be link (no browser URL check), and an empty Add does nothing", async () => {
    await open();
    expect((root().querySelector("form") as HTMLFormElement).noValidate).toBe(true);
    add().click();
    await settle();
    expect(messages.filter((m) => (m as { type: string }).type === "add-link")).toEqual([]);
    expect(root().textContent).not.toContain("Only YouTube and Instagram links for now.");
  });
});

describe("the token, in the popup (audit 2026-11-06, I1)", () => {
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it("a refused token heads the popup with what to do and offers Options, not Retry; a held link waits", async () => {
    const vid = ["Zx", "9_-Qa", "B3cD"].join("");
    const url = `${["ht", "tps://www."].join("")}${["you", "tube.com"].join("")}/watch?v=${vid}`;
    await open({ status: null, appError: "The app refused the token — paste it in Options", health: null, localLinks: [{ source: "youtube", key: vid, url, error: null }] });
    expect(root().querySelector("h1")!.textContent).toBe("The app refused the token — paste it in Options");
    const labels = [...root().querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toContain("Options");
    expect(labels).not.toContain("Retry");
    expect(root().textContent).toContain("Waiting — the app refused the token");
    expect(root().textContent).not.toContain("Reading");
    [...root().querySelectorAll("button")].find((b) => b.textContent === "Options")!.click();
    await settle();
    expect((globalThis as unknown as { chrome: { runtime: { openOptionsPage: { mock: { calls: unknown[] } } } } }).chrome.runtime.openOptionsPage.mock.calls).toHaveLength(1);
  });

  it("no token: the popup says to add it, with Options", async () => {
    await open({ status: null, appError: "Add the app's token in Options", health: null });
    expect(root().querySelector("h1")!.textContent).toBe("Add the app's token in Options");
    expect([...root().querySelectorAll("button")].map((b) => b.textContent)).toContain("Options");
  });
});

describe("several links pasted in the popup (audit 2026-11-06, I4)", () => {
  const S = ["ht", "tps://"].join("");
  const yt = (v: string) => `${S}www.${["you", "tube.com"].join("")}/watch?v=${v}`;
  const field = () => root().querySelector("input") as HTMLInputElement;
  const addButton = () => root().querySelector("form button") as HTMLButtonElement;
  const settle = async () => {
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it("adds each link, says how many, and why it left one out", async () => {
    await open({}, { "add-link": { ok: true, added: true } });
    field().value = `${yt("Zx9_-QaB3cD")} ${yt("Yt0000000ab")} ${S}www.${["you", "tube.com"].join("")}/playlist?list=PLzorbex`;
    addButton().click();
    await settle();
    expect(messages.filter((m) => (m as { type: string }).type === "add-link")).toEqual([
      { type: "add-link", url: yt("Zx9_-QaB3cD") },
      { type: "add-link", url: yt("Yt0000000ab") },
    ]);
    expect(root().textContent).toContain("Added 2 — they'll be waiting in the coach. Took 2 of 3 — single videos and posts only, not playlists or channels.");
  });

  it("a playlist alone is refused for what it is, and nothing is sent", async () => {
    await open();
    field().value = `${S}www.${["you", "tube.com"].join("")}/playlist?list=PLzorbex`;
    addButton().click();
    await settle();
    expect(messages.filter((m) => (m as { type: string }).type === "add-link")).toEqual([]);
    expect(root().textContent).toContain("Single videos and posts only — not playlists or channels.");
  });
});
