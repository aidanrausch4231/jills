import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chat, never, suggest, start, wait, setAuto } from "../src/api.js";
import { loadSession } from "../src/plugins/suggest-default.js";
import { loadConfig } from "../src/config.js";
import { tmpHome, tmpRepo, writeJill } from "./helpers.js";
import { JEV_TEST_CONFIG, keywordJev, resetKeywordJev } from "./jev-fixtures.js";

after(resetKeywordJev);

function setup() {
  const home = tmpHome(JEV_TEST_CONFIG);
  keywordJev({ "fix-bug": ["bug"], docs: ["docs"] });
  writeJill(home, "fix-bug", "description: Fix a bug\nworktree: false\nsteps:\n  a: {run: sleep 3}");
  writeJill(home, "docs", "description: Write docs\nworktree: false\nsteps:\n  a: {run: echo}");
  return { home, repo: tmpRepo() };
}

test("at most one suggestion per 3 messages", async () => {
  const { home, repo } = setup();
  const say = (m: string) => suggest({ home, session: "rate", message: m, repo });
  assert.equal((await say("a bug here")).action, "suggest");
  const s2 = await say("another bug");
  assert.equal(s2.action, "quiet");
  assert.match(s2.reason, /one suggestion per 3/);
  assert.equal((await say("bug bug")).action, "quiet");
  assert.equal((await say("write the docs")).action, "suggest");
});

test("ignored suggestion: wait for a new task (same/talk stay quiet)", async () => {
  const { home, repo } = setup();
  await suggest({ home, session: "ign", message: "a bug", repo });
  await suggest({ home, session: "ign", message: "hmm ok", repo });
  assert.equal(loadSession(home, "ign").waitingForNew, true);
  await suggest({ home, session: "ign", message: "ok", repo });
  const talk = await suggest({ home, session: "ign", message: "nice weather", repo });
  assert.equal(talk.action, "quiet");
  assert.equal(talk.reason, "just talk");
  const fresh = await suggest({ home, session: "ign", message: "update the docs", repo });
  assert.equal(fresh.action, "suggest");
  assert.equal(loadSession(home, "ign").waitingForNew, false);
});

test("dismissed -> quiet for this chat only", async () => {
  const { home, repo } = setup();
  await suggest({ home, session: "dis", message: "bug", repo });
  await chat("dis", { kind: "dismiss" }, { home });
  for (let i = 0; i < 4; i++) {
    const s = await suggest({ home, session: "dis", message: "bug " + i, repo });
    assert.equal(s.action, "quiet");
    assert.equal(s.reason, "dismissed in this chat");
  }
  assert.equal((await suggest({ home, session: "other-chat", message: "bug", repo })).action, "suggest");
});

test("quiet mode and on", async () => {
  const { home, repo } = setup();
  await chat("qm", { kind: "quiet" }, { home });
  assert.match((await suggest({ home, session: "qm", message: "bug", repo })).reason, /quiet mode/);
  await chat("qm", { kind: "on" }, { home });
  assert.equal((await suggest({ home, session: "qm", message: "bug", repo })).action, "suggest");
});

test("never mutes a Jill per repo; on --unmute clears it", async () => {
  const { home, repo } = setup();
  await suggest({ home, session: "nv", message: "bug", repo });
  assert.match(await never({ home, session: "nv", repo }), /muted fix-bug for/);
  const other = tmpRepo();
  assert.equal((await suggest({ home, session: "nv2", message: "bug", repo })).action, "quiet");
  assert.equal((await suggest({ home, session: "nv3", message: "docs", repo })).jill, "docs");
  assert.equal((await suggest({ home, session: "nv4", message: "bug", repo: other })).jill, "fix-bug");
  await chat("nv5", { kind: "on", unmute: repo }, { home });
  assert.equal((await suggest({ home, session: "nv5", message: "bug", repo })).jill, "fix-bug");
});

test("running Jill in this chat -> quiet until it ends", async () => {
  const { home, repo } = setup();
  const rec = await start("fix-bug", { home, cwd: repo, session: "run" });
  const s = await suggest({ home, session: "run", message: "write docs please", repo });
  assert.equal(s.action, "quiet");
  assert.match(s.reason, /a Jill is running/);
  await wait(rec.id, { home, timeoutMs: 20_000 });
  assert.equal((await suggest({ home, session: "run", message: "write docs please", repo })).action, "suggest");
});

test("auto switch changes the agent instructions", async () => {
  const { home, repo } = setup();
  setAuto(true, { home });
  assert.equal(loadConfig(home).auto, true);
  const s = await suggest({ home, session: "auto", message: "bug!", repo });
  assert.equal(s.auto, true);
  assert.match(s.agentContext!, /Auto mode is on: start it with the start_jill MCP tool/);
  assert.match(s.agentContext!, /jills wait <run-id>` in the background/);
  setAuto(false, { home });
  assert.equal(loadConfig(home).auto, false);
});
