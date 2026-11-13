import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { leaveToLogin, signOutFailed, turnSsoOff, turnSsoOn } from "../lib/sign-out-redirect.ts";
import { SIGNED_OUT_PATH, SSO_OFF_COOKIE, ssoConsumeRedirect, ssoIsOff } from "../lib/sso-login.ts";
import { consumeSsoSession } from "../lib/sso-session.ts";

test("leaving loads the logged-out view with a full navigation and turns SSO off first", () => {
  const doc = { cookie: "" };
  const calls: string[] = [];
  leaveToLogin(doc, { replace: (url) => calls.push(url) });
  assert.deepEqual(calls, [SIGNED_OUT_PATH]);
  assert.equal(SIGNED_OUT_PATH, "/login?signedout=1");
  assert.match(doc.cookie, new RegExp(`^${SSO_OFF_COOKIE}=1;`));
  assert.match(doc.cookie, /Secure/);
  turnSsoOn(doc);
  assert.match(doc.cookie, /Max-Age=0/);
  turnSsoOff(doc);
});

test("a refused sign-out is reported, a clean one is not", () => {
  assert.equal(signOutFailed({ data: { success: true }, error: null }), false);
  assert.equal(signOutFailed({ data: null, error: { status: 500 } }), true);
  assert.equal(signOutFailed(undefined), false);
});

test("with the sign-out cookie, lulox_sso does not log the user back in", async () => {
  const off = new Request("https://garpen.lulox.com.ar/login", { headers: { cookie: `a=1; ${SSO_OFF_COOKIE}=1` } });
  const on = new Request("https://garpen.lulox.com.ar/login", { headers: { cookie: "a=1" } });
  assert.equal(ssoIsOff(off), true);
  assert.equal(ssoIsOff(on), false);
  assert.equal(await ssoConsumeRedirect(off, "secret", "/dashboard"), null);
  const never = async () => { throw new Error("must not look anything up"); };
  assert.equal(
    await consumeSsoSession({ request: off, secret: "secret", allowedEmail: "x@y.z", findUserByEmail: never, findActiveSession: never, createSession: never }),
    null,
  );
});

test("every sign-out button leaves to the login page and the explicit sign-in turns SSO back on", () => {
  const button = readFileSync(new URL("../app/sign-out-button.tsx", import.meta.url), "utf8");
  const pending = readFileSync(new URL("../app/pending/page.tsx", import.meta.url), "utf8");
  const form = readFileSync(new URL("../app/login-form.tsx", import.meta.url), "utf8");
  const login = readFileSync(new URL("../app/login/page.tsx", import.meta.url), "utf8");
  assert.match(button, /leaveToLogin\(document, window\.location\)/);
  assert.match(pending, /leaveToLogin\(document, window\.location\)/);
  assert.match(form, /turnSsoOn\(document\)/g);
  assert.match(login, /signedout/);
});
