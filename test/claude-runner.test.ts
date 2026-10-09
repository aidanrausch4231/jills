import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { check, dryRun, runNow } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import type { StepDef } from "../src/jillfile.js";
import { builtinPlugins } from "../src/plugins/index.js";
import agentRunner from "../src/plugins/runner-agent.js";
import claudeRunner, { buildClaudeCommand, claudeModel, claudeTools } from "../src/plugins/runner-claude.js";
import { tmp, tmpHome, writeAgent, writeJill } from "./helpers.js";

const agent = { name: "ex", description: "", instructions: "Be brief.", path: "/a/ex.md", tools: ["read", "grep", "find", "ls", "write", "edit", "bash"] };
const step = (o: Partial<StepDef> = {}): StepDef => ({ name: "s", agent: "ex", needs: [], copies: 1, writes: false, merges: false, extra: {}, ...o });
const flag = (args: string[], f: string) => args[args.indexOf(f) + 1];

test("claude command: flags, writer vs non-writer permissions, tool mapping", () => {
  const cfg = loadConfig(tmpHome());
  const w = buildClaudeCommand(agent, { writes: true }, "fix it", cfg);
  assert.equal(w.cmd, "claude");
  assert.deepEqual(w.args, ["-p", "--model", "claude-opus-5-5", "--append-system-prompt", "Be brief.", "--permission-mode", "acceptEdits", "--tools", "Read,Grep,Glob,Write,Edit,Bash", "--allowedTools", "Read,Grep,Glob,Write,Edit", "--output-format", "text", "--", "fix it"]);
  const r = buildClaudeCommand(agent, { writes: false }, "look", cfg);
  assert.equal(flag(r.args, "--permission-mode"), "manual");
  assert.equal(flag(r.args, "--tools"), "Read,Grep,Glob,Bash");
  assert.equal(flag(r.args, "--allowedTools"), "Read,Grep,Glob");
  for (const a of [...w.args, ...r.args]) assert.ok(!/bypassPermissions|dangerously/.test(a), a);
  // default tool set: read-only, plus write/edit for writers; never Bash
  assert.deepEqual(claudeTools({ ...agent, tools: undefined }, false), ["Read", "Grep", "Glob"]);
  assert.deepEqual(claudeTools({ ...agent, tools: undefined }, true), ["Read", "Grep", "Glob", "Write", "Edit"]);
  // claude_tools replaces allowedTools verbatim; --tools still drops Write/Edit for non-writers
  const pat = buildClaudeCommand({ ...agent, claudeTools: ["Read", "Bash(pnpm test:*)"] }, { writes: false }, "t", cfg);
  assert.equal(flag(pat.args, "--allowedTools"), "Read,Bash(pnpm test:*)");
  assert.equal(flag(pat.args, "--tools"), "Read,Grep,Glob,Bash");
  assert.throws(() => claudeTools({ ...agent, tools: ["read", "websearch"] }, false), /tool "websearch" has no Claude Code name/);
});

test("claude model: step > agent > tier > claude_default_model; anthropic/ stripped; claude_bin override", () => {
  const cfg = loadConfig(tmpHome("default_model: openai-codex/gpt-5.6-sol\ntiers: {big: anthropic/claude-tier}\n"));
  const ag = { ...agent, tier: "big" };
  assert.equal(claudeModel("anthropic/claude-opus-5-5", ag, cfg), "claude-opus-5-5");
  assert.equal(claudeModel(undefined, { ...ag, model: "claude-x" }, cfg), "claude-x");
  assert.equal(claudeModel(undefined, ag, cfg), "claude-tier");
  assert.equal(claudeModel(undefined, agent, cfg), "claude-opus-5-5"); // not default_model
  const own = loadConfig(tmpHome("claude_default_model: anthropic/claude-sonnet\nclaude_bin: /opt/claude\n"));
  assert.equal(claudeModel(undefined, agent, own), "claude-sonnet");
  assert.equal(buildClaudeCommand(agent, { writes: false }, "t", own).cmd, "/opt/claude");
});

test("runner split: claude claims cli: claude steps (step > agent file > config), pi keeps the rest", () => {
  const home = tmpHome();
  writeAgent(join(home, "agents"), "c.md", "name: cagent\ndescription: c\ncli: claude");
  writeAgent(join(home, "agents"), "p.md", "name: pagent\ndescription: p");
  const cfg = loadConfig(home);
  const claims = (s: StepDef, c = cfg) => [claudeRunner.canRun(s, c), agentRunner.canRun(s, c)];
  assert.deepEqual(claims(step({ agent: "pagent" })), [false, true]);
  assert.deepEqual(claims(step({ agent: "pagent", extra: { cli: "claude" } })), [true, false]);
  assert.deepEqual(claims(step({ agent: "cagent" })), [true, false]);
  assert.deepEqual(claims(step({ agent: "cagent", extra: { cli: "pi" } })), [false, true]);
  const cfgClaude = { ...cfg, raw: { ...cfg.raw, agent_cli: "claude" } };
  assert.deepEqual(claims(step({ agent: "pagent" }), cfgClaude), [true, false]);
  assert.deepEqual(claims(step({ agent: undefined, run: "echo" })), [false, false]);
  const order = builtinPlugins().runners.map((r) => r.name);
  assert.ok(order.indexOf("claude") < order.indexOf("agent"), order.join(","));
});

test("jills check and dry run describe claude steps; an unknown tool is a check error", async () => {
  const home = tmpHome();
  writeAgent(join(home, "agents"), "ok.md", "name: ok\ndescription: o\ntools: read, grep");
  writeAgent(join(home, "agents"), "bad.md", "name: bad\ndescription: b\ntools: read, websearch");
  writeJill(home, "good", "worktree: false\nsteps:\n  a: {agent: ok, cli: claude, model: anthropic/claude-opus-5-5}");
  writeJill(home, "broken", "worktree: false\nsteps:\n  a: {agent: bad, cli: claude}");
  const r = await check({ home });
  assert.ok(r.errors.some((e) => /broken.*step a: agent bad: tool "websearch"/.test(e)), r.errors.join("\n"));
  assert.ok(!r.errors.some((e) => /good/.test(e)), r.errors.join("\n"));
  const lines = await dryRun("good", { home, cwd: tmp() });
  assert.ok(lines.some((l) => l.includes("claude") && l.includes('"--permission-mode" "manual"') && l.includes('"claude-opus-5-5"')), lines.join("\n"));
});

test("a claude step runs claude_bin with the run env and no added secrets", async () => {
  const bin = join(tmp(), "fake-claude");
  writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$JILLS_WORKSPACE/argv.txt"\nenv -0 > "$JILLS_WORKSPACE/env.bin"\necho claude-said-hi\n`);
  chmodSync(bin, 0o755);
  const home = tmpHome(`claude_bin: ${bin}\n`);
  writeAgent(join(home, "agents"), "helper.md", "name: helper\ndescription: h\ntools: read, edit, write\ncli: claude", "Help well.");
  writeJill(home, "ask", "worktree: false\ninputs: [task]\nsteps:\n  a: {agent: helper, writes: true, task: 'Q: {{inputs.task}}'}");
  const ws = tmp();
  const r = await runNow("ask", { home, inputs: { task: "why" }, cwd: ws });
  assert.equal(r.state, "done", r.error);
  const argv = readFileSync(join(ws, "argv.txt"), "utf8").trim().split("\n");
  assert.deepEqual(argv.slice(0, 7), ["-p", "--model", "claude-opus-5-5", "--append-system-prompt", "Help well.", "--permission-mode", "acceptEdits"]);
  assert.equal(argv.at(-1), "Q: why");
  const env = Object.fromEntries(readFileSync(join(ws, "env.bin"), "utf8").split("\0").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  assert.equal(env.JILLS_RUN_ID, r.id);
  assert.equal(env.JILLS_STEP, "a");
  const added = Object.keys(env).filter((k) => !(k in process.env) && !k.startsWith("JILLS_") && !["PWD", "SHLVL", "_", "OLDPWD"].includes(k));
  assert.deepEqual(added, []);
  assert.ok(!Object.keys(env).some((k) => /KEY|TOKEN|SECRET/.test(k) && !(k in process.env)), "no added credential vars");
  assert.match(readFileSync(r.steps.a!.log!, "utf8"), /via .*fake-claude \(Claude Code\) model=claude-opus-5-5[\s\S]*claude-said-hi/);
});
