# Performance review tooling

Three tools wired in on 2026-04-24. Everything is opt-in — normal
`npm run dev` / `npm run build` don't trigger any of them.

## Baseline (2026-04-24)

| Build | Score | LCP   | FCP   | CLS | TBT    | Bundle (gz) |
| ----- | ----- | ----- | ----- | --- | ------ | ----------- |
| dev (vite serve)     | 57/100  | 12.9s | 7.2s  | 0 | 90 ms  | 2 MB unminified |
| **prod (vite build)** | **100/100** | **1.4s** | **1.4s** | **0** | **10 ms** | **~80 KB (gz)** |

The dev-mode numbers are Vite-dev artifact (unminified per-module
serving). The **production build is the real number**: perfect score,
every Core Web Vital green. Only opportunity Lighthouse flagged was
"reduce unused JS" saving 43 KiB — barely worth chasing.

Reports in this folder:
- `baseline-2026-04-24.report.html` — dev-mode scan
- `prod-baseline-2026-04-24.report.html` — production-build scan

## 1. Lighthouse

```
# Dev build:
cd perf-reports
CHROME_PATH=/home/kevin/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome \
  npx lighthouse http://localhost:52244/ \
  --chrome-flags="--headless=new --no-sandbox --disable-dev-shm-usage" \
  --output html --output-path=./dev-$(date +%F) \
  --only-categories=performance

# Production build:
cd web && ANALYZE=1 npm run build && npx vite preview --port 52245 &
cd ../perf-reports
CHROME_PATH=/home/kevin/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome \
  npx lighthouse http://localhost:52245/ \
  --chrome-flags="--headless=new --no-sandbox --disable-dev-shm-usage" \
  --output html --output-path=./prod-$(date +%F) \
  --only-categories=performance
```

WSL note: Lighthouse can't drive Windows-side Chrome (devtools port
isn't reachable across the WSL↔Windows network boundary). The
`CHROME_PATH` points at the Playwright-cached Linux Chromium that's
already on disk.

## 2. Bundle analyzer (rollup-plugin-visualizer)

```
cd web
ANALYZE=1 npm run build
# Outputs dist/stats.html — open in browser for an interactive treemap
```

The visualizer is gated on `ANALYZE=1`; a normal `npm run build`
stays clean and doesn't emit stats.html.

## 3. react-scan (re-render visualizer)

Only loads in dev mode AND only when explicitly requested via a URL
flag. Production bundle is unaffected — tree-shaken out entirely.

```
# Start dev server normally:
npm run dev

# Then in the browser, add ?scan=1 to the URL (or #scan):
http://localhost:52244/?scan=1
```

Look for the overlay over re-rendering components. Agent cards that
flash on every WS event are expected; anything ELSE re-rendering
unnecessarily is a hotspot worth looking at.

## What to do when a run becomes slow

1. Refresh the production Lighthouse baseline (Tool 1) and compare.
   If the score dropped: look at the Opportunities section.
2. If JS bundle looks bloated: `ANALYZE=1 npm run build`, open
   `dist/stats.html`, find the new big node.
3. If the slow feel is "UI jank when events arrive": load with
   `?scan=1`, watch which component is re-rendering too often, then
   wrap with `React.memo` or pull props out of a bigger parent.
