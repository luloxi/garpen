import { approvedContext, unauthorized } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Public OAuth client id (not a secret) and whether the account is encrypted,
 * so the dialog can warn before a plaintext copy goes to Google Drive.
 * Never intercepted by the local engine: it always reaches the server.
 */
export async function GET() {
  const ctx = await approvedContext();
  if (!ctx) return unauthorized();
  const row = await ctx.db.prepare("SELECT encryption_mode AS mode FROM user WHERE id = ?").bind(ctx.userId).first<{ mode: string | null }>();
  const env = ctx.env as unknown as { GOOGLE_CLIENT_ID?: string };
  return Response.json(
    { clientId: env.GOOGLE_CLIENT_ID?.trim() || null, encrypted: Boolean(row?.mode && row.mode !== "server") },
    { headers: { "Cache-Control": "no-store" } },
  );
}
