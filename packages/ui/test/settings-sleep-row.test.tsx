// @vitest-environment jsdom
/**
 * SLEEP FROM COROS, WHEN COROS STOPS ACCEPTING THE CONNECTION (seen live from 2026-11-18). COROS answered every sleep
 * read with a refusal in place of data, and the row went on saying "Connected · synced 1d ago". Now the worker marks a
 * refused grant (`error`, `credentials_rejected`) and the row says so, with Reconnect; an expired grant keeps its own
 * words. And since 2026-11-19 it says what fixed it then: COROS's MCP refused every call ("identity mismatched … Verify
 * COROS App login status") until the owner signed in to the COROS phone app again — so a refused grant says to check the
 * app's sign-in first. Synthetic data only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { CorosSleepRow } from "../src/screens/settings.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

function render(conn: { status: string; lastSyncAt: string | null; lastErrorCategory: string | null }) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient();
  act(() => root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(CorosSleepRow, { conn })))));
  return host;
}

const words = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
const DAY_AGO = new Date(Date.now() - 86_400_000).toISOString();
/** A refused grant's words: the COROS app's sign-in first (the 2026-11-19 fix), then Reconnect. */
const REFUSED =
  "COROS stopped accepting this connection. Check that the COROS app on your phone is signed in to the same COROS account, then Reconnect.";
const EXPIRED = "Sleep sync stopped — COROS expired the connection. Reconnect to resume.";

describe("Sleep from COROS", () => {
  it("a grant COROS refused: says so, never 'synced', and offers Reconnect", () => {
    const el = render({ status: "error", lastSyncAt: DAY_AGO, lastErrorCategory: "credentials_rejected" });
    expect(words(el)).toContain("Sleep from COROS");
    expect(words(el)).toContain(REFUSED);
    expect(words(el)).not.toMatch(/synced|Connected/);
    const link = el.querySelector<HTMLAnchorElement>("a.btn")!;
    expect(words(link)).toBe("Reconnect");
    expect(link.getAttribute("href")).toBe("/api/auth/coros-mcp/start?redirect=/settings");
  });

  it("an expired grant, or any other reason, keeps today's words: no word of the phone app", () => {
    for (const category of ["needs_reauth", null, "api_error"]) {
      const el = render({ status: "error", lastSyncAt: DAY_AGO, lastErrorCategory: category });
      expect([category, words(el)]).toEqual([category, `Sleep from COROS${EXPIRED}Reconnect`]);
      expect(words(el)).not.toContain("COROS app");
      act(() => root?.unmount());
      host?.remove();
    }
  });

  it("a healthy connection reads as it did", () => {
    const el = render({ status: "connected", lastSyncAt: DAY_AGO, lastErrorCategory: null });
    expect(words(el)).toContain("Connected · nightly duration and depth · synced");
  });
});
