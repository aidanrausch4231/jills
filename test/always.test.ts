import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runNow } from "../src/api.js";
import { parseJill } from "../src/jillfile.js";
import { tmp, tmpHome, writeJill } from "./helpers.js";

// Each always step appends "<name>:<JILLS_RUN_STATUS>" to log.txt.
const log = (name: string) => `{run: 'echo ${name}:$JILLS_RUN_STATUS >> log.txt', always: true`;
const lines = (ws: string) => readFileSync(join(ws, "log.txt"), "utf8").trim().split("\n");

test("always steps run in file order after a failing step; the run stays failed", async () => {
  const home = tmpHome();
  const ws = tmp();
  writeJill(home, "fails", `worktree: false
steps:
  a: {run: 'exit 2'}
  b: {run: 'echo no', needs: [a]}
  restore: ${log("restore")}, needs: [a]}
  summary: ${log("summary")}, needs: [restore]}`);
  const r = await runNow("fails", { home, cwd: ws });
  assert.equal(r.state, "failed");
  assert.match(r.error!, /step a: exit code 2/);
  assert.equal(r.steps.b, undefined);
  assert.deepEqual(lines(ws), ["restore:fail", "summary:fail"]);
  assert.equal(r.steps.restore!.state, "done");
  assert.equal(r.steps.summary!.state, "done");
});

test("always steps run after a passing run, and an always failure fails it", async () => {
  const home = tmpHome();
  const ws = tmp();
  writeJill(home, "ok", `worktree: false\nsteps:\n  a: {run: 'echo a'}\n  restore: ${log("restore")}, needs: [a]}`);
  const r = await runNow("ok", { home, cwd: ws });
  assert.equal(r.state, "done", r.error);
  assert.deepEqual(lines(ws), ["restore:pass"]);

  const ws2 = tmp();
  writeJill(home, "leak", `worktree: false
steps:
  a: {run: 'echo a'}
  leak: {run: 'exit 3', always: true}
  summary: ${log("summary")}, needs: [leak]}`);
  const l = await runNow("leak", { home, cwd: ws2 });
  assert.equal(l.state, "failed");
  assert.match(l.error!, /step leak: exit code 3/);
  assert.deepEqual(lines(ws2), ["summary:fail"]); // a failed always step does not stop the next one
});

test("a passing always step never clears an earlier failure", async () => {
  const home = tmpHome();
  writeJill(home, "f", `worktree: false\nsteps:\n  a: {run: 'exit 1'}\n  ok: {run: 'echo fine', always: true}`);
  const r = await runNow("f", { home, cwd: tmp() });
  assert.equal(r.state, "failed");
  assert.equal(r.steps.ok!.state, "done");
  assert.match(r.error!, /step a: exit code 1/);
});

test("always steps run after on_fail rounds are exhausted (needs-you kept)", async () => {
  const home = tmpHome();
  const ws = tmp();
  writeJill(home, "loop", `worktree: false
steps:
  build: {run: 'echo b'}
  review: {run: 'exit 1', needs: [build], on_fail: {back_to: build, max_rounds: 2}}
  restore: ${log("restore")}, needs: [review]}`);
  const r = await runNow("loop", { home, cwd: ws });
  assert.equal(r.state, "needs-you");
  assert.match(r.error!, /review failed 2 rounds/);
  assert.deepEqual(lines(ws), ["restore:fail"]);
});

test("always steps inside a nested Jill run when it fails", async () => {
  const home = tmpHome();
  const ws = tmp();
  writeJill(home, "inner", `worktree: false\nsteps:\n  a: {run: 'exit 1'}\n  clean: ${log("inner")}}`);
  writeJill(home, "outer", `worktree: false\nsteps:\n  sub: {jill: inner}\n  clean: ${log("outer")}}`);
  const r = await runNow("outer", { home, cwd: ws });
  assert.equal(r.state, "failed");
  assert.deepEqual(lines(ws), ["inner:fail", "outer:fail"]);
});

test("always validation: boolean only, agent:/run: without on_fail or merges, normal steps never need one", () => {
  const bad = (steps: string) => () => parseJill(`---\nname: b\nworktree: false\nsteps:\n${steps}\n---\n`, "b/JILL.md");
  assert.throws(bad("  a: {run: x, always: yes}"), /step a: always must be true or false/);
  assert.throws(bad("  a: {run: x, always: 1}"), /step a: always must be true or false/);
  assert.throws(bad("  a: {run: x, always: true}\n  b: {run: y, needs: [a]}"), /step b: needs always step "a"/);
  assert.throws(bad("  a: {jill: other, always: true}"), /step a: always must be .* on an agent: or run: step/);
  assert.throws(bad("  a: {run: x}\n  b: {run: y, needs: [a], always: true, on_fail: {back_to: a}}"), /step b: always must/);
  const ok = parseJill("---\nname: t\nsteps:\n  a: {run: x}\n  m: {run: y, needs: [a], merges: true}\n  c: {run: z, always: true, needs: [m]}\n  d: {run: z, always: true, needs: [c]}\n---\n");
  assert.deepEqual(ok.steps.map((s) => s.always), [false, false, true, true]);
});
