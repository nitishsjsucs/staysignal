import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./design/tokens.css";
import "./design/motion.css";
import "./design/app.css";
import { applyTheme, readTheme } from "./theme";

applyTheme(readTheme());
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
