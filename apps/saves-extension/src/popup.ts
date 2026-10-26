import type { CheckNowResponse, OverrideResponse, StatusResponse } from "./background.js";
import { CHECKING, popupModel, safeHref, type PopupAction, type PopupModel } from "./status.js";

// Renders popupModel with plain DOM (text is always set with textContent). The popup holds no token and calls no app
// route itself: it asks the background, which calls the token routes.

const root = document.getElementById("root") as HTMLElement;

const LABELS: Record<PopupAction, string> = { check_now: "Check now", process_anyway: "Process anyway", retry: "Retry", options: "Options" };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(label: string, onClick: (b: HTMLButtonElement) => void, quiet = false): HTMLButtonElement {
  const b = el("button", label, quiet ? "quiet" : undefined);
  b.type = "button";
  b.addEventListener("click", () => onClick(b));
  return b;
}

const ask = <T>(message: unknown): Promise<T> => chrome.runtime.sendMessage(message) as Promise<T>;

let note = "";
/** While a check runs, the popup re-reads the status every few seconds so a reopened popup shows it moving. */
const REFRESH_MS = 5_000;
let refresh: ReturnType<typeof setTimeout> | null = null;

async function load(): Promise<void> {
  let answer: StatusResponse;
  try {
    answer = await ask<StatusResponse>({ type: "status" });
  } catch {
    answer = { status: null, appError: "the extension did not answer", queueSize: 0, nextCheckAt: null, checking: false };
  }
  const m = popupModel({ ...answer, now: Date.now() });
  render(m);
  if (refresh) clearTimeout(refresh);
  refresh = m.checking ? setTimeout(() => void load(), REFRESH_MS) : null;
}

async function checkNow(b: HTMLButtonElement): Promise<void> {
  b.disabled = true;
  b.textContent = "Checking…";
  try {
    const answer = await ask<CheckNowResponse>({ type: "check-now" });
    note = answer.ok ? "" : `Error: ${answer.message}`;
  } catch {
    note = "Error: the extension did not answer";
  }
  await load();
}

async function override(key: string): Promise<void> {
  try {
    const answer = await ask<OverrideResponse>({ type: "override", key, action: "process" });
    note = answer.ok ? "" : `Error: ${answer.message}`;
  } catch {
    note = "Error: the extension did not answer";
  }
  await load();
}

function render(m: PopupModel): void {
  const frag = document.createDocumentFragment();
  const problem = m.headline !== "Up to date" && !m.checking;
  frag.append(el("h1", m.headline, problem ? "problem" : undefined));
  if (m.detail) frag.append(el("p", m.detail, "meta"));
  if (note) frag.append(el("p", note, "meta"));
  frag.append(el("p", [`Last check ${m.lastCheck}`, `Next ${m.nextCheck}`, m.queue].filter(Boolean).join(" · "), "meta"));
  if (m.totals) frag.append(el("p", m.totals, "meta"));
  if (m.spend) frag.append(el("p", m.spend, "meta"));

  const bar = el("div");
  for (const a of m.actions) {
    if (a === "check_now") {
      const b = button(LABELS[a], (b) => void checkNow(b));
      if (m.checking) {
        b.disabled = true;
        b.textContent = CHECKING;
      }
      bar.append(b);
    }
    else if (a === "options") bar.append(button(LABELS[a], () => void chrome.runtime.openOptionsPage()));
    else if (a === "retry" && m.posts.length === 0) bar.append(button(LABELS[a], () => void load()));
  }
  frag.append(bar);

  if (m.checks.length) {
    const list = el("ul");
    for (const c of m.checks) {
      const li = el("li", undefined, "row");
      const line = el("div", undefined, "line");
      line.append(el("span", c.when, "meta"), el("span", c.counts));
      if (c.error) line.append(el("span", c.error, "error"));
      li.append(line);
      list.append(li);
    }
    frag.append(list);
  }

  if (m.posts.length) {
    const list = el("ul");
    for (const p of m.posts) {
      const li = el("li", undefined, "row");
      const line = el("div", undefined, "line");
      const link = el("a", p.creator);
      const href = safeHref(p.url);
      if (href) {
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      line.append(link, el("span", p.status, "meta"));
      if (p.reason) line.append(el("span", p.reason, "reason"));
      li.append(line);
      for (const a of p.actions) li.append(button(LABELS[a], (b) => { b.disabled = true; void override(p.key); }, true));
      list.append(li);
    }
    frag.append(list);
  }

  root.replaceChildren(frag);
}

void load();
