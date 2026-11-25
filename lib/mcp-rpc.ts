// Garpen McpRpc. Pure logic (no Next.js or Cloudflare imports) so node:test can load it.
import type { D1Bound, D1Like } from "./finance.ts";
import { UNDATED_OCCURRED_AT } from "./pending-notes.ts";
import { resolveApprovedUser } from "./mailtox-link.ts";
import { isDateKey } from "./recurring.ts";
import { clearNoteDate, convertTaskToNote, isUndatedOccurredAt } from "./pending-notes.ts";
import { PAYMENT_SELECT, mapPayment, parsePaymentCreate, parsePaymentPatch, type Payment } from "./payments.ts";

export type RpcErrorCode = "no_owner" | "encrypted_account" | "invalid" | "not_found" | "not_enabled" | "internal";
export type RpcResult<T> = { ok: true; data: T } | { ok: false; error: { code: RpcErrorCode; message: string } };
export type Page<T> = { items: T[]; nextOffset: number | null };

export type Contact = {
  id: string;
  kind: "person" | "company";
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  metEvent: string | null;
  metEventAt: string | null;
  metNote: string | null;
  updatedAt: number;
};
export type Task = {
  id: string;
  title: string;
  description: string | null;
  status: "todo" | "in_progress" | "done" | "cancelled";
  priority: "low" | "normal" | "high" | "urgent";
  dueDate: string | null;
  contactId: string | null;
  updatedAt: number;
};
export type AgendaEvent = {
  id: string;
  title: string;
  body: string | null;
  occurredAt: string;
  contactIds: string[];
  updatedAt: number;
};
export type Note = {
  id: string;
  title: string;
  body: string | null;
  occurredAt: string | null;
  contactIds: string[];
  updatedAt: number;
};
export type { Payment };
export type Inquiry = {
  id: string;
  name: string;
  email: string;
  message: string;
  status: "new" | "read" | "archived";
  source: string;
  createdAt: number;
  readAt: number | null;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_QUERY = 200;
const NAME_MAX = 160;
const COMPANY_MAX = 160;
const EMAIL_MAX = 254;
const PHONE_MAX = 80;
const NOTES_MAX = 5000;
const MET_EVENT_MAX = 200;
const MET_NOTE_MAX = 5000;
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 5000;
const BODY_MAX = 30000;
const WHEN_MAX = 32;
const ID_MAX = 80;
const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;
const ENCRYPTED = "encrypted account, not readable server-side";

const CONTACT_KINDS = ["person", "company"] as const;
const TASK_STATUSES = ["todo", "in_progress", "done", "cancelled"] as const;
const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const INQUIRY_STATUSES = ["new", "read", "archived"] as const;

const WHEN_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** Agenda day: first 10 chars after a space is treated as `T` (same as app/agenda.tsx). */
const DAY_EXPR = "substr(replace(a.occurred_at, ' ', 'T'), 1, 10)";
/**
 * Wall clock the agenda shows (YYYY-MM-DDTHH:mm[:ss]), padded so a date-only value is midnight
 * and `YYYY-MM-DDTHH:mm` compares equal to the same minute with seconds.
 */
const CLOCK_EXPR = "(CASE WHEN length(replace(a.occurred_at, ' ', 'T')) <= 10 THEN substr(replace(a.occurred_at, ' ', 'T'), 1, 10) || 'T00:00:00' WHEN length(replace(a.occurred_at, ' ', 'T')) = 16 THEN replace(a.occurred_at, ' ', 'T') || ':00' ELSE substr(replace(a.occurred_at, ' ', 'T'), 1, 19) END)";

type WhenBound = { raw: string; day: string; clock: string | null };

function fail(code: RpcErrorCode, message: string): RpcResult<never> {
  return { ok: false, error: { code, message } };
}

function invalid(message: string): RpcResult<never> {
  return fail("invalid", message);
}

function internal(): RpcResult<never> {
  return fail("internal", "internal error");
}

function ok<T>(data: T): RpcResult<T> {
  return { ok: true, data };
}

async function run<T>(body: () => Promise<RpcResult<T>>): Promise<RpcResult<T>> {
  try {
    return await body();
  } catch {
    return internal();
  }
}

function record(input: unknown): Record<string, unknown> | null {
  if (input === undefined) return {};
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

async function ownerId(db: D1Like, ownerEmail: string | undefined): Promise<{ ok: true; userId: string } | { ok: false; result: RpcResult<never> }> {
  // HTTP /mcp scopes to any approved user. The service binding still passes MCP_OWNER_EMAIL (admin).
  const gate = await resolveApprovedUser(db, ownerEmail);
  if (gate.ok) return gate;
  if (gate.status === "skipped_e2e") return { ok: false, result: fail("encrypted_account", ENCRYPTED) };
  return { ok: false, result: fail("no_owner", "no owner") };
}

export { resolveApprovedUser };

function parsePage(input: Record<string, unknown>): { ok: true; limit: number; offset: number } | { ok: false; message: string } {
  const limit = input.limit === undefined ? DEFAULT_LIMIT : input.limit;
  const offset = input.offset === undefined ? 0 : input.offset;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { ok: false, message: "invalid limit" };
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || !Number.isSafeInteger(offset)) return { ok: false, message: "invalid offset" };
  return { ok: true, limit, offset };
}

function parseQuery(value: unknown): { ok: true; query: string } | { ok: false; message: string } {
  if (typeof value !== "string") return { ok: false, message: "invalid query" };
  const query = value.trim();
  if (query.length < 1 || query.length > MAX_QUERY) return { ok: false, message: "invalid query" };
  return { ok: true, query };
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): { ok: true; value?: T } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) return { ok: false, message: "invalid " + label };
  return { ok: true, value: value as T };
}

/** `%query%` with `\`, `%` and `_` escaped so LIKE treats them as literal characters. */
function likePattern(query: string): string {
  return "%" + query.replace(/[\\%_]/g, (ch) => "\\" + ch) + "%";
}

function likeAny(columns: readonly string[], binds: unknown[], query: string): string {
  const pattern = likePattern(query);
  const parts = columns.map((column) => "lower(ifnull(" + column + ", '')) LIKE lower(?) ESCAPE '\\'");
  for (let i = 0; i < columns.length; i++) binds.push(pattern);
  return "(" + parts.join(" OR ") + ")";
}

function num(value: unknown): number {
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(value: unknown): number | null {
  if (value == null) return null;
  return num(value);
}

function textOrNull(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

function parseWhen(value: unknown): WhenBound | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > WHEN_MAX) return null;
  const match = WHEN_RE.exec(raw);
  if (!match || !isDateKey(match[1])) return null;
  if (match[2] === undefined) return { raw, day: match[1], clock: null };
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = match[4] === undefined ? 0 : Number(match[4]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const clock = match[1] + "T" + match[2] + ":" + match[3] + ":" + String(second).padStart(2, "0");
  return { raw, day: match[1], clock };
}

function dayNumber(day: string): number {
  return Math.floor(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / DAY_MS);
}

function rangeOk(from: WhenBound, to: WhenBound): boolean {
  const span = dayNumber(to.day) - dayNumber(from.day);
  if (span < 0 || span > MAX_RANGE_DAYS) return false;
  const start = from.clock ?? from.day + "T00:00:00";
  const end = to.clock ?? to.day + "T23:59:59";
  return start <= end;
}

function pushRange(where: string[], binds: unknown[], from?: WhenBound, to?: WhenBound): void {
  if (from) {
    if (from.clock) {
      where.push(CLOCK_EXPR + " >= ?");
      binds.push(from.clock);
    } else {
      where.push(DAY_EXPR + " >= ?");
      binds.push(from.day);
    }
  }
  if (to) {
    if (to.clock) {
      where.push(CLOCK_EXPR + " <= ?");
      binds.push(to.clock);
    } else {
      where.push(DAY_EXPR + " <= ?");
      binds.push(to.day);
    }
  }
}

function optionalWhen(input: Record<string, unknown>, key: string): { ok: true; value?: WhenBound } | { ok: false } {
  if (!Object.prototype.hasOwnProperty.call(input, key) || input[key] === undefined) return { ok: true };
  const value = parseWhen(input[key]);
  if (!value) return { ok: false };
  return { ok: true, value };
}

type PageMeta = { limit: number; offset: number };

async function queryPage<T>(db: D1Like, sql: string, binds: unknown[], page: PageMeta): Promise<{ rows: T[]; nextOffset: number | null }> {
  const rows = (await db.prepare(sql).bind(...binds, page.limit + 1, page.offset).all<T>()).results ?? [];
  const more = rows.length > page.limit;
  return { rows: more ? rows.slice(0, page.limit) : rows, nextOffset: more ? page.offset + page.limit : null };
}

function requiredText(value: unknown, max: number, label: string): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string") return { ok: false, message: "invalid " + label };
  const text = value.trim();
  if (!text || text.length > max) return { ok: false, message: "invalid " + label };
  return { ok: true, value: text };
}

function optionalDate(value: unknown, label: string): { ok: true; value: string | null } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, message: "invalid " + label };
  const text = value.trim();
  if (!text) return { ok: true, value: null };
  if (!isDateKey(text)) return { ok: false, message: "invalid " + label };
  return { ok: true, value: text };
}

function optionalText(value: unknown, max: number, label: string): { ok: true; value: string | null } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, message: "invalid " + label };
  const text = value.trim();
  if (!text) return { ok: true, value: null };
  if (text.length > max) return { ok: false, message: "invalid " + label };
  return { ok: true, value: text };
}

function optionalId(value: unknown): { ok: true; id: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, id: null };
  if (typeof value !== "string") return { ok: false };
  const id = value.trim();
  if (!id) return { ok: true, id: null };
  if (id.length > ID_MAX) return { ok: false };
  return { ok: true, id };
}

async function contactOwned(db: D1Like, userId: string, id: string): Promise<boolean> {
  const row = await db.prepare("SELECT id FROM contacts WHERE id=? AND user_id=?").bind(id, userId).first<{ id: string }>();
  return row != null;
}

type ContactRow = { id: string; kind: string; name: string; company: string | null; email: string | null; phone: string | null; notes: string | null; metEvent: string | null; metEventAt: string | null; metNote: string | null; updatedAt: number | bigint };
type TaskRow = { id: string; title: string; description: string | null; status: string; priority: string; dueDate: string | null; contactId: string | null; updatedAt: number | bigint };
type EventRow = { id: string; title: string; body: string | null; occurredAt: string; updatedAt: number | bigint };
type InquiryRow = { id: string; name: string; email: string; message: string; status: string; source: string; createdAt: number | bigint; readAt: number | bigint | null };

function mapContact(row: ContactRow): Contact {
  const kind = row.kind === "company" ? "company" : "person";
  return {
    id: String(row.id),
    kind,
    name: String(row.name),
    company: textOrNull(row.company),
    email: textOrNull(row.email),
    phone: textOrNull(row.phone),
    notes: textOrNull(row.notes),
    metEvent: textOrNull(row.metEvent),
    metEventAt: textOrNull(row.metEventAt),
    metNote: textOrNull(row.metNote),
    updatedAt: num(row.updatedAt),
  };
}

function mapTask(row: TaskRow): Task {
  const status = (TASK_STATUSES as readonly string[]).includes(row.status) ? row.status as Task["status"] : "todo";
  const priority = (TASK_PRIORITIES as readonly string[]).includes(row.priority) ? row.priority as Task["priority"] : "normal";
  return {
    id: String(row.id),
    title: String(row.title),
    description: textOrNull(row.description),
    status,
    priority,
    dueDate: textOrNull(row.dueDate),
    contactId: textOrNull(row.contactId),
    updatedAt: num(row.updatedAt),
  };
}

function mapInquiry(row: InquiryRow): Inquiry {
  const status = (INQUIRY_STATUSES as readonly string[]).includes(row.status) ? row.status as Inquiry["status"] : "new";
  return {
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    message: String(row.message),
    status,
    source: String(row.source),
    createdAt: num(row.createdAt),
    readAt: numOrNull(row.readAt),
  };
}

const CONTACT_SELECT = "SELECT id, kind, name, company_name AS company, email, phone, notes, met_event AS metEvent, met_event_at AS metEventAt, met_note AS metNote, updated_at AS updatedAt FROM contacts";
const TASK_SELECT = "SELECT id, title, description, status, priority, due_date AS dueDate, contact_id AS contactId, updated_at AS updatedAt FROM tasks";
const EVENT_SELECT = "SELECT a.id, a.title, a.body, a.occurred_at AS occurredAt, a.updated_at AS updatedAt FROM activities a";
const INQUIRY_SELECT = "SELECT id, name, email, message, status, source, created_at AS createdAt, read_at AS readAt FROM inquiries";

async function contactIdsFor(db: D1Like, userId: string, activityIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (activityIds.length === 0) return map;
  const marks = activityIds.map(() => "?").join(",");
  const rows = (await db.prepare(
    "SELECT ac.activity_id AS activityId, ac.contact_id AS contactId FROM activity_contacts ac JOIN contacts c ON c.id = ac.contact_id AND c.user_id = ac.user_id WHERE ac.user_id=? AND ac.activity_id IN (" + marks + ") ORDER BY ac.activity_id, ac.contact_id",
  ).bind(userId, ...activityIds).all<{ activityId: string; contactId: string }>()).results ?? [];
  for (const row of rows) {
    const list = map.get(String(row.activityId));
    if (list) list.push(String(row.contactId));
    else map.set(String(row.activityId), [String(row.contactId)]);
  }
  return map;
}

async function mapEvents(db: D1Like, userId: string, rows: EventRow[]): Promise<AgendaEvent[]> {
  const links = await contactIdsFor(db, userId, rows.map((row) => String(row.id)));
  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    body: textOrNull(row.body),
    occurredAt: String(row.occurredAt),
    contactIds: links.get(String(row.id)) ?? [],
    updatedAt: num(row.updatedAt),
  }));
}

export async function listContacts(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Page<Contact>>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const page = parsePage(body);
    if (!page.ok) return invalid(page.message);
    const listed = await queryPage<ContactRow>(db, CONTACT_SELECT + " WHERE user_id=? ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?", [owner.userId], page);
    return ok({ items: listed.rows.map(mapContact), nextOffset: listed.nextOffset });
  });
}

export async function searchContacts(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Page<Contact>>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const query = parseQuery(body.query);
    if (!query.ok) return invalid(query.message);
    const page = parsePage(body);
    if (!page.ok) return invalid(page.message);
    const binds: unknown[] = [owner.userId];
    const match = likeAny(["name", "company_name", "email", "phone", "notes"], binds, query.query);
    const listed = await queryPage<ContactRow>(db, CONTACT_SELECT + " WHERE user_id=? AND " + match + " ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?", binds, page);
    return ok({ items: listed.rows.map(mapContact), nextOffset: listed.nextOffset });
  });
}

export async function createContact(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Contact>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const name = requiredText(body.name, NAME_MAX, "name");
    if (!name.ok) return invalid(name.message);
    const kind = parseEnum(body.kind, CONTACT_KINDS, "kind");
    if (!kind.ok) return invalid(kind.message);
    const email = optionalText(body.email, EMAIL_MAX, "email");
    if (!email.ok) return invalid(email.message);
    const phone = optionalText(body.phone, PHONE_MAX, "phone");
    if (!phone.ok) return invalid(phone.message);
    const company = optionalText(body.company, COMPANY_MAX, "company");
    if (!company.ok) return invalid(company.message);
    const notes = optionalText(body.notes, NOTES_MAX, "notes");
    if (!notes.ok) return invalid(notes.message);
    const metEvent = optionalText(body.metEvent, MET_EVENT_MAX, "metEvent");
    if (!metEvent.ok) return invalid(metEvent.message);
    const metNote = optionalText(body.metNote, MET_NOTE_MAX, "metNote");
    if (!metNote.ok) return invalid(metNote.message);
    const metEventAt = optionalDate(body.metEventAt, "metEventAt");
    if (!metEventAt.ok) return invalid(metEventAt.message);
    const id = crypto.randomUUID();
    const now = Date.now();
    const storedKind = kind.value ?? "person";
    await db.prepare(
      "INSERT INTO contacts (id,user_id,kind,name,company_name,email,phone,notes,met_event,met_event_at,met_note,is_potential,role,relations,github_url,x_url,instagram_url,telegram_url,whatsapp_url,linkedin_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(id, owner.userId, storedKind, name.value, company.value, email.value, phone.value, notes.value, metEvent.value, metEventAt.value, metNote.value, 0, "potential", "{}", null, null, null, null, null, null, now, now).run();
    return ok({ id, kind: storedKind, name: name.value, company: company.value, email: email.value, phone: phone.value, notes: notes.value, metEvent: metEvent.value, metEventAt: metEventAt.value, metNote: metNote.value, updatedAt: now });
  });
}

export async function listTasks(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Page<Task>>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const status = parseEnum(body.status, TASK_STATUSES, "status");
    if (!status.ok) return invalid(status.message);
    const page = parsePage(body);
    if (!page.ok) return invalid(page.message);
    const where = ["user_id=?"];
    const binds: unknown[] = [owner.userId];
    if (status.value) {
      where.push("status=?");
      binds.push(status.value);
    }
    const listed = await queryPage<TaskRow>(
      db,
      TASK_SELECT + " WHERE " + where.join(" AND ") + " ORDER BY CASE status WHEN 'todo' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, due_date, id LIMIT ? OFFSET ?",
      binds,
      page,
    );
    return ok({ items: listed.rows.map(mapTask), nextOffset: listed.nextOffset });
  });
}

export async function searchTasks(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Page<Task>>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const query = parseQuery(body.query);
    if (!query.ok) return invalid(query.message);
    const status = parseEnum(body.status, TASK_STATUSES, "status");
    if (!status.ok) return invalid(status.message);
    const page = parsePage(body);
    if (!page.ok) return invalid(page.message);
    const where = ["user_id=?"];
    const binds: unknown[] = [owner.userId];
    if (status.value) {
      where.push("status=?");
      binds.push(status.value);
    }
    where.push(likeAny(["title", "description"], binds, query.query));
    const listed = await queryPage<TaskRow>(
      db,
      TASK_SELECT + " WHERE " + where.join(" AND ") + " ORDER BY CASE status WHEN 'todo' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, due_date, id LIMIT ? OFFSET ?",
      binds,
      page,
    );
    return ok({ items: listed.rows.map(mapTask), nextOffset: listed.nextOffset });
  });
}

export async function createTask(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Task>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const title = requiredText(body.title, TITLE_MAX, "title");
    if (!title.ok) return invalid(title.message);
    const description = optionalText(body.description, DESCRIPTION_MAX, "description");
    if (!description.ok) return invalid(description.message);
    const status = parseEnum(body.status, TASK_STATUSES, "status");
    if (!status.ok) return invalid(status.message);
    const priority = parseEnum(body.priority, TASK_PRIORITIES, "priority");
    if (!priority.ok) return invalid(priority.message);
    const due = optionalText(body.dueDate, 10, "due date");
    if (!due.ok) return invalid(due.message);
    if (due.value !== null && !isDateKey(due.value)) return invalid("invalid due date");
    const contact = optionalId(body.contactId);
    if (!contact.ok) return invalid("invalid contact");
    if (contact.id && !(await contactOwned(db, owner.userId, contact.id))) return invalid("invalid contact");
    const id = crypto.randomUUID();
    const now = Date.now();
    const storedStatus = status.value ?? "todo";
    const storedPriority = priority.value ?? "normal";
    await db.prepare(
      "INSERT INTO tasks (id,user_id,project_id,contact_id,title,description,status,priority,due_date,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(id, owner.userId, null, contact.id, title.value, description.value, storedStatus, storedPriority, due.value, now, now).run();
    return ok({
      id,
      title: title.value,
      description: description.value,
      status: storedStatus,
      priority: storedPriority,
      dueDate: due.value,
      contactId: contact.id,
      updatedAt: now,
    });
  });
}

async function eventPage(db: D1Like, userId: string, where: string[], binds: unknown[], page: PageMeta): Promise<Page<AgendaEvent>> {
  const listed = await queryPage<EventRow>(
    db,
    EVENT_SELECT + " WHERE " + where.join(" AND ") + " ORDER BY " + CLOCK_EXPR + " DESC, a.created_at DESC, a.id DESC LIMIT ? OFFSET ?",
    binds,
    page,
  );
  return { items: await mapEvents(db, userId, listed.rows), nextOffset: listed.nextOffset };
}


/** One row of the "Próximos" list: open tasks plus events and notes with a date. */
export type UpcomingItem = {
  id: string;
  kind: "task" | "event" | "note";
  title: string;
  /** ISO date (or date+time) of the item; empty for a task without a due date. */
  when: string;
  contactIds: string[];
  priority: string | null;
};

type UpcomingRow = {
  kind: string;
  id: string;
  title: string;
  whenx: string | null;
  priority: string | null;
  contact_ids: string | null;
};

/**
 * The same mixed list the Garpen home calls "Próximos": open tasks (dated ones first,
 * undated at the end) and activities (events and notes) from `from` onwards. Genki's
 * widget reads this so both surfaces show exactly the same items.
 */
export async function listUpcoming(
  db: D1Like,
  ownerEmail: string | undefined,
  input: unknown = {},
): Promise<RpcResult<{ items: UpcomingItem[]; nextOffset: number }>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const from = parseWhen(body.from);
    if (!from) return invalid("invalid date range");
    const page = parsePage(body.limit === undefined ? { ...body, limit: 10 } : body);
    if (!page.ok) return invalid(page.message);
    // The UNION is wrapped so ORDER BY can use expressions: on a compound SELECT SQLite
    // only accepts plain output columns there.
    const sql =
      "SELECT * FROM (" +
      "SELECT 'task' AS kind, t.id AS id, t.title AS title, COALESCE(t.due_date,'') AS whenx, " +
      "t.priority AS priority, COALESCE(t.contact_id,'') AS contact_ids " +
      "FROM tasks t WHERE t.user_id = ? AND t.status IN ('todo','in_progress') " +
      "UNION ALL " +
      "SELECT a.kind AS kind, a.id AS id, a.title AS title, COALESCE(a.occurred_at,'') AS whenx, " +
      "NULL AS priority, " +
      "COALESCE((SELECT group_concat(ac.contact_id, ',') FROM activity_contacts ac WHERE ac.activity_id = a.id), '') AS contact_ids " +
      "FROM activities a WHERE a.user_id = ? AND a.occurred_at >= ?" +
      ") ORDER BY (whenx = '') ASC, whenx ASC, kind = 'task' DESC, title ASC LIMIT ? OFFSET ?";
    const listed = await db
      .prepare(sql)
      .bind(owner.userId, owner.userId, from.raw, page.limit + 1, page.offset)
      .all<UpcomingRow>();
    const rows = listed.results ?? [];
    const hasMore = rows.length > page.limit;
    const items: UpcomingItem[] = rows.slice(0, page.limit).map((r) => ({
      id: r.id,
      kind: r.kind === "task" ? "task" : r.kind === "event" ? "event" : "note",
      title: r.title,
      when: r.whenx ?? "",
      contactIds: String(r.contact_ids ?? "").split(",").filter(Boolean),
      priority: r.priority,
    }));
    return ok({ items, nextOffset: hasMore ? page.offset + page.limit : -1 });
  });
}

export async function listEvents(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Page<AgendaEvent>>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const from = parseWhen(body.from);
    const to = parseWhen(body.to);
    if (!from || !to || !rangeOk(from, to)) return invalid("invalid date range");
    const page = parsePage(body);
    if (!page.ok) return invalid(page.message);
    const where = ["a.user_id=?", "a.kind='event'"];
    const binds: unknown[] = [owner.userId];
    pushRange(where, binds, from, to);
    return ok(await eventPage(db, owner.userId, where, binds, page));
  });
}

export async function searchEvents(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Page<AgendaEvent>>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const query = parseQuery(body.query);
    if (!query.ok) return invalid(query.message);
    const from = optionalWhen(body, "from");
    if (!from.ok) return invalid("invalid date range");
    const to = optionalWhen(body, "to");
    if (!to.ok) return invalid("invalid date range");
    if (from.value && to.value && !rangeOk(from.value, to.value)) return invalid("invalid date range");
    const page = parsePage(body);
    if (!page.ok) return invalid(page.message);
    const where = ["a.user_id=?", "a.kind='event'"];
    const binds: unknown[] = [owner.userId];
    pushRange(where, binds, from.value, to.value);
    where.push(likeAny(["a.title", "a.body"], binds, query.query));
    return ok(await eventPage(db, owner.userId, where, binds, page));
  });
}

export async function createEvent(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<AgendaEvent>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const title = requiredText(body.title, TITLE_MAX, "title");
    if (!title.ok) return invalid(title.message);
    const when = parseWhen(body.occurredAt);
    if (!when) return invalid("invalid occurredAt");
    const notes = optionalText(body.body, BODY_MAX, "body");
    if (!notes.ok) return invalid(notes.message);
    const contactIds: string[] = [];
    if (body.contactIds !== undefined) {
      if (!Array.isArray(body.contactIds)) return invalid("invalid contact");
      const seen = new Set<string>();
      for (const value of body.contactIds) {
        if (typeof value !== "string") return invalid("invalid contact");
        const id = value.trim();
        if (!id || seen.has(id)) continue;
        if (id.length > ID_MAX) return invalid("invalid contact");
        seen.add(id);
        contactIds.push(id);
      }
    }
    if (contactIds.length > 0) {
      const marks = contactIds.map(() => "?").join(",");
      const linked = await db.prepare("SELECT COUNT(*) AS count FROM contacts WHERE user_id=? AND id IN (" + marks + ")").bind(owner.userId, ...contactIds).first<{ count: number | bigint }>();
      if (Number(linked?.count ?? 0) !== contactIds.length) return invalid("invalid contact");
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    const insert = db.prepare("INSERT INTO activities (id,user_id,kind,title,body,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(id, owner.userId, "event", title.value, notes.value, when.raw, now, now);
    const links = contactIds.map((contactId) => db.prepare("INSERT INTO activity_contacts (activity_id,contact_id,user_id) VALUES (?,?,?)").bind(id, contactId, owner.userId));
    const statements = [insert, ...links];
    const wrote = db.batch ? await db.batch(statements) : await Promise.all(statements.map((statement) => statement.run()));
    if ((wrote[0]?.meta.changes ?? 0) < 1) return internal();
    return ok({ id, title: title.value, body: notes.value, occurredAt: when.raw, contactIds, updatedAt: now });
  });
}

/** Create a note (activity kind="note"). No date means an undated note (occurred_at=""). */
export async function createNote(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Note>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const title = requiredText(body.title, TITLE_MAX, "title");
    if (!title.ok) return invalid(title.message);
    const text = optionalText(body.body, BODY_MAX, "body");
    if (!text.ok) return invalid(text.message);
    let when: string = UNDATED_OCCURRED_AT;
    if (body.occurredAt !== undefined && body.occurredAt !== null && body.occurredAt !== "") {
      const parsed = parseWhen(body.occurredAt);
      if (!parsed) return invalid("invalid occurredAt");
      when = parsed.raw;
    }
    const contactIds: string[] = [];
    if (body.contactIds !== undefined) {
      if (!Array.isArray(body.contactIds)) return invalid("invalid contact");
      const seen = new Set<string>();
      for (const value of body.contactIds) {
        if (typeof value !== "string") return invalid("invalid contact");
        const cid = value.trim();
        if (!cid || seen.has(cid)) continue;
        if (cid.length > ID_MAX) return invalid("invalid contact");
        seen.add(cid);
        contactIds.push(cid);
      }
    }
    if (contactIds.length > 0) {
      const marks = contactIds.map(() => "?").join(",");
      const linked = await db.prepare("SELECT COUNT(*) AS count FROM contacts WHERE user_id=? AND id IN (" + marks + ")").bind(owner.userId, ...contactIds).first<{ count: number | bigint }>();
      if (Number(linked?.count ?? 0) !== contactIds.length) return invalid("invalid contact");
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    const statements: D1Bound[] = [
      db.prepare("INSERT INTO activities (id,user_id,kind,title,body,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(id, owner.userId, "note", title.value, text.value, when, now, now),
      ...contactIds.map((contactId) => db.prepare("INSERT INTO activity_contacts (activity_id,contact_id,user_id) VALUES (?,?,?)").bind(id, contactId, owner.userId)),
    ];
    const wrote = await executeAll(db, statements);
    if ((wrote[0]?.meta.changes ?? 0) < 1) return internal();
    return ok({ id, title: title.value, body: text.value, occurredAt: when ? when : null, contactIds, updatedAt: now });
  });
}

export async function listInquiries(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Page<Inquiry>>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const status = parseEnum(body.status, INQUIRY_STATUSES, "status");
    if (!status.ok) return invalid(status.message);
    const page = parsePage(body);
    if (!page.ok) return invalid(page.message);
    const where = ["user_id=?"];
    const binds: unknown[] = [owner.userId];
    if (status.value) {
      where.push("status=?");
      binds.push(status.value);
    }
    const listed = await queryPage<InquiryRow>(db, INQUIRY_SELECT + " WHERE " + where.join(" AND ") + " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?", binds, page);
    return ok({ items: listed.rows.map(mapInquiry), nextOffset: listed.nextOffset });
  });
}

export async function searchInquiries(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Page<Inquiry>>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const query = parseQuery(body.query);
    if (!query.ok) return invalid(query.message);
    const status = parseEnum(body.status, INQUIRY_STATUSES, "status");
    if (!status.ok) return invalid(status.message);
    const page = parsePage(body);
    if (!page.ok) return invalid(page.message);
    const where = ["user_id=?"];
    const binds: unknown[] = [owner.userId];
    if (status.value) {
      where.push("status=?");
      binds.push(status.value);
    }
    where.push(likeAny(["name", "email", "message"], binds, query.query));
    const listed = await queryPage<InquiryRow>(db, INQUIRY_SELECT + " WHERE " + where.join(" AND ") + " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?", binds, page);
    return ok({ items: listed.rows.map(mapInquiry), nextOffset: listed.nextOffset });
  });
}

function requiredId(value: unknown): { ok: true; id: string } | { ok: false; message: string } {
  if (typeof value !== "string") return { ok: false, message: "invalid id" };
  const id = value.trim();
  if (!id || id.length > ID_MAX) return { ok: false, message: "invalid id" };
  return { ok: true, id };
}

function requireConfirm(value: unknown): { ok: true } | { ok: false; message: string } {
  if (value !== true) return { ok: false, message: "confirm required" };
  return { ok: true };
}

function hasOwn(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function mapNote(row: EventRow, contactIds: string[]): Note {
  const occurred = String(row.occurredAt);
  return {
    id: String(row.id),
    title: String(row.title),
    body: textOrNull(row.body),
    occurredAt: isUndatedOccurredAt(occurred) ? null : occurred,
    contactIds,
    updatedAt: num(row.updatedAt),
  };
}

async function mapNotes(db: D1Like, userId: string, rows: EventRow[]): Promise<Note[]> {
  const links = await contactIdsFor(db, userId, rows.map((row) => String(row.id)));
  return rows.map((row) => mapNote(row, links.get(String(row.id)) ?? []));
}

async function notePage(db: D1Like, userId: string, where: string[], binds: unknown[], page: PageMeta): Promise<Page<Note>> {
  const listed = await queryPage<EventRow>(
    db,
    EVENT_SELECT + " WHERE " + where.join(" AND ") + " ORDER BY CASE WHEN trim(ifnull(a.occurred_at,''))='' THEN 0 ELSE 1 END, a.occurred_at DESC, a.created_at DESC, a.id DESC LIMIT ? OFFSET ?",
    binds,
    page,
  );
  return { items: await mapNotes(db, userId, listed.rows), nextOffset: listed.nextOffset };
}

export async function listNotes(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Page<Note>>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const from = optionalWhen(body, "from");
    if (!from.ok) return invalid("invalid date range");
    const to = optionalWhen(body, "to");
    if (!to.ok) return invalid("invalid date range");
    if (from.value && to.value && !rangeOk(from.value, to.value)) return invalid("invalid date range");
    const page = parsePage(body);
    if (!page.ok) return invalid(page.message);
    const where = ["a.user_id=?", "a.kind='note'"];
    const binds: unknown[] = [owner.userId];
    if (from.value || to.value) {
      const range: string[] = ["trim(ifnull(a.occurred_at,''))=''"];
      const dated: string[] = ["trim(ifnull(a.occurred_at,''))!=''"];
      const datedBinds: unknown[] = [];
      pushRange(dated, datedBinds, from.value, to.value);
      where.push("(" + range[0] + " OR (" + dated.join(" AND ") + "))");
      binds.push(...datedBinds);
    }
    return ok(await notePage(db, owner.userId, where, binds, page));
  });
}

export async function searchNotes(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Page<Note>>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const query = parseQuery(body.query);
    if (!query.ok) return invalid(query.message);
    const from = optionalWhen(body, "from");
    if (!from.ok) return invalid("invalid date range");
    const to = optionalWhen(body, "to");
    if (!to.ok) return invalid("invalid date range");
    if (from.value && to.value && !rangeOk(from.value, to.value)) return invalid("invalid date range");
    const page = parsePage(body);
    if (!page.ok) return invalid(page.message);
    const where = ["a.user_id=?", "a.kind='note'"];
    const binds: unknown[] = [owner.userId];
    if (from.value || to.value) {
      const dated: string[] = ["trim(ifnull(a.occurred_at,''))!=''"];
      const datedBinds: unknown[] = [];
      pushRange(dated, datedBinds, from.value, to.value);
      where.push("(trim(ifnull(a.occurred_at,''))='' OR (" + dated.join(" AND ") + "))");
      binds.push(...datedBinds);
    }
    where.push(likeAny(["a.title", "a.body"], binds, query.query));
    return ok(await notePage(db, owner.userId, where, binds, page));
  });
}

async function loadTask(db: D1Like, userId: string, id: string): Promise<TaskRow | null> {
  return db.prepare(TASK_SELECT + " WHERE user_id=? AND id=?").bind(userId, id).first<TaskRow>();
}

async function loadNote(db: D1Like, userId: string, id: string): Promise<EventRow | null> {
  return db.prepare(EVENT_SELECT + " WHERE a.user_id=? AND a.id=? AND a.kind='note'").bind(userId, id).first<EventRow>();
}

export async function updateTask(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Task>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const id = requiredId(body.id);
    if (!id.ok) return invalid(id.message);
    const existing = await loadTask(db, owner.userId, id.id);
    if (!existing) return fail("not_found", "not found");
    const current = mapTask(existing);
    let title = current.title;
    let description = current.description;
    let status = current.status;
    let priority = current.priority;
    let dueDate = current.dueDate;
    let contactId = current.contactId;
    if (hasOwn(body, "title")) {
      const parsed = requiredText(body.title, TITLE_MAX, "title");
      if (!parsed.ok) return invalid(parsed.message);
      title = parsed.value;
    }
    if (hasOwn(body, "description")) {
      const parsed = optionalText(body.description, DESCRIPTION_MAX, "description");
      if (!parsed.ok) return invalid(parsed.message);
      description = parsed.value;
    }
    if (hasOwn(body, "status")) {
      const parsed = parseEnum(body.status, TASK_STATUSES, "status");
      if (!parsed.ok || !parsed.value) return invalid("invalid status");
      status = parsed.value;
    }
    if (hasOwn(body, "priority")) {
      const parsed = parseEnum(body.priority, TASK_PRIORITIES, "priority");
      if (!parsed.ok || !parsed.value) return invalid("invalid priority");
      priority = parsed.value;
    }
    if (hasOwn(body, "dueDate")) {
      const parsed = optionalDate(body.dueDate, "due date");
      if (!parsed.ok) return invalid(parsed.message);
      dueDate = parsed.value;
    }
    if (hasOwn(body, "contactId")) {
      const contact = optionalId(body.contactId);
      if (!contact.ok) return invalid("invalid contact");
      if (contact.id && !(await contactOwned(db, owner.userId, contact.id))) return invalid("invalid contact");
      contactId = contact.id;
    }
    const now = Date.now();
    const result = await db.prepare("UPDATE tasks SET title=?,description=?,status=?,priority=?,due_date=?,contact_id=?,updated_at=? WHERE id=? AND user_id=?").bind(title, description, status, priority, dueDate, contactId, now, id.id, owner.userId).run();
    if ((result.meta.changes ?? 0) < 1) return fail("not_found", "not found");
    return ok({ id: id.id, title, description, status, priority, dueDate, contactId, updatedAt: now });
  });
}

export async function deleteTask(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<{ id: string; deleted: true }>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const confirmed = requireConfirm(body.confirm);
    if (!confirmed.ok) return invalid(confirmed.message);
    const id = requiredId(body.id);
    if (!id.ok) return invalid(id.message);
    const result = await db.prepare("DELETE FROM tasks WHERE id=? AND user_id=?").bind(id.id, owner.userId).run();
    if ((result.meta.changes ?? 0) < 1) return fail("not_found", "not found");
    return ok({ id: id.id, deleted: true });
  });
}

async function parseContactIds(db: D1Like, userId: string, value: unknown): Promise<{ ok: true; ids: string[] } | { ok: false; message: string }> {
  if (value === undefined) return { ok: true, ids: [] };
  if (!Array.isArray(value)) return { ok: false, message: "invalid contact" };
  const contactIds: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return { ok: false, message: "invalid contact" };
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    if (id.length > ID_MAX) return { ok: false, message: "invalid contact" };
    seen.add(id);
    contactIds.push(id);
  }
  if (contactIds.length > 0) {
    const marks = contactIds.map(() => "?").join(",");
    const linked = await db.prepare("SELECT COUNT(*) AS count FROM contacts WHERE user_id=? AND id IN (" + marks + ")").bind(userId, ...contactIds).first<{ count: number | bigint }>();
    if (Number(linked?.count ?? 0) !== contactIds.length) return { ok: false, message: "invalid contact" };
  }
  return { ok: true, ids: contactIds };
}

export async function updateNote(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Note>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const id = requiredId(body.id);
    if (!id.ok) return invalid(id.message);
    const existing = await loadNote(db, owner.userId, id.id);
    if (!existing) return fail("not_found", "not found");
    const currentIds = (await contactIdsFor(db, owner.userId, [id.id])).get(id.id) ?? [];
    let title = String(existing.title);
    let notes = textOrNull(existing.body);
    let occurredAt = isUndatedOccurredAt(String(existing.occurredAt)) ? null : String(existing.occurredAt);
    let contactIds = currentIds;
    if (hasOwn(body, "title")) {
      const parsed = requiredText(body.title, TITLE_MAX, "title");
      if (!parsed.ok) return invalid(parsed.message);
      title = parsed.value;
    }
    if (hasOwn(body, "body")) {
      const parsed = optionalText(body.body, BODY_MAX, "body");
      if (!parsed.ok) return invalid(parsed.message);
      notes = parsed.value;
    }
    if (hasOwn(body, "occurredAt")) {
      if (body.occurredAt === null || body.occurredAt === "") occurredAt = null;
      else {
        const when = parseWhen(body.occurredAt);
        if (!when) return invalid("invalid occurredAt");
        occurredAt = when.raw;
      }
    }
    if (hasOwn(body, "contactIds")) {
      const parsed = await parseContactIds(db, owner.userId, body.contactIds);
      if (!parsed.ok) return invalid(parsed.message);
      contactIds = parsed.ids;
    }
    const now = Date.now();
    const stored = occurredAt ?? "";
    const update = db.prepare("UPDATE activities SET title=?,body=?,occurred_at=?,updated_at=? WHERE id=? AND user_id=? AND kind='note'").bind(title, notes, stored, now, id.id, owner.userId);
    const statements = [update];
    if (hasOwn(body, "contactIds")) {
      statements.push(db.prepare("DELETE FROM activity_contacts WHERE activity_id=? AND user_id=?").bind(id.id, owner.userId));
      for (const contactId of contactIds) statements.push(db.prepare("INSERT INTO activity_contacts (activity_id,contact_id,user_id) VALUES (?,?,?)").bind(id.id, contactId, owner.userId));
    }
    const wrote = db.batch ? await db.batch(statements) : await Promise.all(statements.map((statement) => statement.run()));
    if ((wrote[0]?.meta.changes ?? 0) < 1) return fail("not_found", "not found");
    return ok({ id: id.id, title, body: notes, occurredAt, contactIds, updatedAt: now });
  });
}

export async function deleteNote(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<{ id: string; deleted: true }>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const confirmed = requireConfirm(body.confirm);
    if (!confirmed.ok) return invalid(confirmed.message);
    const id = requiredId(body.id);
    if (!id.ok) return invalid(id.message);
    const result = await db.prepare("DELETE FROM activities WHERE id=? AND user_id=? AND kind='note'").bind(id.id, owner.userId).run();
    if ((result.meta.changes ?? 0) < 1) return fail("not_found", "not found");
    return ok({ id: id.id, deleted: true });
  });
}

export async function taskToUndatedNote(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<{ note: Note; deletedTaskIds: string[]; merged: boolean }>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const id = requiredId(body.taskId ?? body.id);
    if (!id.ok) return invalid(id.message);
    const result = await convertTaskToNote(db, owner.userId, id.id);
    if ("error" in result) return fail("not_found", "not found");
    const note = result.notes[0];
    if (!note) return fail("not_found", "not found");
    return ok({
      note: { id: note.id, title: note.title, body: note.body, occurredAt: null, contactIds: note.contactIds, updatedAt: Date.now() },
      deletedTaskIds: result.convertedTaskIds,
      merged: note.merged,
    });
  });
}

export async function clearNoteDateRpc(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<{ id: string; occurredAt: null }>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const id = requiredId(body.id);
    if (!id.ok) return invalid(id.message);
    const result = await clearNoteDate(db, owner.userId, id.id);
    if ("error" in result) return fail("not_found", "not found");
    return ok({ id: id.id, occurredAt: null });
  });
}


export const ITEM_KINDS = ["task", "event", "note"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

async function executeAll(db: D1Like, statements: D1Bound[]): Promise<Array<{ meta: { changes: number } }>> {
  if (db.batch) return db.batch(statements);
  return Promise.all(statements.map((statement) => statement.run()));
}

/**
 * Change an item between task, event and note.
 * Keeps what the three share (title, body/description, date, contact) and drops the
 * fields that only exist on the source type. Creates the target and removes the source,
 * so the id changes. A note with no date uses occurred_at = "" (that is how Garpen
 * stores undated notes); an event always needs a date.
 */
export async function convertItem(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<{ from: ItemKind; to: ItemKind; id: string; title: string; removedId: string }>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const id = requiredId(body.id);
    if (!id.ok) return invalid(id.message);
    const from = parseEnum(body.from, ITEM_KINDS, "from");
    if (!from.ok) return invalid(from.message);
    if (!from.value) return invalid("invalid from");
    const to = parseEnum(body.to, ITEM_KINDS, "to");
    if (!to.ok) return invalid(to.message);
    if (!to.value) return invalid("invalid to");
    const target = to.value;
    if (from.value === target) return invalid("from and to are the same");
    const now = Date.now();
    const newId = crypto.randomUUID();
    const statements: D1Bound[] = [];

    if (from.value === "task") {
      const task = await db.prepare("SELECT id, title, description, status, priority, due_date AS dueDate, contact_id AS contactId FROM tasks WHERE user_id=? AND id=?").bind(owner.userId, id.id).first<TaskRow>();
      if (!task) return fail("not_found", "not found");
      const title = String(task.title ?? "").slice(0, TITLE_MAX);
      const text = task.description ? String(task.description) : null;
      const due = task.dueDate ? String(task.dueDate).slice(0, 10) : "";
      const contact = task.contactId ? String(task.contactId) : null;
      if (target === "event") {
        if (!due) return invalid("a task without a due date cannot become an event");
        statements.push(db.prepare("INSERT INTO activities (id,user_id,kind,title,body,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(newId, owner.userId, "event", title, text, due, now, now));
        if (contact) statements.push(db.prepare("INSERT INTO activity_contacts (activity_id,contact_id,user_id) VALUES (?,?,?)").bind(newId, contact, owner.userId));
      } else {
        statements.push(db.prepare("INSERT INTO activities (id,user_id,kind,title,body,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(newId, owner.userId, "note", title, text, due, now, now));
        if (contact) statements.push(db.prepare("INSERT INTO activity_contacts (activity_id,contact_id,user_id) VALUES (?,?,?)").bind(newId, contact, owner.userId));
      }
      statements.push(db.prepare("DELETE FROM tasks WHERE user_id=? AND id=?").bind(owner.userId, id.id));
      const wrote = await executeAll(db, statements);
      if ((wrote[0]?.meta.changes ?? 0) < 1) return internal();
      return ok({ from: "task" as ItemKind, to: target, id: newId, title, removedId: id.id });
    }

    const activity = await db.prepare("SELECT id, kind, title, body, occurred_at AS occurredAt FROM activities WHERE user_id=? AND id=?").bind(owner.userId, id.id).first<{ id: string; kind: string; title: string; body: string | null; occurredAt: string | null }>();
    if (!activity) return fail("not_found", "not found");
    const title = String(activity.title ?? "").slice(0, TITLE_MAX);
    const text = activity.body ? String(activity.body) : null;
    const when = activity.occurredAt ? String(activity.occurredAt) : "";
    const day = when ? when.slice(0, 10) : "";
    const links = await db.prepare("SELECT contact_id AS contactId FROM activity_contacts WHERE user_id=? AND activity_id=?").bind(owner.userId, id.id).all<{ contactId: string }>();
    const contactIds = (links.results ?? []).map((row) => String(row.contactId));

    if (target === "task") {
      statements.push(db.prepare("INSERT INTO tasks (id,user_id,contact_id,title,description,status,priority,due_date,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(newId, owner.userId, contactIds[0] ?? null, title, text, "todo", "normal", day || null, now, now));
    } else {
      const nextKind = target === "event" ? "event" : "note";
      if (nextKind === "event" && !day) return invalid("a note without a date cannot become an event");
      statements.push(db.prepare("INSERT INTO activities (id,user_id,kind,title,body,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(newId, owner.userId, nextKind, title, text, when, now, now));
      for (const contactId of contactIds) statements.push(db.prepare("INSERT INTO activity_contacts (activity_id,contact_id,user_id) VALUES (?,?,?)").bind(newId, contactId, owner.userId));
    }
    statements.push(db.prepare("DELETE FROM activities WHERE user_id=? AND id=?").bind(owner.userId, id.id));
    const wrote = await executeAll(db, statements);
    if ((wrote[0]?.meta.changes ?? 0) < 1) return internal();
    return ok({ from: (activity.kind === "event" ? "event" : "note") as ItemKind, to: target, id: newId, title, removedId: id.id });
  });
}

export async function addContactNote(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Note>> {
  const body = record(input);
  if (!body) return invalid("invalid input");
  const contact = requiredId(body.contactId);
  if (!contact.ok) return invalid("invalid contact");
  const rest: Record<string, unknown> = { ...body, contactIds: [contact.id] };
  delete rest.contactId;
  return createNote(db, ownerEmail, rest);
}

export async function createPayment(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Payment>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const parsed = parsePaymentCreate(body);
    if (!parsed.ok) return invalid(parsed.message);
    if (!(await contactOwned(db, owner.userId, parsed.value.contactId))) return invalid("invalid contact");
    const id = crypto.randomUUID();
    const now = Date.now();
    const v = parsed.value;
    const result = await db.prepare(
      "INSERT INTO contact_payments (id,user_id,contact_id,amount_minor,currency,occurred_at,concept,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).bind(id, owner.userId, v.contactId, v.amountMinor, v.currency, v.occurredAt, v.concept, v.status, now, now).run();
    if ((result.meta.changes ?? 0) < 1) return internal();
    const row = await db.prepare(PAYMENT_SELECT + " WHERE p.user_id=? AND p.id=?").bind(owner.userId, id).first<Parameters<typeof mapPayment>[0]>();
    if (!row) return internal();
    return ok(mapPayment(row));
  });
}

export async function listPayments(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Page<Payment>>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const page = parsePage(body);
    if (!page.ok) return invalid(page.message);
    const where = ["p.user_id=?"];
    const binds: unknown[] = [owner.userId];
    if (body.contactId !== undefined && body.contactId !== null && body.contactId !== "") {
      const contact = requiredId(body.contactId);
      if (!contact.ok) return invalid("invalid contact");
      if (!(await contactOwned(db, owner.userId, contact.id))) return invalid("invalid contact");
      where.push("p.contact_id=?");
      binds.push(contact.id);
    }
    if (body.status !== undefined && body.status !== null && body.status !== "") {
      if (body.status !== "pending" && body.status !== "paid") return invalid("invalid status");
      where.push("p.status=?");
      binds.push(body.status);
    }
    const sql = PAYMENT_SELECT + " WHERE " + where.join(" AND ") + " ORDER BY p.occurred_at DESC, p.created_at DESC LIMIT ? OFFSET ?";
    const { rows, nextOffset } = await queryPage<Parameters<typeof mapPayment>[0]>(db, sql, binds, page);
    return ok({ items: rows.map(mapPayment), nextOffset });
  });
}

export async function updatePayment(db: D1Like, ownerEmail: string | undefined, input: unknown = {}): Promise<RpcResult<Payment>> {
  return run(async () => {
    const owner = await ownerId(db, ownerEmail);
    if (!owner.ok) return owner.result;
    const body = record(input);
    if (!body) return invalid("invalid input");
    const id = requiredId(body.id);
    if (!id.ok) return invalid(id.message);
    const parsed = parsePaymentPatch(body);
    if (!parsed.ok) return invalid(parsed.message);
    const existing = await db.prepare(
      "SELECT id, contact_id AS contactId, amount_minor AS amountMinor, currency, occurred_at AS occurredAt, concept, status FROM contact_payments WHERE id=? AND user_id=?",
    ).bind(id.id, owner.userId).first<{ id: string; contactId: string; amountMinor: number; currency: string; occurredAt: string; concept: string; status: string }>();
    if (!existing) return fail("not_found", "not found");
    const next = {
      amountMinor: parsed.value.amountMinor ?? Number(existing.amountMinor),
      currency: parsed.value.currency ?? existing.currency,
      occurredAt: parsed.value.occurredAt ?? existing.occurredAt,
      concept: parsed.value.concept ?? existing.concept,
      status: parsed.value.status ?? existing.status,
    };
    const now = Date.now();
    const result = await db.prepare(
      "UPDATE contact_payments SET amount_minor=?,currency=?,occurred_at=?,concept=?,status=?,updated_at=? WHERE id=? AND user_id=?",
    ).bind(next.amountMinor, next.currency, next.occurredAt, next.concept, next.status, now, id.id, owner.userId).run();
    if ((result.meta.changes ?? 0) < 1) return fail("not_found", "not found");
    const row = await db.prepare(PAYMENT_SELECT + " WHERE p.user_id=? AND p.id=?").bind(owner.userId, id.id).first<Parameters<typeof mapPayment>[0]>();
    if (!row) return internal();
    return ok(mapPayment(row));
  });
}
