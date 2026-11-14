import "@vanr/ui/styles.css";
import "./gallery.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { mirrorPointerStates } from "./forceStates.ts";

const root = document.getElementById("root");
if (root === null) throw new Error("gallery: #root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Styles are in the document once the module graph has run.
requestAnimationFrame(mirrorPointerStates);
