import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/list.css";
import "./styles/thread.css";
import "./styles/compose.css";
import "./styles/overlays.css";
import "./styles/settings.css";
import "./styles/agents.css";
import "./styles/cloud.css";
import "./styles/models.css";
import "./styles/autopilot.css";
import "./styles/labels.css";
import "./styles/signals.css";
import "./styles/onboarding.css";

// Apply the saved theme before the first paint so there is no flash.
try {
  const theme = localStorage.getItem("ss-theme");
  if (theme === "dark" || theme === "light") document.documentElement.setAttribute("data-theme", theme);
} catch {
  /* private mode */
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
