import "@fontsource-variable/inter";
import "@fontsource-variable/source-serif-4";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

// The hidden inset title bar puts the macOS traffic lights over the app header.
if (navigator.userAgent.includes("Macintosh")) document.documentElement.classList.add("mac");
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
