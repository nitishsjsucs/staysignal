import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function App() {
  return (
    <main>
      <h1>StaySignal</h1>
      <p>Synthetic company: Larkspur Systems. The app arrives in M1.</p>
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);
