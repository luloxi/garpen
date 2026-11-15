import { readSso } from "./lulox-sso.ts";
import type { D1Like } from "./finance.ts";
import {
  createContact,
  createEvent,
  createTask,
  listContacts,
  listEvents,
  listInquiries,
  listTasks,
  resolveApprovedUser,
  searchContacts,
  searchEvents,
  searchInquiries,
  searchTasks,
} from "./mcp-rpc.ts";
import {
  bearerToken,
  handleMcpJsonRpc,
  isMcpWellKnown,
  jsonSchemaObject,
  mcpForbidden,
  mcpOptions,
  mcpProtectedResource,
  mcpUnauthorized,
  mintMcpToken,
  verifyMcpToken,
  type McpToolDef,
} from "./mcp-http.ts";

export const GARPEN_MCP_ISS = "garpen-mcp";
export const GARPEN_MCP_URL = "https://garpen.lulox.com.ar/mcp";

export type McpRouteEnv = {
  DB: D1Like;
  BETTER_AUTH_SECRET?: string;
  LULOX_SSO_SECRET?: string;
};

const pageProps = {
  limit: { type: "integer", minimum: 1, maximum: 50, description: "Items per page (1-50, default 20)" },
  offset: { type: "integer", minimum: 0, description: "Offset (default 0)" },
};
const queryProps = { query: { type: "string", minLength: 1, maxLength: 200 } };

function toolsFor(db: D1Like, email: string): McpToolDef[] {
  const run = (fn: (db: D1Like, email: string, input: unknown) => Promise<unknown>): McpToolDef["run"] => {
    return (args) => fn(db, email, args);
  };
  return [
    { name: "garpen_list_contacts", description: "List your Garpen contacts.", inputSchema: jsonSchemaObject(pageProps), annotations: { readOnlyHint: true, title: "List contacts" }, run: run(listContacts) },
    { name: "garpen_search_contacts", description: "Search your contacts by name, company, email, phone, or notes.", inputSchema: jsonSchemaObject({ ...queryProps, ...pageProps }, ["query"]), annotations: { readOnlyHint: true, title: "Search contacts" }, run: run(searchContacts) },
    { name: "garpen_create_contact", description: "Create a contact in your Garpen account.", inputSchema: jsonSchemaObject({
      name: { type: "string", minLength: 1, maxLength: 160 },
      kind: { type: "string", enum: ["person", "company"] },
      email: { type: "string", maxLength: 254 },
      phone: { type: "string", maxLength: 80 },
      company: { type: "string", maxLength: 160 },
      notes: { type: "string", maxLength: 5000 },
      metEvent: { type: "string", maxLength: 200 },
      metEventAt: { type: "string", description: "YYYY-MM-DD" },
      metNote: { type: "string", maxLength: 5000 },
    }, ["name"]), annotations: { readOnlyHint: false, destructiveHint: false, title: "Create contact" }, run: run(createContact) },
    { name: "garpen_list_tasks", description: "List your tasks, optionally by status.", inputSchema: jsonSchemaObject({ status: { type: "string", enum: ["todo", "in_progress", "done", "cancelled"] }, ...pageProps }), annotations: { readOnlyHint: true, title: "List tasks" }, run: run(listTasks) },
    { name: "garpen_search_tasks", description: "Search your tasks.", inputSchema: jsonSchemaObject({ ...queryProps, status: { type: "string", enum: ["todo", "in_progress", "done", "cancelled"] }, ...pageProps }, ["query"]), annotations: { readOnlyHint: true, title: "Search tasks" }, run: run(searchTasks) },
    { name: "garpen_create_task", description: "Create a task in your Garpen account.", inputSchema: jsonSchemaObject({
      title: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", maxLength: 5000 },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      dueDate: { type: "string", description: "YYYY-MM-DD" },
      contactId: { type: "string" },
    }, ["title"]), annotations: { readOnlyHint: false, destructiveHint: false, title: "Create task" }, run: run(createTask) },
    { name: "garpen_list_events", description: "List your agenda events in a from/to range.", inputSchema: jsonSchemaObject({ from: { type: "string" }, to: { type: "string" }, ...pageProps }, ["from", "to"]), annotations: { readOnlyHint: true, title: "List events" }, run: run(listEvents) },
    { name: "garpen_search_events", description: "Search your agenda events.", inputSchema: jsonSchemaObject({ ...queryProps, from: { type: "string" }, to: { type: "string" }, ...pageProps }, ["query"]), annotations: { readOnlyHint: true, title: "Search events" }, run: run(searchEvents) },
    { name: "garpen_create_event", description: "Create an agenda event in your Garpen account.", inputSchema: jsonSchemaObject({
      title: { type: "string", minLength: 1, maxLength: 200 },
      occurredAt: { type: "string" },
      body: { type: "string" },
      contactIds: { type: "array", items: { type: "string" } },
    }, ["title", "occurredAt"]), annotations: { readOnlyHint: false, destructiveHint: false, title: "Create event" }, run: run(createEvent) },
    { name: "garpen_list_inquiries", description: "List contact-form inquiries in your account.", inputSchema: jsonSchemaObject({ status: { type: "string", enum: ["new", "read", "archived"] }, ...pageProps }), annotations: { readOnlyHint: true, title: "List inquiries" }, run: run(listInquiries) },
    { name: "garpen_search_inquiries", description: "Search contact-form inquiries.", inputSchema: jsonSchemaObject({ ...queryProps, status: { type: "string", enum: ["new", "read", "archived"] }, ...pageProps }, ["query"]), annotations: { readOnlyHint: true, title: "Search inquiries" }, run: run(searchInquiries) },
  ];
}

export async function resolveMcpEmail(request: Request, env: McpRouteEnv, now = Date.now()): Promise<{ email: string } | { error: Response }> {
  const token = bearerToken(request);
  const secret = env.BETTER_AUTH_SECRET || env.LULOX_SSO_SECRET;
  if (token) {
    if (!secret) return { error: mcpUnauthorized() };
    const verified = await verifyMcpToken(token, secret, GARPEN_MCP_ISS, now);
    if (!verified) return { error: mcpUnauthorized() };
    return verified;
  }
  const sso = await readSso(request, env.LULOX_SSO_SECRET, now);
  if (sso) return { email: sso.email };
  return { error: mcpUnauthorized() };
}

export async function handleGarpenMcp(request: Request, env: McpRouteEnv, now = Date.now()): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  if (isMcpWellKnown(path)) {
    if (request.method === "OPTIONS") return mcpOptions();
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    return mcpProtectedResource(GARPEN_MCP_URL, "Garpen MCP", "https://garpen.lulox.com.ar/mcp");
  }
  if (path === "/api/mcp/token") {
    if (request.method === "OPTIONS") return mcpOptions();
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    return mintToken(request, env, now);
  }
  if (path !== "/mcp") return null;
  if (request.method === "OPTIONS") return mcpOptions();
  if (request.method === "GET") return null; // Next.js setup page
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const resolved = await resolveMcpEmail(request, env, now);
  if ("error" in resolved) return resolved.error;
  const gate = await resolveApprovedUser(env.DB, resolved.email);
  if (!gate.ok) {
    if (gate.status === "skipped_e2e") return mcpForbidden("encrypted account, not readable server-side");
    return mcpForbidden();
  }
  return handleMcpJsonRpc(request, { name: "garpen", version: "1.0.0", tools: toolsFor(env.DB, resolved.email) });
}

async function mintToken(request: Request, env: McpRouteEnv, now: number): Promise<Response> {
  const sso = await readSso(request, env.LULOX_SSO_SECRET, now);
  if (!sso) return mcpUnauthorized();
  const gate = await resolveApprovedUser(env.DB, sso.email);
  if (!gate.ok) return mcpForbidden();
  const secret = env.BETTER_AUTH_SECRET || env.LULOX_SSO_SECRET;
  if (!secret) return new Response(JSON.stringify({ error: "MCP signing secret is not configured" }), { status: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  const token = await mintMcpToken({ email: sso.email, secret, iss: GARPEN_MCP_ISS, now });
  return new Response(JSON.stringify({ token, email: sso.email, expiresInDays: 90 }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
