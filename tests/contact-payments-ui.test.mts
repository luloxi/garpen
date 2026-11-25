import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const workspace = readFileSync(join(root, "app/workspace.tsx"), "utf8");
const css = readFileSync(join(root, "app/contacts.css"), "utf8");

test("the contact card can add a note and a payment after the contact exists", () => {
  assert.match(workspace, /createNoteForContact/);
  assert.match(workspace, /\+\s*Agregar nota/);
  assert.match(workspace, /createPaymentForContact/);
  assert.match(workspace, /\+\s*Agregar pago/);
  assert.match(workspace, /markPaymentPaid/);
  assert.match(workspace, /Marcar pagado/);
  assert.match(workspace, /<strong>Pagos<\/strong>/);
  assert.match(workspace, /paymentFields/);
  assert.doesNotMatch(workspace, /Serpix/);
});

test("history rows and payment actions are clickable", () => {
  assert.match(workspace, /className="contact-history-item"/);
  assert.match(css, /contact-history-item[\s\S]*cursor:\s*pointer/);
  assert.match(css, /contact-related \.text-button[\s\S]*cursor:\s*pointer/);
});
