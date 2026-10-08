import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { runNow, start, status, suggest } from "../src/api.js";
import { parseJill } from "../src/jillfile.js";
import { setJevFetch, type FetchLike } from "../src/plugins/matcher-jev.js";
import { loadRecord } from "../src/runs.js";
import { renderShellTemplate } from "../src/template.js";
import { sleep } from "../src/util.js";
import { git, pidAlive, tmp, tmpHome, tmpRepo, writeJill } from "./helpers.js";

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// ---------------------------------------------------------------- P1: shell injection

const EVIL = `a"; touch pwned1; echo "$(touch pwned2) \`touch pwned3\` 'q' $HOME`;

test("templates inside double quotes in run: cannot inject commands", async () => {
  const home = tmpHome();
  const ws = tmp();
  writeJill(home, "dq", `worktree: false
inputs: [x]
steps:
  a: {run: 'echo "v={{inputs.x}}" > out.txt'}
  b: {run: 'echo "from a: {{steps.a.output}}|{{task}}" > out2.txt', needs: [a]}`);
  const r = await runNow("dq", { home, cwd: ws, inputs: { x: "$(touch pwned)", task: EVIL } });
  assert.equal(r.state, "done", r.error);
  assert.equal(existsSync(join(ws, "pwned")), false, "command substitution in an input ran");
  for (const f of ["pwned1", "pwned2", "pwned3"]) assert.equal(existsSync(join(ws, f)), false, `${f} created`);
  assert.equal(readFileSync(join(ws, "out.txt"), "utf8"), "v=$(touch pwned)\n");
  assert.equal(readFileSync(join(ws, "out2.txt"), "utf8"), `from a: |${EVIL}\n`);
});

test("templates inside single quotes, $( ) and unquoted keep the exact value", async () => {
  const home = tmpHome();
  const ws = tmp();
  writeJill(home, "ctx", String.raw`worktree: false
inputs: [x]
steps:
  a:
    run: |
      echo '[{{inputs.x}}]' > s.txt
      echo "$(printf '%s' {{inputs.x}})" > c.txt
      echo {{inputs.x}} > u.txt
      echo "$(echo "in {{inputs.x}}")" > n.txt`);
  const x = `it's $(touch pwned) "q" *`;
  const r = await runNow("ctx", { home, cwd: ws, inputs: { x } });
  assert.equal(r.state, "done", r.error);
  assert.equal(existsSync(join(ws, "pwned")), false);
  assert.equal(readFileSync(join(ws, "s.txt"), "utf8"), `[${x}]\n`);
  assert.equal(readFileSync(join(ws, "c.txt"), "utf8"), `${x}\n`);
  assert.equal(readFileSync(join(ws, "u.txt"), "utf8"), `${x}\n`);
  assert.equal(readFileSync(join(ws, "n.txt"), "utf8"), `in ${x}\n`);
});

test("shell templates are env references, never values; backticks are refused", () => {
  const t = renderShellTemplate(`echo "a {{inputs.x}}" {{copy}} '{{task}}'`, { inputs: { x: "$(id)", task: "t" }, copy: 2 });
  assert.equal(t.text, `echo "a \${JILLS_INPUT_X}" "\${JILLS_COPY}" ''"\${JILLS_TASK}"''`);
  assert.deepEqual(t.env, { JILLS_INPUT_X: "$(id)", JILLS_COPY: "2", JILLS_TASK: "t" });
  assert.ok(!t.text.includes("$(id)"));
  assert.throws(() => renderShellTemplate("echo `cat {{inputs.x}}`", { inputs: {} }), /backticks/);
  assert.throws(
    () => parseJill("---\nname: bt\nsteps:\n  a: {run: 'echo `{{inputs.x}}`'}\n---\n", "/x/bt/JILL.md"),
    /step a: .*backticks/,
  );
});

// ---------------------------------------------------------------- P2: ignored -> wait for new task

function antiNagHome() {
  const home = tmpHome();
  writeJill(home, "fix-bug", "description: Fix a bug\nkeywords: [bug]\nworktree: false\nsteps:\n  a: {run: echo}");
  writeJill(home, "docs", "description: Write docs\nkeywords: [docs]\nworktree: false\nsteps:\n  a: {run: echo}");
  return home;
}

test("ignored suggestion: the same Jill stays quiet after the rate-limit window", async () => {
  const home = antiNagHome();
  const repo = tmpRepo();
  const say = (m: string) => suggest({ home, session: "ign-same", message: m, repo });
  assert.equal((await say("a bug")).action, "suggest");
  assert.equal((await say("ok")).action, "quiet");
  assert.equal((await say("ok")).action, "quiet");
  const again = await say("another bug");
  assert.equal(again.action, "quiet");
  assert.equal(again.reason, "ignored; waiting for a new task");
  assert.equal((await say("yet another bug")).action, "quiet");
  // a different Jill is a new task: suggest it and clear the wait
  assert.equal((await say("now the docs")).jill, "docs");
});

afterEach(() => {
  setJevFetch(undefined);
  delete process.env.JILLS_TEST_JEV_KEY;
});

test("ignored suggestion: Jev naming the same Jill with another target counts as new", async () => {
  const home = tmpHome("jev: {key_env: JILLS_TEST_JEV_KEY, threshold: 0.7}\n");
  writeJill(home, "fix-bug", "description: Fix a bug\nkeywords: [bug]\ninputs: [task]\nworktree: false\nsteps:\n  a: {run: echo}");
  process.env.JILLS_TEST_JEV_KEY = "sk-test-not-real";
  let reply: unknown = { label: "new", jill: "fix-bug", inputs: { task: "login 500" }, confidence: 0.9 };
  const f: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) });
  setJevFetch(f);
  const repo = tmpRepo();
  const say = (m: string) => suggest({ home, session: "ign-jev", message: m, repo });
  assert.equal((await say("login gives 500")).action, "suggest");
  reply = { label: "talk", confidence: 0.9 };
  await say("ok");
  await say("ok");
  reply = { label: "new", jill: "fix-bug", inputs: { task: "login 500" }, confidence: 0.9 };
  assert.equal((await say("login still 500")).reason, "ignored; waiting for a new task");
  reply = { label: "new", jill: "fix-bug", inputs: { task: "signup page crashes" }, confidence: 0.9 };
  const fresh = await say("signup crashes too");
  assert.equal(fresh.action, "suggest");
  assert.deepEqual(fresh.inputs, { task: "signup page crashes" });
});

// ---------------------------------------------------------------- P2: merge-back with a dirty parent

test("merge-back with a dirty parent worktree: files and branch stay in step", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "dirty", `steps:
  scratch: {run: 'echo dirty > base.txt'}
  w1: {run: 'echo child1 > base.txt', writes: true, needs: [scratch]}
  w2: {run: 'echo two > other.txt', writes: true, needs: [scratch]}`);
  const r = await runNow("dirty", { home, cwd: repo });
  assert.equal(r.state, "needs-you", r.error);
  assert.deepEqual(r.conflicts, ["base.txt"]);
  // the parent's files always match its branch: no stale index or reverted merge
  assert.equal(git(r.workspace!, "status", "--porcelain"), "", "parent worktree matches its branch");
  assert.equal(git(r.workspace!, "rev-parse", "HEAD"), git(repo, "rev-parse", r.branch!));
  assert.equal(readFileSync(join(r.workspace!, "base.txt"), "utf8"), "dirty\n");
  assert.equal(git(repo, "show", `${r.branch}:base.txt`), "dirty");
});

test("merge-back with a dirty parent and no clash: everything lands on the branch", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "dirty-ok", `steps:
  scratch: {run: 'echo notes > notes.txt'}
  w1: {run: 'echo one > one.txt', writes: true, needs: [scratch]}
  w2: {run: 'echo two > two.txt', writes: true, needs: [scratch]}`);
  const r = await runNow("dirty-ok", { home, cwd: repo });
  assert.equal(r.state, "done", r.error);
  assert.equal(git(r.workspace!, "status", "--porcelain"), "");
  for (const f of ["notes.txt", "one.txt", "two.txt"]) assert.ok(git(repo, "ls-tree", "--name-only", r.branch!).split("\n").includes(f), f);
});

// ---------------------------------------------------------------- P2: runner death leaves no orphans

const LONG_STEP = `worktree: false
steps:
  long: {run: 'sleep 300 & echo $! > "$JILLS_WORKSPACE/child.pid"; wait'}`;

const spawned: number[] = [];
after(() => {
  // Never leave a test's sleep behind, even when a test fails.
  for (const pid of spawned) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
});

async function startLong(home: string, ws: string, needStepPid: boolean) {
  writeJill(home, "long", LONG_STEP);
  const rec = await start("long", { home, cwd: ws });
  const pidFile = join(ws, "child.pid");
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 15_000, "step to start");
  const childPid = Number(readFileSync(pidFile, "utf8").trim());
  spawned.push(childPid);
  // The step's process group id is recorded at spawn, not when the step ends.
  if (needStepPid) await until(() => loadRecord(home, rec.id)?.steps.long?.pid !== undefined, 5_000, "step pid in record");
  const r = loadRecord(home, rec.id)!;
  assert.equal(r.steps.long!.state, "running");
  return { id: rec.id, runnerPid: r.pid!, childPid };
}

test("SIGTERM to the runner kills step process groups and records the run as failed", async () => {
  const home = tmpHome();
  const ws = tmp();
  const { id, runnerPid, childPid } = await startLong(home, ws, false);
  assert.ok(pidAlive(childPid));
  process.kill(runnerPid, "SIGTERM");
  // the runner itself writes the terminal state (no refresh sweep involved)
  await until(() => loadRecord(home, id)?.state === "failed", 15_000, "runner to record failed");
  assert.match(loadRecord(home, id)!.error!, /runner stopped: SIGTERM/);
  await until(() => !pidAlive(childPid), 10_000, "step grandchild to die");
  await until(() => !pidAlive(runnerPid), 10_000, "runner to exit");
});

test("a runner killed with SIGKILL: refresh sweeps the recorded step process groups", async () => {
  const home = tmpHome();
  const ws = tmp();
  const { id, runnerPid, childPid } = await startLong(home, ws, true);
  process.kill(runnerPid, "SIGKILL");
  await until(() => !pidAlive(runnerPid), 10_000, "runner to die");
  assert.ok(pidAlive(childPid), "orphaned step still running before the sweep");
  const r = status(id, { home })!;
  assert.equal(r.state, "failed");
  assert.equal(r.steps.long!.state, "failed");
  assert.match(r.steps.long!.reason!, /process group stopped/);
  await until(() => !pidAlive(childPid), 10_000, "orphaned step to be killed");
});
