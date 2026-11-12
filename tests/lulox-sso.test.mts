import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readSso, signSso, ssoClearCookie, ssoSetCookie } from "../lib/lulox-sso.ts";
import { SSO_ALLOWED_EMAIL, isSsoEmailAllowed, ssoConsumeRedirect } from "../lib/sso-login.ts";
import { consumeSsoSession, type SsoAccount } from "../lib/sso-session.ts";

const SECRET = "x".repeat(48);
const email = "lucianoolivabianco@gmail.com";
const user = { email: "LucianoOlivabianco@gmail.com", name: "Luciano", picture: "" };

function req(cookie: string, url = "https://garpen.lulox.com.ar/") {
  return new Request(url, { headers: { cookie } });
}

test("SSO allowlist is the same email Garpen already uses", () => {
  const auth = readFileSync(new URL("../lib/auth.ts", import.meta.url), "utf8");
  assert.match(auth, new RegExp(`ADMIN_EMAIL = "${email}"`));
  assert.equal(SSO_ALLOWED_EMAIL, email);
  assert.equal(isSsoEmailAllowed("LucianoOlivabianco@gmail.com"), true);
  assert.equal(isSsoEmailAllowed("other@example.com"), false);
});

test("accepts a valid lulox_sso cookie and lowercases the email", async () => {
  const value = await signSso(user, SECRET, 60_000);
  assert.deepEqual(await readSso(req(`a=b; lulox_sso=${value}`), SECRET), {
    email,
    name: "Luciano",
    picture: "",
  });
  const next = await ssoConsumeRedirect(req(`lulox_sso=${value}`), SECRET, "/dashboard");
  assert.equal(next, "/api/auth/lulox-sso?next=" + encodeURIComponent("/dashboard"));
});

test("rejects an expired cookie", async () => {
  const value = await signSso(user, SECRET, 1_000, Date.now() - 5_000);
  assert.equal(await readSso(req(`lulox_sso=${value}`), SECRET), null);
  assert.equal(await ssoConsumeRedirect(req(`lulox_sso=${value}`), SECRET, "/dashboard"), null);
});

test("rejects a bad signature", async () => {
  const value = await signSso(user, SECRET, 60_000);
  const [payload, sig] = value.split(".");
  const forged = Buffer.from(JSON.stringify({ v: 1, email, iat: Date.now(), exp: Date.now() + 1e6 })).toString("base64url");
  assert.equal(await readSso(req(`lulox_sso=${forged}.${sig}`), SECRET), null);
  assert.equal(await readSso(req(`lulox_sso=${payload}.${sig}x`), SECRET), null);
  assert.equal(await ssoConsumeRedirect(req(`lulox_sso=${value.slice(0, -2)}aa`), SECRET, "/dashboard"), null);
});

test("rejects the wrong email even with a valid signature", async () => {
  const value = await signSso({ email: "other@example.com", name: "X", picture: "" }, SECRET, 60_000);
  assert.equal((await readSso(req(`lulox_sso=${value}`), SECRET))?.email, "other@example.com");
  assert.equal(await ssoConsumeRedirect(req(`lulox_sso=${value}`), SECRET, "/dashboard"), null);
  assert.equal(isSsoEmailAllowed("other@example.com"), false);
});

test("wrong secret, short secret and missing cookie are rejected", async () => {
  const value = await signSso(user, SECRET, 60_000);
  assert.equal(await readSso(req(`lulox_sso=${value}`), "y".repeat(48)), null);
  assert.equal(await readSso(req(`lulox_sso=${value}`), "short"), null);
  assert.equal(await readSso(req(""), SECRET), null);
  assert.equal(await ssoConsumeRedirect(req(`lulox_sso=${value}`), undefined, "/dashboard"), null);
});

test("cookie attributes match Genki (parent domain, HttpOnly, Secure, Lax)", () => {
  const cookie = ssoSetCookie("abc", 60);
  for (const part of ["Domain=.lulox.com.ar", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=60"]) {
    assert.ok(cookie.includes(part), part);
  }
  assert.ok(ssoClearCookie().includes("Max-Age=0"));
  assert.doesNotMatch(cookie, /SameSite=None/);
});

test("consume reuses the existing user id and an active Better Auth session", async () => {
  const value = await signSso(user, SECRET, 60_000);
  const request = req(`lulox_sso=${value}`);
  const account: SsoAccount = { id: "user-existing", email, name: "Luciano" };
  const created: string[] = [];
  const first = await consumeSsoSession({
    request,
    secret: SECRET,
    allowedEmail: email,
    findUserByEmail: async (got) => (got === email ? account : null),
    findActiveSession: async () => ({ token: "tok-1", userId: account.id, expiresAt: new Date(Date.now() + 60_000) }),
    createSession: async (userId) => {
      created.push(userId);
      return { token: "tok-new", userId, expiresAt: new Date(Date.now() + 60_000) };
    },
  });
  assert.equal(first?.user.id, "user-existing");
  assert.equal(first?.session.token, "tok-1");
  assert.deepEqual(created, []);

  const minted = await consumeSsoSession({
    request,
    secret: SECRET,
    allowedEmail: email,
    findUserByEmail: async () => account,
    findActiveSession: async () => null,
    createSession: async (userId) => {
      created.push(userId);
      return { token: "tok-new", userId, expiresAt: new Date(Date.now() + 60_000) };
    },
  });
  assert.equal(minted?.session.token, "tok-new");
  assert.deepEqual(created, ["user-existing"]);
});

test("consume does not create a user when the email is unknown or not allowed", async () => {
  const ok = await signSso(user, SECRET, 60_000);
  const other = await signSso({ email: "otro@example.com", name: "X", picture: "" }, SECRET, 60_000);
  const created: string[] = [];
  const missing = await consumeSsoSession({
    request: req(`lulox_sso=${ok}`),
    secret: SECRET,
    allowedEmail: email,
    findUserByEmail: async () => null,
    findActiveSession: async () => null,
    createSession: async (userId) => {
      created.push(userId);
      return { token: "x", userId, expiresAt: new Date() };
    },
  });
  const denied = await consumeSsoSession({
    request: req(`lulox_sso=${other}`),
    secret: SECRET,
    allowedEmail: email,
    findUserByEmail: async () => ({ id: "other-id", email: "otro@example.com", name: "X" }),
    findActiveSession: async () => null,
    createSession: async (userId) => {
      created.push(userId);
      return { token: "x", userId, expiresAt: new Date() };
    },
  });
  assert.equal(missing, null);
  assert.equal(denied, null);
  assert.deepEqual(created, []);
});

test("session cookies stay SameSite=Lax and the Worker secret is not hardcoded", () => {
  const auth = readFileSync(new URL("../lib/auth.ts", import.meta.url), "utf8");
  assert.match(auth, /sameSite:\s*"lax"/);
  assert.match(auth, /luloxSsoPlugin/);
  assert.match(auth, /LULOX_SSO_SECRET/);
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(wrangler, /LULOX_SSO_SECRET/);
  assert.doesNotMatch(wrangler, /LULOX_SSO_SECRET\s*:/);
  const worker = readFileSync(new URL("../worker.ts", import.meta.url), "utf8");
  assert.doesNotMatch(worker, /LULOX_SSO_SECRET\s*=\s*["']/);
});
