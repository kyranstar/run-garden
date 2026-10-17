/**
 * The coach's live tests' shared pieces (the new shape, stream C): a stubbed server, a quiet or driven step loop, and
 * the act-wrapped waits and taps. Synthetic data only.
 */
import { act } from "react";
import { vi } from "vitest";
import type { CoachRunDto, CoachRunEventDto, CoachRunStepResult } from "@rg/api-client";
import type { LoopDeps } from "../src/screens/studio/use-coach-run.js";
import { TODAY } from "./studio-fixtures.js";

export const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

export const run = (over: Partial<CoachRunDto> = {}): CoachRunDto => ({
  id: "run-1",
  role: "main",
  scope: { kind: "now" },
  request: "hips",
  status: "active",
  steps: 0,
  costUsd: 0,
  proposalId: null,
  error: null,
  createdAt: `${TODAY}T08:00:00.000Z`,
  updatedAt: `${TODAY}T08:00:00.000Z`,
  finishedAt: null,
  estimateUsd: null,
  ceilingUsd: 1.5,
  ...over,
});

export interface Call {
  method: string;
  path: string;
  query: string;
  body: any;
}

export type Routes = Record<string, unknown | ((body: any, query: string) => Response | unknown)>;

/** The server: `"METHOD /path"` → an answer (a value, a Response, or a function of the body). Anything else is a 503. */
export function serve(routes: Routes): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const [path, query = ""] = String(input).split("?") as [string, string?];
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, query, body });
      const answer = routes[`${method} ${path}`];
      if (answer === undefined) return json({ error: "offline" }, 503);
      const out = typeof answer === "function" ? (answer as (b: unknown, q: string) => unknown)(body, query) : answer;
      return out instanceof Response ? out.clone() : json(out);
    }),
  );
  return calls;
}

/** A loop that never steps: the read answers the server's run. */
export const quietLoop =
  (r: () => CoachRunDto, events: () => CoachRunEventDto[] = () => []) =>
  (): LoopDeps => ({
    step: () => new Promise(() => undefined),
    read: async () => ({ run: r(), events: events() }),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    visible: () => true,
    onVisibility: () => () => undefined,
  });

/** A loop the test drives: each step waits until `answer` gives its result; the read answers the server's run. */
export function drivenLoop(server: () => CoachRunDto, events: () => CoachRunEventDto[] = () => []) {
  const waiting: Array<(r: CoachRunStepResult) => void> = [];
  const deps = (): LoopDeps => ({
    step: () => new Promise<CoachRunStepResult>((r) => waiting.push(r)),
    read: async () => ({ run: server(), events: events() }),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    visible: () => true,
    onVisibility: () => () => undefined,
  });
  const answer = async (r: CoachRunStepResult) => {
    await until(() => waiting.length > 0, "a step out");
    await act(async () => waiting.shift()!(r));
    await settle(10);
  };
  return { deps, answer };
}

export const settle = (ms = 0) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

export const text = () => (document.body.textContent ?? "").replace(/\s+/g, " ");

export async function until(test: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (test()) return;
    await settle(5);
  }
  throw new Error(`waited for ${what}; the page says: ${text()}`);
}

export async function click(el: Element | null | undefined, what: string) {
  if (!el) throw new Error(`no ${what} in: ${text()}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

export const button = (name: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name) ?? null;

export const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

export async function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

export async function press(key: string, target: EventTarget = document) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
  await settle();
}
