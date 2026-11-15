import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { resolveApprovedUser } from "@/lib/mcp-rpc";
import { GARPEN_MCP_ISS, type McpRouteEnv } from "@/lib/mcp-route";
import { mintMcpToken } from "@/lib/mcp-http";

export const dynamic = "force-dynamic";

/** Mint a 90-day MCP bearer token for the signed-in approved user. Shown once. */
export async function POST() {
  const headerList = await headers();
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: headerList });
  if (!session?.user?.email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { env } = await getCloudflareContext({ async: true });
  const gate = await resolveApprovedUser(env.DB as McpRouteEnv["DB"], session.user.email);
  if (!gate.ok) return Response.json({ error: "Forbidden" }, { status: 403 });
  const secret = env.BETTER_AUTH_SECRET || env.LULOX_SSO_SECRET;
  if (!secret) return Response.json({ error: "MCP signing secret is not configured" }, { status: 503 });
  const token = await mintMcpToken({ email: session.user.email, secret, iss: GARPEN_MCP_ISS });
  return Response.json({ token, email: session.user.email, expiresInDays: 90 });
}
