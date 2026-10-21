import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runNow } from "../src/api.js";
import { parseJill } from "../src/jillfile.js";
import { tmp, tmpHome, writeJill } from "./helpers.js";

const span = (r: { steps: Record<string, { started?: string; finished?: string }> }, k: string) =>
  ({ start: Date.parse(r.steps[k]!.started!), end: Date.parse(r.steps[k]!.finished!) });

test("foreach: 3 items run 3 times, max_parallel respected, outputs in order", async () => {
  const home = tmpHome();
  writeJill(home, "fan", `worktree: false
steps:
  plan: {run: "echo 'planning'; echo '{\\"qs\\": [\\"alpha\\", \\"beta\\", {\\"n\\": 3}]}'"}
  ask: {run: 'sleep 0.4; echo "got {{q}} as #{{copy}}"', needs: [plan], foreach: steps.plan.qs, as: q, max_parallel: 2}
  after: {run: 'printf "%s" "{{steps.ask.output}}"', needs: [ask]}`);
  const r = await runNow("fan", { home, cwd: tmp() });
  assert.equal(r.state, "done", r.error);
  assert.deepEqual(Object.keys(r.steps).sort(), ["after", "ask#1", "ask#2", "ask#3", "plan"]);
  const s = ["ask#1", "ask#2", "ask#3"].map((k) => span(r, k));
  assert.ok(s[2]!.start >= Math.min(s[0]!.end, s[1]!.end) - 5, "item 3 waits for a free slot");
  assert.ok(Math.abs(s[0]!.start - s[1]!.start) < 300, "items 1 and 2 run together");
  const out = readFileSync(r.steps.after!.log!, "utf8");
  assert.match(out, /item 1\/3: alpha\ngot alpha as #1[\s\S]*item 2\/3: beta\ngot beta as #2[\s\S]*item 3\/3: \{"n":3\}\ngot \{"n":3\} as #3/);
});

test("foreach: an empty list skips the step and dependents still run", async () => {
  const home = tmpHome();
  writeJill(home, "none", `worktree: false
steps:
  plan: {run: "echo '[]'"}
  ask: {run: echo never, needs: [plan], foreach: steps.plan}
  after: {run: echo after, needs: [ask]}`);
  const r = await runNow("none", { home, cwd: tmp() });
  assert.equal(r.state, "done", r.error);
  assert.deepEqual(Object.keys(r.steps).sort(), ["after", "plan"]);
  assert.ok(r.events.some((e) => e.type === "step-done" && /foreach list is empty/.test(String((e as { text?: string }).text ?? JSON.stringify(e)))));
});

test("foreach: one failed item never cancels the others; the step names it", async () => {
  const home = tmpHome();
  writeJill(home, "onebad", `worktree: false
steps:
  plan: {run: 'echo ''["a", "b", "c"]'''}
  ask: {run: 'sleep 0.3; [ "{{item}}" != b ] && echo "ok {{item}}"', needs: [plan], foreach: steps.plan}
  after: {run: echo never, needs: [ask]}`);
  const r = await runNow("onebad", { home, cwd: tmp() });
  assert.equal(r.state, "failed");
  assert.deepEqual(["ask#1", "ask#2", "ask#3"].map((k) => r.steps[k]!.state), ["done", "failed", "done"]);
  assert.match(r.error!, /step ask: foreach: 1 of 3 items failed \(item 2\)/);
  assert.equal(r.steps.after, undefined);
});

test("foreach: a failed item takes the step's back-arrow with every item's output as feedback", async () => {
  const home = tmpHome();
  writeJill(home, "loop", `worktree: false
steps:
  plan: {run: 'echo "round {{round}}: {{feedback}}" | head -c 300; echo; echo "[\\"x{{round}}\\", \\"y\\"]"'}
  ask: {run: '[ "{{item}}" != x1 ] && echo "ok {{item}}"', needs: [plan], foreach: steps.plan, on_fail: {back_to: plan, max_rounds: 2}}`);
  const r = await runNow("loop", { home, cwd: tmp() });
  assert.equal(r.state, "done", r.error);
  assert.match(readFileSync(r.steps["plan@2"]!.log!, "utf8"), /round 2: .*item 1\/2 \(failed\): x1/s);
  assert.equal(r.steps["ask#1@2"]!.state, "done");
});

test("foreach: a list over max_items fails the step clearly and runs nothing", async () => {
  const home = tmpHome();
  writeJill(home, "big", `worktree: false
steps:
  plan: {run: 'echo ''{"qs": [1, 2, 3]}'''}
  ask: {run: 'echo "{{item}}"', needs: [plan], foreach: steps.plan.qs, max_items: 2}`);
  const r = await runNow("big", { home, cwd: tmp() });
  assert.equal(r.state, "failed");
  assert.match(r.error!, /foreach steps\.plan\.qs has 3 items, over max_items 2; nothing ran/);
  assert.deepEqual(Object.keys(r.steps).sort(), ["ask#1", "plan"]);
  assert.equal(r.steps["ask#1"]!.exitCode, undefined, "no item command ran");
});

test("foreach: runtime list errors (no JSON, missing field, not a list) fail the step clearly", async () => {
  for (const [print, ref, why] of [
    ["echo plain text", "steps.plan", /printed no JSON line/],
    ["echo '{\"a\": 1}'", "steps.plan.qs", /has no field "qs"/],
    ["echo '{\"qs\": \"x\"}'", "steps.plan.qs", /steps\.plan\.qs is not a list \(got string\)/],
  ] as const) {
    const home = tmpHome();
    writeJill(home, "oops", `worktree: false\nsteps:\n  plan: {run: ${JSON.stringify(print)}}\n  ask: {run: echo hi, needs: [plan], foreach: ${ref}}`);
    const r = await runNow("oops", { home, cwd: tmp() });
    assert.equal(r.state, "failed");
    assert.match(r.error!, why);
  }
});

test("foreach: bad refs and settings are validation errors", () => {
  const bad = (step: string) => () => parseJill(`---\nname: bad\nsteps:\n  plan: {run: echo}\n  other: {run: echo}\n  ask: ${step}\n---\n`, "bad/JILL.md");
  assert.throws(bad("{run: echo, needs: [plan], foreach: steps.nope}"), /foreach refers to steps\.nope, which is not an earlier step it needs/);
  assert.throws(bad("{run: echo, needs: [plan], foreach: steps.other}"), /steps\.other, which is not an earlier step/);
  assert.throws(bad("{run: echo, needs: [plan], foreach: plan.output}"), /foreach must be steps\.<step> or steps\.<step>\.<field>/);
  assert.throws(bad("{run: echo, needs: [plan], foreach: steps.plan, copies: 2}"), /cannot be combined with copies/);
  assert.throws(bad("{run: echo, needs: [plan], foreach: steps.plan, max_parallel: 0}"), /max_parallel must be 1\.\.16/);
  assert.throws(bad("{run: echo, needs: [plan], foreach: steps.plan, as: steps}"), /as must be a plain name/);
  assert.throws(bad("{run: echo, needs: [plan], max_parallel: 2}"), /max_parallel needs foreach:/);
  assert.doesNotThrow(bad("{run: echo, needs: [plan], foreach: steps.plan.qs, as: q, max_parallel: 3, max_items: 50}"));
});
