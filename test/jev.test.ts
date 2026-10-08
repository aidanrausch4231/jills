import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { suggest } from "../src/api.js";
import { buildJevRequest, parseJevReply, setJevFetch, type FetchLike } from "../src/plugins/matcher-jev.js";
import { loadConfig } from "../src/config.js";
import { tmpHome, tmpRepo, writeJill } from "./helpers.js";

const KEY = "sk-test-not-real-123";

function homeWithJills() {
  const home = tmpHome("jev: {key_env: JILLS_TEST_JEV_KEY, threshold: 0.7}\n");
  writeJill(home, "fix-bug", "description: Fix a bug\nwhen: user reports a bug\nkeywords: [bug, broken]\ninputs: [task]\nsteps:\n  a: {run: echo}");
  writeJill(home, "research", "description: Research a question\nwhen: user asks how something works\nkeywords: [research]\nsteps:\n  a: {run: echo}");
  return home;
}

function fakeFetch(reply: unknown, calls: { url: string; init: Parameters<FetchLike>[1] }[], ok = true): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok, status: ok ? 200 : 500, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) };
  };
}

afterEach(() => {
  setJevFetch(undefined);
  delete process.env.JILLS_TEST_JEV_KEY;
});

test("Jev request shape: one call, model, jills list, last 3 turns, already line; key only in header", async () => {
  const home = homeWithJills();
  process.env.JILLS_TEST_JEV_KEY = KEY;
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  setJevFetch(fakeFetch({ label: "new", jill: "fix-bug", inputs: { task: "login 500" }, confidence: 0.92 }, calls));
  const recent = [
    { role: "user" as const, text: "t1" },
    { role: "assistant" as const, text: "t2" },
    { role: "user" as const, text: "t3" },
    { role: "assistant" as const, text: "t4" },
  ];
  const s = await suggest({ home, session: "jev-1", message: "the login page is broken", recent, repo: tmpRepo() });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.headers.authorization, `Bearer ${KEY}`);
  const body = JSON.parse(calls[0]!.init.body) as { model: string; messages: { role: string; content: string }[]; response_format: { type: string } };
  assert.equal(body.model, "typesafe/jev-router");
  assert.equal(body.response_format.type, "json_object");
  assert.equal(body.messages[0]!.role, "system");
  const user = body.messages[1]!.content;
  assert.match(user, /"name":"fix-bug","when":"user reports a bug","description":"Fix a bug","inputs":\["task"\]/);
  assert.match(user, /Last turns: \[\{"role":"assistant","text":"t2"\},\{"role":"user","text":"t3"\},\{"role":"assistant","text":"t4"\}\]/);
  assert.match(user, /Already this chat: none/);
  assert.match(user, /New message: "the login page is broken"/);
  assert.ok(!calls[0]!.init.body.includes(KEY), "key never in body");
  assert.equal(s.action, "suggest");
  assert.equal(s.jill, "fix-bug");
  assert.equal(s.matcher, "jev");
  assert.deepEqual(s.inputs, { task: "login 500" });
  assert.match(s.agentContext!, /Manual mode: do NOT start it yourself/);
});

test("already-suggested Jills are listed to Jev", () => {
  const cfg = loadConfig(homeWithJills());
  const req = buildJevRequest({ message: "m", recent: [], jills: [], already: ["fix-bug"], config: cfg });
  assert.match(req.messages[1]!.content, /Already this chat: fix-bug/);
});

test("no key -> keywords fallback without any HTTP call", async () => {
  const home = homeWithJills();
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  setJevFetch(fakeFetch({ label: "talk", confidence: 1 }, calls));
  const s = await suggest({ home, session: "nokey", message: "there is a bug in checkout", repo: tmpRepo() });
  assert.equal(calls.length, 0);
  assert.equal(s.action, "suggest");
  assert.equal(s.matcher, "keywords");
  assert.equal(s.jill, "fix-bug");
});

test("network error or bad reply -> keywords fallback", async () => {
  const home = homeWithJills();
  process.env.JILLS_TEST_JEV_KEY = KEY;
  setJevFetch(async () => {
    throw new Error("ECONNREFUSED");
  });
  const s1 = await suggest({ home, session: "neterr", message: "please research the cache", repo: tmpRepo() });
  assert.equal(s1.matcher, "keywords");
  assert.equal(s1.jill, "research");
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  setJevFetch(fakeFetch({}, calls, false));
  const s2 = await suggest({ home, session: "http500", message: "a bug again", repo: tmpRepo() });
  assert.equal(s2.matcher, "keywords");
});

test("Jev talk / same / low confidence stay quiet", async () => {
  const home = homeWithJills();
  process.env.JILLS_TEST_JEV_KEY = KEY;
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  setJevFetch(fakeFetch({ label: "talk", confidence: 0.99 }, calls));
  assert.equal((await suggest({ home, session: "q1", message: "thanks!" })).action, "quiet");
  setJevFetch(fakeFetch({ label: "same", confidence: 0.99 }, calls));
  assert.equal((await suggest({ home, session: "q2", message: "also do x" })).reason, "same task as before");
  setJevFetch(fakeFetch({ label: "new", jill: "fix-bug", confidence: 0.4 }, calls));
  const low = await suggest({ home, session: "q3", message: "maybe a bug?" });
  assert.equal(low.action, "quiet");
  assert.match(low.reason, /not confident/);
});

test("parseJevReply validates labels and Jill names", () => {
  assert.equal(parseJevReply("nonsense", ["a"]), undefined);
  assert.equal(parseJevReply('{"label":"maybe"}', ["a"]), undefined);
  assert.equal(parseJevReply('```json\n{"label":"new","jill":"zzz","confidence":0.9}\n```', ["a"])!.label, "talk");
  const ok = parseJevReply('{"label":"new","jill":"a","confidence":3,"inputs":{"x":1}}', [{ name: "a", inputs: ["x"] }])!;
  assert.equal(ok.confidence, 1);
  assert.deepEqual(ok.inputs, { x: "1" });
});
