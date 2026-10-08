import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJill, v1Refusal } from "../src/jillfile.js";
import { start, dryRun, check } from "../src/api.js";
import { tmpHome, tmpRepo, writeJill } from "./helpers.js";

const ok = `---
name: demo
description: Demo jill
when: When testing
keywords: [demo, try]
inputs:
  - who
  - name: task
    required: true
    default: x
goal: later-mode
steps:
  a:
    run: echo {{inputs.who}}
  b:
    agent: some-agent
    needs: a
    copies: 2
    writes: true
    model: m1
    timeout: 5m
    custom: 7
---
Body text.
`;

test("JILL.md parses fields, defaults and pass-through extras", () => {
  const j = parseJill(ok, "/x/demo/JILL.md");
  assert.equal(j.name, "demo");
  assert.equal(j.when, "When testing");
  assert.deepEqual(j.keywords, ["demo", "try"]);
  assert.deepEqual(j.inputs.map((i) => i.name), ["who", "task"]);
  assert.equal(j.inputs[1]!.required, true);
  assert.equal(j.worktree, true);
  assert.equal(j.docker, false);
  assert.equal(j.machine, "local");
  assert.equal(j.extra.goal, "later-mode");
  const b = j.steps.find((s) => s.name === "b")!;
  assert.deepEqual(b.needs, ["a"]);
  assert.equal(b.copies, 2);
  assert.equal(b.writes, true);
  assert.equal(b.model, "m1");
  assert.equal(b.extra.custom, 7);
  assert.equal(j.body, "Body text.");
});

test("JILL.md validation errors are clear", () => {
  const bad = (fm: string) => () => parseJill(`---\nname: bad\n${fm}\n---\n`, "bad/JILL.md");
  assert.throws(() => parseJill("no front matter"), /missing YAML front matter/);
  assert.throws(bad("steps: {}"), /steps is empty/);
  assert.throws(bad("steps:\n  a: {run: x, agent: y}"), /exactly one of agent, run, jill/);
  assert.throws(bad("steps:\n  a: {task: hi}"), /exactly one of agent, run, jill/);
  assert.throws(bad("steps:\n  a: {run: x, needs: [zz]}"), /needs unknown step "zz"/);
  assert.throws(bad("steps:\n  a: {run: x, needs: [b]}\n  b: {run: y, needs: [a]}"), /cycle/);
  assert.throws(bad("steps:\n  a: {run: x, copies: 0}"), /copies must be/);
  assert.throws(bad("steps:\n  a: {run: x, timeout: soon}"), /bad duration/);
  assert.throws(bad("timeout: forever\nsteps:\n  a: {run: x}"), /bad duration/);
});

test("docker: true and machine != local are refused clearly", async () => {
  const d = parseJill("---\nname: d\ndocker: true\nsteps:\n  a: {run: x}\n---\n");
  assert.match(v1Refusal(d)!, /docker isolation is not supported in v1/);
  const m = parseJill("---\nname: m\nmachine: gpu-box\nsteps:\n  a: {run: x}\n---\n");
  assert.match(v1Refusal(m)!, /only machine: local is supported in v1/);
  assert.equal(v1Refusal(parseJill("---\nname: l\nsteps:\n  a: {run: x}\n---\n")), undefined);

  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "boxed", "docker: true\nsteps:\n  a: {run: echo hi}");
  writeJill(home, "remote", "machine: build-01\nsteps:\n  a: {run: echo hi}");
  await assert.rejects(start("boxed", { home, cwd: repo }), /docker isolation is not supported in v1/);
  await assert.rejects(start("remote", { home, cwd: repo }), /only machine: local/);
  await assert.rejects(dryRun("boxed", { home, cwd: repo }), /not supported in v1/);
  const rep = await check({ home });
  assert.ok(rep.warnings.some((w) => /docker/.test(w)));
});

test("required inputs are enforced", async () => {
  const home = tmpHome();
  writeJill(home, "needy", "inputs:\n  - {name: task, required: true}\nsteps:\n  a: {run: 'echo {{inputs.task}}'}");
  await assert.rejects(start("needy", { home, cwd: tmpRepo() }), /needs input\(s\): task/);
});
