import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FRAME_ANCESTORS,
} from "../lib/csp.ts";
import {
  APP_ORIGIN,
  GENKI_ORIGIN,
  genkiLoginUrl,
  isGoogleSignInPath,
  requestIsIframe,
  returnUrlFor,
} from "../lib/sso-login.ts";

test("top-level return URLs stay on Garpen; unknown hosts do not", () => {
  assert.equal(
    returnUrlFor(new Request("https://garpen.lulox.com.ar/login?next=%2Fdashboard")),
    "https://garpen.lulox.com.ar/login?next=%2Fdashboard",
  );
  assert.equal(returnUrlFor(new Request("https://erp.lulox.com.ar/dashboard")), "https://erp.lulox.com.ar/dashboard");
  assert.equal(returnUrlFor(new Request("https://evil.example/phish")), `${APP_ORIGIN}/`);
});

test("iframe is detected from Sec-Fetch-Dest and Genki opens with a return URL", () => {
  assert.equal(requestIsIframe(new Request("https://garpen.lulox.com.ar/", { headers: { "sec-fetch-dest": "iframe" } })), true);
  assert.equal(requestIsIframe(new Request("https://garpen.lulox.com.ar/", { headers: { "sec-fetch-dest": "document" } })), false);
  const href = genkiLoginUrl("https://garpen.lulox.com.ar/dashboard");
  assert.ok(href.startsWith(`${GENKI_ORIGIN}/?`));
  assert.equal(new URL(href).searchParams.get("return"), "https://garpen.lulox.com.ar/dashboard");
});

test("Google sign-in path is the Better Auth social endpoint", () => {
  assert.equal(isGoogleSignInPath("/api/auth/sign-in/social"), true);
  assert.equal(isGoogleSignInPath("/api/auth/callback/google"), false);
  assert.equal(isGoogleSignInPath("/login"), false);
});

test("login form never starts Google inside an iframe and opens Genki in the top frame", () => {
  const form = readFileSync(new URL("../app/login-form.tsx", import.meta.url), "utf8");
  assert.match(form, /Iniciá sesión en Genki/);
  assert.match(form, /target="_top"/);
  assert.match(form, /window\.self !== window\.top/);
  assert.match(form, /if \(inFrame\) return/);
  assert.match(form, /signIn\.social/);
  const page = readFileSync(new URL("../app/login/page.tsx", import.meta.url), "utf8");
  assert.match(page, /ssoConsumeRedirect/);
  assert.match(page, /requestIsIframe/);
  const authRoute = readFileSync(new URL("../app/api/auth/[...all]/route.ts", import.meta.url), "utf8");
  assert.match(authRoute, /blockGoogleInIframe/);
});

test("CSP still allows only Genki to frame Garpen", () => {
  assert.deepEqual([...FRAME_ANCESTORS], ["https://genki.lulox.com.ar"]);
});
