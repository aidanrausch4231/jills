// Regression tests for the lead review fix round 3.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { check, newJill, runNow, start, suggest, wait } from "../src/api.js";
import { NO_WORKTREE_NOTE, parseJill } from "../src/jillfile.js";
import { totalLimit } from "../src/engine.js";
import { procStartToken } from "../src/proc.js";
import { loadRecord, refreshRecord, saveRecord, type RunRecord } from "../src/runs.js";
import { MAX_TIMER_MS, sleep } from "../src/util.js";
import { pidAlive, tmp, tmpHome, tmpRepo, writeJill } from "./helpers.js";

const kids: ChildProcess[] = [];
after(() => {
  for (const k of kids) {
    try {
      if (k.pid) process.kill(k.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
});

function sleeper(): ChildProcess {
  const c = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  c.unref();
  kids.push(c);
  return c;
}

/** A node "runner": on SIGTERM writes a marker, optionally overwrites the record as failed, then exits (or ignores it). */
function fakeRunner(marker: string, mode: "exit" | "ignore", recordFile?: string): ChildProcess {
  const code = `
    const fs = require("node:fs");
    process.on("SIGTERM", () => {
      fs.writeFileSync(${JSON.stringify(marker)}, "TERM");
      if (${JSON.stringify(mode)} === "exit") {
        const f = ${JSON.stringify(recordFile ?? "")};
        if (f) { const r = JSON.parse(fs.readFileSync(f, "utf8")); r.state = "failed"; r.error = "runner stopped: SIGTERM"; fs.writeFileSync(f, JSON.stringify(r)); }
        process.exit(1);
      }
    });
    fs.writeFileSync(${JSON.stringify(marker + ".ready")}, "1");
    setInterval(() => {}, 1000);
  `;
  const c = spawn(process.execPath, ["-e", code], { detached: true, stdio: "ignore" });
  c.unref();
  kids.push(c);
  return c;
}

async function until(fn: () => boolean, ms = 5000): Promise<void> {
  for (let t = 0; t < ms && !fn(); t += 25) await sleep(25);
}

function record(home: string, id: string, extra: Partial<RunRecord>): RunRecord {
  mkdirSync(join(home, "runs"), { recursive: true });
  const past = new Date(Date.now() - 10 * 60_000).toISOString();
  const r: RunRecord = {
    version: 1,
    id,
    jill: "x",
    jillPath: "/nowhere",
    inputs: {},
    state: "running",
    created: past,
    started: past,
    repo: tmp(),
    logDir: join(home, "runs", id),
    steps: {},
    events: [],
    timeLimit: "1m",
    timeLimitMs: 60_000,
    deadline: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...extra,
  };
  saveRecord(home, r);
  return r;
}

// ---------------------------------------------------------------- 1. markStuck: no blind SIGKILL

test("stuck runner gets SIGTERM first; its own 'failed' write does not replace stuck", async () => {
  const home = tmpHome();
  const marker = join(tmp(), "term");
  const file = join(home, "runs", "term-1.json");
  const runner = fakeRunner(marker, "exit", file);
  await until(() => existsSync(marker + ".ready"));
  record(home, "term-1", { pid: runner.pid, pidStart: procStartToken(runner.pid) });
  const w = await wait("term-1", { home, timeoutMs: 10_000, pollMs: 50, staleMs: 100, killGraceMs: 3000 });
  assert.equal(w.record.state, "stuck");
  assert.equal(readFileSync(marker, "utf8"), "TERM", "runner got SIGTERM");
  await until(() => !pidAlive(runner.pid!));
  assert.equal(pidAlive(runner.pid!), false);
  assert.equal(loadRecord(home, "term-1")!.state, "stuck", "stuck survives the runner's own write");
});

test("a runner that ignores SIGTERM gets SIGKILL after the grace", async () => {
  const home = tmpHome();
  const marker = join(tmp(), "term");
  const runner = fakeRunner(marker, "ignore");
  await until(() => existsSync(marker + ".ready"));
  record(home, "kill-1", { pid: runner.pid, pidStart: procStartToken(runner.pid) });
  const t0 = Date.now();
  const w = await wait("kill-1", { home, timeoutMs: 10_000, pollMs: 50, staleMs: 100, killGraceMs: 600 });
  assert.equal(w.record.state, "stuck");
  await until(() => !pidAlive(runner.pid!));
  assert.equal(readFileSync(marker, "utf8"), "TERM");
  assert.equal(pidAlive(runner.pid!), false, "SIGKILL after grace");
  assert.ok(Date.now() - t0 >= 600, "not killed before the grace");
});

test("a recycled runner or step pid (start token differs) is never signaled", async () => {
  const home = tmpHome();
  const other = sleeper();
  const otherStep = sleeper();
  record(home, "recycled-1", {
    pid: other.pid,
    pidStart: "linux:1",
    steps: { a: { key: "a", step: "a", jill: "x", kind: "run", state: "running", pid: otherStep.pid, pidStart: "linux:1" } },
  });
  const w = await wait("recycled-1", { home, timeoutMs: 5000, pollMs: 50, staleMs: 100, killGraceMs: 200 });
  // The recorded runner (start token) is gone, so the run failed — but the
  // processes that now hold those pids were left alone.
  assert.equal(w.record.state, "failed");
  await sleep(400);
  assert.equal(pidAlive(other.pid!), true, "unrelated process with the runner's pid survives");
  assert.equal(pidAlive(otherStep.pid!), true, "unrelated process with the step's pid survives");
});

test("stuck run: a step pid now held by another process is not signaled", async () => {
  const home = tmpHome();
  const runner = sleeper();
  const otherStep = sleeper();
  record(home, "recycled-2", {
    pid: runner.pid,
    pidStart: procStartToken(runner.pid),
    steps: { a: { key: "a", step: "a", jill: "x", kind: "run", state: "running", pid: otherStep.pid, pidStart: "linux:1" } },
  });
  const w = await wait("recycled-2", { home, timeoutMs: 5000, pollMs: 50, staleMs: 100, killGraceMs: 200 });
  assert.equal(w.record.state, "stuck");
  await until(() => !pidAlive(runner.pid!));
  assert.equal(pidAlive(runner.pid!), false, "the real runner is stopped");
  assert.equal(pidAlive(otherStep.pid!), true, "the recycled step pid is left alone");
});

test("wall clock past the deadline (suspend/clock jump) with a live, beating runner is not stuck", async () => {
  const home = tmpHome();
  const runner = sleeper();
  record(home, "jump-1", {
    pid: runner.pid,
    pidStart: procStartToken(runner.pid),
    heartbeat: { at: new Date().toISOString(), elapsedMs: 5_000 },
  });
  const w = await wait("jump-1", { home, timeoutMs: 500, pollMs: 50, staleMs: 10_000 });
  assert.equal(w.timedOut, true);
  assert.equal(w.record.state, "running");
  assert.equal(pidAlive(runner.pid!), true);
});

test("a stale heartbeat is not stuck on one look; it must stay stale on the observer's clock", async () => {
  const home = tmpHome();
  const runner = sleeper();
  record(home, "stale-1", {
    pid: runner.pid,
    pidStart: procStartToken(runner.pid),
    heartbeat: { at: new Date(Date.now() - 10 * 60_000).toISOString(), elapsedMs: 5_000 },
  });
  assert.equal(refreshRecord(home, "stale-1", { staleMs: 300 })!.state, "running", "first look after resume");
  // The runner beats again (resumed): still not stuck.
  const r = loadRecord(home, "stale-1")!;
  r.heartbeat = { at: new Date().toISOString(), elapsedMs: 6_000 };
  saveRecord(home, r);
  await sleep(400);
  assert.equal(refreshRecord(home, "stale-1", { staleMs: 300 })!.state, "running");
  // No beat for longer than the window → stuck.
  r.heartbeat = { at: new Date(Date.now() - 60_000).toISOString(), elapsedMs: 6_000 };
  saveRecord(home, r);
  assert.equal(refreshRecord(home, "stale-1", { staleMs: 300, killGraceMs: 200 })!.state, "running");
  await sleep(400);
  assert.equal(refreshRecord(home, "stale-1", { staleMs: 300, killGraceMs: 200 })!.state, "stuck");
});

test("runner's own elapsed time past the limit → stuck even with a fresh heartbeat", async () => {
  const home = tmpHome();
  const runner = sleeper();
  record(home, "over-1", {
    pid: runner.pid,
    pidStart: procStartToken(runner.pid),
    heartbeat: { at: new Date().toISOString(), elapsedMs: 10 * 60_000 },
  });
  const w = await wait("over-1", { home, timeoutMs: 5000, pollMs: 50, killGraceMs: 200 });
  assert.equal(w.record.state, "stuck");
  await until(() => !pidAlive(runner.pid!));
  assert.equal(pidAlive(runner.pid!), false);
});

test("a real run records its runner start token and a heartbeat", async () => {
  const home = tmpHome();
  writeJill(home, "quick", "worktree: false\nsteps:\n  a: {run: 'true'}");
  const r = await runNow("quick", { home, cwd: tmp() });
  assert.equal(r.state, "done");
  assert.equal(r.pidStart, procStartToken(process.pid));
  assert.ok(r.heartbeat && r.heartbeat.elapsedMs >= 0);
  assert.ok(r.steps.a!.pid);
});

// ---------------------------------------------------------------- 2. time limits

test("totalLimit: <= 0 falls back to the default, huge values clamp to 2^31-1 ms", () => {
  assert.deepEqual(totalLimit("0", undefined), { label: "2h", ms: 7_200_000 });
  assert.deepEqual(totalLimit(0, "2h"), { label: "2h", ms: 7_200_000 });
  assert.deepEqual(totalLimit("0s", "5m"), { label: "5m", ms: 300_000 });
  assert.deepEqual(totalLimit(undefined, "0"), { label: "2h", ms: 7_200_000 });
  assert.deepEqual(totalLimit("9999999h", undefined), { label: `${MAX_TIMER_MS}ms`, ms: MAX_TIMER_MS });
  assert.deepEqual(totalLimit("90s", "5m"), { label: "90s", ms: 90_000 });
});

test("timeout: 0 runs with the default limit (not instantly stuck) and records it", async () => {
  const home = tmpHome("default_timeout: 10m\n");
  writeJill(home, "zero", "worktree: false\ntimeout: 0\nsteps:\n  a: {run: 'sleep 0.3'}");
  const r = await runNow("zero", { home, cwd: tmp() });
  assert.equal(r.state, "done", r.error);
  assert.equal(r.timeLimit, "10m");
  assert.equal(r.timeLimitMs, 600_000);
});

test("a huge timeout is clamped (no overflow to an instant timer); step timeouts too", async () => {
  const home = tmpHome();
  writeJill(home, "huge", "worktree: false\ntimeout: 9999999h\nsteps:\n  a: {run: 'sleep 0.3', timeout: 9999999h}");
  const r = await runNow("huge", { home, cwd: tmp() });
  assert.equal(r.state, "done", r.error);
  assert.equal(r.timeLimit, `${MAX_TIMER_MS}ms`);
  assert.equal(r.timeLimitMs, MAX_TIMER_MS);
  assert.ok(Date.parse(r.deadline!) - Date.parse(r.started!) >= MAX_TIMER_MS - 5000);
});

// ---------------------------------------------------------------- 5a. worktree: false is warned about

test("jills check warns on worktree: false; jills new scaffolds worktree: true with a comment", async () => {
  const home = tmpHome();
  writeJill(home, "direct", "worktree: false\nsteps:\n  a: {run: 'true'}");
  writeJill(home, "safe", "steps:\n  a: {run: 'true'}");
  const rep = await check({ home });
  assert.deepEqual(rep.errors, []);
  const w = rep.warnings.filter((x) => /worktree: false/.test(x));
  assert.equal(w.length, 1);
  assert.match(w[0]!, /Jill "direct".*no worktree: edits your checkout directly.*strongly recommended/);
  const file = newJill("scaffolded", { home });
  const text = readFileSync(file, "utf8");
  assert.match(text, /^worktree: true {2}# strongly recommended/m);
  assert.equal(parseJill(text, file).worktree, true);
});

test("a worktree: false suggestion says 'no worktree: edits your checkout directly'", async () => {
  const home = tmpHome();
  writeJill(home, "direct", "description: Fix it in place\nkeywords: [inplace]\nworktree: false\nsteps:\n  a: {run: 'true'}");
  const s = await suggest({ home, session: "nw", message: "please do the inplace thing", repo: tmp() });
  assert.equal(s.action, "suggest", s.reason);
  assert.equal(s.worktree, false);
  assert.equal(s.warning, NO_WORKTREE_NOTE);
  assert.match(s.text!, /no worktree: edits your checkout directly/);
  assert.match(s.agentContext!, /no worktree: edits your checkout directly/);
  const home2 = tmpHome();
  writeJill(home2, "iso", "description: In a worktree\nkeywords: [inplace]\nsteps:\n  a: {run: 'true'}");
  const s2 = await suggest({ home: home2, session: "nw", message: "please do the inplace thing", repo: tmp() });
  assert.equal(s2.worktree, true);
  assert.equal(s2.warning, undefined);
  assert.doesNotMatch(s2.text!, /no worktree/);
});

// ---------------------------------------------------------------- 5b. box: needs its isolation extension

test("box: openshell / docker (and docker: true) are refused until the extension is installed", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "shell", "box: openshell\nsteps:\n  a: {run: 'true'}");
  writeJill(home, "dock", "box: docker\nsteps:\n  a: {run: 'true'}");
  writeJill(home, "alias", "docker: true\nsteps:\n  a: {run: 'true'}");
  await assert.rejects(start("shell", { home, cwd: repo }), /box: openshell, but the "openshell" isolation extension is not installed/);
  await assert.rejects(start("dock", { home, cwd: repo }), /"docker" isolation extension is not installed/);
  await assert.rejects(start("alias", { home, cwd: repo }), /docker: true.*"docker" isolation extension is not installed/);
  const rep = await check({ home });
  for (const n of ["shell", "dock", "alias"]) assert.ok(rep.errors.some((e) => e.includes(`Jill "${n}"`) && /isolation extension is not installed/.test(e)), n);
  assert.equal(parseJill("---\nname: a\ndocker: true\nsteps:\n  s: {run: x}\n---\n").box, "docker");
  assert.throws(() => parseJill("---\nname: a\ndocker: true\nbox: openshell\nsteps:\n  s: {run: x}\n---\n"), /conflicts with box: openshell/);
  assert.throws(() => parseJill("---\nname: a\nbox: 12\nsteps:\n  s: {run: x}\n---\n"), /box must be a plug-in name/);
});

test("with a matching isolation plug-in in config plugins:, box: runs through it", async () => {
  const dir = tmp();
  const marker = join(dir, "prepared.txt");
  const file = join(dir, "openshell.js");
  writeFileSync(
    file,
    `import { writeFileSync, mkdirSync } from "node:fs";
export default { slot: "isolation", apiVersion: 1, name: "openshell",
  async prepare({ repo, runId }) { writeFileSync(${JSON.stringify(marker)}, runId); return { dir: repo, isolated: false }; },
  async child(p) { return p; }, async mergeBack() { return { ok: true, conflicts: [], message: "" }; }, async commit() { return undefined; } };`,
  );
  const home = tmpHome(`plugins: [${file}]\n`);
  writeJill(home, "shell", "box: openshell\nsteps:\n  a: {run: 'true'}");
  const rep = await check({ home });
  assert.deepEqual(rep.errors, []);
  const r = await runNow("shell", { home, cwd: tmpRepo() });
  assert.equal(r.state, "done", r.error);
  assert.equal(readFileSync(marker, "utf8"), r.id);
});
