import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import LoginForm from "@/app/login-form";
import { getAuth } from "@/lib/auth";
import { APP_ORIGIN, requestFromHeaders, requestIsIframe, ssoConsumeRedirect } from "@/lib/sso-login";
import { safeNext } from "@/lib/nav";

export const dynamic = "force-dynamic";

type Search = { next?: string | string[]; error?: string | string[] };

function first(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const headerList = await headers();
  const next = safeNext(first(params.next), APP_ORIGIN);
  const errorCode = first(params.error);
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: headerList });
  if (session) redirect(next);

  const request = requestFromHeaders(headerList, `${APP_ORIGIN}/login`);
  const { env } = await getCloudflareContext({ async: true });
  if (errorCode !== "sso") {
    const consume = await ssoConsumeRedirect(request, env.LULOX_SSO_SECRET, next);
    if (consume) redirect(consume);
  }

  return <LoginForm framed={requestIsIframe(request)} errorCode={errorCode} next={next} />;
}
