// Convert open tasks into undated notes, merging duplicates. Pure enough for node:test.
import type { D1Bound, D1Like } from "./finance.ts";
import { isRichNoteHtml } from "./note-html.ts";

export const UNDATED_OCCURRED_AT = "";

export type PendingTask = {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  contactId: string | null;
  contactName: string | null;
  createdAt: number;
};

export type ExistingNote = {
  id: string;
  title: string;
  body: string | null;
  contactIds: string[];
  updatedAt: number;
};

export type ConvertedNote = {
  id: string;
  title: string;
  body: string | null;
  occurredAt: null;
  contactIds: string[];
  merged: boolean;
};

export type ConvertResult = {
  convertedTaskIds: string[];
  notes: ConvertedNote[];
};

type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  contactId: string | null;
  contactName: string | null;
  createdAt: number | bigint;
};

type NoteRow = { id: string; title: string; body: string | null; updatedAt: number | bigint };

const OPEN = "status IN ('todo','in_progress')";
const UNDATED_SQL = "(occurred_at IS NULL OR trim(occurred_at)='')";

export function isUndatedOccurredAt(value: string | null | undefined): boolean {
  return !String(value || "").trim();
}

export function activityOccurredAt(kind: string, value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const text = typeof value === "string" ? value.trim() : value == null ? "" : "";
  if (typeof value === "number" || (value != null && typeof value !== "string")) {
    return { ok: false, error: "Fecha inválida" };
  }
  if (kind === "note") return { ok: true, value: text ? text.slice(0, 32) : UNDATED_OCCURRED_AT };
  if (!text) return { ok: false, error: "La fecha es obligatoria" };
  return { ok: true, value: text.slice(0, 32) };
}

/** Strip a trailing "(...)" so "Coordinar visita (reprogramada)" groups with "Coordinar visita". */
export function normalizePendingTitle(title: string): string {
  return title.trim().replace(/\s*\([^)]*\)\s*$/g, "").replace(/\s+/g, " ").toLowerCase();
}

export function pendingGroupKey(task: { contactId: string | null; title: string }): string {
  if (task.contactId) return "contact:" + task.contactId;
  return "title:" + normalizePendingTitle(task.title);
}

export function formatEsDate(iso: string): string {
  const day = iso.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return iso.trim();
  return day.slice(8, 10) + "/" + day.slice(5, 7) + "/" + day.slice(0, 4);
}

export function formatTaskSnippet(task: Pick<PendingTask, "title" | "description" | "dueDate">): string {
  const lines = [task.title.trim()];
  const description = (task.description || "").trim();
  if (description) lines.push(description);
  if (task.dueDate && String(task.dueDate).trim()) lines.push("Fecha original: " + formatEsDate(String(task.dueDate)));
  return lines.join("\n");
}

export function joinSnippets(snippets: string[]): string {
  return snippets.map((text) => text.trim()).filter(Boolean).join("\n\n");
}

export function noteTitleForGroup(tasks: PendingTask[]): string {
  const named = tasks.find((task) => (task.contactName || "").trim());
  if (named?.contactName) return named.contactName.trim();
  const first = tasks[0]?.title.trim() || "Pendiente";
  const stripped = first.replace(/\s*\([^)]*\)\s*$/g, "").trim();
  return stripped || first;
}

export function escapeNoteText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Keep existing note HTML intact and append the new plain-text block. */
export function appendNoteBody(existing: string | null | undefined, addition: string): string {
  const extra = addition.trim();
  const current = (existing || "").trim();
  if (!extra) return current;
  if (!current) return extra;
  if (isRichNoteHtml(current)) {
    const html = extra.split(/\n\n+/).map((part) => "<p>" + escapeNoteText(part).replace(/\n/g, "<br>") + "</p>").join("");
    return current + html;
  }
  return current + "\n\n" + extra;
}

export function canMergeNote(note: ExistingNote, contactId: string | null): boolean {
  if (contactId) return note.contactIds.length === 1 && note.contactIds[0] === contactId;
  return note.contactIds.length === 0;
}

function num(value: unknown): number {
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mapTask(row: TaskRow): PendingTask {
  return {
    id: String(row.id),
    title: String(row.title),
    description: row.description == null ? null : String(row.description),
    dueDate: row.dueDate == null || !String(row.dueDate).trim() ? null : String(row.dueDate),
    contactId: row.contactId == null ? null : String(row.contactId),
    contactName: row.contactName == null ? null : String(row.contactName),
    createdAt: num(row.createdAt),
  };
}

async function loadOpenTasks(db: D1Like, userId: string, taskId?: string): Promise<PendingTask[]> {
  const where = ["t.user_id=?", OPEN];
  const binds: unknown[] = [userId];
  if (taskId) {
    where.push("t.id=?");
    binds.push(taskId);
  }
  const rows = (await db.prepare(
    "SELECT t.id, t.title, t.description, t.due_date AS dueDate, t.contact_id AS contactId, c.name AS contactName, t.created_at AS createdAt FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id AND c.user_id = t.user_id WHERE " + where.join(" AND ") + " ORDER BY t.due_date, t.created_at, t.id",
  ).bind(...binds).all<TaskRow>()).results ?? [];
  return rows.map(mapTask);
}

async function loadUndatedNotes(db: D1Like, userId: string): Promise<ExistingNote[]> {
  const rows = (await db.prepare(
    "SELECT a.id, a.title, a.body, a.updated_at AS updatedAt FROM activities a WHERE a.user_id=? AND a.kind='note' AND " + UNDATED_SQL + " ORDER BY a.updated_at DESC, a.id DESC",
  ).bind(userId).all<NoteRow>()).results ?? [];
  if (rows.length === 0) return [];
  const ids = rows.map((row) => String(row.id));
  const marks = ids.map(() => "?").join(",");
  const links = (await db.prepare(
    "SELECT activity_id AS activityId, contact_id AS contactId FROM activity_contacts WHERE user_id=? AND activity_id IN (" + marks + ") ORDER BY activity_id, contact_id",
  ).bind(userId, ...ids).all<{ activityId: string; contactId: string }>()).results ?? [];
  const byId = new Map<string, string[]>();
  for (const link of links) {
    const list = byId.get(String(link.activityId));
    if (list) list.push(String(link.contactId));
    else byId.set(String(link.activityId), [String(link.contactId)]);
  }
  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    body: row.body == null ? null : String(row.body),
    contactIds: byId.get(String(row.id)) ?? [],
    updatedAt: num(row.updatedAt),
  }));
}

function pickMergeTarget(notes: ExistingNote[], tasks: PendingTask[]): ExistingNote | null {
  const contactId = tasks[0]?.contactId ?? null;
  const titleKey = normalizePendingTitle(noteTitleForGroup(tasks));
  for (const note of notes) {
    if (!canMergeNote(note, contactId)) continue;
    if (contactId) return note;
    if (normalizePendingTitle(note.title) === titleKey) return note;
  }
  return null;
}

async function applyStatements(db: D1Like, statements: D1Bound[]): Promise<void> {
  if (statements.length === 0) return;
  if (db.batch) {
    await db.batch(statements);
    return;
  }
  for (const statement of statements) await statement.run();
}

type Planned = { statements: (db: D1Like) => D1Bound[]; note: ConvertedNote };

function planConversion(db: D1Like, userId: string, tasks: PendingTask[], notes: ExistingNote[], now: number): Planned {
  const title = noteTitleForGroup(tasks);
  const addition = joinSnippets(tasks.map(formatTaskSnippet));
  const contactId = tasks[0]?.contactId ?? null;
  const contactIds = contactId ? [contactId] : [];
  const target = pickMergeTarget(notes, tasks);
  if (target) {
    const body = appendNoteBody(target.body, addition);
    return {
      note: { id: target.id, title: target.title, body, occurredAt: null, contactIds, merged: true },
      statements: (d) => [
        d.prepare("UPDATE activities SET title=?, body=?, occurred_at=?, updated_at=? WHERE id=? AND user_id=? AND kind='note'").bind(target.title, body || null, UNDATED_OCCURRED_AT, now, target.id, userId),
        ...tasks.map((task) => d.prepare("DELETE FROM tasks WHERE id=? AND user_id=?").bind(task.id, userId)),
      ],
    };
  }
  const id = crypto.randomUUID();
  return {
    note: { id, title, body: addition || null, occurredAt: null, contactIds, merged: false },
    statements: (d) => [
      d.prepare("INSERT INTO activities (id,user_id,kind,title,body,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(id, userId, "note", title, addition || null, UNDATED_OCCURRED_AT, now, now),
      ...contactIds.map((cid) => d.prepare("INSERT INTO activity_contacts (activity_id,contact_id,user_id) VALUES (?,?,?)").bind(id, cid, userId)),
      ...tasks.map((task) => d.prepare("DELETE FROM tasks WHERE id=? AND user_id=?").bind(task.id, userId)),
    ],
  };
}

function groupTasks(tasks: PendingTask[]): PendingTask[][] {
  const order: string[] = [];
  const groups = new Map<string, PendingTask[]>();
  for (const task of tasks) {
    const key = pendingGroupKey(task);
    const list = groups.get(key);
    if (list) list.push(task);
    else {
      groups.set(key, [task]);
      order.push(key);
    }
  }
  return order.map((key) => groups.get(key)!);
}

async function convertTasks(db: D1Like, userId: string, tasks: PendingTask[], now: number): Promise<ConvertResult> {
  if (tasks.length === 0) return { convertedTaskIds: [], notes: [] };
  const existing = await loadUndatedNotes(db, userId);
  const used = new Set<string>();
  const available = () => existing.filter((note) => !used.has(note.id));
  const statements: D1Bound[] = [];
  const notes: ConvertedNote[] = [];
  const convertedTaskIds: string[] = [];
  for (const group of groupTasks(tasks)) {
    const planned = planConversion(db, userId, group, available(), now);
    if (planned.note.merged) used.add(planned.note.id);
    statements.push(...planned.statements(db));
    notes.push(planned.note);
    convertedTaskIds.push(...group.map((task) => task.id));
  }
  await applyStatements(db, statements);
  return { convertedTaskIds, notes };
}

export async function convertOpenTasksToNotes(db: D1Like, userId: string, now = Date.now()): Promise<ConvertResult> {
  return convertTasks(db, userId, await loadOpenTasks(db, userId), now);
}

export async function convertTaskToNote(db: D1Like, userId: string, taskId: string, now = Date.now()): Promise<ConvertResult | { error: "not_found" }> {
  const tasks = await loadOpenTasks(db, userId, taskId);
  if (tasks.length === 0) return { error: "not_found" };
  return convertTasks(db, userId, tasks, now);
}

export async function clearNoteDate(db: D1Like, userId: string, activityId: string, now = Date.now()): Promise<{ ok: true } | { error: "not_found" }> {
  const result = await db.prepare(
    "UPDATE activities SET occurred_at=?, updated_at=? WHERE id=? AND user_id=? AND kind='note'",
  ).bind(UNDATED_OCCURRED_AT, now, activityId, userId).run();
  if ((result.meta.changes ?? 0) < 1) return { error: "not_found" };
  return { ok: true };
}
