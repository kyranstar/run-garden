import { chromeStore } from "./queue.js";
import { BUILT_APP_ORIGIN, loadSettings, saveSettings, validateSettings } from "./settings.js";

// The options page: the app URL, the import token and (for a probe) the pages per check, kept in chrome.storage.local.
// The saved token is never written back into the page or logged: a blank token field keeps the one saved.

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

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    const saved = await loadSettings(chromeStore);
    const checked = validateSettings({
      appUrl: appUrl.value,
      token: token.value || saved?.token || "",
      maxPages: maxPages.value ? Number(maxPages.value) : null,
    });
    if (!checked.ok) {
      status.textContent = checked.message;
      return;
    }
    await saveSettings(chromeStore, checked.settings);
    token.value = "";
    token.placeholder = "Saved";
    status.textContent = "Saved";
  })();
});

void load();
