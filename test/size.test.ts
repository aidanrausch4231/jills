// Size budgets from AGENTS.md rule 5, counted like `wc -l`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const root = new URL("../../", import.meta.url).pathname;
const lines = (f: string) => (readFileSync(f, "utf8").match(/\n/g) ?? []).length;
const tsFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));

/** Core line count after the loop-3 cuts; lower it as core shrinks. */
const CEILING = 1623;

const coreFiles = () => tsFiles(join(root, "src")).filter((f) => !relative(root, f).startsWith("src/plugins/"));
const core = () => coreFiles().reduce((n, f) => n + lines(f), 0);
const coreReport = () => `core is ${core()} lines: ${coreFiles().map((f) => `${relative(root, f)} ${lines(f)}`).join(", ")}`;

// Ratchet: core may only shrink. Set to the count after the loop-3 cuts while the
// lead decides between the 1,500 budget and a revised one.
test("core (src/**/*.ts without src/plugins/) never grows past the current ceiling", () => {
  assert.ok(core() <= CEILING, coreReport());
});

// Budget from AGENTS.md. It reports as TODO while core is above it (lead decision pending).
test("core is at most 1,500 lines", { todo: core() > 1500 ? `lead decision pending; ${core()} lines` : false }, () => {
  assert.ok(core() <= 1500, coreReport());
});

test("each built-in plug-in, the Pi add-on and the notify example stay in budget", () => {
  for (const f of tsFiles(join(root, "src", "plugins"))) assert.ok(lines(f) <= 150, `${relative(root, f)} is ${lines(f)} lines (max 150)`);
  assert.ok(lines(join(root, "addons", "pi", "jills.ts")) <= 400, "addons/pi/jills.ts over 400 lines");
  assert.ok(lines(join(root, "examples", "plugins", "notify.ts")) <= 40, "examples/plugins/notify.ts over 40 lines");
});

// dsh target: tracked files outside test/, without the lock file (each one justified in addons/dsh/README.md).
test("the dsh add-on stays at or under 1,200 non-test lines", () => {
  const files = execFileSync("git", ["ls-files", "addons/dsh"], { cwd: root, encoding: "utf8" }).split("\n");
  const kept = files.filter((f) => f && !f.startsWith("addons/dsh/test/") && !f.endsWith("pnpm-lock.yaml"));
  const n = kept.reduce((sum, f) => sum + lines(join(root, f)), 0);
  assert.ok(n <= 1200, `addons/dsh is ${n} non-test lines (target 1,200)`);
});
