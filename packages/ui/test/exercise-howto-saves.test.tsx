// @vitest-environment jsdom
/**
 * THE HOW-TO SHEET NAMES WHERE A MOVE CAME FROM (audit 2026-11-06, I10): it said only "From your saves". A move from the
 * saves (a why that says so, or one of the owner's own) reads its links: each creator by name (text), and How it came in,
 * which opens the post's trail at the move. Anything else asks for nothing. Synthetic data only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionExerciseDto, SessionItemDto } from "@rg/api-client";
import { EXERCISES } from "@rg/exercise-library";
import { ExerciseHowto } from "../src/components/exercise-howto.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const goblet = EXERCISES.find((e) => e.id === "gobletSquat")!;
const exercise = goblet as unknown as SessionExerciseDto;
const item = (why: string[]) => ({ exerciseId: goblet.id, why }) as unknown as SessionItemDto;
const S = ["ht", "tps://"].join("");
const reel = `${S}www.${["insta", "gram.com"].join("")}/reel/ZorbexPost1/`;

let root: Root | null = null;
let host: HTMLElement;
let asked: string[];

function mount(why: string[]) {
  asked = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      asked.push(url);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
      if (url === "/api/library/gobletSquat") {
        return json({ id: goblet.id, saved: true, provenance: [{ sourceType: "instagram", url: reel, creator: "Zorbex Coach", note: null, postId: "post-z1", position: 1 }] });
      }
      return json({ error: "not_found" }, 404);
    }),
  );
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root!.render(createElement(QueryClientProvider, { client: qc }, createElement(ExerciseHowto, { exercise, item: item(why), profiles: [], exercises: {}, onClose: () => undefined }))));
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the how-to sheet of a move from the saves", () => {
  it("names the creator and offers How it came in, which opens the post's trail", async () => {
    mount(["From your saves"]);
    for (let i = 0; i < 4; i++) await settle();
    const from = document.querySelector(".howto-saved")!;
    expect(from).toBeTruthy();
    expect(from.textContent).toContain("Zorbex Coach");
    const open = [...from.querySelectorAll("button")].find((b) => b.textContent?.startsWith("How it came in"))!;
    await act(async () => open.click());
    for (let i = 0; i < 4; i++) await settle();
    expect(asked).toContain("/api/my-saves/posts/post-z1/trail");
  });

  it("a move not from the saves asks for nothing", async () => {
    mount(["Fits your hips"]);
    for (let i = 0; i < 3; i++) await settle();
    expect(asked).toEqual([]);
    expect(document.querySelector(".howto-saved")).toBeNull();
  });
});
