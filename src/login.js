// Server-rendered login page for src/index.js's GET/POST /login routes --
// zero client JS (same philosophy as dashboard.js). Deliberately its own
// small file/style rather than importing shell.js's STYLE: this page is
// one center card, not a data-dense multi-section layout. Palette/type
// tokens are kept in step with shell.js's DARK_VARS by hand (plan.md
// "Dashboard: Heavy Polish, Redesign & Reorganization" Step 1, 2026-09-22) --
// this file has no import of shell.js's STYLE to share the source of truth.

import { escapeHtml } from "./dashboard/helpers.js";

const LOGIN_STYLE = `
  :root {
    color-scheme: dark;
    --bg-base: #14171f;
    --bg-surface: #1c2029;
    --bg-elevated: #242935;
    --bg-hover: #2b3140;
    --border-color: #313846;
    --border-strong: #3f4759;
    --text-main: #edeae2;
    --text-muted: #a8a398;
    --text-subtle: #7d7a72;
    --accent: #d98e3c;
    --accent-hover: #c67d2e;
    --accent-bright: #e8a458;
    --accent-deep: #a8631f;
    --accent-subtle: rgba(217, 142, 60, 0.14);
    --accent-glow: rgba(232, 164, 88, 0.22);
    --focus-ring: #e8a458;
    --color-danger-bg: rgba(239, 68, 68, 0.12);
    --color-danger-text: #f87171;
    --color-success-text: #34d399;
    --font-sans: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --font-display: "Fraunces", Georgia, "Times New Roman", serif;
    --font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
    --radius-sm: 6px;
    --radius-md: 10px;
    --shadow-card: 0 1px 0 rgba(255, 255, 255, 0.04) inset, 0 8px 24px -12px rgba(0, 0, 0, 0.5);
    --shadow-pop: 0 24px 60px -20px rgba(0, 0, 0, 0.7);
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--font-sans);
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: var(--bg-base);
    background-image: radial-gradient(900px 480px at 12% -8%, rgba(217, 142, 60, 0.10), transparent 70%),
                      radial-gradient(700px 360px at 88% 0%, rgba(139, 111, 158, 0.06), transparent 70%);
    background-attachment: fixed;
    color: var(--text-main);
    padding: 1.5rem;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%; max-width: 400px;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 2rem 2rem 2.25rem;
    box-shadow: var(--shadow-pop);
  }
  .brand {
    display: flex; align-items: center; gap: 0.75rem;
    border-bottom: 1px solid var(--border-color);
    padding-bottom: 1rem; margin-bottom: 1.5rem;
  }
  .brand-mark {
    width: 36px; height: 36px; border-radius: 10px;
    background: linear-gradient(135deg, var(--accent-bright) 0%, var(--accent) 100%);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 700; font-family: var(--font-display);
    font-size: 0.95rem; letter-spacing: -0.04em;
    box-shadow: 0 4px 12px -2px var(--accent-glow);
    flex-shrink: 0;
  }
  .brand-text { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
  .brand-main {
    font-family: var(--font-display);
    font-size: 0.9375rem; font-weight: 600; letter-spacing: -0.015em;
    color: var(--text-main); line-height: 1.2;
  }
  .brand-sub {
    font-size: 0.6875rem; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--text-subtle); font-weight: 500;
  }
  label {
    display: block;
    font-size: 0.6875rem; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600;
    margin-bottom: 0.5rem;
  }
  .field { margin-bottom: 1.25rem; }
  input {
    width: 100%; background: var(--bg-base); color: var(--text-main);
    border: 1px solid var(--border-color);
    padding: 0.6rem 0.75rem;
    font-family: var(--font-sans);
    font-size: 0.9375rem; border-radius: var(--radius-sm);
    transition: border-color 150ms ease, box-shadow 150ms ease;
  }
  input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-subtle); }
  button {
    width: 100%; margin-top: 0.5rem;
    font-family: var(--font-sans); font-size: 0.875rem; font-weight: 600;
    color: #fff;
    background: linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%);
    border: none; padding: 0.625rem 1rem; border-radius: var(--radius-sm);
    cursor: pointer; height: 42px;
    transition: background 150ms ease, transform 100ms ease;
    box-shadow: 0 2px 8px -2px var(--accent-glow);
  }
  button:hover { background: linear-gradient(135deg, var(--accent-hover) 0%, var(--accent-deep) 100%); }
  button:active { transform: translateY(1px); }
  button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  .error {
    color: var(--color-danger-text); background: var(--color-danger-bg);
    border: 1px solid rgba(239, 68, 68, 0.28);
    font-size: 0.8125rem; padding: 0.75rem 1rem;
    margin-bottom: 1.25rem; border-radius: var(--radius-sm);
    font-weight: 500;
  }
  .disabled-note {
    color: var(--text-muted); font-size: 0.8125rem; line-height: 1.6;
  }
`;

/**
 * Renders the login page. `error` (optional) shows a dismissable-looking
 * banner above the form -- used for both "wrong credentials" (401) and
 * "login isn't configured yet" (503, see src/index.js's own comment on
 * why an unset DASHBOARD_USERNAME/PASSWORD/JWT_SECRET intentionally
 * leaves /dashboard open rather than locking it behind a login nobody can
 * complete). `disabled` swaps the form out for a plain explanatory note
 * in that second case, since showing a username/password form that can
 * never succeed would be actively misleading.
 */
export function renderLoginPage({ error = null, disabled = false } = {}) {
  const body = disabled
    ? `<p class="disabled-note">${escapeHtml(error ?? "Dashboard login is not configured.")}</p>
       <p class="disabled-note" style="margin-top:0.9rem;">The dashboard is unreachable until DASHBOARD_USERNAME, DASHBOARD_PASSWORD, and JWT_SECRET are all set on this Worker (plan.md Step 2 -- an unconfigured login now fails closed rather than serving an open dashboard).</p>`
    : `${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
       <form method="post" action="/login">
         <div class="field">
           <label for="username">Username</label>
           <input id="username" type="text" name="username" autocomplete="username" required autofocus>
         </div>
         <div class="field">
           <label for="password">Password</label>
           <input id="password" type="password" name="password" autocomplete="current-password" required>
         </div>
         <button type="submit">Log in</button>
       </form>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#14171f">
<title>news-market-ai &mdash; login</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,500;1,9..144,600&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${LOGIN_STYLE}</style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <span class="brand-mark">N</span>
      <span class="brand-text">
        <span class="brand-main">news-market-ai</span>
        <span class="brand-sub">operations ledger</span>
      </span>
    </div>
    ${body}
  </div>
</body>
</html>`;
}
