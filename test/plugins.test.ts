import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runNow } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import { loadPlugins, validatePlugin } from "../src/plugins/index.js";
import { tmp, tmpHome, writeJill } from "./helpers.js";

test("old-style one-argument runner plug-ins load and run unchanged; bad versions are refused", async () => {
  const dir = tmp();
  const file = join(dir, "echo-runner.js");
  writeFileSync(
    file,
    `export default { slot: "runner", apiVersion: 1, name: "upper", canRun: (s) => s.extra.upper !== undefined,
      describe: () => "upper", run: async (ctx) => { (await import("node:fs")).writeFileSync(ctx.cwd + "/up.txt", String(ctx.step.extra.upper).toUpperCase()); return { exitCode: 0, timedOut: false, aborted: false }; } };`,
  );
  const home = tmpHome(`plugins: [${file}]\n`);
  const set = await loadPlugins(loadConfig(home));
  assert.equal(set.runners[0]!.name, "upper");
  assert.equal(set.runners[0]!.canRun.length, 1);
  assert.deepEqual(set.matchers.map((m) => m.name), ["jev"]);
  // a step with an unknown field + run: is picked up by the plug-in that claims it
  writeJill(home, "plug", "worktree: false\nsteps:\n  a: {run: 'exit 1', upper: shout}");
  const ws = tmp();
  const r = await runNow("plug", { home, cwd: ws });
  assert.equal(r.state, "done", r.error);
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(join(ws, "up.txt"), "utf8"), "SHOUT");

  assert.throws(() => validatePlugin({ slot: "runner", apiVersion: 2, name: "x" }, "f.js"), /apiVersion 2 is not supported/);
  assert.throws(() => validatePlugin({ slot: "place", apiVersion: 1, name: "x" }, "f.js"), /unknown plug-in slot "place"/);
  assert.throws(() => validatePlugin({ slot: "check", apiVersion: 1, name: "x" }, "f.js"), /missing check\(\)/);
});
