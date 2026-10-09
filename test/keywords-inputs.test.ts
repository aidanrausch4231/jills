// The keywords matcher fills a Jill's one required input with the message, so Start (`jills go`) can run it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { go, listJills, suggest, wait } from "../src/api.js";
import keywordsMatcher from "../src/plugins/matcher-keywords.js";
import { loadConfig } from "../src/config.js";
import { tmpHome, tmpRepo, writeJill } from "./helpers.js";

const ONE = "description: Fix a Jill bug\nkeywords: [bug]\nworktree: false\ninputs:\n  - {name: task, required: true}\n  - {name: notes}\n  - {name: area, required: true, default: core}\nsteps:\n  a: {run: echo hi}";
const TWO = "description: Port a feature\nkeywords: [port]\nworktree: false\ninputs:\n  - {name: task, required: true}\n  - {name: target, required: true}\nsteps:\n  a: {run: echo hi}";

test("a keywords suggestion fills the one required input with the message, and go runs it", async () => {
  const home = tmpHome();
  writeJill(home, "fix-jill-bug", ONE);
  const repo = tmpRepo();
  assert.deepEqual((await listJills({ home })).find((j) => j.name === "fix-jill-bug")?.required, ["task"]);
  const s = await suggest({ home, session: "kw1", message: "  there is a bug in the loop step; fix it  ", repo });
  assert.equal(s.action, "suggest");
  assert.equal(s.matcher, "keywords");
  assert.deepEqual(s.inputs, { task: "there is a bug in the loop step; fix it" });
  const g = await go({ home, session: "kw1", cwd: repo });
  assert.equal(g.record.inputs.task, "there is a bug in the loop step; fix it");
  assert.equal((await wait(g.record.id, { home, timeoutMs: 30_000 })).record.state, "done");
});

test("a Jill with two required inputs gets none from a keyword hit", async () => {
  const home = tmpHome();
  writeJill(home, "port", TWO);
  const s = await suggest({ home, session: "kw2", message: "port the parser", repo: tmpRepo() });
  assert.equal(s.action, "suggest");
  assert.deepEqual(s.inputs, {});
});

test("the filled input is capped at 4000 characters", async () => {
  const config = loadConfig(tmpHome());
  const jills = [{ name: "j", description: "", inputs: ["task"], keywords: ["bug"], required: ["task"] }];
  const m = await keywordsMatcher.match({ message: `bug ${"x".repeat(5000)}`, recent: [], jills, already: [], config });
  assert.equal(m?.inputs?.task?.length, 4000);
});

// Chat text reaches a keyword Jill's input as is, so it must never reach a command the agent may run.
const NASTY = 'bug in `touch /tmp/jills-pwned` and $(id); echo "x" > /tmp/jills-pwned2';

test("auto + keyword hit with shell characters: no suggested command carries an input value", async () => {
  const home = tmpHome("auto: true\n");
  writeJill(home, "fix", "description: Fix\nkeywords: [bug]\nworktree: false\ninputs:\n  - {name: task, required: true}\nsteps:\n  a: {run: echo hi}");
  const s = await suggest({ home, session: "kw-auto", message: NASTY, repo: tmpRepo() });
  assert.equal(s.action, "suggest");
  assert.equal(s.auto, true);
  assert.equal(s.inputs?.task, NASTY, "the value itself is kept for jills go");
  for (const out of [s.text!, s.agentContext!]) {
    assert.doesNotMatch(out, /--input|jills start/);
    const cmds = [...out.matchAll(/`(jills [^`]*)`/g)].map((m) => m[1]);
    for (const c of cmds) {
      assert.ok(["jills go --session kw-auto", "jills wait <run-id>"].includes(c!), `unexpected command: ${c}`);
      assert.doesNotMatch(c!, /\$\(|"|;/);
    }
  }
  assert.ok(s.agentContext!.includes("`jills go --session kw-auto`"));
  assert.doesNotMatch(s.agentContext!, /`touch/, "backticks from chat are not shown as code");
});

test("a session id with shell characters is never put into a command", async () => {
  const home = tmpHome("auto: true\n");
  writeJill(home, "fix", "description: Fix\nkeywords: [bug]\nworktree: false\nsteps:\n  a: {run: echo hi}");
  const s = await suggest({ home, session: "x$(id)", message: "a bug", repo: tmpRepo() });
  assert.equal(s.action, "suggest");
  assert.doesNotMatch(s.agentContext!, /jills go/);
  assert.match(s.agentContext!, /start_jill MCP tool/);
});

test("shown input text is one line of at most 200 characters", async () => {
  const home = tmpHome();
  writeJill(home, "fix", "description: Fix\nkeywords: [bug]\nworktree: false\ninputs:\n  - {name: task, required: true}\nsteps:\n  a: {run: echo hi}");
  const s = await suggest({ home, session: "kw-long", message: `a bug\nwith\n${"y".repeat(3000)}`, repo: tmpRepo() });
  const shownTask = /task=(.*?): Fix/.exec(s.text!)?.[1] ?? "";
  assert.ok(shownTask.length <= 200, `shown ${shownTask.length} chars`);
  assert.doesNotMatch(shownTask, /\n/);
  assert.ok((s.inputs?.task?.length ?? 0) > 3000, "the saved input keeps the full text")
});
