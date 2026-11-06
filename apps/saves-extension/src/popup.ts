import { LINK_REFUSED, normalizeLink } from "@rg/saves";
import type { AddLinkResponse, CheckNowResponse, OverrideResponse, StatusResponse } from "./background.js";
import {
  addAnswerLine, CHECKING, linkTrailHref, popupLinks, popupModel, safeHref, type PopupAction, type PopupLight, type PopupLink, type PopupModel,
} from "./status.js";

// Renders popupModel with plain DOM (text is always set with textContent). The popup holds no token and calls no app
// route itself: it asks the background, which calls the token routes. A post's trail opens in the app.

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

/** A link that opens apart: only to an address the model checked (`safeHref`, `appHref`). */
function link(text: string, href: string | null, className?: string): HTMLElement {
  if (!href) return el("span", text, className);
  const a = el("a", text, className);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

const ask = <T>(message: unknown): Promise<T> => chrome.runtime.sendMessage(message) as Promise<T>;

let note = "";
/** The field's last answer, and the trail it can open (an already-imported link's). */
let linkNote: { line: string; href: string | null } | null = null;
/** What the field holds between re-reads (a re-read never wipes what the owner is typing). */
let draft: string | null = null;
let last: StatusResponse | null = null;
/** While a check runs, the popup re-reads the status every few seconds so a reopened popup shows it moving. */
const REFRESH_MS = 5_000;
let refresh: ReturnType<typeof setTimeout> | null = null;

async function load(): Promise<void> {
  let answer: StatusResponse;
  try {
    answer = await ask<StatusResponse>({ type: "status" });
  } catch {
    answer = { status: null, appError: "the extension did not answer", queueSize: 0, nextCheckAt: null, checking: false, health: null, appUrl: null };
  }
  last = answer;
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

async function addLink(url: string): Promise<void> {
  const link = normalizeLink(url);
  if (!link) {
    linkNote = { line: LINK_REFUSED, href: null };
    return load();
  }
  let answer: AddLinkResponse;
  try {
    answer = await ask<AddLinkResponse>({ type: "add-link", url: link.url });
  } catch {
    answer = { ok: false, message: "The extension did not answer" };
  }
  linkNote = { line: addAnswerLine(answer), href: answer.ok && "known" in answer ? linkTrailHref(last?.appUrl, answer.known.postId) : null };
  if (answer.ok) draft = "";
  await load();
}

async function linkAction(l: PopupLink): Promise<void> {
  const a = l.action;
  if (!a) return;
  if (a.kind === "add") await ask({ type: "retry-link", url: a.url }).catch(() => undefined);
  else await ask({ type: "override", key: a.key, source: a.source, action: "process" }).catch(() => undefined);
  await load();
}

/** The field at the top: paste and Add (Enter too); on a YouTube video, filled with it and reading "Import this video". */
function linkField(): HTMLFormElement {
  const form = el("form", undefined, "link-field");
  const input = el("input");
  input.type = "url";
  input.placeholder = "Paste a YouTube or Instagram link";
  input.setAttribute("aria-label", "Paste a YouTube or Instagram link");
  const video = last?.activeVideo ?? null;
  input.value = draft ?? video ?? "";
  input.addEventListener("input", () => (draft = input.value));
  const submit = el("button", video && (draft === null || draft === video) ? "Import this video" : "Add");
  submit.type = "submit";
  form.append(input, submit);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit.disabled = true;
    void addLink(input.value);
  });
  return form;
}

/** The recent links: title, a word or two of where it stands, its trail, and Retry / Import anyway. */
function recentLinks(rows: PopupLink[]): HTMLElement | null {
  if (!rows.length) return null;
  const section = el("section", undefined, "links");
  section.append(el("h2", "Recent links"));
  const list = el("ul");
  for (const l of rows) {
    const li = el("li", undefined, "row");
    const line = el("div", undefined, "line");
    line.append(link(l.title, l.href), el("span", l.words, "meta"));
    li.append(line);
    if (l.action) li.append(button(l.action.label, (b) => { b.disabled = true; void linkAction(l); }, true));
    list.append(li);
  }
  section.append(list);
  return section;
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

/** The light whose failures are open (kept across re-reads while the popup is open). */
let openLight: string | null = null;

/**
 * The health row: seven lights (a glyph and a word as well as a colour), the worst one's line, and each light's
 * failures under the row, one open at a time — toggled in place, so the live region doesn't read the popup again.
 */
function healthRow(m: PopupModel): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (!m.lights.length) return frag;
  const row = el("div", undefined, "lights");
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", "Import health");
  const panels: Array<{ light: PopupLight; button: HTMLButtonElement; panel: HTMLElement }> = [];
  const show = () => {
    for (const p of panels) {
      p.button.setAttribute("aria-expanded", String(openLight === p.light.light));
      p.panel.hidden = openLight !== p.light.light;
    }
  };
  for (const l of m.lights) {
    const b = el("button", undefined, `light light--${l.color}`);
    b.type = "button";
    const mark = el("span", l.mark, "mark");
    mark.setAttribute("aria-hidden", "true");
    b.append(mark, el("span", l.label), el("span", `: ${l.word}`, "visually-hidden"));
    const panel = lightPanel(l);
    panel.id = `light-${l.light}`;
    b.setAttribute("aria-controls", panel.id);
    b.addEventListener("click", () => {
      openLight = openLight === l.light ? null : l.light;
      show();
    });
    row.append(b);
    panels.push({ light: l, button: b, panel });
  }
  frag.append(row);
  if (m.healthLine) frag.append(el("p", m.healthLine, "health-line"));
  for (const p of panels) frag.append(p.panel);
  show();
  return frag;
}

function lightPanel(l: PopupLight): HTMLElement {
  const panel = el("div", undefined, "light-panel");
  if (l.failures.length === 0) {
    panel.append(el("p", l.line ?? (l.color === "grey" ? "Nothing to judge in the last 7 days." : "Nothing failed in the last 7 days."), "meta"));
    return panel;
  }
  if (l.line) panel.append(el("p", l.line, "meta"));
  const list = el("ul");
  for (const f of l.failures) {
    const li = el("li", undefined, "row");
    const line = el("div", undefined, "line");
    line.append(link(f.title, f.href), el("span", f.when, "meta"), el("span", f.why, "reason"));
    li.append(line);
    if (f.retryKey) {
      const key = f.retryKey;
      li.append(button("Retry", (b) => { b.disabled = true; void override(key); }, true));
    }
    list.append(li);
  }
  panel.append(list);
  return panel;
}

function render(m: PopupModel): void {
  const frag = document.createDocumentFragment();
  const problem = m.headline !== "Up to date" && !m.checking;
  frag.append(linkField());
  if (linkNote) {
    const said = el("p", undefined, "meta link-note");
    said.append(el("span", linkNote.line));
    if (linkNote.href) said.append(" ", link("Open", linkNote.href, "quiet-link"));
    frag.append(said);
  }
  frag.append(el("h1", m.headline, problem ? "problem" : undefined));
  frag.append(healthRow(m));
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

  const links = recentLinks(popupLinks(last?.links ?? null, last?.localLinks ?? [], last?.appUrl));
  if (links) frag.append(links);

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
      // The creator opens the post's trail in the app; the post itself is a link of its own.
      const post = safeHref(p.url);
      line.append(link(p.creator, p.trailHref ?? post), el("span", p.status, "meta"));
      if (p.trailHref && post) line.append(link("Open post", post, "quiet-link"));
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
