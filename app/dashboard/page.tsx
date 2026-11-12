import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import E2eGateSlot from "@/app/e2e-gate-slot";
import Workspace from "@/app/workspace";
import { shouldMountGate } from "@/lib/e2e/gate";
import { encryptionMode } from "@/lib/e2e-server";
import type { D1Like } from "@/lib/finance";
import { getAuth } from "@/lib/auth";
import { APP_ORIGIN, requestFromHeaders, ssoConsumeRedirect } from "@/lib/sso-login";
export const dynamic = "force-dynamic";

type SearchParams = { [key: string]: string | string[] | undefined };

function searchSuffix(searchParams: SearchParams): string {
 const params = new URLSearchParams();
 for (const [key, value] of Object.entries(searchParams)) {
  if (typeof value === "string") params.append(key, value);
  else if (Array.isArray(value)) for (const item of value) params.append(key, item);
 }
 const query = params.toString();
 return query ? `?${query}` : "";
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
 const auth = await getAuth();
 const headerList = await headers();
 const session = await auth.api.getSession({ headers: headerList });
 const query = searchSuffix(await searchParams);
 if (!session) {
  const next = "/dashboard" + query;
  const { env } = await getCloudflareContext({ async: true });
  const consume = await ssoConsumeRedirect(requestFromHeaders(headerList, `${APP_ORIGIN}${next}`), env.LULOX_SSO_SECRET, next);
  if (consume) redirect(consume);
  redirect("/login?next=" + encodeURIComponent(next));
 }
 if (session.user.approvalStatus !== "approved") redirect("/pending");
 const name = session.user.name;
 const email = session.user.email;
 const image = session.user.image ?? null;
 const userId = session.user.id;
 // Admin keeps today's workspace: no gate, no key fetch, no local engine.
 if (session.user.role === "admin") return <Workspace name={name} email={email} image={image} isAdmin userId={userId} />;
 const { env } = await getCloudflareContext({ async: true });
 const mode = await encryptionMode(env.DB as D1Like, session.user.id);
 if (!shouldMountGate({ role: session.user.role, encryptionMode: mode })) return <Workspace name={name} email={email} image={image} isAdmin={false} userId={userId} />;
 return <E2eGateSlot userId={session.user.id} encryptionMode={mode} name={name} email={email} image={image} />;
}
