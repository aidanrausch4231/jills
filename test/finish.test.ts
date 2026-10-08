// Regression tests for the finishing round: guarded group kills, heartbeat file.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { runNow } from "../src/api.js";
import { spawnLogged } from "../src/plugins/runner-command.js";
import { taggedPids } from "../src/proc.js";
import { heartbeatPath, listRecords, loadHeartbeat, markTerminal, recordPath } from "../src/runs.js";
import { sleep } from "../src/util.js";
import { pidAlive, tmp, tmpHome, writeJill } from "./helpers.js";

const strays: number[] = [];
after(() => {
  for (const p of strays) if (pidAlive(p)) process.kill(p, "SIGKILL");
});

/** Record every negative-pid (process group) signal while fn runs. */
async function groupSignals(fn: () => Promise<void>): Promise<[number, string | number | undefined][]> {
  const real = process.kill;
  const calls: [number, string | number | undefined][] = [];
  process.kill = ((pid: number, sig?: string | number) => (pid < 0 && calls.push([pid, sig]), real.call(process, pid, sig))) as typeof process.kill;
  try {
    await fn();
  } finally {
    process.kill = real;
  }
  return calls;
}

test("taggedPids with a process group only lists tagged members of that group", async () => {
  const runId = `pg-${process.pid}`;
  const c = spawn("sleep", ["30"], { detached: true, stdio: "ignore", env: { ...process.env, JILLS_RUN_ID: runId } });
  strays.push(c.pid!);
  for (let t = 0; t < 2000 && !taggedPids(runId).length; t += 25) await sleep(25);
  assert.deepEqual(taggedPids(runId, c.pid), [c.pid]);
  assert.deepEqual(taggedPids(runId, c.pid! + 1_000_000), [], "another group id matches nothing");
  assert.deepEqual(taggedPids(`${runId}-other`, c.pid), [], "another run id matches nothing");
  c.kill("SIGKILL");
});

test("after the leader is reaped, the group is never signaled when no member carries the run id; the SIGKILL timer is cleared", async () => {
  const ws = tmp();
  let pid = 0;
  const calls = await groupSignals(async () => {
    const env = { JILLS_RUN_ID: `reap-${process.pid}` };
    const res = await spawnLogged({ cmd: "bash", args: ["-c", "echo $$ > leader.pid; exec sleep 30"], cwd: ws, logPath: join(ws, "a.log"), env, timeoutMs: 300 });
    assert.equal(res.timedOut, true);
    pid = Number(readFileSync(join(ws, "leader.pid"), "utf8"));
    await sleep(2500); // past the 2 s SIGKILL timer
  });
  assert.deepEqual(calls, [[-pid, "SIGTERM"]], "only the SIGTERM sent while the leader was alive");
});

test("a tagged grandchild that ignores SIGTERM is killed once its leader is reaped", async () => {
  const ws = tmp();
  const script = "(trap '' TERM; exec sleep 30) & echo $! > gc.pid; trap 'exit 0' TERM; wait";
  const res = await spawnLogged({ cmd: "bash", args: ["-c", script], cwd: ws, logPath: join(ws, "a.log"), env: { JILLS_RUN_ID: `gc-${process.pid}` }, timeoutMs: 500 });
  assert.equal(res.timedOut, true);
  const gc = Number(readFileSync(join(ws, "gc.pid"), "utf8"));
  strays.push(gc);
  for (let t = 0; t < 2000 && pidAlive(gc); t += 25) await sleep(25);
  assert.equal(pidAlive(gc), false, "grandchild in the run's group was SIGKILLed");
});

test("heartbeats go to their own file and never rewrite the record; an observer's stuck mark wins", async () => {
  const home = tmpHome();
  writeJill(home, "beat2", "worktree: false\nsteps:\n  a: {run: sleep 30}");
  const run = runNow("beat2", { home, cwd: tmp() });
  let id = "";
  for (let t = 0; t < 5000 && listRecords(home)[0]?.steps.a?.state !== "running"; t += 25) await sleep(25);
  id = listRecords(home)[0]!.id;
  const before = readFileSync(recordPath(home, id), "utf8");
  const beat0 = loadHeartbeat(home, id)!;
  for (let t = 0; t < 8000 && loadHeartbeat(home, id)?.mono === beat0.mono; t += 50) await sleep(50);
  assert.notEqual(loadHeartbeat(home, id)!.mono, beat0.mono, "the runner beat");
  assert.equal(readFileSync(recordPath(home, id), "utf8"), before, "a beat never writes the run record");
  assert.ok(heartbeatPath(home, id).startsWith(join(home, "runs", id)));
  const marked = markTerminal(home, listRecords(home)[0]!, "stuck", "marked by observer")!;
  assert.equal(marked.state, "stuck");
  const final = await run; // the next beat reads stuck and halts the runner's steps
  assert.equal(final.state, "stuck");
  assert.equal(final.error, "marked by observer");
  assert.equal(JSON.parse(readFileSync(recordPath(home, id), "utf8")).state, "stuck");
});
