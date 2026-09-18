// Server-rendered login page for src/index.js's GET/POST /login routes --
// zero client JS (same philosophy as dashboard.js, minus that file's one
// setDateRange script, which has no reason to exist here). Deliberately
// its own small file/style rather than importing dashboard.js's STYLE:
// this page is one centered card, not a data-dense multi-section layout,
// so sharing the full ledger stylesheet would pull in far more than this
// page uses. Palette (ink-navy + brass accent) intentionally matches
// dashboard.js's STYLE so the login -> dashboard transition doesn't jar.

import { escapeHtml } from "./dashboard/helpers.js";

const LOGIN_STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    font-family: Georgia, "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0a0d12; color: #d9d4c4;
  }
  .card {
    width: 100%; max-width: 340px; margin: 1.5rem;
    background: #0d1118; border: 1px solid #232b35; padding: 2rem 2rem 2.25rem;
  }
  .wordmark-main {
    font-size: 1.05rem; font-weight: 600; color: #efe9d8;
    border-bottom: 2px double #b8944f; padding-bottom: 0.55rem; margin-bottom: 1.5rem;
  }
  .wordmark-sub {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase;
    color: #6e7787; display: block; margin-top: 0.3rem;
  }
  label {
    display: block; font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.68rem; color: #6e7787; text-transform: uppercase; letter-spacing: 0.05em;
    margin-bottom: 0.4rem;
  }
  .field { margin-bottom: 1.1rem; }
  input {
    width: 100%; background: #0a0d12; color: #d9d4c4; border: 1px solid #2c3644;
    padding: 0.55rem 0.6rem; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 0.9rem;
  }
  input:focus { outline: none; border-color: #b8944f; }
  button {
    width: 100%; margin-top: 0.4rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.82rem; font-weight: 600;
    color: #0a0d12; background: #b8944f; border: none; padding: 0.6rem; cursor: pointer;
  }
  button:hover { background: #cba764; }
  .error {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #e8b4a0; background: #241512; border: 1px solid #c1502e;
    font-size: 0.82rem; padding: 0.6rem 0.75rem; margin-bottom: 1.1rem;
  }
  .disabled-note {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #7c8698; font-size: 0.8rem; line-height: 1.5;
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
