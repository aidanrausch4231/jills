import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { check, dryRun } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import { buildAgentCommand, resolveModel, scanAgents } from "../src/plugins/runner-agent.js";
import { tmp, tmpHome, writeAgent, writeJill } from "./helpers.js";

test("agent lookup searches agent_paths in order; first match wins", () => {
  const a = tmp();
  const b = tmp();
  writeAgent(a, "rev.md", "name: reviewer\ndescription: first\ntools: read, grep\ntier: cheap");
  writeAgent(b, "reviewer.md", "name: reviewer\ndescription: second\nmodel: big");
  writeAgent(b, "only-b.md", "name: only-b\ndescription: b");
  const scan = scanAgents([a, b]);
  assert.equal(scan.items.get("reviewer")!.description, "first");
  assert.deepEqual(scan.items.get("reviewer")!.tools, ["read", "grep"]);
  assert.equal(scan.items.get("only-b")!.description, "b");
  assert.deepEqual(scan.duplicates.get("reviewer"), [join(a, "rev.md"), join(b, "reviewer.md")]);
  assert.equal(scanAgents([b, a]).items.get("reviewer")!.description, "second");
  assert.equal(scanAgents([a, b]).items.get("nope"), undefined);
});

test("jills check warns on duplicate agent and Jill names", async () => {
  const extra = tmp();
  const extraJills = tmp();
  const home = tmpHome();
  // rewrite config with two agent paths and two jill paths
  const { writeFileSync, mkdirSync, cpSync } = await import("node:fs");
  writeFileSync(join(home, "config.yml"), `agent_paths: [${join(home, "agents")}, ${extra}]\njill_paths: [${join(home, "jills")}, ${extraJills}]\n`);
  writeAgent(join(home, "agents"), "x.md", "name: dup\ndescription: one");
  writeAgent(extra, "y.md", "name: dup\ndescription: two");
  writeJill(home, "same", "steps:\n  a: {agent: dup}");
  mkdirSync(join(extraJills, "same"), { recursive: true });
  cpSync(join(home, "jills", "same", "JILL.md"), join(extraJills, "same", "JILL.md"));
  writeJill(home, "bad-agent", "steps:\n  a: {agent: ghost}");
  const r = await check({ home });
  assert.ok(r.warnings.some((w) => /agent "dup" found more than once; using .*x\.md/.test(w)), r.warnings.join("\n"));
  assert.ok(r.warnings.some((w) => /Jill "same" found more than once/.test(w)));
  assert.ok(r.errors.some((e) => /unknown agent "ghost"/.test(e)));
});

test("model resolution: step > agent > tier > default", () => {
  const ag = { name: "a", description: "", instructions: "", path: "p", tier: "cheap" } as const;
  assert.equal(resolveModel("s", { ...ag, model: "m" }, { cheap: "t" }, "d"), "s");
  assert.equal(resolveModel(undefined, { ...ag, model: "m" }, { cheap: "t" }, "d"), "m");
  assert.equal(resolveModel(undefined, ag, { cheap: "t" }, "d"), "t");
  assert.equal(resolveModel(undefined, ag, {}, "d"), "d");
  assert.equal(resolveModel(undefined, ag, {}, undefined), undefined);
});

test("agent command line for pi; other agent CLIs are refused (add-ons)", () => {
  const home = tmpHome("default_model: base\ntiers: {cheap: tiny}\n");
  const cfg = loadConfig(home);
  const agent = { name: "ex", description: "", instructions: "Be brief.", path: "/a/ex.md", tools: ["read", "grep", "find", "bash"], tier: "cheap" };
  const pi = buildAgentCommand(agent, "do it", undefined, cfg, "/tmp/p.md");
  assert.equal(pi.cmd, "pi");
  assert.deepEqual(pi.args, ["-p", "--model", "tiny", "--append-system-prompt", "/tmp/p.md", "--tools", "read,grep,find,bash", "--", "do it"]);
  const big = buildAgentCommand(agent, "do it", "opus", cfg, "/tmp/p.md");
  assert.deepEqual(big.args.slice(0, 3), ["-p", "--model", "opus"]);
  for (const cli of ["claude", "nope"]) assert.throws(() => buildAgentCommand(agent, "x", undefined, { ...cfg, raw: { ...cfg.raw, agent_cli: cli } }, "f"), /not supported/);
});

test("agent steps run the configured agent CLI headless", async () => {
  const { writeFileSync, chmodSync, readFileSync } = await import("node:fs");
  const bin = join(tmp(), "fake-pi");
  writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$JILLS_WORKSPACE/argv.txt"\necho agent-said-hi\n`);
  chmodSync(bin, 0o755);
  const home = tmpHome(`agent_bin: ${bin}\n`);
  writeAgent(join(home, "agents"), "helper.md", "name: helper\ndescription: h\ntools: read\nmodel: m9", "Help well.");
  writeJill(home, "ask", "worktree: false\ninputs: [task]\nsteps:\n  a: {agent: helper, task: 'Q: {{inputs.task}}'}");
  const lines = await dryRun("ask", { home, inputs: { task: "why" }, cwd: tmp() });
  assert.ok(lines.some((l) => l.includes("--model") && l.includes("m9")), lines.join("\n"));
  const { runNow } = await import("../src/api.js");
  const ws = tmp();
  const r = await runNow("ask", { home, inputs: { task: "why" }, cwd: ws });
  assert.equal(r.state, "done", r.error);
  const argv = readFileSync(join(ws, "argv.txt"), "utf8").trim().split("\n");
  assert.deepEqual(argv.slice(0, 3), ["-p", "--model", "m9"]);
  assert.equal(argv.at(-1), "Q: why");
  assert.match(readFileSync(argv[4]!, "utf8"), /Help well\./);
  assert.match(readFileSync(r.steps.a!.log!, "utf8"), /agent-said-hi/);
});
