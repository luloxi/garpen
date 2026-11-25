import test from "node:test";
import assert from "node:assert/strict";
import { asUser, call, locked, setEnv } from "./route-harness.mts";
import { A, B, assertNoA, seedWorld } from "./isolation-shared.mts";
import { matchLocalPath } from "../lib/e2e/local-api.ts";
import { plainText } from "../lib/sheets-export.ts";

const base = "http://t.local";
const CLIENT = "106402432160-test.apps.googleusercontent.com";

async function routes() {
  return {
    data: await import("../app/api/export/sheets/route.ts"),
    config: await import("../app/api/export/sheets-config/route.ts"),
  };
}

test("an export carries only the signed-in user's rows", async () => {
  await locked(async () => {
    const { d1 } = seedWorld();
    setEnv(d1, { GOOGLE_CLIENT_ID: CLIENT });
    asUser(B);
    const r = await routes();
    const res = await call(r.data, "GET", base + "/api/export/sheets");
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assertNoA(res.body);
    const body = res.body as { fileTitle: string; exportKey: string; tabs: { title: string; rows: unknown[][] }[] };
    assert.deepEqual(body.tabs.map((t) => t.title), ["Contactos", "Tareas", "Proyectos", "Movimientos", "Cuentas", "Documentos", "Horas", "Pagos", "Notas y eventos"]);
    const flat = JSON.stringify(body.tabs);
    assert.match(flat, /B-CONTACT/);
    assert.match(flat, /B-TASK/);
    assert.match(body.exportKey, /^[0-9a-f]{40}$/);
    assert.doesNotMatch(body.exportKey, /user-b/);
  });
});

test("A and B get different keys, so one never finds the other's Sheet", async () => {
  await locked(async () => {
    const { d1 } = seedWorld();
    setEnv(d1);
    const r = await routes();
    asUser(A);
    const a = (await call(r.data, "GET", base + "/api/export/sheets")).body as { exportKey: string };
    asUser(B);
    const b = (await call(r.data, "GET", base + "/api/export/sheets")).body as { exportKey: string };
    assert.notEqual(a.exportKey, b.exportKey);
  });
});

test("the server refuses plaintext data for an encrypted account and the config says so", async () => {
  await locked(async () => {
    const { db, d1 } = seedWorld();
    db.prepare("UPDATE user SET encryption_mode = 'e2e' WHERE id = ?").run(B);
    setEnv(d1, { GOOGLE_CLIENT_ID: CLIENT });
    asUser(B);
    const r = await routes();
    const res = await call(r.data, "GET", base + "/api/export/sheets");
    assert.equal(res.status, 403);
    assertNoA(res.body);
    const config = await call(r.config, "GET", base + "/api/export/sheets-config");
    assert.deepEqual(config.body, { clientId: CLIENT, encrypted: true });
  });
});

test("config gives the public client id, or null when it is missing; both routes need a session", async () => {
  await locked(async () => {
    const { d1 } = seedWorld();
    setEnv(d1);
    const r = await routes();
    asUser(B);
    const config = await call(r.config, "GET", base + "/api/export/sheets-config");
    assert.deepEqual(config.body, { clientId: null, encrypted: false });
    asUser(null);
    assert.equal((await call(r.data, "GET", base + "/api/export/sheets")).status, 401);
    assert.equal((await call(r.config, "GET", base + "/api/export/sheets-config")).status, 401);
  });
});

test("an encrypted account's browser answers the data URL locally, never the config", () => {
  assert.deepEqual(matchLocalPath("/api/export/sheets"), { name: "sheetsExport", params: {} });
  assert.equal(matchLocalPath("/api/export/sheets-config"), null);
});

test("notes go to the Sheet as plain text", () => {
  assert.equal(plainText("<p>Hola <b>Ana</b></p><p>chau &amp; gracias</p>"), "Hola Ana\nchau & gracias");
  assert.equal(plainText("x".repeat(6000)).length, 5000);
});
