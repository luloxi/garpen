import { betterAuth } from "better-auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { luloxSsoPlugin } from "@/lib/lulox-sso-plugin";
import { isAutoApproved } from "@/lib/approval";

const APP_URL = "https://garpen.lulox.com.ar";
export const ADMIN_EMAIL = "lucianoolivabianco@gmail.com";

export async function getAuth() {
  const { env } = await getCloudflareContext({ async: true });

  return betterAuth({
    appName: "Garpen",
    baseURL: APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: ["https://garpen.lulox.com.ar", "https://erp.lulox.com.ar", "https://genki.lulox.com.ar"],
    database: env.DB,
    plugins: [luloxSsoPlugin({ secret: env.LULOX_SSO_SECRET, allowedEmail: ADMIN_EMAIL })],
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },
    user: {
      additionalFields: {
        role: {
          type: ["admin", "user"],
          required: false,
          defaultValue: "user",
          input: false,
        },
        approvalStatus: {
          type: ["pending", "approved", "rejected"],
          required: false,
          defaultValue: "pending",
          input: false,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const isAdmin = user.email.trim().toLowerCase() === ADMIN_EMAIL;
            return {
              data: {
                ...user,
                role: isAdmin ? "admin" : "user",
                approvalStatus: isAutoApproved(user.email, ADMIN_EMAIL) ? "approved" : "pending",
              },
            };
          },
        },
      },
    },
    advanced: {
      database: {
        generateId: "uuid",
        // Our migrations own the schema; skip Better Auth's per-instance D1 pragma check.
        validateSchema: false,
      },
      useSecureCookies: true,
      defaultCookieAttributes: {
        sameSite: "lax",
        secure: true,
        httpOnly: true,
        path: "/",
      },
    },
  });
}
