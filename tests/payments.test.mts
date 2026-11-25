import test from "node:test";
import assert from "node:assert/strict";
import { majorToMinor, parseAmountMinor, parsePaymentCreate, parsePaymentPatch, paymentErrorEs } from "../lib/payments.ts";
import { addContactNote, createPayment, listPayments, updatePayment } from "../lib/mcp-rpc.ts";
import { resetEncryptionModeCache } from "../lib/mailtox-link.ts";
import { openDb } from "./db-shim.mts";
import type { DatabaseSync } from "node:sqlite";

const OWNER = "admin@owner.test";

function person(db: DatabaseSync, id: string, role: "admin" | "user", approval: "approved" | "pending" | "rejected", email = id + "@test.local") {
  db.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,role,approvalStatus) VALUES (?,?,?,?,?,?,?,?)").run(id, id, email, 1, 1, 1, role, approval);
}

function setup() {
  resetEncryptionModeCache();
  const opened = openDb();
  person(opened.db, "owner", "admin", "approved", OWNER);
  opened.db.prepare("INSERT INTO contacts (id,user_id,kind,name,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("c1", "owner", "person", "Ana", 1, 1);
  return opened;
}

test("majorToMinor accepts cents and rejects junk", () => {
  assert.equal(majorToMinor(15), 1500);
  assert.equal(majorToMinor(15.5), 1550);
  assert.equal(majorToMinor("15,50"), 1550);
  assert.equal(majorToMinor("1.500,50"), 150050);
  assert.equal(majorToMinor("1,500.50"), 150050);
  assert.equal(majorToMinor("1500.5"), 150050);
  assert.equal(majorToMinor(0), null);
  assert.equal(majorToMinor(-1), null);
  assert.equal(majorToMinor("abc"), null);
  assert.equal(majorToMinor(Number.POSITIVE_INFINITY), null);
  assert.equal(majorToMinor(1.234), null);
  assert.equal(majorToMinor(1e16), null);
});

test("parseAmountMinor prefers amountMinor and validates it on the server", () => {
  assert.deepEqual(parseAmountMinor({ amountMinor: 1250 }), { ok: true, amountMinor: 1250 });
  assert.deepEqual(parseAmountMinor({ amount: 12.5 }), { ok: true, amountMinor: 1250 });
  assert.equal(parseAmountMinor({ amountMinor: 0 }).ok, false);
  assert.equal(parseAmountMinor({ amountMinor: 12.5 }).ok, false);
  assert.equal(parseAmountMinor({ amount: "no" }).ok, false);
  assert.equal(parseAmountMinor({}).ok, false);
  assert.equal(paymentErrorEs("invalid amount"), "Importe inválido");
});

test("parsePaymentCreate and patch require a real amount, currency, date and concept", () => {
  const ok = parsePaymentCreate({ contactId: "c1", amount: 10, currency: "ARS", date: "2026-11-25", concept: "Anticipo" });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.amountMinor, 1000);
    assert.equal(ok.value.status, "pending");
    assert.equal(ok.value.occurredAt, "2026-11-25");
  }
  assert.equal(parsePaymentCreate({ contactId: "c1", amount: 10, currency: "EUR", date: "2026-11-25", concept: "x" }).ok, false);
  assert.equal(parsePaymentCreate({ contactId: "c1", amount: 10, currency: "ARS", date: "25/11/2026", concept: "x" }).ok, false);
  assert.equal(parsePaymentCreate({ contactId: "c1", amount: 10, currency: "ARS", date: "2026-11-25", concept: "  " }).ok, false);
  const patch = parsePaymentPatch({ status: "paid" });
  assert.equal(patch.ok, true);
  if (patch.ok) assert.equal(patch.value.status, "paid");
  assert.equal(parsePaymentPatch({}).ok, false);
});

test("create, list (by contact), update status, and add a note to an existing contact", async () => {
  const { db, d1 } = setup();
  db.prepare("INSERT INTO contacts (id,user_id,kind,name,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("c2", "owner", "person", "Bea", 1, 1);

  const created = await createPayment(d1, OWNER, { contactId: "c1", amount: 1500.5, currency: "ARS", date: "2026-11-20", concept: "Seña del sitio" });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.data.amountMinor, 150050);
  assert.equal(created.data.status, "pending");
  assert.equal(created.data.contactId, "c1");

  const other = await createPayment(d1, OWNER, { contactId: "c2", amountMinor: 2000, currency: "USD", date: "2026-11-21", concept: "Otro", status: "paid" });
  assert.equal(other.ok, true);

  const listed = await listPayments(d1, OWNER, { contactId: "c1" });
  assert.equal(listed.ok, true);
  if (listed.ok) {
    assert.equal(listed.data.items.length, 1);
    assert.equal(listed.data.items[0].concept, "Seña del sitio");
    assert.equal(listed.data.nextOffset, null);
  }

  const pending = await listPayments(d1, OWNER, { status: "pending" });
  assert.equal(pending.ok, true);
  if (pending.ok) assert.deepEqual(pending.data.items.map((item) => item.contactId), ["c1"]);

  const paid = await updatePayment(d1, OWNER, { id: created.data.id, status: "paid" });
  assert.equal(paid.ok, true);
  if (paid.ok) assert.equal(paid.data.status, "paid");

  const missingContact = await createPayment(d1, OWNER, { contactId: "nope", amount: 10, currency: "ARS", date: "2026-11-20", concept: "x" });
  assert.equal(missingContact.ok, false);
  if (!missingContact.ok) assert.equal(missingContact.error.code, "invalid");

  const note = await addContactNote(d1, OWNER, { contactId: "c1", title: "Hablamos de la seña", body: "queda pendiente el resto" });
  assert.equal(note.ok, true);
  if (note.ok) {
    assert.deepEqual(note.data.contactIds, ["c1"]);
    assert.equal(note.data.title, "Hablamos de la seña");
  }
  const badNote = await addContactNote(d1, OWNER, { contactId: "nope", title: "Nope" });
  assert.equal(badNote.ok, false);
});

test("payments and addContactNote fail closed on an encrypted account", async () => {
  const { db, d1 } = setup();
  db.prepare("UPDATE user SET encryption_mode=? WHERE id='owner'").run("e2e");
  resetEncryptionModeCache();
  const before = (db.prepare("SELECT COUNT(*) AS n FROM contact_payments").get() as { n: number }).n;
  const encrypted = { ok: false as const, error: { code: "encrypted_account" as const, message: "encrypted account, not readable server-side" } };
  assert.deepEqual(await createPayment(d1, OWNER, { contactId: "c1", amount: 10, currency: "ARS", date: "2026-11-20", concept: "x" }), encrypted);
  assert.deepEqual(await listPayments(d1, OWNER, {}), encrypted);
  assert.deepEqual(await updatePayment(d1, OWNER, { id: "x", status: "paid" }), encrypted);
  assert.deepEqual(await addContactNote(d1, OWNER, { contactId: "c1", title: "x" }), encrypted);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM contact_payments").get() as { n: number }).n, before);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM activities").get() as { n: number }).n, 0);
});
