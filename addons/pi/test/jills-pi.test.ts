/**
 * Unit tests for the Pi add-on. Run with Node's type stripping:
 *   node --test addons/pi/test/jills-pi.test.ts
 * No network, no real ~/.jills: the fake-core tests never touch disk, and the
 * real-core test uses a temp JILLS_HOME and a temp git repo.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJillsExtension, parseArgs, recentTurns, type JillsCore } from "../jills.ts";

delete process.env.OPENROUTER_API_KEY;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

// ------------------------------------------------------------- fakes

type Handler = (event: any, ctx: any) => any;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const sent: { message: any; options: any }[] = [];
  const pi: any = {
    on(ev: string, h: Handler) {
      handlers.set(ev, [...(handlers.get(ev) ?? []), h]);
      return () => {};
    },
    registerCommand(name: string, o: any) {
      commands.set(name, o);
    },
    sendMessage(message: any, options: any) {
      sent.push({ message, options });
    },
  };
  const emit = async (ev: string, event: any, ctx: any) => {
    let out: any;
    for (const h of handlers.get(ev) ?? []) out = await h(event, ctx);
    return out;
  };
  return { pi, handlers, commands, sent, emit };
}

function fakeCtx(branch: any[] = [], cwd = "/repo") {
  const calls = { notify: [] as [string, string | undefined][], status: [] as (string | undefined)[], widget: [] as (string[] | undefined)[] };
  const ctx: any = {
    hasUI: true,
    mode: "tui",
    cwd,
    ui: {
      notify: (m: string, t?: string) => calls.notify.push([m, t]),
      setStatus: (_k: string, t: string | undefined) => calls.status.push(t),
      setWidget: (_k: string, l: string[] | undefined) => calls.widget.push(l),
    },
    sessionManager: { getSessionId: () => "s1", getBranch: () => branch },
  };
  return { ctx, calls };
}

function fakeCore(over: Partial<Record<keyof JillsCore, any>> = {}) {
  const log: [string, any[]][] = [];
  const rec = (name: string, fn: (...a: any[]) => any) => (...a: any[]) => {
    log.push([name, a]);
    return fn(...a);
  };
  let polls = 0;
  const run = { id: "r1", jill: "hello", state: "queued", logDir: "/logs/r1", branch: "jills/hello-r1" };
  const core: any = {
    suggest: rec("suggest", async () => ({
      action: "suggest",
      reason: "fits",
      jill: "hello",
      inputs: { who: "pi" },
      auto: false,
      text: 'Jev: this looks like a job for Jill "hello"',
      agentContext: "[Jills] Manual mode: ask the user.",
    })),
    start: rec("start", async (jill: string) => ({ ...run, jill })),
    go: rec("go", async (o: any) => ({ record: { ...run, jill: o.jill ?? "hello" }, inputs: { who: "pi", ...o.inputs }, dropped: [] })),
    status: rec("status", (id?: string) => {
      if (!id) return [{ ...run, state: "done" }];
      polls += 1;
      return { ...run, state: polls >= 2 ? "done" : "running" };
    }),
    listJills: rec("listJills", async () => [{ name: "hello", description: "say hi", inputs: [], keywords: [], path: "/x" }]),
    chat: rec("chat", async (_s: string, ch: any) => (ch.kind === "last" ? { jill: "hello", inputs: {} } : undefined)),
    never: rec("never", async () => "muted hello for /repo"),
    setAuto: rec("setAuto", () => {}),
    resultLine: (r: any) => `jills run ${r.id} ${r.state}: ${r.jill} | branch ${r.branch} | logs ${r.logDir}`,
    TERMINAL: new Set(["done", "failed", "stuck", "needs-you"]),
    ...over,
  };
  const called = (name: string) => log.filter(([n]) => n === name).map(([, a]) => a);
  return { core: core as JillsCore, log, called };
}

const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

function setup(over: Partial<Record<keyof JillsCore, any>> = {}, branch: any[] = []) {
  const f = fakePi();
  const c = fakeCore(over);
  createJillsExtension(f.pi, { core: c.core, pollMs: 5, contextWaitMs: 1000 });
  const { ctx, calls } = fakeCtx(branch);
  return { ...f, ...c, ctx, calls };
}

// ------------------------------------------------------------- tests

describe("pi add-on: registration", () => {
  it("registers input, before_agent_start, session hooks and the /jills command", () => {
    const { handlers, commands } = setup();
    for (const ev of ["input", "before_agent_start", "session_start", "session_shutdown"]) assert.ok(handlers.has(ev), ev);
    assert.ok(commands.has("jills"));
    const comp = commands.get("jills").getArgumentCompletions("d");
    assert.deepEqual(comp.map((c: any) => c.value), ["dismiss"]);
  });
});

describe("pi add-on: suggestions", () => {
  it("manual mode: shows widget + notice and gives the agent hidden context", async () => {
    const t = setup({}, [
      { type: "message", message: { role: "user", content: "earlier question" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "earlier answer" }] } },
      { type: "model_change" },
    ]);
    const r = await t.emit("input", { type: "input", text: "please say hello to pi", source: "interactive" }, t.ctx);
    assert.deepEqual(r, { action: "continue" });
    const res = await t.emit("before_agent_start", { type: "before_agent_start", prompt: "please say hello to pi" }, t.ctx);
    assert.deepEqual(res, { message: { customType: "jills", content: "[Jills] Manual mode: ask the user.", display: false } });
    const [args] = t.called("suggest");
    assert.equal(args[0].session, "pi-s1");
    assert.equal(args[0].message, "please say hello to pi");
    assert.equal(args[0].cwd, "/repo");
    assert.deepEqual(args[0].recent, [
      { role: "user", text: "earlier question" },
      { role: "assistant", text: "earlier answer" },
    ]);
    assert.match(t.calls.widget.at(-1)![0], /Jill "hello"/);
    assert.match(t.calls.widget.at(-1)![1], /\/jills go/);
    assert.match(t.calls.notify.at(-1)![0], /Jill "hello"/);
    assert.equal(t.called("start").length, 0, "manual mode never starts on its own");
  });

  it("worktree: false suggestion shows 'no worktree: edits your checkout directly' (widget, notice, auto message)", async () => {
    const warning = "no worktree: edits your checkout directly";
    const manual = setup({
      suggest: async () => ({ action: "suggest", reason: "fits", jill: "hello", auto: false, text: 'Jev: this looks like a job for Jill "hello"', agentContext: "ask", worktree: false, warning }),
    });
    await manual.emit("input", { text: "say hello", source: "interactive" }, manual.ctx);
    await manual.emit("before_agent_start", { prompt: "say hello" }, manual.ctx);
    assert.match(manual.calls.widget.at(-1)![0], /no worktree: edits your checkout directly/);
    assert.match(manual.calls.notify.at(-1)![0], /no worktree: edits your checkout directly/);
    const auto = setup({
      suggest: async () => ({ action: "suggest", reason: "fits", jill: "hello", auto: true, text: "x", agentContext: "x", worktree: false, warning }),
    });
    await auto.emit("input", { text: "say hello", source: "interactive" }, auto.ctx);
    const res = await auto.emit("before_agent_start", { prompt: "say hello" }, auto.ctx);
    assert.match(res.message.content, /no worktree: edits your checkout directly/);
    assert.doesNotMatch(res.message.content, /separate worktree/);
  });

  it("quiet result: shows nothing and adds no context", async () => {
    const t = setup({ suggest: async () => ({ action: "quiet", reason: "just talk", auto: false }) });
    await t.emit("input", { text: "hi there", source: "interactive" }, t.ctx);
    const res = await t.emit("before_agent_start", { prompt: "hi there" }, t.ctx);
    assert.equal(res, undefined);
    assert.equal(t.calls.widget.length, 0);
    assert.equal(t.calls.notify.length, 0);
  });

  it("skips slash commands, bash lines, empty text and extension-sent input", async () => {
    const t = setup();
    for (const [text, source] of [["/jills go", "interactive"], ["!ls", "interactive"], ["   ", "interactive"], ["do work", "extension"]])
      assert.deepEqual(await t.emit("input", { text, source }, t.ctx), { action: "continue" });
    assert.equal(t.called("suggest").length, 0);
    assert.equal(await t.emit("before_agent_start", { prompt: "x" }, t.ctx), undefined);
  });

  it("a failing core does not break the chat", async () => {
    const t = setup({ suggest: async () => { throw new Error("boom"); } });
    await t.emit("input", { text: "say hello", source: "interactive" }, t.ctx);
    assert.equal(await t.emit("before_agent_start", { prompt: "say hello" }, t.ctx), undefined);
    assert.match(t.calls.notify.at(-1)![0], /boom/);
  });

  it("a slow Jev check does not hold the agent past contextWaitMs", async () => {
    const f = fakePi();
    const c = fakeCore({ suggest: () => new Promise(() => {}) });
    createJillsExtension(f.pi, { core: c.core, contextWaitMs: 30 });
    const { ctx } = fakeCtx();
    await f.emit("input", { text: "say hello", source: "interactive" }, ctx);
    const t0 = Date.now();
    assert.equal(await f.emit("before_agent_start", { prompt: "say hello" }, ctx), undefined);
    assert.ok(Date.now() - t0 < 1000);
  });

  it("auto mode: starts the Jill, tells the agent, watches and posts the result", async () => {
    const t = setup({
      suggest: async () => ({ action: "suggest", reason: "fits", jill: "hello", inputs: { who: "pi" }, auto: true, text: "x", agentContext: "use MCP" }),
    });
    await t.emit("input", { text: "say hello to pi", source: "interactive" }, t.ctx);
    const res = await t.emit("before_agent_start", { prompt: "say hello to pi" }, t.ctx);
    assert.match(res.message.content, /already started Jill "hello" as run r1/);
    assert.equal(res.message.display, false);
    const [startArgs] = t.called("start");
    assert.equal(startArgs[0], "hello");
    assert.deepEqual(startArgs[1].inputs, { who: "pi" });
    assert.equal(startArgs[1].session, "pi-s1");
    assert.equal(startArgs[1].cwd, "/repo");
    assert.match(t.calls.status[0]!, /hello running \(r1\)/);
    await until(() => t.sent.length > 0);
    assert.equal(t.sent[0]!.message.customType, "jills");
    assert.equal(t.sent[0]!.message.display, true);
    assert.match(t.sent[0]!.message.content, /jills run r1 done: hello \| branch jills\/hello-r1/);
    assert.equal(t.sent[0]!.message.details.state, "done");
    assert.equal(t.calls.status.at(-1), undefined, "status line cleared when the run ends");
  });
});

describe("pi add-on: messages never steer the agent", () => {
  it("the finished-run message and the go notice use triggerTurn: false (no steer, no interrupt, no new turn)", async () => {
    const t = setup();
    await t.commands.get("jills").handler("go hello", t.ctx);
    await until(() => t.sent.length > 1);
    assert.equal(t.sent.length, 2);
    for (const { message, options } of t.sent) {
      assert.deepEqual(options, { triggerTurn: false }, `${message.content}`);
      assert.notEqual((options as { deliverAs?: string } | undefined)?.deliverAs, "steer");
    }
    assert.match(t.sent[1]!.message.content, /run r1 done/);
    assert.equal(t.sent[1]!.message.display, true);
  });
});

describe("pi add-on: /jills commands", () => {
  it("/jills go starts the last suggestion with Jev's inputs plus overrides", async () => {
    const t = setup();
    await t.emit("input", { text: "say hello to pi", source: "interactive" }, t.ctx);
    await t.emit("before_agent_start", { prompt: "x" }, t.ctx);
    await t.commands.get("jills").handler('go who="the team"', t.ctx);
    const [[args]] = t.called("go");
    assert.equal(args.jill, "hello");
    assert.equal(args.session, "pi-s1");
    assert.equal(args.cwd, "/repo");
    assert.deepEqual(args.inputs, { who: "the team" }, "only overrides; the core adds the saved inputs");
    assert.deepEqual(t.calls.widget.at(-1), undefined, "suggestion widget cleared");
    assert.match(t.sent[0]!.message.content, /The user started Jill "hello" as run r1/);
    await until(() => t.sent.length > 1);
    assert.match(t.sent[1]!.message.content, /run r1 done/);
  });

  it("/jills go with nothing suggested warns", async () => {
    const t = setup({ chat: async () => undefined });
    await t.commands.get("jills").handler("go", t.ctx);
    assert.equal(t.called("go").length, 0);
    assert.match(t.calls.notify.at(-1)![0], /nothing suggested/);
  });

  it("dismiss, never, quiet, on, auto, list, status call the core", async () => {
    const t = setup();
    const run = (a: string) => t.commands.get("jills").handler(a, t.ctx);
    await run("dismiss");
    await run("never hello");
    await run("quiet");
    await run("on --unmute");
    await run("auto on");
    await run("auto maybe");
    await run("list");
    await run("status");
    await run("status r1");
    await run("");
    const chats = t.called("chat");
    assert.deepEqual(chats[0], ["pi-s1", { kind: "dismiss" }, { home: undefined }]);
    assert.equal(t.called("never")[0]![0].jill, "hello");
    assert.equal(t.called("never")[0]![0].session, "pi-s1");
    assert.deepEqual(chats[1]![1], { kind: "quiet" });
    assert.deepEqual(chats[2]!.slice(1), [{ kind: "on", unmute: true }, { cwd: "/repo", home: undefined }]);
    assert.deepEqual(t.called("setAuto"), [[true, { home: undefined }]]);
    const notes = t.calls.notify.map(([m]) => m).join("\n");
    assert.match(notes, /muted hello/);
    assert.match(notes, /auto on\|off/);
    assert.match(notes, /hello: say hi/);
    assert.match(notes, /jills run r1 done/);
    assert.match(notes, /\/jills go \[jill\]/);
  });

  it("errors from the core show as error notices", async () => {
    const t = setup({ go: async () => { throw new Error('no Jill named "zzz"'); } });
    await t.commands.get("jills").handler("go zzz", t.ctx);
    assert.deepEqual(t.calls.notify.at(-1), ['Jills: no Jill named "zzz"', "error"]);
  });

  it("session_shutdown stops watchers", async () => {
    const t = setup({ status: () => ({ id: "r1", jill: "hello", state: "running", logDir: "/l" }) });
    await t.commands.get("jills").handler("go hello", t.ctx);
    await t.emit("session_shutdown", { reason: "quit" }, t.ctx);
    const n = t.sent.length;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(t.sent.length, n);
  });
});

describe("pi add-on: helpers", () => {
  it("parseArgs splits words and key=value inputs", () => {
    assert.deepEqual(parseArgs(`go fix-bug repo=/x task="fix the login" note='a b'`), {
      words: ["go", "fix-bug"],
      inputs: { repo: "/x", task: "fix the login", note: "a b" },
    });
  });
  it("recentTurns keeps the last 3 user/assistant texts", () => {
    const b = [1, 2, 3, 4].map((i) => ({ type: "message", message: { role: i % 2 ? "user" : "assistant", content: `t${i}` } }));
    assert.deepEqual(recentTurns({ sessionManager: { getBranch: () => b } } as any).map((t) => t.text), ["t2", "t3", "t4"]);
  });
});

// ------------------------------------------------------------- real core, end to end

const dist = join(repoRoot, "dist", "src", "index.js");
describe("pi add-on: real core (temp JILLS_HOME, temp repo)", { skip: !existsSync(dist) && "run pnpm build first" }, () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const tmp = (p: string) => {
    const d = mkdtempSync(join(tmpdir(), p));
    dirs.push(d);
    return d;
  };

  it("keyword match suggests hello, /jills go runs it, and the result is posted", async () => {
    const home = tmp("jills-pi-home-");
    mkdirSync(join(home, "jills"), { recursive: true });
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(join(home, "config.yml"), `agent_paths: [${join(home, "agents")}]\n`);
    cpSync(join(repoRoot, "examples", "hello"), join(home, "jills", "hello"), { recursive: true });
    const repo = tmp("jills-pi-repo-");
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
    writeFileSync(join(repo, "base.txt"), "base\n");
    execFileSync("git", ["add", "-A"], { cwd: repo, env });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo, env });

    const core = (await import(pathToFileURL(dist).href)) as JillsCore;
    const f = fakePi();
    createJillsExtension(f.pi, { core, home, pollMs: 50 });
    const { ctx, calls } = fakeCtx([], repo);
    await f.emit("session_start", { reason: "startup" }, ctx);
    await f.emit("input", { text: "say hello to the team", source: "interactive" }, ctx);
    const res = await f.emit("before_agent_start", { prompt: "say hello to the team" }, ctx);
    assert.match(res?.message?.content ?? "", /Manual mode/);
    assert.match(calls.widget.at(-1)?.[0] ?? "", /hello/);

    await f.commands.get("jills").handler("go", ctx);
    await until(() => f.sent.some((s) => s.message.display === true), 60000);
    const done = f.sent.find((s) => s.message.display === true)!;
    assert.equal(done.message.details.state, "done", done.message.content);
    const branch = done.message.details.branch as string;
    assert.match(branch, /^jills\/hello-/);
    const log = execFileSync("git", ["log", "--oneline", branch], { cwd: repo, encoding: "utf8" });
    assert.ok(log.trim().split("\n").length >= 2, "run branch has a Jills commit");
    assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), "main");
  });
});
