import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@rg/ui";
import "@rg/ui/styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
