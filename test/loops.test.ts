import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { check, dryRun, runNow } from "../src/api.js";
import { parseJill } from "../src/jillfile.js";
import verdictCheck from "../src/plugins/check-verdict.js";
import { renderTemplate } from "../src/template.js";
import { tmp, tmpHome, writeJill } from "./helpers.js";

// review fails until its counter file reaches `passAt`; the output names the round.
const review = (passAt: number, extra = "") => `
  review:
    run: 'n=$(cat n 2>/dev/null || echo 0); n=$((n+1)); echo $n > n; echo "review says no $n"; [ $n -ge ${passAt} ]'
    needs: [build]
    on_fail: {back_to: build, max_rounds: 3}${extra}`;

test("back-arrow: review fails twice then passes -> build ran 3 times with {{round}}/{{feedback}}, run done", async () => {
  const home = tmpHome();
  const ws = tmp();
  writeJill(home, "loop", `worktree: false
steps:
  build: {run: 'printf "round=%s fb=%s|\\n" {{round}} "{{feedback}}" >> build.txt'}${review(3)}`);
  const r = await runNow("loop", { home, cwd: ws });
  assert.equal(r.state, "done", r.error);
  assert.deepEqual(Object.keys(r.steps).sort(), ["build", "build@2", "build@3", "review", "review@2", "review@3"]);
  assert.equal(r.steps.review!.state, "failed");
  assert.equal(r.steps["review@2"]!.state, "failed");
  assert.equal(r.steps["review@3"]!.state, "done");
  assert.equal(readFileSync(join(ws, "build.txt"), "utf8"), "round=1 fb=|\nround=2 fb=review says no 1|\nround=3 fb=review says no 2|\n");
  assert.equal(r.error, undefined);
});

test("back-arrow exhausted -> needs-you with a reason; timeouts never loop", async () => {
  const home = tmpHome();
  writeJill(home, "never", `worktree: false\nsteps:\n  build: {run: 'echo b'}${review(99)}`);
  const r = await runNow("never", { home, cwd: tmp() });
  assert.equal(r.state, "needs-you");
  assert.match(r.error!, /review failed 3 rounds/);
  assert.deepEqual(Object.keys(r.steps).filter((k) => k.startsWith("build")).sort(), ["build", "build@2", "build@3"]);

  writeJill(home, "slow", `worktree: false
steps:
  build: {run: 'echo b'}
  review: {run: 'sleep 5', timeout: 1s, needs: [build], on_fail: {back_to: build}}`);
  const s = await runNow("slow", { home, cwd: tmp() });
  assert.equal(s.state, "stuck");
  assert.deepEqual(Object.keys(s.steps).sort(), ["build", "review"]);
});

test("a step without on_fail still stops the run at once", async () => {
  const home = tmpHome();
  writeJill(home, "plain", "worktree: false\nsteps:\n  a: {run: 'exit 2'}\n  b: {run: 'echo no', needs: [a]}");
  const r = await runNow("plain", { home, cwd: tmp() });
  assert.equal(r.state, "failed");
  assert.match(r.error!, /step a: exit code 2/);
});

test("back-arrows work inside a nested Jill, scoped to it", async () => {
  const home = tmpHome();
  writeJill(home, "inner", `worktree: false\nsteps:\n  build: {run: 'echo b'}${review(2)}`);
  writeJill(home, "outer", "worktree: false\nsteps:\n  sub: {jill: inner}\n  after: {run: 'echo after', needs: [sub]}");
  const r = await runNow("outer", { home, cwd: tmp() });
  assert.equal(r.state, "done", r.error);
  for (const k of ["sub", "sub/build", "sub/build@2", "sub/review", "sub/review@2", "after"]) assert.ok(r.steps[k], k);
});

test("on_fail validation: back_to must be an earlier step it needs", () => {
  const bad = (steps: string) => () => parseJill(`---\nname: b\nworktree: false\nsteps:\n${steps}\n---\n`, "b/JILL.md");
  assert.throws(bad("  a: {run: x}\n  b: {run: y, needs: [a], on_fail: {back_to: ghost}}"), /back_to "ghost" must be an earlier step it needs/);
  assert.throws(bad("  a: {run: x}\n  b: {run: y, on_fail: {back_to: a}}"), /back_to "a" must be an earlier step/);
  assert.throws(bad("  a: {run: x, needs: [b]}\n  b: {run: y, on_fail: {back_to: a}}"), /back_to "a"/);
  assert.throws(bad("  a: {run: x}\n  b: {run: y, needs: [a], on_fail: {back_to: a, max_rounds: 0}}"), /on_fail must be/);
  assert.throws(bad("  a: {run: x}\n  b: {run: y, needs: [a], on_fail: a}"), /on_fail must be/);
  // transitive: c needs b needs a
  const ok = parseJill("---\nname: t\nsteps:\n  a: {run: x}\n  b: {run: y, needs: [a]}\n  c: {run: z, needs: [b], on_fail: {back_to: a, max_rounds: 50}}\n---\n");
  assert.deepEqual(ok.steps[2]!.onFail, { backTo: "a", maxRounds: 10 });
  assert.equal(ok.steps[1]!.onFail, undefined);
  assert.equal(parseJill("---\nname: d\nsteps:\n  a: {run: x}\n  b: {run: y, needs: [a], on_fail: {back_to: a}}\n---\n").steps[1]!.onFail!.maxRounds, 3);
});

test("{{round}} and {{feedback}} render in agent tasks; dry run shows the back-arrow", async () => {
  assert.equal(renderTemplate("r{{round}}: {{ feedback }}", { inputs: {}, round: 2, feedback: "fix x" }), "r2: fix x");
  assert.equal(renderTemplate("r{{round}}:{{feedback}}", { inputs: {} }), "r:");
  const home = tmpHome();
  writeJill(home, "loop", `worktree: false\nsteps:\n  build: {run: 'echo b'}${review(3)}`);
  const lines = await dryRun("loop", { home, cwd: tmp() });
  assert.ok(lines.some((l) => /review .*on fail back to build, max 3 rounds/.test(l)), lines.join("\n"));
  assert.deepEqual((await check({ home })).errors, []);
});

test("verdict check: pass, fail, missing; steps without verdict: true always pass", async () => {
  const dir = tmp();
  const run = async (text: string, verdict: unknown = true) => {
    const logPath = join(dir, `${Math.random()}.log`);
    (await import("node:fs")).writeFileSync(logPath, text);
    const step = parseJill(`---\nname: v\nsteps:\n  a: {run: x, verdict: ${JSON.stringify(verdict)}}\n---\n`).steps[0]!;
    return verdictCheck.check({ step, logPath, result: { exitCode: 0, timedOut: false, aborted: false } });
  };
  assert.equal((await run("notes\nVERDICT: issues\nmore\nverdict: Clean.\n")).ok, true);
  assert.equal((await run("**VERDICT: clean**")).ok, true);
  const fail = await run("VERDICT: clean\nthen\nVERDICT: 2 defects\n");
  assert.equal(fail.ok, false);
  assert.match(fail.reason!, /VERDICT: 2 defects/);
  const missing = await run("looks fine to me\n");
  assert.equal(missing.ok, false);
  assert.match(missing.reason!, /no VERDICT: line/);
  assert.equal((await run("anything", false)).ok, true);
  assert.equal((await run("VERDICT: cleanish")).ok, false);
});

test("verdict: true fails a step that exits 0 and drives its back-arrow", async () => {
  const home = tmpHome();
  writeJill(home, "rv", `worktree: false
steps:
  build: {run: 'echo b'}
  review:
    run: 'if [ -f seen ]; then echo "VERDICT: clean"; else touch seen; echo "VERDICT: fix the tests"; fi'
    verdict: true
    needs: [build]
    on_fail: {back_to: build}`);
  const r = await runNow("rv", { home, cwd: tmp() });
  assert.equal(r.state, "done", r.error);
  assert.match(r.steps.review!.reason!, /VERDICT: fix the tests/);
  assert.equal(r.steps["review@2"]!.state, "done");
});
