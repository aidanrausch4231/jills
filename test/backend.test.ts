import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { check, executeRun, runNow, status, stop, suggest, wait, chat } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import json from "../src/plugins/backend-json.js";
import { loadPlugins, validatePlugin } from "../src/plugins/index.js";
import { heartbeatPath, recordPath, runLogDir, type RunRecord } from "../src/runs.js";
import { writeJsonAtomic } from "../src/util.js";
import { tmp, tmpHome, writeJill } from "./helpers.js";

function record(home: string, id: string, state: RunRecord["state"] = "queued"): RunRecord {
  return { version: 1, id, jill: "hello", jillPath: join(home, "jills/hello/JILL.md"), inputs: {}, state, created: new Date().toISOString(), repo: tmp(), logDir: runLogDir(home, id), steps: {}, events: [] };
}

async function memoryHome() {
  const home = tmpHome("backend: memory\nplugins: [./memory.mjs]\n");
  writeFileSync(join(home, "memory.mjs"), `
    export const records = new Map(), beats = new Map(), calls = [];
    const key = (home, id) => home + '/' + id;
    export default {
      slot: 'backend', apiVersion: 1, name: 'memory',
      save(home, r) { calls.push('save'); records.set(key(home, r.id), structuredClone(r)); },
      load(home, id) { calls.push('load'); return structuredClone(records.get(key(home, id))); },
      list(home) { calls.push('list'); return [...records.entries()].filter(([k]) => k.startsWith(home + '/')).map(([, r]) => structuredClone(r)).sort((a, b) => b.created.localeCompare(a.created)); },
      beat(home, id, hb) { calls.push('beat'); beats.set(key(home, id), structuredClone(hb)); },
      loadBeat(home, id) { calls.push('loadBeat'); return structuredClone(beats.get(key(home, id))); },
      sweep(home, config) { if (home !== config.home) throw Error('wrong sweep home'); calls.push('sweep'); return []; },
      check(config) { return { errors: [], warnings: ['memory backend check: ' + config.home] }; }
    };
  `);
  writeJill(home, "hello", "worktree: false\nsteps:\n  hi: {run: echo hi}");
  const mod = await import(pathToFileURL(join(home, "memory.mjs")).href);
  return { home, mod, config: loadConfig(home) };
}

test("json is the default backend and reads legacy records and heartbeat files unchanged", async () => {
  const home = tmpHome();
  const set = await loadPlugins(loadConfig(home));
  assert.equal(set.backend, json);
  assert.equal(set.backends.get("json"), json);
  const old = record(home, "old");
  old.created = "2025-01-01T00:00:00Z";
  const hb = { at: old.created, mono: "1", since: "1" };
  writeJsonAtomic(recordPath(home, old.id), old);
  writeJsonAtomic(heartbeatPath(home, old.id), hb);
  assert.deepEqual(set.backend.load(home, old.id), old);
  assert.deepEqual(set.backend.loadBeat(home, old.id), hb);
  const recent = record(home, "recent");
  json.save(home, recent);
  json.beat(home, recent.id, hb);
  assert.deepEqual(json.list(home).map((r) => r.id), ["recent", "old"]);
  assert.deepEqual(json.loadBeat(home, recent.id), hb);
  assert.equal(json.load(home, "../outside"), undefined);
  assert.equal(json.loadBeat(home, "../outside"), undefined);
  assert.throws(() => json.save(home, { ...old, id: "../outside" }), /bad run id/);
  assert.throws(() => json.beat(home, "..", hb), /bad run id/);
});

test("backend selection validates required and optional methods and sweeps once per load", async () => {
  const { home, config, mod } = await memoryHome();
  const set = await loadPlugins(config);
  assert.equal(set.backend.name, "memory");
  assert.equal(set.backend, set.backends.get("memory"));
  assert.deepEqual(mod.calls, ["sweep"]);
  set.backend.list(home);
  assert.equal(mod.calls.filter((s: string) => s === "sweep").length, 1);
  for (const fn of ["save", "load", "list", "beat", "loadBeat"]) {
    assert.throws(() => validatePlugin({ ...mod.default, [fn]: undefined }, "test"), new RegExp(`missing ${fn}`));
  }
  assert.throws(() => validatePlugin({ ...mod.default, sweep: true }, "test"), /sweep must be a function/);
  assert.throws(() => validatePlugin({ ...mod.default, check: true }, "test"), /check must be a function/);
  const checked = await check({ home });
  assert.deepEqual(checked.errors, []);
  assert.ok(checked.warnings.includes(`memory backend check: ${home}`));
  const findings = mod.default.check;
  mod.default.check = () => ({ errors: ["backend unavailable"], warnings: [] });
  assert.ok((await check({ home })).errors.includes("backend unavailable"));
  mod.default.check = findings;
});

test("a failing backend sweep warns but check still reaches backend diagnostics", async () => {
  const { home, config, mod } = await memoryHome();
  mod.default.sweep = () => { throw new Error("sweep unavailable"); };
  mod.default.check = () => ({ errors: ["backend check reached"], warnings: [] });
  const plugins = await loadPlugins(config);
  assert.match(plugins.warnings.join("\n"), /memory sweep failed: sweep unavailable/);
  const result = await check({ home });
  assert.ok(result.errors.includes("backend check reached"));
  assert.match(result.warnings.join("\n"), /sweep unavailable/);
});

test("status/wait/stop tolerate a broken unrelated plug-in for JSON and custom storage", async () => {
  for (const custom of [false, true]) {
    const home = custom ? (await memoryHome()).home : tmpHome();
    const { backend } = await loadPlugins(loadConfig(home));
    const r = record(home, "escape-hatch");
    backend.save(home, r);
    writeFileSync(join(home, "broken.mjs"), "export default { syntax: ; }");
    writeFileSync(join(home, "config.yml"), `backend: ${custom ? "memory" : "json"}\nplugins: [./broken.mjs${custom ? ", ./memory.mjs" : ""}]\nexecutor: not-installed\njill_paths: [./not-needed]\n`);
    assert.equal((await status(r.id, { home }))?.state, "queued");
    assert.equal((await status(undefined, { home }))[0]?.id, r.id);
    assert.equal((await wait(r.id, { home, timeoutMs: 0 })).timedOut, true);
    assert.equal((await stop(r.id, { home })).record.state, "failed");
  }
});

test("an unknown backend fails loading, check, and cold status instead of using JSON", async () => {
  const home = tmpHome("backend: missing\n");
  await assert.rejects(loadPlugins(loadConfig(home)), /no backend plug-in "missing"/);
  assert.deepEqual((await check({ home })).errors, ['no backend plug-in "missing"']);
  await assert.rejects(status(undefined, { home }), /no backend plug-in "missing"/);
  await assert.rejects(runNow("hello", { home }), /no backend plug-in "missing"/);
});

test("a real run stores records and heartbeats in memory, with file logs only", async () => {
  const { home, mod } = await memoryHome();
  const r = await runNow("hello", { home, cwd: tmp() });
  assert.equal(r.state, "done", r.error);
  assert.equal(r.steps.hi?.state, "done");
  assert.equal(readFileSync(r.steps.hi!.log!, "utf8").trim(), "hi");
  assert.equal(existsSync(recordPath(home, r.id)), false);
  assert.equal(existsSync(heartbeatPath(home, r.id)), false);
  assert.deepEqual(await status(r.id, { home }), r);
  assert.deepEqual((await status(undefined, { home })).map((r) => r.id), [r.id]);
  assert.equal((await wait(r.id, { home })).record.state, "done");
  for (const method of ["save", "load", "list", "beat"]) assert.ok(mod.calls.includes(method), method);
  assert.equal(mod.beats.size, 1);
});

test("queued execution, observer terminal marks, stop, and anti-nag use the selected backend", async () => {
  const { home, mod, config } = await memoryHome();
  const { backend } = await loadPlugins(config);
  const queued = record(home, "queued");
  backend.save(home, queued);
  assert.equal((await executeRun(queued.id, { home })).state, "done");

  const pending = record(home, "pending");
  backend.save(home, pending);
  assert.equal((await wait(pending.id, { home, timeoutMs: 0 })).timedOut, true);
  await chat("chat", { kind: "started", run: pending.id }, { home });
  assert.match((await suggest({ home, session: "chat", message: "another task" })).reason, /a Jill is running/);
  pending.created = "2000-01-01T00:00:00Z";
  backend.save(home, pending);
  assert.equal((await status(pending.id, { home }))?.state, "failed");
  assert.equal(backend.load(home, pending.id)?.error, "runner never started");

  const dead = record(home, "dead", "running");
  dead.pid = 999_999_99;
  dead.steps.hi = { key: "hi", step: "hi", jill: "hello", kind: "run", state: "running" };
  backend.save(home, dead);
  assert.equal((await status(dead.id, { home }))?.state, "stuck");
  assert.equal(backend.load(home, dead.id)?.steps.hi?.state, "stuck");

  const stopped = record(home, "stop");
  backend.save(home, stopped);
  backend.beat(home, stopped.id, { at: stopped.created, mono: "1", since: "1", bootId: "another-boot" });
  assert.equal((await stop(stopped.id, { home })).record.state, "failed");
  assert.equal(backend.load(home, stopped.id)?.error, "stopped by jills stop");
  assert.ok(mod.calls.includes("loadBeat"));
  assert.equal(json.list(home).length, 0);
});

test("the engine preserves a terminal mark written through a non-JSON backend", async () => {
  const { home, config } = await memoryHome();
  const { backend } = await loadPlugins(config);
  const r = await runNow("hello", { home, cwd: tmp(), onEvent(e, r) {
    if (e.type === "step-started") backend.save(home, { ...r, state: "stuck", error: "observer mark" });
  } });
  assert.equal(r.state, "stuck");
  assert.equal(r.error, "observer mark");
  assert.equal(backend.load(home, r.id)?.state, "stuck");
});
