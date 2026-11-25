import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db-shim.mts";
import { createContact, createEvent, createNote, createTask, listUpcoming } from "../lib/mcp-rpc.ts";

const OWNER = "admin@owner.test";

function person(db: import("node:sqlite").DatabaseSync, id: string, email: string) {
  db.prepare(
    "INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,role,approvalStatus) VALUES (?,?,?,?,?,?,?,?)",
  ).run(id, id, email, 1, 1, 1, "admin", "approved");
}

test("listUpcoming mixes open tasks, events and dated notes, and skips undated notes", async () => {
  const { db, d1 } = openDb();
  person(db, "owner", OWNER);

  const contact = await createContact(d1, OWNER, { name: "Camila Soria" });
  assert.equal(contact.ok, true);
  const contactId = contact.ok ? contact.data.id : "";

  // Una tarea con fecha, una sin fecha, un evento, una nota con fecha y una nota sin fecha.
  await createTask(d1, OWNER, { title: "Llamar a Camila", dueDate: "2026-11-28", contactId });
  await createTask(d1, OWNER, { title: "Tarea sin fecha" });
  await createEvent(d1, OWNER, { title: "Meet con Marco", occurredAt: "2026-12-03T11:00", contactIds: [contactId] });
  await createNote(d1, OWNER, { title: "Nota con Thayliss", occurredAt: "2026-12-02" });
  await createNote(d1, OWNER, { title: "Nota sin fecha" });

  const res = await listUpcoming(d1, OWNER, { from: "2026-11-24", limit: 10 });
  assert.equal(res.ok, true);
  if (!res.ok) return;

  const titles = res.data.items.map((i) => i.title);
  assert.deepEqual(titles, ["Llamar a Camila", "Nota con Thayliss", "Meet con Marco", "Tarea sin fecha"]);
  assert.deepEqual(
    res.data.items.map((i) => i.kind),
    ["task", "note", "event", "task"],
  );
  assert.deepEqual(res.data.items[0].contactIds, [contactId], "the task keeps its contact");
  assert.deepEqual(res.data.items[2].contactIds, [contactId], "the event keeps its contacts");
  assert.equal(res.data.items[3].when, "", "an undated task sorts last with an empty date");
});

test("listUpcoming only looks forward from the given day", async () => {
  const { db, d1 } = openDb();
  person(db, "owner", OWNER);
  await createEvent(d1, OWNER, { title: "Viejo", occurredAt: "2026-11-01T10:00" });
  await createEvent(d1, OWNER, { title: "Nuevo", occurredAt: "2026-12-01T10:00" });

  const res = await listUpcoming(d1, OWNER, { from: "2026-11-24", limit: 10 });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.data.items.map((i) => i.title), ["Nuevo"]);
});
