import { legacyDataContext, encryptedAccount, unauthorized } from "@/lib/session";
import { buildGarpenSheets } from "@/lib/sheets-export";

export const dynamic = "force-dynamic";

/**
 * Data for "Guardar en Google Sheets". Only the signed-in user's rows.
 * An encrypted account gets 403 here; its browser answers this same URL from
 * the decrypted local copy (lib/e2e/local-api.ts).
 */
export async function GET() {
  const ctx = await legacyDataContext();
  if (!ctx) return unauthorized();
  if ("encrypted" in ctx) return encryptedAccount();
  const data = await buildGarpenSheets(ctx.db, { id: ctx.userId, name: ctx.name ?? "", email: ctx.email ?? "" });
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
