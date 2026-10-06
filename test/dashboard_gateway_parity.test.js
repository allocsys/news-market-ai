// The dashboard gateway (dashboard-next/src/server/*.mjs) carries copies of a few
// things that also live under src/: the session-cookie name and JWT format
// (src/auth/*, still used by the backend Worker's own gate and its tests), and
// two constants (src/storage/pause_flags.js, src/dashboard/helpers.js). The
// Next.js build can't import across the folder boundary, so they are copied; this
// file is what stops the copies drifting apart.

import test from "node:test";
import assert from "node:assert/strict";
import { PAUSE_KEYS as GATEWAY_PAUSE_KEYS, BACKTEST_ID_RE as GATEWAY_BACKTEST_ID_RE } from "../dashboard-next/src/server/gateway.mjs";
import * as gatewaySession from "../dashboard-next/src/server/session.mjs";
import { signJwt as gatewaySignJwt, verifyJwt as gatewayVerifyJwt } from "../dashboard-next/src/server/jwt.mjs";
import * as backendSession from "../src/auth/session.js";
import { signJwt as backendSignJwt, verifyJwt as backendVerifyJwt } from "../src/auth/jwt.js";
import { PAUSE_KEYS } from "../src/storage/pause_flags.js";
import { BACKTEST_ID_RE } from "../src/dashboard/helpers.js";

const config = { jwtSecret: "parity-test-key", sessionTtlSeconds: 60 };

function requestWithCookie(setCookie) {
  return new Request("https://dashboard.example/api/overview", { headers: { Cookie: setCookie.split(";")[0] } });
}

test("PAUSE_KEYS in the gateway is the backend's list, in the same order", () => {
  assert.deepEqual([...GATEWAY_PAUSE_KEYS], [...PAUSE_KEYS]);
});

test("BACKTEST_ID_RE in the gateway is the backend's pattern", () => {
  assert.equal(GATEWAY_BACKTEST_ID_RE.source, BACKTEST_ID_RE.source);
  assert.equal(GATEWAY_BACKTEST_ID_RE.flags, BACKTEST_ID_RE.flags);
});

test("the session cookie has the same name on both sides", () => {
  assert.equal(gatewaySession.SESSION_COOKIE_NAME, backendSession.SESSION_COOKIE_NAME);
});

test("a session cookie issued by the gateway verifies on the backend's copy, and the other way round", async () => {
  const fromGateway = await gatewaySession.createSessionCookie("admin", config);
  assert.equal(await backendSession.getSessionUsername(requestWithCookie(fromGateway), config), "admin");
  assert.equal(await gatewaySession.getSessionUsername(requestWithCookie(fromGateway), config), "admin");

  const fromBackend = await backendSession.createSessionCookie("admin", config);
  assert.equal(await gatewaySession.getSessionUsername(requestWithCookie(fromBackend), config), "admin");
});

test("both copies give the cookie the same attributes (HttpOnly, Secure, SameSite=Lax, Max-Age = the TTL)", async () => {
  const gateway = await gatewaySession.createSessionCookie("admin", config);
  const backend = await backendSession.createSessionCookie("admin", config);
  const attributes = (cookie) => cookie.split(";").slice(1).map((a) => a.trim()).sort();
  assert.deepEqual(attributes(gateway), attributes(backend));
  assert.deepEqual(gatewaySession.clearSessionCookie().split(";").map((a) => a.trim()).sort(), backendSession.clearSessionCookie().split(";").map((a) => a.trim()).sort());
});

test("JWTs sign and verify across the two copies, and both reject the same bad tokens", async () => {
  const token = await gatewaySignJwt({ sub: "admin" }, "k", { expiresInSeconds: 60 });
  assert.equal((await backendVerifyJwt(token, "k")).sub, "admin");
  assert.equal((await gatewayVerifyJwt(await backendSignJwt({ sub: "admin" }, "k", { expiresInSeconds: 60 }), "k")).sub, "admin");

  const expired = await gatewaySignJwt({ sub: "admin" }, "k", { expiresInSeconds: -10 });
  const algNone = `${btoa(JSON.stringify({ alg: "none", typ: "JWT" })).replace(/=+$/, "")}.${token.split(".")[1]}.`;
  for (const bad of [expired, algNone, "garbage", "a.b.c", token.slice(0, -2) + "xx", undefined]) {
    assert.equal(await gatewayVerifyJwt(bad, "k"), null, `gateway rejects ${String(bad).slice(0, 20)}`);
    assert.equal(await backendVerifyJwt(bad, "k"), null, `backend rejects ${String(bad).slice(0, 20)}`);
  }
  assert.equal(await gatewayVerifyJwt(token, "another-key"), null, "wrong key");
});
