// Regression tests for the lead review fix round 3.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { check, newJill, runNow, start, status, stop, suggest, wait } from "../src/api.js";
import { NO_WORKTREE_NOTE, parseJill } from "../src/jillfile.js";
import { bootId } from "../src/proc.js";
import { heartbeatPath, listRecords, loadHeartbeat, loadRecord, refreshRecord, saveRecord, type Heartbeat, type RunRecord } from "../src/runs.js";
import { MAX_TIMER_MS, sleep, writeJsonAtomic } from "../src/util.js";
import { pidAlive, tmp, tmpHome, tmpRepo, writeJill } from "./helpers.js";
import { JEV_TEST_CONFIG, keywordJev, resetKeywordJev } from "./jev-fixtures.js";

const kids: ChildProcess[] = [];
after(() => {
  resetKeywordJev();
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

function tagged(runId: string): ChildProcess {
  const c = spawn("sleep", ["60"], { detached: true, stdio: "ignore", env: { ...process.env, JILLS_RUN_ID: runId } });
  c.unref();
  kids.push(c);
  return c;
}

async function until(fn: () => boolean, ms = 5000): Promise<void> {
  for (let t = 0; t < ms && !fn(); t += 25) await sleep(25);
}

const mono = (agoMs = 0) => String(process.hrtime.bigint() - BigInt(agoMs) * 1_000_000n);

/** A running record; `heartbeat` goes to the runner's own heartbeat file. */
function record(home: string, id: string, { heartbeat, ...extra }: Partial<RunRecord> & { heartbeat?: Heartbeat }): RunRecord {
  mkdirSync(join(home, "runs"), { recursive: true });
  if (heartbeat) writeJsonAtomic(heartbeatPath(home, id), heartbeat);
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

// ---------------------------------------------------------------- 1. observers never signal; stop is env-scoped

test("observer marks a hung runner stuck without signaling it or its steps", async () => {
  const home = tmpHome();
  const runner = sleeper();
  const step = sleeper();
  record(home, "hung-obs", {
    pid: runner.pid,
    heartbeat: { at: new Date().toISOString(), mono: mono(60_000), since: mono(120_000), bootId: bootId() },
    steps: { a: { key: "a", step: "a", jill: "x", kind: "run", state: "running" } },
  });
  const r = (await status("hung-obs", { home }))!;
  assert.equal(r.state, "stuck");
  assert.match(r.error!, /stopped beating.*jills stop hung-obs/);
  assert.equal(r.steps.a!.state, "stuck");
  await sleep(300);
  assert.equal(pidAlive(runner.pid!), true, "observer never signals the runner");
  assert.equal(pidAlive(step.pid!), true, "observer never signals a step");
});

test("a runner whose pid is gone is stuck at once (one-shot status, no deadline needed)", async () => {
  const home = tmpHome();
  record(home, "gone-1", { pid: 999_999_99, deadline: new Date(Date.now() + 3_600_000).toISOString() });
  const r = (await status("gone-1", { home }))!;
  assert.equal(r.state, "stuck");
  assert.match(r.error!, /runner process is gone/);
});

test("a record from another boot is stuck, and stop signals nothing for it", async () => {
  const home = tmpHome();
  const t = tagged("boot-1");
  record(home, "boot-1", { pid: t.pid, heartbeat: { at: new Date().toISOString(), mono: mono(), since: mono(), bootId: "not-this-boot" } });
  assert.equal((await status("boot-1", { home }))!.state, "stuck");
  const s = await stop("boot-1", { home, graceMs: 200 });
  assert.deepEqual(s.pids, []);
  assert.equal(pidAlive(t.pid!), true);
});

test("stop kills only processes tagged JILLS_RUN_ID=<run>; an untagged sibling and another run survive", async () => {
  const home = tmpHome();
  const mine = [tagged("stop-1"), tagged("stop-1")];
  const sibling = sleeper();
  const other = tagged("stop-2");
  await until(() => mine.every((k) => readFileSync(`/proc/${k.pid}/environ`, "utf8").includes("JILLS_RUN_ID=stop-1")));
  record(home, "stop-1", { pid: mine[0]!.pid, heartbeat: { at: new Date().toISOString(), mono: mono(), since: mono(), bootId: bootId() } });
  const s = await stop("stop-1", { home, graceMs: 2000 });
  assert.deepEqual([...s.pids].sort(), mine.map((k) => k.pid).sort());
  await until(() => mine.every((k) => !pidAlive(k.pid!)));
  for (const k of mine) assert.equal(pidAlive(k.pid!), false, "tagged process stopped");
  assert.equal(pidAlive(sibling.pid!), true, "untagged sibling untouched");
  assert.equal(pidAlive(other.pid!), true, "another run's process untouched");
  assert.equal(s.record.state, "failed");
  assert.match(s.record.error!, /stopped by jills stop/);
});

test("wall clock past the deadline (suspend/clock jump) with a live, beating runner is not stuck", async () => {
  const home = tmpHome();
  const runner = sleeper();
  record(home, "jump-1", { pid: runner.pid, heartbeat: { at: new Date().toISOString(), mono: mono(), since: mono(5_000), bootId: bootId() } });
  const w = await wait("jump-1", { home, timeoutMs: 500, pollMs: 50 });
  assert.equal(w.timedOut, true);
  assert.equal(w.record.state, "running");
});

test("runner's own monotonic time past the limit → stuck even with a fresh stamp", () => {
  const home = tmpHome();
  const runner = sleeper();
  record(home, "over-1", { pid: runner.pid, heartbeat: { at: new Date().toISOString(), mono: mono(), since: mono(10 * 60_000), bootId: bootId() } });
  assert.equal(refreshRecord(home, "over-1")!.state, "stuck");
  assert.equal(pidAlive(runner.pid!), true);
});

test("the runner's next beat never overwrites stuck on disk; the runner stops its own steps", async () => {
  const home = tmpHome();
  writeJill(home, "beat", "worktree: false\nsteps:\n  a: {run: sleep 30}");
  const run = runNow("beat", { home, cwd: tmp() });
  let id = "";
  await until(() => {
    const r = listRecords(home)[0];
    id = r?.id ?? "";
    return r?.steps.a?.state === "running";
  });
  const r = loadRecord(home, id)!;
  saveRecord(home, { ...r, state: "stuck", error: "marked by test", finished: new Date().toISOString() });
  const t0 = Date.now();
  const final = await run; // the runner's 5 s beat sees stuck on disk and halts its steps
  assert.ok(Date.now() - t0 < 15_000);
  assert.equal(final.state, "stuck");
  assert.equal(loadRecord(home, id)!.state, "stuck");
  assert.equal(loadRecord(home, id)!.error, "marked by test");
});

test("a real run records its runner pid and a monotonic heartbeat with the boot id", async () => {
  const home = tmpHome();
  writeJill(home, "quick", "worktree: false\nsteps:\n  a: {run: 'true'}");
  const r = await runNow("quick", { home, cwd: tmp() });
  assert.equal(r.state, "done");
  assert.equal(r.pid, process.pid);
  const hb = loadHeartbeat(home, r.id)!;
  assert.ok(BigInt(hb.mono) >= BigInt(hb.since));
  assert.equal(hb.bootId, bootId());
  assert.equal("heartbeat" in r, false, "the heartbeat lives in its own file, not the record");
});

// ---------------------------------------------------------------- 2. time limits

test("total limit: <= 0 falls back to the default, huge values clamp to 2^31-1 ms", async () => {
  const cases: [string, string, string, number][] = [
    ["", "0", "2h", 7_200_000],
    ["0s", "5m", "5m", 300_000],
    ["9999999h", "", `${MAX_TIMER_MS}ms`, MAX_TIMER_MS],
    ["90s", "5m", "90s", 90_000],
  ];
  for (const [jt, dt, label, ms] of cases) {
    const home = tmpHome(dt ? `default_timeout: "${dt}"\n` : "");
    writeJill(home, "lim", `worktree: false\n${jt ? `timeout: "${jt}"\n` : ""}steps:\n  a: {run: 'true'}`);
    const r = await runNow("lim", { home, cwd: tmp() });
    assert.deepEqual([r.state, r.timeLimit, r.timeLimitMs], ["done", label, ms], `${jt}/${dt}`);
  }
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
  const home = tmpHome(JEV_TEST_CONFIG);
  keywordJev({ direct: ["inplace"] });
  writeJill(home, "direct", "description: Fix it in place\nworktree: false\nsteps:\n  a: {run: 'true'}");
  const s = await suggest({ home, session: "nw", message: "please do the inplace thing", repo: tmp() });
  assert.equal(s.action, "suggest", s.reason);
  assert.equal(s.worktree, false);
  assert.equal(s.warning, NO_WORKTREE_NOTE);
  assert.match(s.text!, /no worktree: edits your checkout directly/);
  assert.match(s.agentContext!, /no worktree: edits your checkout directly/);
  const home2 = tmpHome(JEV_TEST_CONFIG);
  keywordJev({ iso: ["inplace"] });
  writeJill(home2, "iso", "description: In a worktree\nsteps:\n  a: {run: 'true'}");
  const s2 = await suggest({ home: home2, session: "nw", message: "please do the inplace thing", repo: tmp() });
  assert.equal(s2.worktree, true);
  assert.equal(s2.warning, undefined);
  assert.doesNotMatch(s2.text!, /no worktree/);
});

// ---------------------------------------------------------------- 5b. box: needs its isolation extension

test("box: openshell / docker are refused until the extension is installed; docker: is not a field", async () => {
  const home = tmpHome();
  const repo = tmpRepo();
  writeJill(home, "shell", "box: openshell\nsteps:\n  a: {run: 'true'}");
  writeJill(home, "dock", "box: docker\nsteps:\n  a: {run: 'true'}");
  await assert.rejects(start("shell", { home, cwd: repo }), /box: openshell, but the "openshell" isolation extension is not installed/);
  await assert.rejects(start("dock", { home, cwd: repo }), /"docker" isolation extension is not installed/);
  const rep = await check({ home });
  for (const n of ["shell", "dock"]) assert.ok(rep.errors.some((e) => e.includes(`Jill "${n}"`) && /isolation extension is not installed/.test(e)), n);
  assert.throws(() => parseJill("---\nname: a\ndocker: true\nsteps:\n  s: {run: x}\n---\n"), /docker: is not a Jill field; use box: docker/);
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
