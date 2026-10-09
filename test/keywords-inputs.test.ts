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
