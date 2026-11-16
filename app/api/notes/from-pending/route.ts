import { NextResponse } from "next/server";
import { encryptedAccount, encryptedWriteResponse, legacyDataContext, unauthorized } from "@/lib/session";
import { clearNoteDate, convertOpenTasksToNotes, convertTaskToNote } from "@/lib/pending-notes";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const ctx = await legacyDataContext();
  if (!ctx) return unauthorized();
  if ("encrypted" in ctx) return encryptedAccount();
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  try {
    if (body.all === true) {
      const result = await convertOpenTasksToNotes(ctx.db, ctx.userId);
      return NextResponse.json({ ok: true, converted: result.convertedTaskIds.length, notes: result.notes.length, result });
    }
    if (typeof body.taskId === "string" && body.taskId.trim()) {
      const result = await convertTaskToNote(ctx.db, ctx.userId, body.taskId.trim());
      if ("error" in result) return NextResponse.json({ error: "Tarea no encontrada o ya no está abierta" }, { status: 404 });
      return NextResponse.json({ ok: true, converted: result.convertedTaskIds.length, notes: result.notes.length, result });
    }
    if (typeof body.activityId === "string" && body.activityId.trim()) {
      const result = await clearNoteDate(ctx.db, ctx.userId, body.activityId.trim());
      if ("error" in result) return NextResponse.json({ error: "Nota no encontrada" }, { status: 404 });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });
  } catch (error) {
    const blocked = encryptedWriteResponse(error);
    if (blocked) return blocked;
    console.error("pending_to_notes_failed", { error: String(error) });
    return NextResponse.json({ error: "No se pudieron pasar los pendientes a notas" }, { status: 500 });
  }
}
