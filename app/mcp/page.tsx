import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";
import { McpSetup } from "./setup";

export const dynamic = "force-dynamic";

export default async function McpPage() {
  const headerList = await headers();
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: headerList });
  if (!session) redirect("/login?next=/mcp");
  if (session.user.approvalStatus !== "approved") redirect("/pending");
  return (
    <main style={{ maxWidth: 640, margin: "2rem auto", padding: "0 1.25rem", fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>MCP de Garpen</h1>
      <p style={{ lineHeight: 1.5, color: "#444" }}>
        Endpoint remoto Streamable HTTP: <code>https://garpen.lulox.com.ar/mcp</code>.
        Cada token ve solo tus datos. Generá un bearer y pegalo en grok.com o Cursor; no lo escribas en el chat.
      </p>
      <McpSetup email={session.user.email} />
    </main>
  );
}
