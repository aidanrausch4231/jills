import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { check, executeRun, start, status, stop, wait } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import json from "../src/plugins/backend-json.js";
import { loadPlugins, validatePlugin } from "../src/plugins/index.js";
import { runLogDir, type RunRecord } from "../src/runs.js";
import { sleep } from "../src/util.js";
import { tmp, tmpHome, tmpRepo, writeJill } from "./helpers.js";

const cli = new URL("../src/cli.js", import.meta.url).pathname;
function queued(home: string, id = "resume", repo = tmp()): RunRecord {
  const logDir = runLogDir(home, id);
  mkdirSync(logDir, { recursive: true });
  return { version: 1, id, jill: "flow", jillPath: join(home, "jills/flow/JILL.md"), inputs: {}, state: "queued", created: new Date().toISOString(), repo, logDir, steps: {}, events: [] };
}
function completed(r: RunRecord, key: string, text = "saved output") {
  const log = join(r.logDir, key.replaceAll("/", "_") + ".log");
  writeFileSync(log, text + "\n");
  r.steps[key] = { key, step: key, jill: "flow", kind: "run", state: "done", log };
}
async function until(fn: () => boolean, ms = 12_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    assert.ok(Date.now() < end, "condition timed out");
    await sleep(30);
  }
}

for (const state of ["queued", "running", "stuck", "failed"] as const) {
  test(`engine resumes ${state}, keeps completed outputs and restarts other states`, async () => {
    const home = tmpHome("executor: deliberately-ignored\n");
    writeJill(home, "flow", `worktree: false
steps:
  first: {run: 'echo must-not-run > unwanted'}
  second: {run: 'printf "%s" {{steps.first.output}} > second; echo {{round}}', needs: [first]}
  third: {run: 'printf "%s" {{steps.second.output}} > third', needs: [second]}`);
    const r = queued(home);
    r.state = state;
    if (state !== "queued") r.pid = 99_999_999;
    r.error = "old failure";
    r.workspace = r.repo;
    completed(r, "first", "safe $(touch injected); 'quoted'");
    const partialLog = join(r.logDir, "second.log");
    writeFileSync(partialLog, "stale-partial\n");
    r.steps.second = { key: "second", step: "second", jill: "flow", kind: "run", state: "running", log: partialLog };
    r.steps.third = { key: "third", step: "third", jill: "flow", kind: "run", state: "skipped" };
    json.save(home, r);
    const after = await executeRun(r.id, { home, engine: true });
    assert.equal(after.state, "done", after.error);
    assert.equal(after.id, r.id);
    assert.equal(after.workspace, r.workspace);
    assert.deepEqual(after.steps.first, r.steps.first);
    assert.equal(existsSync(join(r.repo, "unwanted")), false);
    assert.equal(existsSync(join(r.repo, "injected")), false);
    assert.equal(readFileSync(join(r.repo, "second"), "utf8"), "safe $(touch injected); 'quoted'");
    assert.equal(readFileSync(after.steps.second!.log!, "utf8").trim(), "1");
    assert.equal(readFileSync(join(r.repo, "third"), "utf8"), "1");
    assert.equal(readFileSync(after.steps.first!.log!, "utf8"), "safe $(touch injected); 'quoted'\n");
    assert.ok(after.events.some((e) => e.type === "started" && e.note === "resumed (1 steps already done)"));
    assert.deepEqual(after.events.filter((e) => e.type === "step-started").map((e) => e.step), ["second", "third"]);
  });
}

test("engine CLI refuses live engines (including hung ones) and done runs", () => {
  const home = tmpHome();
  writeJill(home, "flow", "worktree: false\nsteps:\n  first: {run: echo no}");
  for (const state of ["running", "stuck", "failed", "done"] as const) {
    const r = queued(home, state);
    Object.assign(r, { state, pid: process.pid, deadline: "2000-01-01T00:00:00Z" });
    json.save(home, r);
    const result = spawnSync(process.execPath, [cli, "engine", r.id], { env: { ...process.env, JILLS_HOME: home }, encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, state === "done" ? /cannot resume.*done/ : /runner is still alive/);
    assert.deepEqual(json.load(home, r.id), r);
  }
});

test("resume reuses the worktree and branch, and clearly fails if the workspace disappeared", async () => {
  const home = tmpHome();
  writeJill(home, "flow", "steps:\n  first: {run: echo first}\n  second: {run: echo second, needs: [first]}");
  const r = queued(home, "worktree", tmpRepo());
  const plugins = await loadPlugins(loadConfig(home));
  const ws = await plugins.isolation.get("worktree")!.prepare({ repo: r.repo, jill: r.jill, runId: r.id, config: loadConfig(home) });
  Object.assign(r, { workspace: ws.dir, branch: ws.branch, base: ws.base, isolated: true, state: "failed", pid: 99_999_999 });
  completed(r, "first");
  json.save(home, r);
  const after = await executeRun(r.id, { home, engine: true });
  assert.equal(after.state, "done", after.error);
  assert.equal(after.branch, ws.branch);
  assert.equal(after.workspace, ws.dir);
  const missing = { ...r, id: "missing", workspace: join(home, "gone") };
  json.save(home, missing);
  const failed = await executeRun(missing.id, { home, engine: true });
  assert.equal(failed.state, "failed");
  assert.match(failed.error!, /recorded workspace .* is gone/);
});

test("resume handles copies and nested completed outputs", async () => {
  const home = tmpHome();
  writeJill(home, "child", "worktree: false\nsteps:\n  inner: {run: echo never}\n  rest: {run: 'echo {{steps.inner.output}}', needs: [inner]}");
  writeJill(home, "flow", `worktree: false
steps:
  copies: {run: 'echo copy{{copy}}', copies: 2}
  nested: {jill: child, needs: [copies]}
  after: {run: 'echo {{steps.copies.output}}; echo {{steps.nested.output}}', needs: [nested]}`);
  const r = queued(home);
  completed(r, "copies#1", "copy1saved");
  completed(r, "nested/inner", "nested saved");
  r.steps.nested = { key: "nested", step: "nested", jill: "flow", kind: "jill", state: "failed" };
  json.save(home, r);
  const after = await executeRun(r.id, { home, engine: true });
  assert.equal(after.state, "done", after.error);
  assert.equal(after.events.some((e) => e.step === "copies#1" || e.step === "nested/inner"), false);
  assert.match(readFileSync(after.steps.after!.log!, "utf8"), /copy1saved\n\n---\n\ncopy2\nnested saved/);
});

test("resumed back-arrows rerun completed ancestors and unfinished steps begin at round 1", async () => {
  const home = tmpHome();
  writeJill(home, "flow", `worktree: false
steps:
  build: {run: 'echo build{{round}}'}
  review:
    run: 'echo review{{round}}; test {{round}} = 2'
    needs: [build]
    on_fail: {back_to: build, max_rounds: 3}`);
  const r = queued(home);
  completed(r, "build", "old build");
  r.steps["review@3"] = { key: "review@3", step: "review", jill: "flow", kind: "run", state: "failed" };
  json.save(home, r);
  const after = await executeRun(r.id, { home, engine: true });
  assert.equal(after.state, "done", after.error);
  assert.equal(readFileSync(after.steps.review!.log!, "utf8").trim(), "review1");
  assert.equal(readFileSync(after.steps["build@2"]!.log!, "utf8").trim(), "build2");
  assert.equal(after.steps["review@2"]?.state, "done");
});

test("executor selection validates execute/check and reports missing names at check/start", async () => {
  const home = tmpHome("executor: absent\n");
  assert.equal((await check({ home })).errors[0], 'no executor plug-in "absent"');
  await assert.rejects(start("flow", { home }), /no executor plug-in "absent"/);
  assert.throws(() => validatePlugin({ slot: "executor", apiVersion: 1, name: "x" }, "x"), /missing execute/);
  assert.throws(() => validatePlugin({ slot: "executor", apiVersion: 1, name: "x", execute() {}, check: true }, "x"), /check must be a function/);
});

function executorHome(body: string) {
  const home = tmpHome("executor: test\nplugins: [./executor.mjs]\n");
  writeFileSync(join(home, "executor.mjs"), `
    import { spawn } from 'node:child_process';
    import { writeFileSync, readFileSync } from 'node:fs';
    import { join } from 'node:path';
    export default {
      slot: 'executor', apiVersion: 1, name: 'test',
      check() { return { errors: [], warnings: ['test executor selected'] }; },
      async execute(run, ctx) { ${body} }
    };
  `);
  return home;
}

test("a fake executor spawns the engine CLI and drives a real detached run to done", async (t) => {
  const home = executorHome(`
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [ctx.cli, 'engine', run.id], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(Error('engine exit ' + code)));
    });
  `);
  writeJill(home, "flow", "worktree: false\nsteps:\n  first: {run: echo executor}");
  assert.ok((await check({ home })).warnings.includes("test executor selected"));
  const r = await start("flow", { home, cwd: tmp() });
  t.after(() => stop(r.id, { home, graceMs: 100 }));
  const after = await wait(r.id, { home, timeoutMs: 12_000, pollMs: 30 });
  assert.equal(after.record.state, "done", after.line);
  assert.equal(readFileSync(after.record.steps.first!.log!, "utf8").trim(), "executor");
  assert.notEqual(after.record.pid, after.record.executorPid);
});

test("executor retries a killed engine with the same id and without repeating done steps", async (t) => {
  const home = executorHome(`
    for (let attempt = 0; attempt < 2; attempt++) {
      const child = spawn(process.execPath, [ctx.cli, 'engine', run.id], { stdio: 'inherit' });
      const killer = attempt === 0 && setInterval(() => {
        try { readFileSync(join(run.repo, 'second.pid')); child.kill('SIGKILL'); clearInterval(killer); } catch {}
      }, 20);
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
      if (killer) clearInterval(killer);
      if (code === 0) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw Error('engine did not recover');
  `);
  const repo = tmp();
  writeJill(home, "flow", `worktree: false
steps:
  first: {run: 'echo first >> first-count; echo first-output'}
  second: {run: 'if test ! -f second.pid; then echo stale-partial; echo $$ > second.pid; sleep 10; fi; echo fresh; echo {{steps.first.output}} > second; echo second >> second-count', needs: [first]}
  third: {run: 'printf "%s" {{steps.second.output}} > third', needs: [second]}`);
  const r = await start("flow", { home, cwd: repo });
  t.after(() => stop(r.id, { home, graceMs: 100 }));
  const after = await wait(r.id, { home, timeoutMs: 15_000, pollMs: 30 });
  assert.equal(after.record.state, "done", after.line);
  assert.equal(after.record.id, r.id);
  assert.equal(readFileSync(join(repo, "first-count"), "utf8"), "first\n");
  assert.equal(readFileSync(join(repo, "second-count"), "utf8"), "second\n");
  assert.equal(readFileSync(join(repo, "second"), "utf8"), "first-output\n");
  assert.equal(readFileSync(after.record.steps.second!.log!, "utf8"), "fresh\n");
  assert.equal(readFileSync(join(repo, "third"), "utf8"), "fresh");
  assert.equal(readFileSync(after.record.steps.first!.log!, "utf8"), "first-output\n");
  assert.ok(after.record.events.some((e) => e.note === "resumed (1 steps already done)"));
});

test("executor heartbeats span dispatch delays and stop aborts its signal", async (t) => {
  const home = executorHome(`
    await new Promise(resolve => ctx.signal.addEventListener('abort', () => {
      writeFileSync(join(ctx.config.home, 'aborted'), 'yes'); resolve();
    }, { once: true }));
  `);
  writeJill(home, "flow", "worktree: false\nsteps:\n  first: {run: echo never}");
  const r = await start("flow", { home, cwd: tmp() });
  t.after(() => stop(r.id, { home, graceMs: 100 }));
  await until(() => !!json.loadBeat(home, r.id));
  const first = json.loadBeat(home, r.id)!;
  await until(() => json.loadBeat(home, r.id)?.mono !== first.mono);
  const delayed = json.load(home, r.id)!;
  delayed.created = "2000-01-01T00:00:00Z";
  json.save(home, delayed);
  assert.equal((await status(r.id, { home }))?.state, "queued", "active executor protects queued dispatch from expiry");
  await stop(r.id, { home, graceMs: 1500 });
  assert.equal(readFileSync(join(home, "aborted"), "utf8"), "yes");
  assert.equal(json.load(home, r.id)?.state, "failed");
});
