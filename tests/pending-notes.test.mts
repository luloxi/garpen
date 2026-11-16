import test from "node:test";
import assert from "node:assert/strict";
import {
  activityOccurredAt,
  appendNoteBody,
  canMergeNote,
  clearNoteDate,
  convertOpenTasksToNotes,
  convertTaskToNote,
  formatTaskSnippet,
  joinSnippets,
  normalizePendingTitle,
  noteTitleForGroup,
  pendingGroupKey,
} from "../lib/pending-notes.ts";
import { openDb } from "./db-shim.mts";
import type { DatabaseSync } from "node:sqlite";

function person(db: DatabaseSync, id: string, email = id + "@test.local") {
  db.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,role,approvalStatus) VALUES (?,?,?,?,?,?,?,?)").run(id, id, email, 1, 1, 1, "admin", "approved");
}

function contact(db: DatabaseSync, id: string, userId: string, name: string) {
  db.prepare("INSERT INTO contacts (id,user_id,kind,name,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, userId, "person", name, 1, 1);
}

function task(db: DatabaseSync, id: string, userId: string, title: string, extra: { description?: string | null; status?: string; due?: string | null; contactId?: string | null; createdAt?: number } = {}) {
  const at = extra.createdAt ?? 1;
  db.prepare("INSERT INTO tasks (id,user_id,contact_id,title,description,status,priority,due_date,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, userId, extra.contactId ?? null, title, extra.description ?? null, extra.status ?? "todo", "normal", extra.due ?? null, at, at);
}

function note(db: DatabaseSync, id: string, userId: string, title: string, extra: { body?: string | null; occurredAt?: string; contactId?: string | null; updatedAt?: number } = {}) {
  const at = extra.updatedAt ?? 1;
  db.prepare("INSERT INTO activities (id,user_id,kind,title,body,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, userId, "note", title, extra.body ?? null, extra.occurredAt ?? "", at, at);
  if (extra.contactId) db.prepare("INSERT INTO activity_contacts (activity_id,contact_id,user_id) VALUES (?,?,?)").run(id, extra.contactId, userId);
}

test("title normalization groups follow-up variants", () => {
  assert.equal(normalizePendingTitle("Coordinar visita (reprogramada)"), "coordinar visita");
  assert.equal(normalizePendingTitle("Ser Midnight Ambassador que cobra (lunes)"), "ser midnight ambassador que cobra");
  assert.equal(pendingGroupKey({ contactId: "isabel", title: "A" }), "contact:isabel");
  assert.equal(pendingGroupKey({ contactId: null, title: "Ser Midnight Ambassador que cobra (jueves)" }), "title:ser midnight ambassador que cobra");
});

test("task snippets keep title, body and original date", () => {
  const text = joinSnippets([
    formatTaskSnippet({ title: "Coordinar visita", description: "Casa 12", dueDate: "2026-11-09" }),
    formatTaskSnippet({ title: "Coordinar visita (jueves 12/11)", description: null, dueDate: "2026-11-12" }),
  ]);
  assert.match(text, /Coordinar visita\nCasa 12\nFecha original: 09\/11\/2026/);
  assert.match(text, /Coordinar visita \(jueves 12\/11\)\nFecha original: 12\/11\/2026/);
  assert.equal(noteTitleForGroup([{ id: "1", title: "X", description: null, dueDate: null, contactId: "c", contactName: "Isabel Carra", createdAt: 1 }]), "Isabel Carra");
});

test("appendNoteBody keeps existing HTML and plain text", () => {
  assert.equal(appendNoteBody(null, "Hola"), "Hola");
  assert.equal(appendNoteBody("Ya estaba", "Nuevo"), "Ya estaba\n\nNuevo");
  const html = appendNoteBody("<p>Hola</p>", "Línea 1\n\nLínea 2");
  assert.equal(html.startsWith("<p>Hola</p>"), true);
  assert.match(html, /<p>Línea 1<\/p><p>Línea 2<\/p>/);
  assert.equal(canMergeNote({ id: "n", title: "A", body: null, contactIds: ["c1"], updatedAt: 1 }, "c1"), true);
  assert.equal(canMergeNote({ id: "n", title: "A", body: null, contactIds: ["c1", "c2"], updatedAt: 1 }, "c1"), false);
  assert.equal(canMergeNote({ id: "n", title: "A", body: null, contactIds: [], updatedAt: 1 }, null), true);
});

test("notes may omit a date; events may not", () => {
  assert.deepEqual(activityOccurredAt("note", ""), { ok: true, value: "" });
  assert.deepEqual(activityOccurredAt("note", null), { ok: true, value: "" });
  assert.deepEqual(activityOccurredAt("note", " 2026-11-16T10:00 "), { ok: true, value: "2026-11-16T10:00" });
  assert.equal(activityOccurredAt("event", "").ok, false);
  assert.equal(activityOccurredAt("event", null).ok, false);
  assert.deepEqual(activityOccurredAt("event", "2026-11-16T10:00"), { ok: true, value: "2026-11-16T10:00" });
});

test("bulk convert merges by contact and unlinked title, leaves done tasks", async () => {
  const { db, d1 } = openDb();
  person(db, "owner");
  person(db, "other");
  contact(db, "isabel", "owner", "Isabel Carra");
  contact(db, "mila", "owner", "Mila Zurbriggen");
  contact(db, "other-c", "other", "Ajena");
  task(db, "i1", "owner", "Coordinar visita", { due: "2026-11-09", contactId: "isabel", description: "Primera" });
  task(db, "i2", "owner", "Coordinar visita (reprogramada)", { due: "2026-11-09", contactId: "isabel" });
  task(db, "i3", "owner", "Coordinar visita (jueves 12/11)", { due: "2026-11-12", contactId: "isabel" });
  task(db, "m1", "owner", "Hablarle por bot", { due: "2026-11-11", contactId: "mila" });
  task(db, "m2", "owner", "Hablarle por bot (lunes 16/11)", { due: "2026-11-16", contactId: "mila" });
  task(db, "mid1", "owner", "Ser Midnight Ambassador que cobra (lunes)", { due: "2026-11-09" });
  task(db, "mid2", "owner", "Ser Midnight Ambassador que cobra", { due: "2026-11-10", status: "in_progress" });
  task(db, "mid3", "owner", "Ser Midnight Ambassador que cobra (jueves)", { due: "2026-11-12" });
  task(db, "open-undated", "owner", "Pactar reunión", { contactId: null });
  task(db, "done", "owner", "Hablarle a Adri", { status: "done", contactId: null });
  task(db, "alien", "other", "Tarea ajena", { due: "2026-11-01", contactId: "other-c" });
  note(db, "keep-dated", "owner", "Isabel Carra", { occurredAt: "2026-10-01", contactId: "isabel", body: "No mezclar" });

  const result = await convertOpenTasksToNotes(d1, "owner", 1000);
  assert.equal(result.convertedTaskIds.sort().join(), ["i1", "i2", "i3", "m1", "m2", "mid1", "mid2", "mid3", "open-undated"].sort().join());
  assert.equal(result.notes.length, 4);

  const leftover = db.prepare("SELECT id, status FROM tasks WHERE user_id='owner' ORDER BY id").all() as { id: string; status: string }[];
  assert.deepEqual(leftover.map((row) => ({ id: row.id, status: row.status })), [{ id: "done", status: "done" }]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id='alien'").get() as { n: number }).n, 1);

  const notes = db.prepare("SELECT id, title, body, occurred_at AS occurredAt FROM activities WHERE user_id='owner' AND kind='note' ORDER BY title, id").all() as { id: string; title: string; body: string | null; occurredAt: string }[];
  const isabel = notes.find((row) => row.title === "Isabel Carra" && row.occurredAt === "");
  const mila = notes.find((row) => row.title === "Mila Zurbriggen");
  const midnight = notes.find((row) => row.title.toLowerCase().includes("midnight"));
  const undated = notes.find((row) => row.title === "Pactar reunión");
  const dated = notes.find((row) => row.id === "keep-dated");
  assert.ok(isabel && mila && midnight && undated && dated);
  assert.equal(isabel.occurredAt, "");
  assert.match(isabel.body || "", /Primera/);
  assert.match(isabel.body || "", /Fecha original: 09\/11\/2026/);
  assert.match(isabel.body || "", /Fecha original: 12\/11\/2026/);
  assert.match(isabel.body || "", /reprogramada/);
  assert.equal(dated.body, "No mezclar");
  assert.equal(dated.occurredAt, "2026-10-01");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM activity_contacts WHERE activity_id=? AND contact_id='isabel'").get(isabel.id) as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE user_id='owner' AND status IN ('todo','in_progress') AND due_date IS NOT NULL AND trim(due_date)!=''").get() as { n: number }).n, 0);
});

test("single convert merges into an existing undated note for that contact", async () => {
  const { db, d1 } = openDb();
  person(db, "owner");
  contact(db, "thay", "owner", "Thayliss");
  note(db, "n1", "owner", "Thayliss", { body: "Ya hablamos", occurredAt: "", contactId: "thay", updatedAt: 50 });
  task(db, "t1", "owner", "Consultar", { due: "2026-11-13", contactId: "thay", description: "Tema X" });
  const result = await convertTaskToNote(d1, "owner", "t1", 2000);
  assert.equal("error" in result, false);
  if ("error" in result) return;
  assert.equal(result.notes[0]?.merged, true);
  assert.equal(result.notes[0]?.id, "n1");
  const row = db.prepare("SELECT body, occurred_at AS occurredAt FROM activities WHERE id='n1'").get() as { body: string; occurredAt: string };
  assert.equal(row.occurredAt, "");
  assert.match(row.body, /Ya hablamos/);
  assert.match(row.body, /Consultar/);
  assert.match(row.body, /Tema X/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id='t1'").get() as { n: number }).n, 0);
});

test("clearNoteDate only touches notes of that user", async () => {
  const { db, d1 } = openDb();
  person(db, "owner");
  person(db, "other");
  note(db, "mine", "owner", "Mia", { occurredAt: "2026-11-01" });
  note(db, "evt-like", "owner", "Evt", { occurredAt: "2026-11-02" });
  db.prepare("UPDATE activities SET kind='event' WHERE id='evt-like'").run();
  note(db, "theirs", "other", "Ajena", { occurredAt: "2026-11-01" });
  assert.deepEqual(await clearNoteDate(d1, "owner", "mine", 3), { ok: true });
  assert.deepEqual(await clearNoteDate(d1, "owner", "evt-like", 3), { error: "not_found" });
  assert.deepEqual(await clearNoteDate(d1, "owner", "theirs", 3), { error: "not_found" });
  assert.equal((db.prepare("SELECT occurred_at AS o FROM activities WHERE id='mine'").get() as { o: string }).o, "");
  assert.equal((db.prepare("SELECT occurred_at AS o FROM activities WHERE id='theirs'").get() as { o: string }).o, "2026-11-01");
});

test("converting a missing or done task returns not_found", async () => {
  const { db, d1 } = openDb();
  person(db, "owner");
  task(db, "done", "owner", "Listo", { status: "done", due: "2026-11-01" });
  assert.deepEqual(await convertTaskToNote(d1, "owner", "done"), { error: "not_found" });
  assert.deepEqual(await convertTaskToNote(d1, "owner", "nope"), { error: "not_found" });
});
