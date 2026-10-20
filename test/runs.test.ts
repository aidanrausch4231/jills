import assert from "node:assert/strict";
import { cpSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { start, status, wait } from "../src/api.js";
import { loadRecord, recordPath, refreshRecord, saveRecord, type RunRecord } from "../src/runs.js";
import { writeJsonAtomic } from "../src/util.js";
import { git, tmp, tmpHome, tmpRepo, writeJill } from "./helpers.js";

const here = new URL("../../", import.meta.url).pathname;

test("atomic JSON writes: readers never see a partial file, no temp files left", async () => {
  const dir = tmp();
  const file = join(dir, "r.json");
  const big = (n: number) => ({ n, pad: "x".repeat(200_000 + n) });
  writeJsonAtomic(file, big(0));
  let bad = 0;
  for (let i = 1; i <= 60; i++) {
    writeJsonAtomic(file, big(i));
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { n: number };
    if (parsed.n !== i) bad++;
  }
  assert.equal(bad, 0);
  // concurrent writers from child processes + a reader loop
  const { spawn } = await import("node:child_process");
  const util = new URL("../src/util.js", import.meta.url).href;
  const kids = [1, 2, 3].map((k) =>
    spawn(process.execPath, ["--input-type=module", "-e", `import {writeJsonAtomic} from ${JSON.stringify(util)}; for (let i=0;i<40;i++) writeJsonAtomic(${JSON.stringify(file)}, {k:${k}, i, pad: "y".repeat(300000)});`], { stdio: "ignore" }),
  );
  let done = 0;
  kids.forEach((k) => k.on("exit", () => done++));
  let reads = 0;
  while (done < kids.length) {
    JSON.parse(readFileSync(file, "utf8")); // throws on a torn read
    reads++;
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(reads > 0);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("a running record whose runner died becomes stuck (observers never signal)", () => {
  const home = tmpHome();
  const r: RunRecord = { version: 1, id: "dead-1", jill: "x", jillPath: "p", inputs: {}, state: "running", created: new Date().toISOString(), repo: "/", pid: 999_999_99, logDir: "/tmp", steps: {}, events: [] };
  saveRecord(home, r);
  const after = refreshRecord(home, "dead-1")!;
  assert.equal(after.state, "stuck");
  assert.match(after.error!, /runner process is gone; run `jills stop dead-1`/);
  assert.equal(loadRecord(home, "dead-1")!.state, "stuck");
  assert.equal(loadRecord(home, "../etc/passwd"), undefined);
});

test("start spawns a detached runner; wait and status report the result", async () => {
  const home = tmpHome();
  cpSync(join(here, "examples", "hello"), join(home, "jills", "hello"), { recursive: true });
  const repo = tmpRepo();
  const rec = await start("hello", { home, cwd: repo, inputs: { who: "tests" }, session: "sess-w" });
  assert.equal(rec.state, "queued");
  assert.ok(readFileSync(recordPath(home, rec.id), "utf8").includes(rec.id));
  const w = await wait(rec.id, { home, timeoutMs: 30_000 });
  assert.equal(w.timedOut, false);
  assert.equal(w.record.state, "done", w.record.error);
  assert.match(w.line, new RegExp(`^jills run ${rec.id} done: hello \\| branch jills/hello-${rec.id}`));
  assert.equal(git(repo, "show", `jills/hello-${rec.id}:hello.txt`).split("\n")[0], "hello tests");
  const one = (await status(rec.id, { home }))!;
  assert.equal(one.state, "done");
  assert.ok((await status(undefined, { home })).some((r) => r.id === rec.id));
  assert.ok(Object.keys(one.steps).includes("count#2"));
});

test("wait times out on a still-running run", async () => {
  const home = tmpHome();
  writeJill(home, "sleepy", "worktree: false\nsteps:\n  a: {run: sleep 5}");
  const rec = await start("sleepy", { home, cwd: tmp() });
  const w = await wait(rec.id, { home, timeoutMs: 400, pollMs: 50 });
  assert.equal(w.timedOut, true);
  assert.match(w.line, /still (queued|running)/);
  // let it finish so no stray process outlives the test
  const fin = await wait(rec.id, { home, timeoutMs: 20_000 });
  assert.equal(fin.record.state, "done");
});

test("wait on an unknown run rejects", async () => {
  const home = tmpHome();
  mkdirSync(join(home, "runs"), { recursive: true });
  writeFileSync(join(home, "runs", "junk.json"), "{not json");
  await assert.rejects(wait("nope", { home }), /no run nope/);
  assert.deepEqual(await status(undefined, { home }), []);
});
