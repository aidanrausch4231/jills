import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runNow } from "../src/api.js";
import { git, pidAlive, tmp, tmpHome, tmpRepo, writeJill } from "./helpers.js";

function times(r: { steps: Record<string, { started?: string; finished?: string }> }, k: string) {
  const s = r.steps[k]!;
  return { start: Date.parse(s.started!), end: Date.parse(s.finished!) };
}

test("needs order steps; independent steps and copies run in parallel", async () => {
  const home = tmpHome();
  writeJill(
    home,
    "graph",
    `worktree: false
steps:
  a: {run: sleep 0.4}
  b: {run: sleep 0.4}
  c: {run: sleep 0.4, copies: 3, needs: [a, b]}
  d: {run: 'echo {{copy}}"|$JILLS_STEP"', needs: [c]}`,
  );
  const t0 = Date.now();
  const r = await runNow("graph", { home, cwd: tmp() });
  const took = Date.now() - t0;
  assert.equal(r.state, "done", r.error);
  assert.deepEqual(Object.keys(r.steps).sort(), ["a", "b", "c#1", "c#2", "c#3", "d"]);
  const a = times(r, "a"), b = times(r, "b");
  assert.ok(Math.abs(a.start - b.start) < 300, "a and b start together");
  for (const k of ["c#1", "c#2", "c#3"]) assert.ok(times(r, k).start >= Math.max(a.end, b.end) - 5, `${k} waits for a and b`);
  assert.ok(times(r, "d").start >= Math.max(...["c#1", "c#2", "c#3"].map((k) => times(r, k).end)) - 5);
  assert.ok(took < 2500, `parallel run took ${took}ms`);
  assert.match(readFileSync(r.steps.d!.log!, "utf8"), /^\|d$/m);
  for (const e of ["started", "step-started", "step-done", "finished"]) assert.ok(r.events.some((x) => x.type === e), e);
});

test("a failing step fails the run and skips its dependents", async () => {
  const home = tmpHome();
  writeJill(home, "boom", "worktree: false\nsteps:\n  a: {run: exit 3}\n  b: {run: echo never, needs: [a]}");
  const r = await runNow("boom", { home, cwd: tmp() });
  assert.equal(r.state, "failed");
  assert.equal(r.steps.a!.state, "failed");
  assert.equal(r.steps.a!.exitCode, 3);
  assert.match(r.error!, /exit code 3/);
  assert.equal(r.steps.b, undefined);
});

test("step timeout -> stuck, whole process group killed", async () => {
  const home = tmpHome();
  const ws = tmp();
  writeJill(home, "slow", `worktree: false
steps:
  hang:
    run: 'sleep 30 & echo $! > child.pid; wait'
    timeout: 1s
  never: {run: echo no, needs: [hang]}`);
  const t0 = Date.now();
  const r = await runNow("slow", { home, cwd: ws });
  assert.equal(r.state, "stuck");
  assert.equal(r.steps.hang!.state, "stuck");
  assert.match(r.steps.hang!.reason!, /timed out/);
  assert.ok(Date.now() - t0 < 8000);
  const pid = Number(readFileSync(join(ws, "child.pid"), "utf8"));
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(pidAlive(pid), false, "grandchild sleep was killed");
});

test("total Jill timeout -> stuck and running steps stopped", async () => {
  const home = tmpHome();
  writeJill(home, "total", "worktree: false\ntimeout: 1s\nsteps:\n  a: {run: sleep 20}\n  b: {run: sleep 20}");
  const t0 = Date.now();
  const r = await runNow("total", { home, cwd: tmp() });
  assert.equal(r.state, "stuck");
  assert.match(r.error!, /total time limit/);
  assert.ok(Date.now() - t0 < 8000);
});

test("worktree: run gets its own branch + worktree, commits per writing step, user branch untouched", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  const mainBefore = git(repo, "rev-parse", "main");
  writeJill(home, "wt", "steps:\n  one: {run: 'echo 1 > one.txt', writes: true}\n  look: {run: 'echo look > scratch.txt', needs: [one]}\n  two: {run: 'echo 2 > two.txt', writes: true, needs: [look]}");
  const r = await runNow("wt", { home, cwd: repo });
  assert.equal(r.state, "done", r.error);
  assert.equal(r.branch, `jills/wt-${r.id}`);
  assert.equal(r.workspace, join(home, "worktrees", `wt-${r.id}`));
  assert.ok(existsSync(join(r.workspace!, "one.txt")));
  assert.equal(git(repo, "rev-parse", "main"), mainBefore, "main did not move");
  assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "main");
  const log = git(repo, "log", "--format=%s", `main..${r.branch}`).split("\n");
  assert.deepEqual(log, ["jills(wt): two", "jills(wt): one"]);
  // the non-writing step's file was picked up by the next writing commit
  assert.ok(git(repo, "show", "--name-only", "--format=", `${r.branch}`).includes("scratch.txt"));
  assert.ok(r.steps.one!.commit);
  assert.ok(existsSync(r.workspace!), "worktree kept");
});

test("parallel writers get child worktrees and merge back cleanly", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "par", `steps:
  w: {run: 'echo "copy {{copy}}" > "out-{{copy}}.txt"', writes: true, copies: 3}
  x: {run: 'echo x > x.txt', writes: true}
  after: {run: 'ls out-1.txt out-2.txt out-3.txt x.txt', needs: [w, x]}`);
  const r = await runNow("par", { home, cwd: repo });
  assert.equal(r.state, "done", r.error);
  for (const k of ["w#1", "w#2", "w#3", "x"]) {
    assert.notEqual(r.steps[k]!.workspace, r.workspace, `${k} ran in a child worktree`);
    assert.match(r.steps[k]!.branch!, new RegExp(`^jills/par-${r.id}--`));
  }
  assert.equal(r.steps.after!.workspace, r.workspace);
  const files = git(repo, "ls-tree", "--name-only", r.branch!).split("\n");
  for (const f of ["out-1.txt", "out-2.txt", "out-3.txt", "x.txt", "base.txt"]) assert.ok(files.includes(f), f);
  const merges = git(repo, "rev-list", "--merges", "--count", `main..${r.branch}`);
  assert.equal(Number(merges), 4);
});

test("merge conflict -> needs-you with files listed, parent branch untouched", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "clash", `steps:
  w: {run: 'echo "copy {{copy}}" > base.txt', writes: true, copies: 2}
  after: {run: echo never, needs: [w]}`);
  const r = await runNow("clash", { home, cwd: repo });
  assert.equal(r.state, "needs-you", r.error);
  assert.deepEqual(r.conflicts, ["base.txt"]);
  assert.match(r.error!, /conflicts in: base\.txt/);
  // parent branch has exactly one of the two copies merged, never a half merge
  const parentFile = git(repo, "show", `${r.branch}:base.txt`);
  assert.match(parentFile, /^copy [12]$/);
  assert.equal(git(r.workspace!, "status", "--porcelain"), "", "parent worktree clean");
  const merges = Number(git(repo, "rev-list", "--merges", "--count", `main..${r.branch}`));
  assert.equal(merges, 1);
  assert.equal(r.steps.after, undefined);
  // the conflicting child branch is kept for the user
  const conflicted = Object.values(r.steps).find((s) => s.state === "needs-you")!;
  assert.ok(git(repo, "branch", "--list", conflicted.branch!).includes(conflicted.branch!));
});

test("worktree: false runs in the folder and never commits", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "inplace", "worktree: false\nsteps:\n  w: {run: 'echo hi > new.txt', writes: true}");
  const r = await runNow("inplace", { home, cwd: repo });
  assert.equal(r.state, "done", r.error);
  assert.equal(r.workspace, repo);
  assert.equal(r.branch, undefined);
  assert.equal(git(repo, "rev-list", "--count", "HEAD"), "1");
  assert.ok(existsSync(join(repo, "new.txt")));
});

test("worktree: true outside a git repo fails clearly", async () => {
  const home = tmpHome();
  writeJill(home, "needgit", "steps:\n  a: {run: echo hi}");
  const r = await runNow("needgit", { home, cwd: tmp() });
  assert.equal(r.state, "failed");
  assert.match(r.error!, /not inside a git repository/);
});

test("inputs never reach the shell text of run: commands (unquoted placeholder)", async () => {
  const home = tmpHome();
  const ws = tmp();
  writeJill(home, "quote", "worktree: false\ninputs: [x]\nsteps:\n  a: {run: 'echo {{inputs.x}} > out.txt'}");
  const r = await runNow("quote", { home, cwd: ws, inputs: { x: "a; touch pwned 'q' $(id)" } });
  assert.equal(r.state, "done", r.error);
  assert.equal(readFileSync(join(ws, "out.txt"), "utf8"), "a; touch pwned 'q' $(id)\n");
  assert.equal(existsSync(join(ws, "pwned")), false);
});
