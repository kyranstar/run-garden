import type { CheckNowResponse } from "./background.js";
import type { CheckSummary } from "./check.js";

// A minimal popup until Task 10's status view: the last check's outcome and "Check now".

const line = document.getElementById("line") as HTMLParagraphElement;
const button = document.getElementById("check") as HTMLButtonElement;

const describe = (s: CheckSummary): string => (s.error ? `Error: ${s.error.message}` : "Up to date");

void chrome.storage.local.get("lastCheck").then((got) => {
  const last = got.lastCheck as CheckSummary | undefined;
  if (last) line.textContent = describe(last);
});

button.addEventListener("click", () => {
  button.disabled = true;
  line.textContent = "Checking…";
  void chrome.runtime.sendMessage({ type: "check-now" }).then(
    (answer: CheckNowResponse) => {
      line.textContent = answer.ok ? describe(answer.summary) : `Error: ${answer.message}`;
      button.disabled = false;
    },
    () => {
      line.textContent = "Error: the extension did not answer";
      button.disabled = false;
    },
  );
});
