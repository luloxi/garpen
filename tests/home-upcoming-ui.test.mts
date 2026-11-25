import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const workspace = readFileSync(join(root, "app/workspace.tsx"), "utf8");
const css = readFileSync(join(root, "app/globals.css"), "utf8");

test("Próximos still mixes up to 10 tasks, events and dated notes", () => {
  assert.match(workspace, /rows\.slice\(0,10\)/);
  assert.match(workspace, /<h3>Próximos<\/h3>/);
  assert.match(workspace, /className="panel home-panel home-upcoming"/);
  assert.match(workspace, /className="home-upcoming-list"/);
  assert.doesNotMatch(workspace, /Serpix/);
});

test("on a phone the Próximos list fills leftover height and scrolls inside", () => {
  assert.match(css, /\.home-upcoming\{[^}]*min-height:min\(420px,calc\(100svh - 320px\)\)/);
  assert.match(css, /\.home-upcoming-list\{[^}]*overflow-y:auto/);
  assert.match(css, /@media \(max-width:700px\)[\s\S]*\.main-area:has\(\.home-head\)\{[^}]*min-height:calc\(100svh - 76px/);
});
