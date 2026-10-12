import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { suggest } from "../src/api.js";
import jevMatcher, { setJevFetch } from "../src/plugins/matcher-jev.js";
import { buildSystemOneRequest, parseSystemOne } from "../src/plugins/jev-system-one.js";
import { loadConfig } from "../src/config.js";
import type { MatchInput } from "../src/plugins/types.js";
import { fakeFetch, systemOne, type JevCall } from "./jev-fixtures.js";
import { tmpHome, tmpRepo, writeJill } from "./helpers.js";

const KEY = "sk-test-not-real-123";

function homeWithJills(config = "threshold: 0.6") {
  const home = tmpHome(`jev: {key_env: JILLS_TEST_JEV_KEY, ${config}}\n`);
  writeJill(home, "fix-bug", "description: Fix a bug\nwhen: user reports a bug\nkeywords: [bug, broken]\ninputs: [{name: task, required: true}]\nsteps:\n  a: {run: echo}");
  writeJill(home, "research", "description: Research a question\nwhen: user asks how something works\nkeywords: [research]\nsteps:\n  a: {run: echo}");
  return home;
}
const input = (home: string, over: Partial<MatchInput> = {}): MatchInput => ({
  message: "the login page is broken",
  recent: [],
  already: [],
  config: loadConfig(home),
  jills: [
    { name: "fix-bug", description: "Fix a bug", when: "user reports a bug", inputs: ["task"], keywords: [], required: ["task"] },
    { name: "research", description: "Research a question", when: "user asks how something works", inputs: [], keywords: [] },
  ],
  ...over,
});

afterEach(() => {
  setJevFetch(undefined);
  delete process.env.JILLS_TEST_JEV_KEY;
});

test("request: one System One call, url/model/questions, key only in the header", async () => {
  const home = homeWithJills();
  process.env.JILLS_TEST_JEV_KEY = KEY;
  const calls: JevCall[] = [];
  setJevFetch(fakeFetch(systemOne("new:fix-bug", 0.9), calls));
  const recent = [
    { role: "user" as const, text: "t1" },
    { role: "assistant" as const, text: "t2" },
    { role: "user" as const, text: "t3" },
    { role: "assistant" as const, text: "t4" },
  ];
  const s = await suggest({ home, session: "jev-1", message: "the login page is broken", recent, repo: tmpRepo() });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.headers.authorization, `Bearer ${KEY}`);
  assert.ok(!calls[0]!.init.body.includes(KEY), "key never in body");
  const body = JSON.parse(calls[0]!.init.body);
  assert.equal(body.model, "jev-latest");
  assert.equal(body.state.latest_message, "the login page is broken");
  assert.deepEqual(body.state.recent_turns, recent.slice(-3));
  assert.deepEqual(body.state.already_suggested_or_running, []);
  assert.deepEqual(body.state.jills[0], { name: "fix-bug", when: "user reports a bug", description: "Fix a bug" });
  assert.equal(body.questions.route.type, "choice");
  assert.deepEqual(Object.keys(body.questions.route.criteria), ["talk", "same", "new:fix-bug", "new:research", "none"]);
  assert.deepEqual(body.questions.route.criteria["new:fix-bug"], { jill: "fix-bug", when: "user reports a bug", description: "Fix a bug" });
  assert.equal(body.questions.action.type, "noul");
  assert.equal(body.questions.refers_back.type, "noul");
  assert.equal(s.action, "suggest");
  assert.equal(s.jill, "fix-bug");
  assert.equal(s.matcher, "jev");
  assert.equal(s.confidence, 0.9);
  assert.deepEqual(s.inputs, { task: "the login page is broken" });
  assert.match(s.agentContext!, /Manual mode: do NOT start it yourself/);
});

test("already-suggested Jills are listed to Jev", () => {
  const home = homeWithJills();
  const req = buildSystemOneRequest(input(home, { already: ["fix-bug"] }), "jev-latest") as { state: { already_suggested_or_running: string[] } };
  assert.deepEqual(req.state.already_suggested_or_running, ["fix-bug"]);
});

test("new: above threshold -> new with the route probability; below -> talk", async () => {
  const home = homeWithJills();
  const hi = parseSystemOne(systemOne("new:fix-bug", 0.61), input(home), 0.6)!;
  assert.deepEqual([hi.label, hi.jill, hi.confidence, hi.matcher], ["new", "fix-bug", 0.61, "jev"]);
  const lo = parseSystemOne(systemOne("new:fix-bug", 0.59), input(home), 0.6)!;
  assert.equal(lo.label, "talk");
  assert.equal(lo.confidence, 0.59);
  process.env.JILLS_TEST_JEV_KEY = KEY;
  setJevFetch(fakeFetch(systemOne("new:fix-bug", 0.55)));
  const q = await suggest({ home, session: "jev-low", message: "maybe a bug?" });
  assert.equal(q.action, "quiet");
  assert.equal(q.reason, "just talk");
});

test("jev.threshold defaults to 0.5", async () => {
  const home = homeWithJills("model: jev-latest");
  process.env.JILLS_TEST_JEV_KEY = KEY;
  setJevFetch(fakeFetch(systemOne("new:fix-bug", 0.52)));
  assert.equal((await suggest({ home, session: "thr-1", message: "login broken", repo: tmpRepo() })).action, "suggest");
  setJevFetch(fakeFetch(systemOne("new:fix-bug", 0.48)));
  assert.equal((await suggest({ home, session: "thr-2", message: "login broken", repo: tmpRepo() })).action, "quiet");
});

test("action no -> talk; talk, none and same routes", () => {
  const home = homeWithJills();
  assert.equal(parseSystemOne(systemOne("new:fix-bug", 0.9, 0.2), input(home), 0.5)!.label, "talk");
  assert.equal(parseSystemOne(systemOne("talk", 0.9), input(home), 0.5)!.label, "talk");
  const none = parseSystemOne(systemOne("none", 0.9), input(home), 0.5)!;
  assert.deepEqual([none.label, none.jill, none.confidence], ["talk", undefined, 0.9]);
  const same = parseSystemOne(systemOne("same", 0.8), input(home), 0.5)!;
  assert.deepEqual([same.label, same.confidence], ["same", 0.8]);
});

test("an option id that is not in the Jill list -> talk (never trust a name)", () => {
  const home = homeWithJills();
  for (const id of ["new:zzz", "new:", "new:fix-bug2", "fix-bug", "rm -rf /"]) {
    const r = parseSystemOne(systemOne(id, 0.99), input(home), 0.5)!;
    assert.equal(r.label, "talk", id);
    assert.equal(r.jill, undefined, id);
  }
});

test("inputs: only the one required input with no default; refers_back adds the quoted turns", () => {
  const home = homeWithJills();
  const recent = [
    { role: "user" as const, text: "the checkout total is wrong" },
    { role: "assistant" as const, text: "I see a rounding bug" },
  ];
  const plain = parseSystemOne(systemOne("new:fix-bug", 0.9), input(home, { message: "fix it", recent }), 0.5)!;
  assert.deepEqual(plain.inputs, { task: "fix it" });
  const back = parseSystemOne(systemOne("new:fix-bug", 0.9, 0.95, 0.9), input(home, { message: "fix it", recent }), 0.5)!;
  assert.deepEqual(back.inputs, { task: "Earlier chat:\nuser: the checkout total is wrong\nassistant: I see a rounding bug\n\nRequest:\nfix it" });
  const none = parseSystemOne(systemOne("new:research", 0.9), input(home), 0.5)!;
  assert.deepEqual(none.inputs, {}, "no required input -> nothing filled");
  const long = parseSystemOne(systemOne("new:fix-bug", 0.9, 0.95, 0.9), input(home, { message: "x".repeat(9000), recent }), 0.5)!;
  assert.ok(long.inputs!.task!.length <= 4000);
  const two = input(home);
  two.jills[0]!.required = ["a", "b"];
  assert.deepEqual(parseSystemOne(systemOne("new:fix-bug", 0.9), two, 0.5)!.inputs, {});
});

test("no key -> undefined without any HTTP call; keywords answer", async () => {
  const home = homeWithJills();
  const calls: JevCall[] = [];
  setJevFetch(fakeFetch(systemOne("talk", 1), calls));
  assert.equal(await jevMatcher.match(input(home)), undefined);
  const s = await suggest({ home, session: "nokey", message: "there is a bug in checkout", repo: tmpRepo() });
  assert.equal(calls.length, 0);
  assert.equal(s.matcher, "keywords");
  assert.equal(s.jill, "fix-bug");
});

test("network error, HTTP 429/500 or a bad reply -> undefined, keywords answer", async () => {
  const home = homeWithJills();
  process.env.JILLS_TEST_JEV_KEY = KEY;
  setJevFetch(async () => {
    throw new Error("ECONNREFUSED");
  });
  const s1 = await suggest({ home, session: "neterr", message: "please research the cache", repo: tmpRepo() });
  assert.equal(s1.matcher, "keywords");
  assert.equal(s1.jill, "research");
  for (const status of [429, 500]) {
    setJevFetch(fakeFetch({ error: "x" }, [], status));
    assert.equal(await jevMatcher.match(input(home)), undefined, String(status));
  }
  for (const bad of [{}, { answers: {} }, { answers: { route: { choice: "talk" } } }, { answers: { route: { choice: "talk", probabilities: { talk: 1 } } } }, null]) {
    setJevFetch(fakeFetch(bad));
    assert.equal(await jevMatcher.match(input(home)), undefined, JSON.stringify(bad));
  }
  setJevFetch(async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }));
  assert.equal(await jevMatcher.match(input(home)), undefined);
});

test("same route stays quiet", async () => {
  const home = homeWithJills();
  process.env.JILLS_TEST_JEV_KEY = KEY;
  setJevFetch(fakeFetch(systemOne("same", 0.9)));
  assert.equal((await suggest({ home, session: "q2", message: "also do x" })).reason, "same task as before");
});
