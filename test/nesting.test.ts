import assert from "node:assert/strict";
import { test } from "node:test";
import { checkNesting, parseJill, type JillDef } from "../src/jillfile.js";
import { start, runNow } from "../src/api.js";
import { tmpHome, tmpRepo, writeJill } from "./helpers.js";

function j(name: string, calls: string[]): JillDef {
  const steps = calls.length ? calls.map((c, i) => `  s${i}: {jill: ${c}}`).join("\n") : "  s: {run: echo hi}";
  return parseJill(`---\nname: ${name}\nsteps:\n${steps}\n---\n`);
}

test("self recursion is refused", () => {
  const a = j("a", ["a"]);
  assert.throws(() => checkNesting(a, (n) => (n === "a" ? a : undefined)), /recursion refused: a -> a/);
});

test("indirect recursion is refused", () => {
  const m = new Map([["a", j("a", ["b"])], ["b", j("b", ["c"])], ["c", j("c", ["a"])]]);
  assert.throws(() => checkNesting(m.get("a")!, (n) => m.get(n)), /recursion refused: a -> b -> c -> a/);
});

test("depth 4 is allowed, depth 5 is refused", () => {
  const four = new Map([["d1", j("d1", ["d2"])], ["d2", j("d2", ["d3"])], ["d3", j("d3", ["d4"])], ["d4", j("d4", [])]]);
  assert.doesNotThrow(() => checkNesting(four.get("d1")!, (n) => four.get(n)));
  const five = new Map([...four, ["d4", j("d4", ["d5"])], ["d5", j("d5", [])]]);
  assert.throws(() => checkNesting(five.get("d1")!, (n) => five.get(n)), /nesting too deep: d1 -> d2 -> d3 -> d4 -> d5 \(max depth 4\)/);
});

test("unknown nested Jill and a nested box that differs from the outermost are refused", () => {
  const a = j("a", ["ghost"]);
  assert.throws(() => checkNesting(a, () => undefined), /unknown Jill "ghost"/);
  const boxed = (name: string, box: string, calls = "  s: {run: x}") => parseJill(`---\nname: ${name}\nbox: ${box}\nsteps:\n${calls}\n---\n`);
  const inner = boxed("inner", "docker");
  const look = (n: string) => (n === "inner" ? inner : undefined);
  assert.throws(() => checkNesting(j("outer", ["inner"]), look), /nested Jill "inner" sets box: docker but outermost Jill "outer" uses box: none/);
  const shell = boxed("shell", "openshell", "  s: {jill: inner}");
  assert.throws(() => checkNesting(shell, look), /nested Jill "inner" sets box: docker but outermost Jill "shell" uses box: openshell/);
  assert.doesNotThrow(() => checkNesting(boxed("dock", "docker", "  s: {jill: inner}"), look));
  assert.doesNotThrow(() => checkNesting(boxed("dock", "docker", "  s: {jill: plain}"), (n) => (n === "plain" ? j("plain", []) : undefined)));
});

test("start refuses recursive Jills before creating anything", async () => {
  const home = tmpHome();
  writeJill(home, "loop", "steps:\n  again: {jill: loop}");
  await assert.rejects(start("loop", { home, cwd: tmpRepo() }), /recursion refused/);
});

test("nested Jills run inline in the same run and worktree", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "inner", "inputs: [who]\nsteps:\n  write: {run: 'echo inner-{{inputs.who}} > inner.txt', writes: true}");
  writeJill(home, "outer", "steps:\n  first: {run: 'echo outer > outer.txt', writes: true}\n  nest: {jill: inner, needs: [first], inputs: {who: kid}}\n  last: {run: 'cat inner.txt outer.txt', needs: [nest]}");
  const r = await runNow("outer", { home, cwd: repo });
  assert.equal(r.state, "done", r.error);
  assert.ok(r.steps["nest/write"], Object.keys(r.steps).join(","));
  assert.equal(r.steps["nest/write"]!.workspace, r.workspace);
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(r.steps.last!.log!, "utf8"), /inner-kid\nouter/);
});
