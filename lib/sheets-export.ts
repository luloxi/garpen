/**
 * Rows for "Guardar en Google Sheets". Every query is scoped to one user_id,
 * so an export only carries what that person already sees in Garpen.
 *
 * Runs on the server for a normal account and in the browser (in-memory copy,
 * already decrypted) for an encrypted one: the SQL is plain SQLite and touches
 * only tables the local engine also has.
 */
import type { SheetCell, SheetTab } from "./sheets/google-sheets";

type Db = {
  prepare(sql: string): { bind(...values: unknown[]): { all<T = Record<string, unknown>>(): Promise<{ results?: T[] }> } };
};
type Row = Record<string, unknown>;

export type GarpenSheetsData = { appName: "Garpen"; fileTitle: string; exportKey: string; loginHint: string | null; tabs: SheetTab[] };

const MAX_ROWS = 20000;

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}
function minor(value: unknown): number | null {
  const n = Number(value);
  return value === null || value === undefined || !Number.isFinite(n) ? null : n / 100;
}
function dateMs(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n).toISOString().slice(0, 10);
}
/** Notes are stored as HTML: the Sheet gets plain text, capped well under Google's 50k per cell. */
export function plainText(html: unknown, max = 5000): string {
  const out = text(html)
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}

const ROLE: Record<string, string> = { client: "Cliente", partner: "Socio", supplier: "Proveedor", potential: "Potencial", none: "" };
const STATUS: Record<string, string> = { todo: "Pendiente", in_progress: "En curso", done: "Hecha", cancelled: "Cancelada", active: "Activo", paused: "Pausado", completed: "Terminado", draft: "Borrador", sent: "Enviado", paid: "Pagado", void: "Anulado", pending: "Pendiente" };
const PRIORITY: Record<string, string> = { high: "Alta", medium: "Media", low: "Baja", urgent: "Urgente" };
const label = (map: Record<string, string>, value: unknown) => map[text(value)] ?? text(value);

async function rows(db: Db, sql: string, ...binds: unknown[]): Promise<Row[]> {
  const res = await db.prepare(sql).bind(...binds).all<Row>();
  return res.results ?? [];
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildGarpenSheets(db: Db, user: { id: string; name: string; email: string }): Promise<GarpenSheetsData> {
  const uid = user.id;
  const [contacts, tasks, projects, txs, accounts, docs, hours, payments, notes] = await Promise.all([
    rows(db, `SELECT name, company_name, email, phone, role, is_potential, met_event, notes, created_at FROM contacts WHERE user_id = ? ORDER BY name COLLATE NOCASE LIMIT ${MAX_ROWS}`, uid),
    rows(db, `SELECT t.title, t.status, t.priority, t.due_date, p.name AS project, c.name AS contact FROM tasks t LEFT JOIN projects p ON p.id = t.project_id AND p.user_id = t.user_id LEFT JOIN contacts c ON c.id = t.contact_id AND c.user_id = t.user_id WHERE t.user_id = ? ORDER BY t.due_date IS NULL, t.due_date LIMIT ${MAX_ROWS}`, uid),
    rows(db, `SELECT name, status, start_date, due_date, description FROM projects WHERE user_id = ? ORDER BY name COLLATE NOCASE LIMIT ${MAX_ROWS}`, uid),
    rows(db, `SELECT t.occurred_at, t.kind, t.amount_minor, a.currency, t.category, t.description, a.name AS account, c.name AS contact FROM financial_transactions t JOIN financial_accounts a ON a.id = t.account_id AND a.user_id = t.user_id LEFT JOIN contacts c ON c.id = t.contact_id AND c.user_id = t.user_id WHERE t.user_id = ? AND t.deleted_at IS NULL ORDER BY t.occurred_at DESC, t.created_at DESC LIMIT ${MAX_ROWS}`, uid),
    rows(db, `SELECT a.name, a.currency, a.opening_balance_minor, a.opening_balance_minor + COALESCE((SELECT SUM(CASE WHEN t.kind = 'income' THEN t.amount_minor ELSE -t.amount_minor END) FROM financial_transactions t WHERE t.account_id = a.id AND t.user_id = a.user_id AND t.deleted_at IS NULL AND COALESCE(t.excluded_from_totals, 0) = 0), 0) AS balance_minor FROM financial_accounts a WHERE a.user_id = ? ORDER BY a.name LIMIT 1000`, uid),
    rows(db, `SELECT d.doc_type, d.number, c.name AS contact, d.status, d.issue_date, d.due_date, d.currency, (SELECT COALESCE(SUM(i.quantity_milli * i.unit_price_minor), 0) FROM document_items i WHERE i.document_id = d.id) AS total_milli_minor, d.paid_at FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id AND c.user_id = d.user_id WHERE d.user_id = ? ORDER BY d.issue_date DESC, d.number DESC LIMIT ${MAX_ROWS}`, uid),
    rows(db, `SELECT e.started_at, e.duration_ms, e.description, t.title AS task, e.billable, e.amount_minor, e.currency FROM time_entries e LEFT JOIN tasks t ON t.id = e.task_id AND t.user_id = e.user_id WHERE e.user_id = ? ORDER BY e.started_at DESC LIMIT ${MAX_ROWS}`, uid),
    rows(db, `SELECT p.occurred_at, c.name AS contact, p.concept, p.amount_minor, p.currency, p.status FROM contact_payments p LEFT JOIN contacts c ON c.id = p.contact_id AND c.user_id = p.user_id WHERE p.user_id = ? ORDER BY p.occurred_at DESC LIMIT ${MAX_ROWS}`, uid),
    rows(db, `SELECT a.occurred_at, a.kind, a.title, a.body, (SELECT group_concat(c.name, ', ') FROM activity_contacts ac JOIN contacts c ON c.id = ac.contact_id AND c.user_id = a.user_id WHERE ac.activity_id = a.id) AS contacts FROM activities a WHERE a.user_id = ? ORDER BY a.occurred_at DESC LIMIT ${MAX_ROWS}`, uid),
  ]);

  const tabs: SheetTab[] = [
    {
      title: "Contactos",
      columns: ["Nombre", "Empresa", "Email", "Teléfono", "Rol", "Potencial", "Dónde nos conocimos", "Notas", "Alta"],
      rows: contacts.map((r): SheetCell[] => [text(r.name), text(r.company_name), text(r.email), text(r.phone), label(ROLE, r.role), Number(r.is_potential) === 1 ? "Sí" : "No", text(r.met_event), plainText(r.notes), dateMs(r.created_at)]),
    },
    {
      title: "Tareas",
      columns: ["Tarea", "Estado", "Prioridad", "Vence", "Proyecto", "Contacto"],
      rows: tasks.map((r) => [text(r.title), label(STATUS, r.status), label(PRIORITY, r.priority), text(r.due_date), text(r.project), text(r.contact)]),
    },
    {
      title: "Proyectos",
      columns: ["Proyecto", "Estado", "Inicio", "Vence", "Descripción"],
      rows: projects.map((r) => [text(r.name), label(STATUS, r.status), text(r.start_date), text(r.due_date), plainText(r.description)]),
    },
    {
      title: "Movimientos",
      columns: ["Fecha", "Tipo", "Monto", "Moneda", "Categoría", "Detalle", "Cuenta", "Contacto"],
      rows: txs.map((r) => [text(r.occurred_at), r.kind === "income" ? "Ingreso" : "Gasto", minor(r.amount_minor), text(r.currency), text(r.category), text(r.description), text(r.account), text(r.contact)]),
    },
    {
      title: "Cuentas",
      columns: ["Cuenta", "Moneda", "Saldo inicial", "Saldo"],
      rows: accounts.map((r) => [text(r.name), text(r.currency), minor(r.opening_balance_minor), minor(r.balance_minor)]),
    },
    {
      title: "Documentos",
      columns: ["Tipo", "Número", "Cliente", "Estado", "Fecha", "Vence", "Moneda", "Total", "Cobrado el"],
      rows: docs.map((r) => [r.doc_type === "invoice" ? "Factura" : "Presupuesto", Number(r.number), text(r.contact), label(STATUS, r.status), text(r.issue_date), text(r.due_date), text(r.currency), minor(Number(r.total_milli_minor) / 1000), text(r.paid_at)]),
    },
    {
      title: "Horas",
      columns: ["Fecha", "Horas", "Detalle", "Tarea", "Facturable", "Monto", "Moneda"],
      rows: hours.map((r) => [dateMs(r.started_at), Math.round((Number(r.duration_ms) / 3_600_000) * 100) / 100, text(r.description), text(r.task), Number(r.billable) === 1 ? "Sí" : "No", minor(r.amount_minor), text(r.currency)]),
    },
    {
      title: "Pagos",
      columns: ["Fecha", "Contacto", "Concepto", "Monto", "Moneda", "Estado"],
      rows: payments.map((r) => [text(r.occurred_at), text(r.contact), text(r.concept), minor(r.amount_minor), text(r.currency), label(STATUS, r.status)]),
    },
    {
      title: "Notas y eventos",
      columns: ["Fecha", "Tipo", "Título", "Contactos", "Texto"],
      rows: notes.map((r) => [text(r.occurred_at), r.kind === "event" ? "Evento" : "Nota", text(r.title), text(r.contacts), plainText(r.body)]),
    },
  ];

  const who = user.name.trim() || user.email;
  return {
    appName: "Garpen",
    fileTitle: who ? `Garpen – ${who}` : "Garpen",
    exportKey: (await sha256Hex(`garpen-sheets:${uid}`)).slice(0, 40),
    loginHint: user.email || null,
    tabs,
  };
}
