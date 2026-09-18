# Dashboard Design Spec

A target design direction for the operations dashboard, written from scratch against what a professional analytics/ops product should look and feel like — not a critique or incremental patch of the current implementation. Treat this as the brief for a redesign, not a changelog.

## Design principles

1. **Clarity over decoration.** This is a data-dense operational tool used by one or a few operators to make real decisions (trade approvals, backfill/backtest triggers). Every visual choice should make numbers, statuses, and trends easier to scan at a glance — never purely aesthetic.
2. **Familiar patterns, not novelty.** Use conventions operators already know from tools like Linear, Vercel, Stripe Dashboard, and Grafana: sidebar or top nav, card-based summary stats, data tables with sticky headers, consistent status colors. Novel layout metaphors cost more in onboarding than they add in personality.
3. **One system, applied consistently.** A small set of reusable primitives (spacing scale, type scale, color tokens, component variants) applied everywhere, rather than one-off inline styles per section. Consistency reads as "professional" far more than any individual component choice.
4. **Legible density.** Operators want to see a lot of data per screen, but density must never come at the cost of readability — enough whitespace and clear visual grouping so a dense screen still scans in seconds, not minutes.
5. **Accessible by default.** WCAG AA contrast minimums, real focus states, semantic HTML, and color never used as the sole signal (status also gets an icon/label, not just a hue).

## Layout

- **Desktop (≥1024px):** Fixed left sidebar (240–280px) for primary navigation, persistent across scroll. Main content area uses a centered max-width (1200–1400px) with responsive gutters — don't let content stretch edge-to-edge on wide monitors.
- **Tablet (768–1023px):** Sidebar collapses to an icon-only rail (labels on hover/tap) or becomes a slide-out drawer triggered by a hamburger in the top bar.
- **Mobile (<768px):** No sidebar. Use a slim top app bar (logo/title + key status/account info) and a **fixed bottom tab bar** for the 4–5 most important sections only (not all nine — pick the primary destinations; secondary sections live inside a "More" tab or within page-level sub-navigation). Bottom bar: 56–64px tall, icon + short label per tab, active tab visually distinct (filled icon or accent underline), safe-area padding for notched devices.
- **Grid:** 8px base spacing unit throughout (8/16/24/32/48/64). Card and section gaps use multiples of this unit — never arbitrary pixel values.
- **Content sections:** Group related content into cards or panels with clear headers, not an undifferentiated scroll of tables. Related sections (e.g. open + closed positions) can sit side-by-side in a responsive grid on wide screens, stacking to a single column on mobile.

## Navigation behavior

This is the one point in this spec that is a hard requirement, not a stylistic preference: **every nav item (sidebar entries on desktop, tabs on the mobile bottom bar) must be a real, independently navigable page/view — its own URL/route that can be linked to, bookmarked, and loaded directly — not a same-page `<a href="#section-id">` scroll-to-anchor link.**

- Clicking a nav item loads that section as its own page. Only that section's data needs to be fetched for that request — sections the operator isn't currently viewing should not all be fetched and rendered into one giant page just so anchors can jump between them.
- The active nav item is derived from the current route, not from scroll position — no scroll-spy/IntersectionObserver logic standing in for real navigation.
- Direct-linking and refreshing on any section's URL must load that section directly, not the top of a combined page.
- This applies equally to the desktop sidebar and the mobile bottom tab bar (and any "More" overflow menu) — both are navigation to distinct pages, just presented in different chrome for the viewport size.
- Implementation can be either separate server-rendered routes (e.g. `GET /dashboard/positions`, `GET /dashboard/decisions`, one per current section) or a client-routed single-page app — either satisfies this requirement. What does NOT satisfy it: one route that renders every section's markup into one document with `id` anchors and a nav bar of `#fragment` links, which is the current implementation and the specific pattern this spec is asking to move away from.

## Typography

- **One typeface family** (a well-tested system/product UI font: Inter, IBM Plex Sans, or the OS system font stack) for everything — headings, body, and data. Avoid mixing serif display type with monospace data with sans body copy; that mix reads as "assembled," not designed.
- Reserve a **monospace font** only for genuinely tabular/numeric data where digit alignment matters (prices, timestamps, IDs) — not for labels, nav items, or prose.
- Type scale (roughly a 1.25 ratio): 12 / 13 / 14 (body default) / 16 / 20 / 24 / 32px. Headings use a consistent weight (600) and never rely on italics or unusual case (no forced uppercase+letterspacing for section titles — reserve uppercase+tracking only for small metadata labels like table column headers, where it's a genuine convention).
- Line height 1.5 for body text, 1.2–1.3 for headings.

## Color system

- **Light and dark mode both supported**, driven by CSS custom properties / design tokens, not a single hardcoded palette. Respect `prefers-color-scheme` by default, with a manual override if the product needs one.
- Neutral base: a proper gray scale (9–10 steps) for backgrounds, borders, and text — not pure black/white, not a tinted "mood" palette.
- One accent/brand color used sparingly for primary actions and active/selected states only — not for decorative rules, mastheads, or borders throughout the page.
- Semantic colors, consistent everywhere they appear: success/green, danger/red, warning/amber, info/blue. Used for status badges, deltas, and alerts — always paired with text/icon, never color alone.
- Minimum 4.5:1 contrast for body text, 3:1 for large text and UI component borders, checked against both light and dark backgrounds.

## Components

- **Buttons:** clear primary/secondary/tertiary/destructive variants, consistent height (36–40px default), 6–8px border radius, visible hover/active/focus/disabled states.
- **Cards / stat tiles:** subtle border or very light shadow (not both heavy-handed), 8–12px border radius, consistent internal padding (16–24px). A stat tile shows one number prominently, a label below it, and optionally a trend indicator (arrow + %) — avoid overloading a single tile with more than one data point.
- **Tables:** sticky header row, comfortable row height (44–48px), zebra striping or hover-row highlighting (not both), right-aligned numeric columns with tabular figures, and a built-in responsive strategy — either horizontal scroll inside a bounded container with a visible scroll affordance, or a card-per-row transformation below a defined breakpoint. Never let a table force the whole page to scroll horizontally.
- **Forms/filters:** grouped logically, labeled clearly above each input (not placeholder-as-label), consistent input height matching buttons, obvious required/error states. Prefer real form controls (native selects, date pickers) over recreating them with custom markup unless there's a specific need.
- **Status badges:** pill-shaped, semantic color background at low opacity with matching text color, icon + label, consistent sizing.
- **Navigation:** active state always visually obvious (background fill or accent indicator, not just a color change on text), clear hit targets (minimum 44×44px touch target on mobile).
- **Charts:** use a real charting approach appropriate to the data (bar for comparisons, line for trends over time), consistent color mapping to the semantic palette above, legible axis labels, and a clear empty state when there's no data — never a blank gap.

## Motion

- Fast, purposeful transitions only (150–200ms ease) on hover/focus/expand — no decorative animation. Respect `prefers-reduced-motion`.

## What "professional" means here, concretely

A professional result is one where:
- A new operator can find any of the 9 current sections within a few seconds on both desktop and mobile.
- Every screen holds up when someone with a large monitor and someone on a mid-range phone in bright sunlight both need to read it.
- Nothing about the visual style calls attention to itself — the data is the interesting part, and the UI gets out of its way.
- The next 10 features (new filters, new tables, new charts) all have an obvious place to go within the existing system, instead of requiring a new one-off visual treatment each time.
