import { readSso } from "./lulox-sso.ts";
import { safeNext } from "./nav.ts";

export const GENKI_ORIGIN = "https://genki.lulox.com.ar";
export const APP_ORIGIN = "https://garpen.lulox.com.ar";
/** Same allowlist as lib/auth.ts ADMIN_EMAIL. Only this address may mint a Garpen session from lulox_sso. */
export const SSO_ALLOWED_EMAIL = "lucianoolivabianco@gmail.com";
export const SSO_CONSUME_PATH = "/api/auth/lulox-sso";

const PUBLIC_HOSTS = new Set(["garpen.lulox.com.ar", "erp.lulox.com.ar"]);

export function requestIsIframe(request: Request): boolean {
  const dest = (request.headers.get("sec-fetch-dest") ?? "").toLowerCase();
  return dest === "iframe" || dest === "embed" || dest === "nested-document";
}

export function isSsoEmailAllowed(email: string, allowedEmail = SSO_ALLOWED_EMAIL): boolean {
  return email.trim().toLowerCase() === allowedEmail.trim().toLowerCase();
}

export function requestFromHeaders(headersList: Headers, url = `${APP_ORIGIN}/`): Request {
  return new Request(url, { headers: headersList });
}

export function returnUrlFor(request: Request): string {
  const url = new URL(request.url);
  if (!PUBLIC_HOSTS.has(url.hostname)) return `${APP_ORIGIN}/`;
  url.protocol = "https:";
  url.hash = "";
  return `${url.origin}${url.pathname}${url.search}`;
}

export function genkiLoginUrl(returnUrl: string): string {
  const login = new URL(GENKI_ORIGIN);
  login.searchParams.set("return", returnUrl);
  return login.toString();
}

export function ssoConsumePath(next: string): string {
  return `${SSO_CONSUME_PATH}?next=${encodeURIComponent(next)}`;
}

export function isGoogleSignInPath(pathname: string): boolean {
  return pathname === "/api/auth/sign-in/social" || pathname.endsWith("/sign-in/social");
}

/** Set by the sign-out button: the user left on purpose, so lulox_sso must not mint a new session behind their back. */
export const SSO_OFF_COOKIE = "garpen_sso_off";
export const SIGNED_OUT_PATH = "/login?signedout=1";

export function ssoIsOff(request: Request): boolean {
  const cookie = request.headers.get("cookie") ?? "";
  return cookie.split(";").some((part) => part.trim() === `${SSO_OFF_COOKIE}=1`);
}

/** If the SSO cookie is valid for the allowlist, the path that mints the Better Auth session. */
export async function ssoConsumeRedirect(
  request: Request,
  secret: string | undefined,
  next: string,
  now?: number,
): Promise<string | null> {
  if (ssoIsOff(request)) return null;
  const sso = await readSso(request, secret, now);
  if (!sso || !isSsoEmailAllowed(sso.email)) return null;
  return ssoConsumePath(safeNext(next, APP_ORIGIN));
}
