import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Perf review 2026-04-24: react-scan re-render visualizer.
// Gated on dev-mode + either a ?scan=1 query param OR a #scan URL
// hash so the overlay only loads when explicitly asked for. Dynamic
// import keeps it out of the production bundle entirely (Vite's
// tree-shaker drops the block when import.meta.env.DEV is false).
if (import.meta.env.DEV) {
  const params = new URLSearchParams(window.location.search);
  const wantScan = params.get("scan") === "1" || window.location.hash === "#scan";
  if (wantScan) {
    void import("react-scan").then(({ scan }) => {
      scan({ enabled: true });
      console.info("[perf] react-scan enabled — overlay shows re-render frequencies");
    });
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
