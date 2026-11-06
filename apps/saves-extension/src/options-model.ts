import { checkToken, createAppClient } from "./app-client.js";
import type { KvStore } from "./queue.js";
import { BUILT_APP_ORIGIN, loadSettings, saveSettings, validateSettings } from "./settings.js";

// The options page's Save, as a function of its fields (tested without a page): the settings checked, the token tested
// on the app (audit 2026-11-06, I1: "Saved" was said without asking), and saved unless the app refused it — so a token
// that works is never replaced by one that doesn't. The token is never logged or put in a URL or a line.

export interface OptionsInput {
  appUrl: string;
  /** Blank keeps the token saved before (the page never shows it). */
  token: string;
  maxPages: number | null;
}

export async function saveOptions(
  input: OptionsInput,
  deps: { store: KvStore; fetchImpl: typeof fetch; builtOrigin?: string },
): Promise<{ saved: boolean; line: string }> {
  const before = await loadSettings(deps.store);
  const checked = validateSettings({ appUrl: input.appUrl, token: input.token || before?.token || "", maxPages: input.maxPages }, deps.builtOrigin ?? BUILT_APP_ORIGIN);
  if (!checked.ok) return { saved: false, line: checked.message };
  const tested = await checkToken(createAppClient({ appUrl: checked.settings.appUrl, token: checked.settings.token, fetchImpl: deps.fetchImpl }));
  if (tested.state === "refused") return { saved: false, line: tested.line };
  await saveSettings(deps.store, checked.settings);
  return { saved: true, line: tested.line };
}
