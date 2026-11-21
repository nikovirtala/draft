import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { loadSystemFonts } from "./fonts.ts";

// On macOS: room for the traffic lights over the header (hidden inset title bar), and Apple's fonts.
if (navigator.userAgent.includes("Macintosh")) {
  document.documentElement.classList.add("mac");
  loadSystemFonts();
}
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
