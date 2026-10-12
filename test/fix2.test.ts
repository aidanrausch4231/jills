// Regression tests for the lead review fix round 2 (items 1-3).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { go, chat, runNow, start, stop, suggest, wait } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import { setJevFetch, type FetchLike } from "../src/plugins/matcher-jev.js";
import { fakeFetch, systemOne } from "./jev-fixtures.js";
import { heartbeatPath, loadRecord, recordPath, saveRecord, type RunRecord } from "../src/runs.js";
import { loadSession } from "../src/plugins/suggest-default.js";
import { bootId } from "../src/proc.js";
import { sleep, writeJsonAtomic } from "../src/util.js";
import { pidAlive, tmp, tmpHome, tmpRepo, writeJill } from "./helpers.js";

const root = new URL("../../", import.meta.url).pathname;
const cli = join(root, "dist", "src", "cli.js");

const jevReply = (reply: unknown): FetchLike => fakeFetch(reply);

function helloHome(config = ""): string {
  const home = tmpHome(`jev: {url: https://jev.example.test/v1/systemone, key_env: JILLS_FIX2_KEY}\n${config}`);
  cpSync(join(root, "examples", "hello"), join(home, "jills", "hello"), { recursive: true });
  return home;
}

afterEach(() => {
  setJevFetch(undefined);
  delete process.env.JILLS_FIX2_KEY;
});

// ---------------------------------------------------------------- 1. only declared inputs

test("Jev fills only the one required input of the Jill, never undeclared ones (suggest, session, go)", async () => {
  const home = helloHome();
  const repo = tmpRepo();
  const elsewhere = tmpRepo();
  process.env.JILLS_FIX2_KEY = "k";
  // hello's only input `who` has a default, so Jev fills nothing; extra keys in a reply are ignored.
  const reply = systemOne("new:hello", 0.95) as { answers: Record<string, unknown> };
  reply.answers.inputs = { who: "Aidan", repo: elsewhere, task: "rm -rf" };
  setJevFetch(jevReply(reply));
  const s = await suggest({ home, session: "f2-1", message: "say hello to Aidan", repo });
  assert.equal(s.action, "suggest");
  assert.deepEqual(s.inputs, {});
  assert.doesNotMatch(s.agentContext!, /repo=|task=/);
  assert.deepEqual(loadSession(home, "f2-1").lastSuggestion?.inputs, {});
  // jills go drops undeclared keys given by hand too, so repo never moves the run.
  const g = await go({ home, session: "f2-1", cwd: repo, inputs: { repo: elsewhere } });
  assert.deepEqual(g.dropped, ["repo"]);
  assert.deepEqual(g.record.inputs, { who: "world" });
  assert.equal(g.record.repo, repo);
  assert.equal((await wait(g.record.id, { home, timeoutMs: 30_000 })).record.state, "done");
});

test("a matcher plug-in's undeclared inputs are dropped centrally", async () => {
  const home = helloHome();
  const plug = join(home, "loud-matcher.mjs");
  writeFileSync(
    plug,
    `export default { slot: "matcher", apiVersion: 1, name: "loud", async match() { return { label: "new", jill: "hello", inputs: { who: "Bo", repo: "/" }, confidence: 0.99, matcher: "loud" }; } };\n`,
  );
  writeFileSync(join(home, "config.yml"), `agent_paths: [${join(home, "agents")}]\nplugins: [${plug}]\n`);
  const s = await suggest({ home, session: "f2-2", message: "anything", repo: tmpRepo() });
  assert.equal(s.matcher, "loud");
  assert.deepEqual(s.inputs, { who: "Bo" });
});

test("keyword matches carry no inputs", async () => {
  const home = helloHome();
  const s = await suggest({ home, session: "f2-3", message: "please say hello", repo: tmpRepo() });
  assert.equal(s.matcher, "keywords");
  assert.deepEqual(s.inputs, {});
});

// ---------------------------------------------------------------- 3. go uses saved inputs

test("jills go with no --input uses the last suggestion's saved inputs (CLI, new process)", async () => {
  const home = helloHome();
  const repo = tmpRepo();
  process.env.JILLS_FIX2_KEY = "k";
  writeJill(home, "ask", "description: Ask someone\nwhen: the user wants someone greeted\ninputs: [{name: who, required: true}]\nworktree: false\nsteps:\n  a: {run: 'true'}");
  setJevFetch(jevReply(systemOne("new:ask", 0.95)));
  assert.equal((await suggest({ home, session: "f2-go", message: "say hello", repo })).action, "suggest");
  assert.deepEqual(await chat("f2-go", { kind: "last" }, { home }), { jill: "ask", inputs: { who: "say hello" } });
  const env: NodeJS.ProcessEnv = { ...process.env, JILLS_HOME: home };
  delete env.JILLS_FIX2_KEY;
  const r = spawnSync(process.execPath, [cli, "go", "--session", "f2-go", "--repo", repo], { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const id = /run (\S+)/.exec(r.stdout)![1]!;
  const w = await wait(id, { home, timeoutMs: 30_000 });
  assert.equal(w.record.state, "done", w.record.error);
  assert.deepEqual(w.record.inputs, { who: "say hello" });
  // --input still overrides one saved value.
  const g = await go({ home, session: "f2-go", cwd: repo, inputs: { who: "Override" } });
  assert.deepEqual(g.record.inputs, { who: "Override" });
  await wait(g.record.id, { home, timeoutMs: 30_000 });
});

// ---------------------------------------------------------------- 2. default total time limit

test("config default_timeout defaults to 2h and every run gets a deadline", async () => {
  const home = tmpHome();
  assert.equal(loadConfig(home).default_timeout, "2h");
  writeJill(home, "quick", "worktree: false\nsteps:\n  a: {run: 'true'}");
  const r = await runNow("quick", { home, cwd: tmp() });
  assert.equal(r.state, "done");
  assert.equal(r.timeLimit, "2h");
  const span = Date.parse(r.deadline!) - Date.parse(r.started!);
  assert.ok(Math.abs(span - 2 * 3_600_000) < 5_000, `deadline ${r.deadline} vs started ${r.started}`);
});

test("config default_timeout applies when the Jill sets none -> stuck", async () => {
  const home = tmpHome("default_timeout: 1s\n");
  writeJill(home, "slow", "worktree: false\nsteps:\n  a: {run: sleep 20}");
  const rec = await start("slow", { home, cwd: tmp() });
  const w = await wait(rec.id, { home, timeoutMs: 20_000 });
  assert.equal(w.timedOut, false);
  assert.equal(w.record.state, "stuck");
  assert.match(w.record.error ?? "", /total time limit 1s reached/);
});

test("jills wait reports stuck when a hung runner passes its deadline (no hang forever); stop then ends it", async () => {
  const home = tmpHome();
  mkdirSync(join(home, "runs"), { recursive: true });
  // A "runner" that ignores its timer, and a step it left running, both tagged with the run id.
  const env = { ...process.env, JILLS_RUN_ID: "hung-1" };
  const runner = spawn("sleep", ["60"], { detached: true, stdio: "ignore", env });
  const step = spawn("sleep", ["60"], { detached: true, stdio: "ignore", env });
  runner.unref();
  step.unref();
  const past = new Date(Date.now() - 5 * 60_000).toISOString();
  const stamp = String(process.hrtime.bigint() - 120_000_000_000n);
  const rec: RunRecord = {
    version: 1,
    id: "hung-1",
    jill: "x",
    jillPath: "/nowhere",
    inputs: {},
    state: "running",
    created: past,
    started: past,
    repo: tmp(),
    pid: runner.pid,
    logDir: join(home, "runs", "hung-1"),
    steps: { a: { key: "a", step: "a", jill: "x", kind: "run", state: "running" } },
    events: [],
    timeLimit: "1m",
    deadline: new Date(Date.now() - 2 * 60_000).toISOString(),
  };
  saveRecord(home, rec);
  writeJsonAtomic(heartbeatPath(home, "hung-1"), { at: past, mono: stamp, since: stamp, bootId: bootId() });
  const w = await wait("hung-1", { home, timeoutMs: 10_000, pollMs: 50 });
  assert.equal(w.timedOut, false, "wait must not hang");
  assert.equal(w.record.state, "stuck");
  assert.match(w.line, /stuck/);
  assert.equal(loadRecord(home, "hung-1")!.steps.a!.state, "stuck");
  assert.equal(pidAlive(runner.pid!), true, "wait never signals");
  const s = await stop("hung-1", { home });
  assert.equal(s.pids.length, 2);
  for (let i = 0; i < 40 && (pidAlive(runner.pid!) || pidAlive(step.pid!)); i++) await sleep(50);
  assert.equal(pidAlive(runner.pid!), false, "hung runner stopped");
  assert.equal(pidAlive(step.pid!), false, "step stopped");
  assert.equal(loadRecord(home, "hung-1")!.state, "stuck", "stop keeps the terminal record");
  assert.ok(recordPath(home, "hung-1"));
});

test("a running record before its deadline is left alone", async () => {
  const home = tmpHome();
  mkdirSync(join(home, "runs"), { recursive: true });
  const now = new Date().toISOString();
  saveRecord(home, {
    version: 1, id: "live-1", jill: "x", jillPath: "/n", inputs: {}, state: "running", created: now, started: now,
    repo: tmp(), pid: process.pid, logDir: join(home, "runs", "live-1"), steps: {}, events: [],
    timeLimit: "2h", deadline: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const w = await wait("live-1", { home, timeoutMs: 200, pollMs: 50 });
  assert.equal(w.timedOut, true);
  assert.equal(w.record.state, "running");
});
