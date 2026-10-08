// Jev uses the harness's own OpenRouter login (SuggestOpts.jevKey); the env var is a fallback.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { go, suggest, wait } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import jevMatcher, { setJevFetch, type FetchLike } from "../src/plugins/matcher-jev.js";
import type { MatchInput } from "../src/plugins/types.js";
import { tmp, tmpHome, tmpRepo, writeJill } from "./helpers.js";

const OWN = "sk-own-login-not-real-456";
const ENV = "sk-env-not-real-789";
type Call = { url: string; init: Parameters<FetchLike>[1] };

function home() {
  const h = tmpHome("jev: {key_env: JILLS_TEST_OWN_KEY, threshold: 0.7}\n");
  writeJill(h, "fix-bug", "description: Fix a bug\nwhen: user reports a bug\ninputs: [task]\nsteps:\n  a: {run: echo}");
  return h;
}
const fetchInto = (calls: Call[]): FetchLike => async (url, init) => {
  calls.push({ url, init });
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ label: "new", jill: "fix-bug", inputs: { task: "login" }, confidence: 0.9 }) } }] }) };
};
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));

afterEach(() => {
  setJevFetch(undefined);
  delete process.env.JILLS_TEST_OWN_KEY;
});

test("the supplied key is used (asked by jev.key_env's name), wins over the env var, and is never persisted", async () => {
  const h = home();
  process.env.JILLS_TEST_OWN_KEY = ENV;
  const calls: Call[] = [];
  const asked: string[] = [];
  setJevFetch(fetchInto(calls));
  const s = await suggest({ home: h, session: "own-1", message: "the login page is broken", repo: tmpRepo(), jevKey: async (n) => (asked.push(n), OWN) });
  assert.equal(s.action, "suggest");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.init.headers.authorization, `Bearer ${OWN}`);
  assert.ok(!calls[0]!.init.body.includes(OWN), "key only in the header");
  assert.deepEqual(asked, ["JILLS_TEST_OWN_KEY"]);
  assert.ok(!JSON.stringify(s).includes(OWN), "key not in the suggestion");
  const { record } = await go({ home: h, session: "own-1", cwd: tmpRepo() });
  const done = await wait(record.id, { home: h, timeoutMs: 30000 });
  assert.equal(done.record.state, "done", done.line);
  assert.ok(!JSON.stringify(done.record).includes(OWN), "key not in the run record");
  for (const f of filesUnder(h)) assert.ok(!readFileSync(f, "utf8").includes(OWN), `key written to ${f}`);
});

test("no supplied key, or a failing lookup: the env var named in config is the fallback", async () => {
  const h = home();
  process.env.JILLS_TEST_OWN_KEY = ENV;
  const calls: Call[] = [];
  setJevFetch(fetchInto(calls));
  await suggest({ home: h, session: "own-2", message: "the login page is broken", repo: tmpRepo(), jevKey: async () => undefined });
  await suggest({ home: h, session: "own-3", message: "the login page is broken", repo: tmpRepo(), jevKey: async () => { throw new Error("no login"); } });
  await suggest({ home: h, session: "own-4", message: "the login page is broken", repo: tmpRepo() });
  assert.deepEqual(calls.map((c) => c.init.headers.authorization), [`Bearer ${ENV}`, `Bearer ${ENV}`, `Bearer ${ENV}`]);
});

test("no supplied key and no env var: Jev makes no call", async () => {
  const calls: Call[] = [];
  setJevFetch(fetchInto(calls));
  await suggest({ home: home(), session: "own-5", message: "the login page is broken", repo: tmpRepo() });
  assert.equal(calls.length, 0);
});

test("only the built-in Jev matcher gets a key lookup, locked to jev.key_env; a third-party matcher gets none", async () => {
  const file = join(tmp(), "spy-matcher.js");
  writeFileSync(file, `export default { slot: "matcher", apiVersion: 1, name: "spy", async match(input) { globalThis.__jillsSpy = { has: "jevKey" in input, type: typeof input.jevKey }; return undefined; } };`);
  const h = tmpHome(`plugins: [${file}]\njev: {key_env: JILLS_TEST_OWN_KEY}\n`);
  writeJill(h, "fix-bug", "description: Fix a bug\nwhen: user reports a bug\ninputs: [task]\nsteps:\n  a: {run: echo}");
  const calls: Call[] = [];
  const asked: string[] = [];
  setJevFetch(fetchInto(calls));
  await suggest({ home: h, session: "own-6", message: "the login page is broken", repo: tmpRepo(), jevKey: async (n) => (asked.push(n), OWN) });
  const spy = (globalThis as { __jillsSpy?: { has: boolean; type: string } }).__jillsSpy;
  assert.deepEqual(spy, { has: false, type: "undefined" }, "third-party matcher saw a key lookup");
  assert.deepEqual(asked, ["JILLS_TEST_OWN_KEY"], "only jev.key_env is ever asked for");
  assert.equal(calls[0]!.init.headers.authorization, `Bearer ${OWN}`);
});

test("Jev matcher tolerates a lookup that throws synchronously or returns a plain string", async () => {
  process.env.JILLS_TEST_OWN_KEY = ENV;
  const calls: Call[] = [];
  setJevFetch(fetchInto(calls));
  const config = loadConfig(home());
  const base: MatchInput = { message: "the login page is broken", recent: [], jills: [{ name: "fix-bug", description: "Fix a bug", inputs: ["task"], keywords: [] }], already: [], config };
  await jevMatcher.match({ ...base, jevKey: () => { throw new Error("sync boom"); } });
  await jevMatcher.match({ ...base, jevKey: () => "  sk-plain-not-real  " });
  assert.deepEqual(calls.map((c) => c.init.headers.authorization), [`Bearer ${ENV}`, "Bearer sk-plain-not-real"]);
});
