import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(new URL("../" + path, import.meta.url), "utf8");
}

test("agenda and home expose a trash icon, convert action, undo, and a pointer cursor", () => {
  const agenda = read("app/agenda.tsx");
  assert.match(agenda, /Pasar todos los pendientes a notas sin fecha/);
  assert.match(agenda, /Quitar fecha \/ pasar a nota/);
  assert.match(agenda, /<Trash2 /);
  assert.match(agenda, /<CalendarOff /);
  assert.match(agenda, /Sin fecha/);
  assert.equal(agenda.includes("window.confirm"), false);

  const workspace = read("app/workspace.tsx");
  assert.match(workspace, /Pasar todos los pendientes a notas sin fecha/);
  assert.match(workspace, /Pasar a nota sin fecha/);
  assert.match(workspace, /toast-undo/);
  assert.match(workspace, />Deshacer</);
  assert.match(workspace, /\/api\/notes\/from-pending/);
  assert.match(workspace, /<Trash2 /);
  // Confirm stays for the bulk action and for contacts/finance, not for deleting a task or note.
  assert.match(workspace, /resource!=="tasks"&&resource!=="activities"/);

  const css = read("app/globals.css");
  assert.match(css, /\.agenda-item-btn\{[^}]*cursor:\s*pointer/);
  assert.match(css, /\.toast-undo\{[^}]*cursor:\s*pointer/);
  assert.match(css, /\.pending-to-notes\{[^}]*cursor:\s*pointer/);
  assert.match(css, /\.row-actions button\{[^}]*cursor:\s*pointer/);
});
