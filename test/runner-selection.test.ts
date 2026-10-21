import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { check, dryRun, runNow } from "../src/api.js";
import { parseJill } from "../src/jillfile.js";
import type { RunnerSelectContext } from "../src/plugins/types.js";
import { tmp, tmpHome, tmpRepo, writeJill } from "./helpers.js";

function fixture() {
  const dir = tmp();
  const selections = join(dir, "selections.jsonl");
  const isolation = join(dir, "openshell.js");
  const runner = join(dir, "runner.js");
  writeFileSync(selections, "");
  writeFileSync(isolation, `export default {
    slot: "isolation", apiVersion: 1, name: "openshell",
    async prepare({ repo }) { return { dir: repo, isolated: false }; },
    async child(parent) { return parent; },
    async mergeBack() { return { ok: true, commit: "unused" }; },
    async commit() {}
  };`);
  writeFileSync(runner, `import { appendFileSync, writeFileSync } from "node:fs";
    export default {
      slot: "runner", apiVersion: 1, name: "box-runner",
      canRun(step, config, ctx) {
        appendFileSync(${JSON.stringify(selections)}, JSON.stringify({ ctx, home: config.home }) + "\\n");
        return ctx?.box === "openshell";
      },
      describe() { return "box-runner"; },
      async run(ctx) {
        writeFileSync(ctx.logPath, "box-runner");
        return { exitCode: 0, timedOut: false, aborted: false };
      }
    };`);
  const home = tmpHome(`plugins: [${isolation}, ${runner}]\n`);
  const seen = (): { ctx: RunnerSelectContext; home: string }[] =>
    readFileSync(selections, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { home, seen };
}

const command = "steps:\n  a: {run: 'printf command-runner'}";

test("runner selection receives the owning Jill and actual box; only boxed commands are claimed", async () => {
  const { home, seen } = fixture();
  const repo = tmpRepo();
  for (const [name, settings, box] of [
    ["boxed", "box: openshell\nworktree: false", "openshell"],
    ["plain", "worktree: false", undefined],
    ["worktree", "worktree: true", undefined],
  ] as const) {
    const path = writeJill(home, name, `${settings}\n${command}`);
    const r = await runNow(name, { home, cwd: repo });
    assert.equal(r.state, "done", r.error);
    const selection = seen().at(-1)!;
    assert.equal(selection.home, home, "the existing config argument is preserved");
    assert.deepEqual(selection.ctx.jill, JSON.parse(JSON.stringify(parseJill(readFileSync(path, "utf8"), path))));
    assert.equal(selection.ctx.box, box);
    assert.equal(readFileSync(r.steps.a!.log!, "utf8"), box ? "box-runner" : "command-runner");
  }
  assert.equal(seen().length, 3);
});

test("nested steps receive the child Jill but share the outermost isolation box", async () => {
  const { home, seen } = fixture();
  writeJill(home, "child", `worktree: false\n${command}`);
  writeJill(home, "same-box", `box: openshell\n${command}`);
  writeJill(home, "outer", "box: openshell\nsteps:\n  nest: {jill: child}\n  explicit: {jill: same-box, needs: [nest]}");
  const r = await runNow("outer", { home, cwd: tmp() });
  assert.equal(r.state, "done", r.error);
  assert.deepEqual(seen().map(({ ctx }) => [ctx.jill.name, ctx.jill.box, ctx.box]), [
    ["child", undefined, "openshell"], ["same-box", "openshell", "openshell"],
  ]);
  for (const key of ["nest/a", "explicit/a"]) {
    assert.equal(r.steps[key]!.workspace, r.workspace);
    assert.equal(readFileSync(r.steps[key]!.log!, "utf8"), "box-runner");
  }
});

test("dry runs and checks use the same nested runner selection context", async () => {
  const { home, seen } = fixture();
  writeJill(home, "child", `worktree: false\n${command}`);
  writeJill(home, "outer", "box: openshell\nsteps:\n  nest: {jill: child}");
  const lines = await dryRun("outer", { home, cwd: tmp() });
  assert.ok(lines.some((line) => line.includes("box-runner")));
  assert.deepEqual(seen().map(({ ctx }) => [ctx.jill.name, ctx.box]), [["child", "openshell"]]);
  const report = await check({ home });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(seen().slice(1).map(({ ctx }) => [ctx.jill.name, ctx.box]), [
    ["child", undefined], ["child", "openshell"],
  ]);
});
