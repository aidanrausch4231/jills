import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { dryRun, suggest } from "../src/api.js";
import { tmp, tmpHome, tmpRepo, writeJill } from "./helpers.js";

test("suggest is quiet inside a Jills run: no plug-in call, no state write", async () => {
  const marker = join(tmp(), "called");
  const plugin = join(tmp(), "loud.js");
  writeFileSync(
    plugin,
    `import { writeFileSync } from "node:fs";
    export default { slot: "suggest", apiVersion: 1, name: "loud",
      async suggest() { writeFileSync(${JSON.stringify(marker)}, "x"); return { action: "suggest", reason: "loud", jill: "hello", auto: false }; },
      chat() { writeFileSync(${JSON.stringify(marker)}, "x"); return undefined; } };\n`,
  );
  const home = tmpHome(`plugins: [${plugin}]\n`);
  writeJill(home, "hello", "keywords: [hello]\nworktree: false\nsteps:\n  a: {run: echo}");
  const before = readdirSync(home).sort();
  process.env.JILLS_RUN_ID = "r-test";
  try {
    const s = await suggest({ home, session: "s1", message: "say hello", repo: tmpRepo() });
    assert.equal(s.action, "quiet");
    assert.equal(s.jill, undefined);
  } finally {
    delete process.env.JILLS_RUN_ID;
  }
  assert.equal(existsSync(marker), false, "suggest plug-in must not run");
  assert.deepEqual(readdirSync(home).sort(), before, "no state written under JILLS_HOME");
  const loud = await suggest({ home, session: "s1", message: "say hello", repo: tmpRepo() });
  assert.equal(loud.action, "suggest", "outside a run the plug-in still answers");
});

test("dry run of a nested Jill shows the child's rendered inputs and defaults, not the parent's", async () => {
  const home = tmpHome();
  writeJill(home, "child", "inputs:\n  - name: task\n  - name: ref\n    default: HEAD\nworktree: false\nsteps:\n  show: {run: 'git show {{inputs.ref}} # {{inputs.task}}'}");
  writeJill(home, "parent", "inputs: [task]\nworktree: false\nsteps:\n  inner:\n    jill: child\n    inputs:\n      task: 'look at {{inputs.task}}'");
  const lines = await dryRun("parent", { home, inputs: { task: "x" }, cwd: tmp() });
  const show = lines.find((l) => l.startsWith("  - show:"));
  assert.ok(show, lines.join("\n"));
  assert.match(show, /JILLS_INPUT_REF="HEAD"/, lines.join("\n"));
  assert.match(show, /JILLS_INPUT_TASK="look at x"/, lines.join("\n"));
});
