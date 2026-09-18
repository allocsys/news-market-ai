// Server-rendered login page for src/index.js's GET/POST /login routes --
// zero client JS (same philosophy as dashboard.js). Deliberately its own
// small file/style rather than importing shell.js's STYLE: this page is
// one centered card, not a data-dense multi-section layout. Palette uses
// the new professional product dark theme and Inter typography matching shell.js.

import { escapeHtml } from "./dashboard/helpers.js";

const LOGIN_STYLE = `
  :root {
    color-scheme: dark;
    --bg-base: #090d16;
    --bg-surface: #0f172a;
    --border-color: #1e293b;
    --text-main: #f1f5f9;
    --text-muted: #94a3b8;
    --accent: #3b82f6;
    --accent-hover: #2563eb;
    --accent-subtle: rgba(59, 130, 246, 0.15);
    --color-danger-bg: rgba(239, 68, 68, 0.12);
    --color-danger-text: #f87171;
    --font-sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--font-sans);
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: var(--bg-base); color: var(--text-main);
  }
  .card {
    width: 100%; max-width: 360px; margin: 1.5rem;
    background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: 10px;
    padding: 2rem 2rem 2.25rem;
    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
  }
  .wordmark-main {
    font-size: 1.125rem; font-weight: 600; color: var(--text-main);
    border-bottom: 1px solid var(--border-color); padding-bottom: 0.75rem; margin-bottom: 1.5rem;
  }
  .wordmark-sub {
    font-family: var(--font-sans);
    font-size: 0.75rem; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--text-muted); display: block; margin-top: 0.35rem; font-weight: 500;
  }
  label {
    display: block; font-family: var(--font-sans);
    font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;
    margin-bottom: 0.5rem;
  }
  .field { margin-bottom: 1.25rem; }
  input {
    width: 100%; background: var(--bg-base); color: var(--text-main); border: 1px solid var(--border-color);
    padding: 0.6rem 0.75rem; font-family: var(--font-sans);
    font-size: 0.9375rem; border-radius: 6px;
    transition: border-color 150ms ease, box-shadow 150ms ease;
  }
  input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-subtle); }
  button {
    width: 100%; margin-top: 0.5rem;
    font-family: var(--font-sans); font-size: 0.875rem; font-weight: 600;
    color: #ffffff; background: var(--accent); border: none; padding: 0.625rem 1rem; border-radius: 6px; cursor: pointer;
    height: 40px;
    transition: background 150ms ease, box-shadow 150ms ease;
  }
  button:hover { background: var(--accent-hover); }
  button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--accent-subtle); }
  .error {
    font-family: var(--font-sans);
    color: var(--color-danger-text); background: var(--color-danger-bg); border: 1px solid var(--color-danger-text);
    font-size: 0.875rem; padding: 0.75rem 1rem; margin-bottom: 1.25rem; border-radius: 6px;
    font-weight: 500;
  }
  .disabled-note {
    font-family: var(--font-sans);
    color: var(--text-muted); font-size: 0.875rem; line-height: 1.5;
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
       <p class="disabled-note" style="margin-top:0.9rem;">The dashboard itself is still reachable unauthenticated until DASHBOARD_USERNAME, DASHBOARD_PASSWORD, and JWT_SECRET are all set.</p>`
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
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>news-market-ai &mdash; login</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${LOGIN_STYLE}</style>
</head>
<body>
  <div class="card">
    <div class="wordmark-main">news-market-ai<span class="wordmark-sub">operations ledger</span></div>
    ${body}
  </div>
</body>
</html>`;
}
