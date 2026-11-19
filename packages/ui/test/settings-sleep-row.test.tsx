// @vitest-environment jsdom
/**
 * SLEEP FROM COROS, WHEN COROS STOPS ACCEPTING THE CONNECTION (seen live from 2026-11-18). COROS answered every sleep
 * read with a refusal in place of data, and the row went on saying "Connected · synced 1d ago". Now the worker marks a
 * refused grant (`error`, `credentials_rejected`) and the row says so, with Reconnect; an expired grant keeps its own
 * words. Synthetic data only.
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

describe("Sleep from COROS", () => {
  it("a grant COROS refused: says so, never 'synced', and offers Reconnect", () => {
    const el = render({ status: "error", lastSyncAt: DAY_AGO, lastErrorCategory: "credentials_rejected" });
    expect(words(el)).toContain("Sleep from COROS");
    expect(words(el)).toContain("COROS stopped accepting this connection. Reconnect.");
    expect(words(el)).not.toMatch(/synced|Connected/);
    const link = el.querySelector<HTMLAnchorElement>("a.btn")!;
    expect(words(link)).toBe("Reconnect");
    expect(link.getAttribute("href")).toBe("/api/auth/coros-mcp/start?redirect=/settings");
  });

  it("an expired grant keeps its own words", () => {
    const el = render({ status: "error", lastSyncAt: DAY_AGO, lastErrorCategory: "needs_reauth" });
    expect(words(el)).toContain("COROS expired the connection");
    expect(words(el)).not.toContain("stopped accepting");
  });

  it("a healthy connection reads as it did", () => {
    const el = render({ status: "connected", lastSyncAt: DAY_AGO, lastErrorCategory: null });
    expect(words(el)).toContain("Connected · nightly duration and depth · synced");
  });
});
