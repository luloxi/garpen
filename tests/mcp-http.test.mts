import test from "node:test";
import assert from "node:assert/strict";
import { signSso } from "../lib/lulox-sso.ts";
import { handleGarpenMcp, GARPEN_MCP_ISS } from "../lib/mcp-route.ts";
import { mintMcpToken, verifyMcpToken } from "../lib/mcp-http.ts";
import { openDb } from "./db-shim.mts";
import { resetEncryptionModeCache } from "../lib/mailtox-link.ts";

const SECRET = "a".repeat(32);
const SSO_SECRET = "b".repeat(32);
const OWNER = "admin@owner.test";
const MEMBER = "member@test.local";

function person(db: import("node:sqlite").DatabaseSync, id: string, role: "admin" | "user", approval: "approved" | "pending", email: string) {
  db.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,role,approvalStatus) VALUES (?,?,?,?,?,?,?,?)").run(id, id, email, 1, 1, 1, role, approval);
}

function setup() {
  resetEncryptionModeCache();
  const opened = openDb();
  person(opened.db, "owner", "admin", "approved", OWNER);
  person(opened.db, "member", "user", "approved", MEMBER);
  opened.db.prepare(
    "INSERT INTO contacts (id,user_id,kind,name,company_name,email,phone,notes,is_potential,role,relations,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run("c-member", "member", "person", "Lila", null, null, null, null, 0, "other", "[]", 1, 1);
  return opened;
}

async function mcpPost(env: { DB: unknown; BETTER_AUTH_SECRET: string; LULOX_SSO_SECRET: string }, path: string, body: unknown, headers: Record<string, string> = {}) {
  return handleGarpenMcp(
    new Request("https://garpen.lulox.com.ar" + path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env as never,
  );
}

async function rpc(env: Parameters<typeof mcpPost>[0], method: string, params: unknown, headers: Record<string, string>) {
  const res = await mcpPost(env, "/mcp", { jsonrpc: "2.0", id: 1, method, params }, headers);
  assert.ok(res);
  const json = await res!.json() as { result?: { tools?: { name: string }[]; content?: { text: string }[] }; error?: unknown };
  return { status: res!.status, json };
}

test("POST /mcp without auth is 401; well-known is public", async () => {
  const { d1 } = setup();
  const env = { DB: d1, BETTER_AUTH_SECRET: SECRET, LULOX_SSO_SECRET: SSO_SECRET };
  const unauthorized = await mcpPost(env, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(unauthorized?.status, 401);
  const well = await handleGarpenMcp(new Request("https://garpen.lulox.com.ar/.well-known/oauth-protected-resource"), env as never);
  assert.equal(well?.status, 200);
  const body = await well!.json() as { resource: string };
  assert.equal(body.resource, "https://garpen.lulox.com.ar/mcp");
});

test("tools/list and a read tool work with a bearer minted for that user", async () => {
  const { d1 } = setup();
  const env = { DB: d1, BETTER_AUTH_SECRET: SECRET, LULOX_SSO_SECRET: SSO_SECRET };
  const token = await mintMcpToken({ email: MEMBER, secret: SECRET, iss: GARPEN_MCP_ISS });
  const listed = await rpc(env, "tools/list", {}, { authorization: `Bearer ${token}` });
  assert.equal(listed.status, 200);
  const names = listed.json.result?.tools?.map((t) => t.name) ?? [];
  assert.ok(names.includes("garpen_list_contacts"));
  assert.equal(names.includes("garpen_delete_contact"), false);
  const call = await rpc(env, "tools/call", { name: "garpen_list_contacts", arguments: {} }, { authorization: `Bearer ${token}` });
  const payload = JSON.parse(call.json.result?.content?.[0]?.text ?? "{}") as { ok: boolean; data: { items: { id: string }[] } };
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.data.items.map((item) => item.id), ["c-member"]);
});

test("a token for one user cannot list another user's contacts", async () => {
  const { d1 } = setup();
  const env = { DB: d1, BETTER_AUTH_SECRET: SECRET, LULOX_SSO_SECRET: SSO_SECRET };
  const token = await mintMcpToken({ email: OWNER, secret: SECRET, iss: GARPEN_MCP_ISS });
  const call = await rpc(env, "tools/call", { name: "garpen_list_contacts", arguments: {} }, { authorization: `Bearer ${token}` });
  const payload = JSON.parse(call.json.result?.content?.[0]?.text ?? "{}") as { ok: boolean; data: { items: { id: string }[] } };
  assert.equal(payload.ok, true);
  assert.equal(payload.data.items.some((item) => item.id === "c-member"), false);
});

test("lulox_sso cookie authenticates /mcp for an approved user", async () => {
  const { d1 } = setup();
  const env = { DB: d1, BETTER_AUTH_SECRET: SECRET, LULOX_SSO_SECRET: SSO_SECRET };
  const cookie = await signSso({ email: MEMBER, name: "Member", picture: "" }, SSO_SECRET, 60_000);
  const listed = await rpc(env, "tools/list", {}, { cookie: `lulox_sso=${cookie}` });
  assert.equal(listed.status, 200);
  assert.ok((listed.json.result?.tools?.length ?? 0) > 0);
});

test("verifyMcpToken rejects a token for the wrong issuer or a short secret mismatch", async () => {
  const token = await mintMcpToken({ email: MEMBER, secret: SECRET, iss: GARPEN_MCP_ISS });
  assert.equal((await verifyMcpToken(token, SECRET, GARPEN_MCP_ISS))?.email, MEMBER);
  assert.equal(await verifyMcpToken(token, SECRET, "other"), null);
  assert.equal(await verifyMcpToken(token, "c".repeat(32), GARPEN_MCP_ISS), null);
});
