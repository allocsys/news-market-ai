# UI/UX overhaul prototype — `news-market-ai`

An interactive Next.js 16 prototype reimagining the operations dashboard. This
sits alongside the existing Cloudflare Workers monorepo as a subdirectory so it
doesn't disturb the production code — it's a parallel UI proposal for review.

## Status

🟢 **Prototype only**. Not wired to the live Cloudflare Workers backend.
All data is mock data in `src/lib/dash/mock-data.ts` (positions, decisions,
LLM calls, pipeline, backtest runs).

## What this reimagines

The production dashboard (in `../src/dashboard/` and `../src/dashboard-worker.js`)
is server-side-rendered HTML with vanilla JS, no frontend framework, single
977-line CSS template string. This prototype is a full React/Next.js rebuild
that keeps the original's design intent (navy elevation ladder, tabular
numerics, hand-rolled SVG charts, accessibility-first) while adding:

1. **Command-center Overview** (new) — fuses pipeline-alive + last decision +
   exposure + stale-source warnings + ticker spotlight into one screen,
   replacing Snapshot as the landing page.
2. **Global ticker search** — `/` keyboard shortcut opens a command palette;
   filtering by a ticker scopes *every* page (Overview, Snapshot, Decisions,
   Positions, Pipeline, LLM Calls).
3. **Auto-refresh** — visibility-API aware, 15s interval, pauses when tab
   hidden (no battery drain in background). Manual "Refresh now" + toast.
4. **Dual theme** — dark (default) / light / system preference. Manual toggle
   in top bar. Light theme is for shared-screen presentations.
5. **Single-operator login** — mirrors the production auth model: one shared
   operator credential, no roles or audit trail.
6. **Mobile bottom sheet** — replaces the old "More" overflow hub with a
   slide-up sheet (vaul) showing all 11 sections grouped by
   Monitor / Operations / System.
7. **Data export** — CSV + JSON dropdown on every DataTable.
8. **Skeleton + toast UX** — Sonner toasts on every action; PageSkeleton
   during view transitions; fade-in animations gated by
   `prefers-reduced-motion`.

## Pages (11 views + login)

| # | View | Path-equivalent | What's new |
|---|------|-----------------|------------|
| — | Login | `/login` | Single operator login, matching the production auth model |
| 1 | Overview (new) | (none) | Command center — replaces Snapshot as landing |
| 2 | Snapshot | `/dashboard/snapshot` | Refined layout, kept structure |
| 3 | Activity | `/dashboard/activity` | Range pills 7/14/30/60d, stacked-bar SVG |
| 4 | Charts | `/dashboard/charts` | Click any ticker to filter the whole dashboard |
| 5 | Health | `/dashboard/health` | Alert strip when any source goes stale |
| 6 | Decisions | `/dashboard/decisions` | Expandable LLM reasoning rows + CSV export |
| 7 | Positions | `/dashboard/positions` | CSV/JSON export on open + closed tables |
| 8 | Pipeline | `/dashboard/pipeline` | Stage distribution bars + checkpoints table |
| 9 | LLM Calls | `/dashboard/llm` + `/dashboard/llm/:id` | Cursor paging + detail dialog with cascade attempts |
| 10 | Backfill | `/dashboard/backfill` | Confirm dialog before quota-spending triggers |
| 11 | Backtest | `/dashboard/backtest` + `/dashboard/backtest/:id` | Run label + collapsible runs + equity curve |

## How to run it locally

```bash
cd prototype-ui-overhaul
bun install
bun run dev    # http://localhost:3000
```

Or with npm:

```bash
cd prototype-ui-overhaul
npm install
npm run dev
```

Log in with any non-empty username/password (demo prototype, no real auth).

## File structure

```
prototype-ui-overhaul/
├── src/
│   ├── app/
│   │   ├── page.tsx              ← Login vs dashboard switch
│   │   ├── layout.tsx            ← ThemeProvider + Sonner Toaster
│   │   └── globals.css           ← Custom navy palette + light theme
│   ├── components/dash/
│   │   ├── theme-provider.tsx
│   │   ├── login-screen.tsx
│   │   ├── dashboard-shell.tsx
│   │   ├── shell.tsx              ← Sidebar + BottomNav
│   │   ├── top-bar.tsx            ← Search + auto-refresh + theme + user menu
│   │   ├── more-sheet.tsx         ← Mobile bottom sheet
│   │   ├── shared/
│   │   │   ├── donut-chart.tsx, gauge-chart.tsx, sparkline.tsx
│   │   │   ├── bar-chart.tsx, equity-curve.tsx
│   │   │   ├── stat-card.tsx, status-badge.tsx
│   │   │   ├── data-table.tsx     ← CSV/JSON export + mobile card transform
│   │   │   ├── skeleton.tsx, empty-state.tsx
│   │   │   └── primitives.tsx     ← Panel, PageHeader, FilterPills
│   │   └── views/  (11 view components)
│   ├── hooks/                     ← use-mobile, use-toast (shadcn defaults)
│   └── lib/
│       ├── utils.ts               ← cn helper
│       └── dash/
│           ├── store.ts           ← Zustand store
│           ├── mock-data.ts       ← ~480 lines of realistic mock data
│           └── types.ts           ← Domain types
├── public/
├── screenshots/                  ← 22 PNG screenshots of every page
├── package.json
├── tailwind.config.ts
├── tsconfig.json
├── next.config.ts
├── eslint.config.mjs
├── components.json                ← shadcn/ui config
└── README.md  (this file)
```

## Tech stack

- **Next.js 16** with App Router, TypeScript, Tailwind CSS 4
- **shadcn/ui** (New York style) + Lucide icons
- **Zustand** for client state, no server state (mock data)
- **Sonner** for toasts, **vaul** (via shadcn Sheet) for mobile bottom sheet
- **Hand-rolled SVG charts** — donut, gauge, sparkline, stacked bar, equity
  curve. Zero chart library, matching the original repo's aesthetic.

## Screenshots

`./screenshots/` contains 22 PNGs covering every page in both dark and light
themes plus mobile views. See `./screenshots/README.md` for an index.

## Migration path (if you adopt it)

The components in `src/components/dash/views/*` map cleanly to the existing
`src/dashboard/views/*` modules in the production repo. To wire this to the
real Cloudflare Workers backend:

1. Replace `src/lib/dash/mock-data.ts` imports with `fetch()` calls to the
   backend service binding (same shape — the mock data was authored to match
   the production JSON responses).
2. Move the auth flow to the existing `src/auth/jwt.js` JWT pattern.
3. Replace `useDash.env` (currently just `"live"`) with the actual env
   selector (`?env=live` / `?env=backtest-<id>`) from the production worker.
4. The hand-rolled SVG charts can be reused verbatim — they take plain
   props, no React dependency for the SVG rendering itself.

The production repo's `helpers.js` already has the donut/gauge/sparkline/
bar/equity-curve SVG helpers as vanilla-JS template strings. They were the
reference for these React versions; the React versions are 1:1 in shape so
the migration is straightforward.

## Open questions for the allocsys team

1. **Command center** — what should the alert strip prioritize? (Currently:
   running jobs → stale ingestion → stalled tickers. Should it also surface
   unrealized P&L changes > N% in the last hour?)
2. **Multi-user roles** — does the existing JWT scaffolding already support
   multi-user, or do you need a `users` table in the `state` D1?
3. **Auto-refresh cadence** — 15s is a placeholder. Live trading probably
   wants faster (5s); long-running backtests probably want manual only.
4. **Light theme** — only useful for shared-screen presentations, or do you
   want it as the default for some operators?
