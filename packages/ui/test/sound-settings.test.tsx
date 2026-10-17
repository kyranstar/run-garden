// @vitest-environment jsdom
/**
 * THE SESSION'S SOUND, SET (the sound pass, 2026-10-17): one shared control for the player's Settings sheet and the
 * app's Settings — sound on/off (a real switch), the volume (a slider that applies as it moves), and the sounds
 * (Automatic, Soft keys, Bowls, Kalimba), each with a ▶ that plays the countdown into go inside the tap.
 *
 * In app Settings it is one row ("Sounds", with what is set) that opens the controls, so the athlete can set it before a
 * session; what is set is kept on this device, where the player reads it.
 */
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { SoundSettings } from "../src/components/sound-settings.js";
import type { CuePlayer, SoundSettings as Sound } from "../src/player/cue-player.js";
import { readSound, type StoredSound } from "../src/player/sound-settings.js";
import { SoundsSection } from "../src/screens/settings/sounds.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  localStorage.clear();
});

function render(el: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
}

function fakePlayer() {
  const calls = { preview: [] as Array<[string, string | undefined]>, configure: [] as Sound[] };
  const player: Pick<CuePlayer, "preview" | "configure"> = {
    preview: (cue, palette) => void calls.preview.push([cue, palette]),
    configure: (s) => void calls.configure.push({ ...s }),
  };
  return { player, calls };
}

const text = () => (document.body.textContent ?? "").replace(/\s+/g, " ");
const byLabel = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("button, input")].find((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").replace(/\s+/g, " ").trim() === name);
async function click(name: string) {
  const b = byLabel(name);
  if (!b) throw new Error(`no control ${name}\n${text()}`);
  await act(async () => b.click());
}
async function slide(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The control with its own state, as a parent keeps it. */
function Harness({ calm, player, seen }: { calm: boolean; player: Pick<CuePlayer, "preview">; seen: StoredSound[] }) {
  const [value, setValue] = useState<StoredSound>({ on: true, volume: 0.7, choice: "auto" });
  return createElement(SoundSettings, {
    value,
    calm,
    player,
    onChange: (next: StoredSound) => {
      seen.push(next);
      setValue(next);
    },
  });
}

describe("the sound control", () => {
  it("a real switch for sound, a volume slider that applies as it moves, and the four sounds as one choice", async () => {
    const seen: StoredSound[] = [];
    const { player } = fakePlayer();
    render(createElement(Harness, { calm: false, player, seen }));
    const sw = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.getAttribute("aria-label")).toBe("Sound");
    const volume = byLabel("Volume") as HTMLInputElement;
    expect(volume.type).toBe("range");
    expect(volume.value).toBe("70");
    await slide(volume, "55");
    await slide(volume, "30");
    expect(seen.map((s) => s.volume)).toEqual([0.55, 0.3]);
    const group = document.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-label")).toBe("Sounds");
    const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false"]);
    await act(async () => radios[2]!.click());
    expect(seen.at(-1)).toEqual({ on: true, volume: 0.3, choice: "bowl" });
    expect([...group.querySelectorAll('[role="radio"]')].map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false", "true", "false"]);
    await act(async () => sw.click());
    expect(seen.at(-1)).toEqual({ on: false, volume: 0.3, choice: "bowl" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });

  it("each sound's ▶ plays the countdown into go in that sound; Automatic's is the session's", async () => {
    const { player, calls } = fakePlayer();
    render(createElement(Harness, { calm: true, player, seen: [] }));
    await click("Play Soft keys");
    await click("Play Kalimba");
    await click("Play Automatic");
    expect(calls.preview).toEqual([["count", "keys"], ["count", "kalimba"], ["count", "bowl"]]);
  });

  it("every control is a fingertip (44px) and a word, never a colour alone", () => {
    const html = renderToStaticMarkup(createElement(SoundSettings, { value: { on: true, volume: 0.7, choice: "keys" }, onChange: () => undefined }));
    expect(html).toContain('class="program-switch"');
    expect(html).toContain("Soft keys");
    expect(html).toContain('aria-checked="true"');
  });
});

describe("app Settings: Sounds", () => {
  it("one row that says what is set and opens the controls; a change is kept on this device and heard at once", async () => {
    localStorage.setItem("rg-player-sound", JSON.stringify({ on: true, volume: 0.4, choice: "kalimba" }));
    const { player, calls } = fakePlayer();
    render(createElement(SoundsSection, { player }));
    const row = byLabel("Sounds Kalimba · 40%") ?? [...document.querySelectorAll("button")].find((b) => b.textContent!.includes("Sounds"));
    expect(row).toBeDefined();
    expect(row!.textContent!.replace(/\s+/g, " ")).toContain("Kalimba · 40%");
    expect(document.querySelector('[role="switch"]')).toBeNull();
    await act(async () => row!.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    const radios = [...document.querySelectorAll<HTMLElement>('[role="dialog"] [role="radio"]')];
    await act(async () => radios[0]!.click());
    expect(readSound()).toEqual({ on: true, volume: 0.4, choice: "auto" });
    // Heard at once: the cue player has it (a preview plays at the volume set), soft keys outside a session.
    expect(calls.configure.at(-1)).toEqual({ on: true, volume: 0.4, palette: "keys" });
    await act(async () => document.querySelector<HTMLElement>('[role="dialog"] [role="switch"]')!.click());
    expect(readSound().on).toBe(false);
    expect(text()).toContain("Off");
  });
});
