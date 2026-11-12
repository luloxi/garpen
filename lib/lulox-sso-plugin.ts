import type { BetterAuthPlugin, Session, User } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { consumeSsoSession, type SsoAccount, type SsoSessionRecord } from "./sso-session.ts";
import { APP_ORIGIN, isGoogleSignInPath, requestIsIframe } from "./sso-login.ts";
import { safeNext } from "./nav.ts";

function loginErrorUrl(): string {
  return `${APP_ORIGIN}/login?error=sso`;
}

function asCookieUser(user: SsoAccount) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image ?? null,
    emailVerified: user.emailVerified ?? true,
    createdAt: user.createdAt ?? new Date(0),
    updatedAt: user.updatedAt ?? new Date(0),
    role: user.role ?? undefined,
    approvalStatus: user.approvalStatus ?? undefined,
  };
}

export function luloxSsoPlugin(options: { secret: string | undefined; allowedEmail: string }): BetterAuthPlugin {
  return {
    id: "lulox-sso",
    endpoints: {
      luloxSso: createAuthEndpoint(
        "/lulox-sso",
        { method: "GET", requireHeaders: true },
        async (ctx) => {
          const request = ctx.request;
          if (!request) throw ctx.redirect(loginErrorUrl());
          const consumed = await consumeSsoSession({
            request,
            secret: options.secret,
            allowedEmail: options.allowedEmail,
            findUserByEmail: async (email) => {
              const found = await ctx.context.internalAdapter.findUserByEmail(email);
              const user = found?.user;
              return user ? (user as SsoAccount) : null;
            },
            findActiveSession: async (userId) => {
              const sessions = await ctx.context.internalAdapter.listSessions(userId);
              const now = Date.now();
              const active = sessions.find((session) => new Date(session.expiresAt).getTime() > now);
              return active ? (active as SsoSessionRecord) : null;
            },
            createSession: async (userId) => {
              const session = await ctx.context.internalAdapter.createSession(userId);
              return session ? (session as SsoSessionRecord) : null;
            },
          });
          if (!consumed) throw ctx.redirect(loginErrorUrl());
          await setSessionCookie(ctx, {
            session: consumed.session as Session,
            user: asCookieUser(consumed.user) as User,
          });
          const next = safeNext(new URL(request.url).searchParams.get("next"), APP_ORIGIN);
          throw ctx.redirect(new URL(next, ctx.context.baseURL).toString());
        },
      ),
    },
    hooks: {
      before: [
        {
          matcher(ctx) {
            return typeof ctx.path === "string" && isGoogleSignInPath(ctx.path);
          },
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.request && requestIsIframe(ctx.request)) {
              throw new APIError("BAD_REQUEST", { message: "Google sign-in is not available inside an iframe" });
            }
          }),
        },
      ],
    },
  };
}
