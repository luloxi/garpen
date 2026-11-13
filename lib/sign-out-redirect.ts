import { SIGNED_OUT_PATH, SSO_OFF_COOKIE } from "./sso-login.ts";

type CookieDoc = { cookie: string };
type Nav = { replace: (url: string) => void };

/** Turns the Genki single sign-on off for this browser until the user signs in again on purpose. */
export function turnSsoOff(doc: CookieDoc): void {
  doc.cookie = `${SSO_OFF_COOKIE}=1; Path=/; Max-Age=86400; Secure; SameSite=Lax`;
}

export function turnSsoOn(doc: CookieDoc): void {
  doc.cookie = `${SSO_OFF_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`;
}

/** better-auth's client returns `{ error }` instead of throwing when the server refuses. */
export function signOutFailed(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && (result as { error?: unknown }).error);
}

export const SIGN_OUT_FAILED_WARNING = "No pudimos cerrar la sesión. Reintentá.";

/**
 * After the session cookie is gone: stop SSO from signing the user straight back in and load the
 * logged-out view with a full navigation, so no signed-in state survives in memory or in the page.
 */
export function leaveToLogin(doc: CookieDoc, location: Nav): void {
  turnSsoOff(doc);
  location.replace(SIGNED_OUT_PATH);
}
