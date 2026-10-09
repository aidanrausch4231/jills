// Tests for the Claude Code hook. Run after `pnpm build`: node --test 'addons/claude-code/test/*.test.mjs'
// Temp JILLS_HOME, no network (no OpenRouter key -> keywords fallback).
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { giveUpMs, hookOutput, HOOK_MARGIN_MS, jevTimeoutMs, recentTurns } from "../hook.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "hook.mjs");
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function setup(config = "") {
  const home = tmp("jills-cc-home-");
  mkdirSync(join(home, "agents"), { recursive: true });
  const jill = join(home, "jills", "fix-bug");
  mkdirSync(jill, { recursive: true });
  writeFileSync(join(home, "config.yml"), `agent_paths: [${join(home, "agents")}]\n${config}`);
  writeFileSync(
    join(jill, "JILL.md"),
    "---\nname: fix-bug\ndescription: Find and fix a bug\nkeywords: [bug, crash]\nworktree: false\nsteps:\n  a: {run: echo hi}\n---\n",
  );
  const repo = tmp("jills-cc-repo-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  return { home, repo };
}

function runHook(home, input, extraEnv = {}) {
  const env = { ...process.env, JILLS_HOME: home, ...extraEnv };
  delete env.OPENROUTER_API_KEY;
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env,
    encoding: "utf8",
    timeout: 20000,
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const hookInput = (repo, prompt, session = "cc-sess-1", extra = {}) => ({
  session_id: session,
  prompt_id: "p1",
  transcript_path: join(repo, "missing.jsonl"),
  cwd: repo,
  permission_mode: "default",
  hook_event_name: "UserPromptSubmit",
  prompt,
  turn_number: 1,
  ...extra,
});

test("no match: prints nothing, exit 0", () => {
  const { home, repo } = setup();
  const r = runHook(home, hookInput(repo, "what a nice day"), { JILLS_HOOK_DEBUG: "1" });
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
  assert.match(r.err, /quiet: just talk/);
});

test("manual suggestion: systemMessage for the user, additionalContext for Claude", () => {
  const { home, repo } = setup();
  const r = runHook(home, hookInput(repo, "there is a crash bug in the login page"));
  assert.equal(r.code, 0);
  const o = JSON.parse(r.out);
  assert.deepEqual(Object.keys(o).sort(), ["hookSpecificOutput", "systemMessage"]);
  assert.match(o.systemMessage, /Jill "fix-bug"/);
  assert.match(o.systemMessage, /\/jills go/);
  assert.equal(o.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const ctx = o.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Manual mode: do NOT start it yourself/);
  assert.match(ctx, /session id for Jills: cc-sess-1/);
  assert.ok(ctx.includes(repo));
  assert.equal(o.decision, undefined, "never blocks");
  // Recorded for /jills go.
  const s = JSON.parse(readFileSync(join(home, "sessions", "cc-sess-1.json"), "utf8"));
  assert.equal(s.lastSuggestion.jill, "fix-bug");
});

test("auto mode: Claude is told to start_jill and wait in the background", () => {
  const { home, repo } = setup("auto: true\n");
  const r = runHook(home, hookInput(repo, "please fix this bug", "cc-auto"));
  const o = JSON.parse(r.out);
  assert.match(o.systemMessage, /Auto mode/);
  const ctx = o.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Auto mode is on/);
  assert.match(ctx, /start_jill/);
  assert.match(ctx, /jills wait/);
  assert.match(ctx, /--session cc-auto/);
});

test("quiet mode: no output for this chat, other chats still get suggestions", () => {
  const { home, repo } = setup();
  const cli = join(HERE, "..", "..", "..", "dist", "src", "cli.js");
  execFileSync(process.execPath, [cli, "quiet", "--session", "cc-quiet"], { env: { ...process.env, JILLS_HOME: home } });
  const r = runHook(home, hookInput(repo, "fix the crash bug", "cc-quiet"), { JILLS_HOOK_DEBUG: "1" });
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
  assert.match(r.err, /quiet mode/);
  assert.notEqual(runHook(home, hookInput(repo, "fix the crash bug", "cc-other")).out, "");
});

test("slash commands, shell escapes, system events, empty and bad input are skipped without error", () => {
  const { home, repo } = setup();
  for (const p of ["/jills go", "!git status", "   ", "<task-notification>fix the crash bug</task-notification>"]) {
    const r = runHook(home, hookInput(repo, p, "cc-skip"));
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
  }
  const bad = runHook(home, "not json");
  assert.equal(bad.code, 0);
  assert.equal(bad.out, "");
  const noLib = runHook(home, hookInput(repo, "a bug"), { JILLS_LIB: join(repo, "nope.js") });
  assert.equal(noLib.code, 0);
  assert.equal(noLib.out, "");
});

test("recentTurns reads the last text turns from a transcript", () => {
  const { repo } = setup();
  const f = join(repo, "t.jsonl");
  const lines = [
    { type: "user", message: { role: "user", content: "first" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "answer one" }, { type: "tool_use", id: "x" }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ignored" }] } },
    { type: "user", isMeta: true, message: { role: "user", content: "meta" } },
    { type: "system", content: "sys" },
    { type: "user", message: { role: "user", content: "second" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "answer two" }] } },
  ];
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n{broken\n");
  assert.deepEqual(recentTurns(f), [
    { role: "assistant", text: "answer one" },
    { role: "user", text: "second" },
    { role: "assistant", text: "answer two" },
  ]);
  assert.deepEqual(recentTurns(join(repo, "none.jsonl")), []);
});

test("hookOutput stays silent for quiet suggestions", () => {
  assert.equal(hookOutput({ action: "quiet", reason: "x", auto: false }, "s"), undefined);
  assert.equal(hookOutput(undefined, "s"), undefined);
});

test("giveUpMs always exceeds the Jev request timeout", () => {
  assert.equal(giveUpMs(8000, undefined), 8000 + HOOK_MARGIN_MS);
  assert.equal(giveUpMs(30000, "8000"), 30000 + HOOK_MARGIN_MS, "a low env value cannot undercut Jev");
  assert.equal(giveUpMs(8000, "60000"), 60000, "env can raise it");
  assert.equal(giveUpMs(undefined, ""), 8000 + HOOK_MARGIN_MS);
  for (const jev of [1000, 8000, 30000]) assert.ok(giveUpMs(jev, "1") > jev);
});

test("jevTimeoutMs reads jev.timeout_ms from the config (plug-in keys live under raw)", async () => {
  const lib = await import(pathToFileURL(join(HERE, "..", "..", "..", "dist", "src", "index.js")).href);
  const { home } = setup("jev: {timeout_ms: 20000}\n");
  const before = process.env.JILLS_HOME;
  process.env.JILLS_HOME = home;
  try {
    assert.equal(jevTimeoutMs(lib), 20000);
    assert.equal(giveUpMs(jevTimeoutMs(lib), undefined), 20000 + HOOK_MARGIN_MS, "a Jev timeout above 8 s is honoured");
  } finally {
    if (before === undefined) delete process.env.JILLS_HOME;
    else process.env.JILLS_HOME = before;
  }
  assert.equal(jevTimeoutMs({ loadConfig: () => { throw new Error("bad yaml"); } }), undefined);
});

test("a slow Jev reply inside jev.timeout_ms still reaches the user (hook does not give up first)", async () => {
  // Jev answers after 1.5 s; jev.timeout_ms is 5 s. A hook that gave up at
  // JILLS_HOOK_TIMEOUT_MS=500 would print nothing.
  const jev = createServer((req, res) => {
    req.resume();
    req.on("end", () =>
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ label: "new", jill: "fix-bug", confidence: 0.9 }) } }] }));
      }, 1500),
    );
  });
  jev.listen(0, "127.0.0.1");
  await once(jev, "listening");
  try {
    const url = `http://127.0.0.1:${jev.address().port}/v1/chat/completions`;
    const { home, repo } = setup(`jev: {url: ${JSON.stringify(url)}, key_env: JILLS_CC_SLOW_KEY, timeout_ms: 5000}\n`);
    const env = { ...process.env, JILLS_HOME: home, JILLS_CC_SLOW_KEY: "fake", JILLS_HOOK_TIMEOUT_MS: "500" };
    delete env.OPENROUTER_API_KEY;
    const child = spawn(process.execPath, [HOOK], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stdin.end(JSON.stringify(hookInput(repo, "the weather is lovely today", "cc-slow")));
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
    const o = JSON.parse(out.trim());
    assert.match(o.systemMessage, /Jill "fix-bug"/, "Jev's (not keywords') answer arrived");
  } finally {
    jev.close();
  }
});
