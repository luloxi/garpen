import { isSsoEmailAllowed, ssoIsOff } from "./sso-login.ts";
import { readSso } from "./lulox-sso.ts";

export type SsoAccount = {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  emailVerified?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  role?: string | null;
  approvalStatus?: string | null;
};

export type SsoSessionRecord = {
  token: string;
  userId: string;
  expiresAt: Date;
  id?: string;
  createdAt?: Date;
  updatedAt?: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * Resolve a Better Auth session for a verified lulox_sso cookie.
 * Never creates a user: only an existing row (same id, so their data stays).
 * Reuses a still-valid session token when one exists.
 */
export async function consumeSsoSession(input: {
  request: Request;
  secret: string | undefined;
  allowedEmail: string;
  findUserByEmail: (email: string) => Promise<SsoAccount | null>;
  findActiveSession: (userId: string) => Promise<SsoSessionRecord | null>;
  createSession: (userId: string) => Promise<SsoSessionRecord | null>;
  now?: number;
}): Promise<{ user: SsoAccount; session: SsoSessionRecord } | null> {
  if (ssoIsOff(input.request)) return null;
  const sso = await readSso(input.request, input.secret, input.now);
  if (!sso || !isSsoEmailAllowed(sso.email, input.allowedEmail)) return null;
  const user = await input.findUserByEmail(sso.email);
  if (!user) return null;
  const existing = await input.findActiveSession(user.id);
  if (existing) return { user, session: existing };
  const session = await input.createSession(user.id);
  if (!session) return null;
  return { user, session };
}
