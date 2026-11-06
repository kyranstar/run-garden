import { saveOptions } from "./options-model.js";
import { chromeStore } from "./queue.js";
import { BUILT_APP_ORIGIN, loadSettings } from "./settings.js";

// The options page: the app URL, the import token and (for a probe) the pages per check, kept in chrome.storage.local.
// The saved token is never written back into the page or logged: a blank token field keeps the one saved. Save tests
// the token on the app first and says plainly how it went (options-model.ts).

const form = document.getElementById("form") as HTMLFormElement;
const appUrl = document.getElementById("appUrl") as HTMLInputElement;
const token = document.getElementById("token") as HTMLInputElement;
const maxPages = document.getElementById("maxPages") as HTMLInputElement;
const status = document.getElementById("status") as HTMLOutputElement;

async function load(): Promise<void> {
  const saved = await loadSettings(chromeStore);
  appUrl.value = saved?.appUrl ?? BUILT_APP_ORIGIN;
  token.placeholder = saved ? "Saved" : "";
  maxPages.value = saved?.maxPages ? String(saved.maxPages) : "";
}

const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (button?.disabled) return;
  if (button) button.disabled = true;
  status.textContent = "Testing the token…";
  void (async () => {
    try {
      const out = await saveOptions(
        { appUrl: appUrl.value, token: token.value, maxPages: maxPages.value ? Number(maxPages.value) : null },
        { store: chromeStore, fetchImpl: (input, init) => fetch(input, init) },
      );
      if (out.saved) {
        token.value = "";
        token.placeholder = "Saved";
      }
      status.textContent = out.line;
    } catch {
      status.textContent = "Couldn't save — try again.";
    } finally {
      if (button) button.disabled = false;
    }
  })();
});

void load();
