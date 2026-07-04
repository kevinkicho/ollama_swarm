import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
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
      console.info("[perf] react-scan enabled — overlay shows re-render frequencies. Use on live runs via ?scan=1");
    });
  }
  // Always expose for live-run measurements without reload: window.enableReactScan()
  (window as any).enableReactScan = () => {
    void import("react-scan").then(({ scan }) => {
      scan({ enabled: true });
      console.info("[perf] react-scan enabled at runtime for this live run.");
    });
  };
  console.debug("[perf] react-scan helper ready: call window.enableReactScan() or append ?scan=1");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* T-Item-MultiTenant Phase 9 (2026-05-04): BrowserRouter wraps
        the whole app so route-based navigation (/runs/:runId) works.
        Routes themselves declared inside App.tsx so each branch can
        access useSwarm + the existing zustand store. */}
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
