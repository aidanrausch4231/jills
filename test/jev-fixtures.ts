// System One reply shapes (see https://docs.typesafe.ai/api.md) for the Jev matcher tests.
import type { FetchLike } from "../src/plugins/matcher-jev.js";

export type JevCall = { url: string; init: Parameters<FetchLike>[1] };

/** A System One reply. `route` is the chosen option id; `p` its probability. */
export function systemOne(route: string, p: number, action = 0.95, refersBack = 0.05, extra: Record<string, number> = {}) {
  const rest = (1 - p) / 2;
  return {
    model: "jev-1.13.0",
    answers: {
      route: { type: "choice", choice: route, probabilities: { [route]: p, other: rest, ...extra }, confidence: p },
      action: { type: "noul", noul: action },
      refers_back: { type: "noul", noul: refersBack },
    },
    usage: { input_tokens: 300, output_tokens: 30 },
  };
}

/** A fake fetch that records calls and answers with `reply` (a function so tests can change it). */
export function fakeFetch(reply: unknown | (() => unknown), calls: JevCall[] = [], status = 200): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => (typeof reply === "function" ? (reply as () => unknown)() : reply) };
  };
}

import { setJevFetch } from "../src/plugins/matcher-jev.js";

/** Config line for tests: Jev at a fake (never contacted) url, key from JILLS_TEST_JEV_KEY. */
export const JEV_TEST_CONFIG = "jev: {url: https://jev.example.test/v1/systemone, key_env: JILLS_TEST_JEV_KEY}\n";

/**
 * A fake Jev that routes by plain word match: a message containing a keyword of a Jill routes to
 * `new:<jill>`, anything else is `talk`. Sets the test key. Call `resetKeywordJev()` after the test.
 */
export function keywordJev(map: Record<string, string[]>, calls: JevCall[] = []): void {
  process.env.JILLS_TEST_JEV_KEY = "sk-test-not-real";
  setJevFetch(async (url, init) => {
    calls.push({ url, init });
    const said = String((JSON.parse(init.body) as { state: { latest_message: string } }).state.latest_message).toLowerCase();
    const hit = Object.entries(map).find(([, words]) => words.some((w) => said.includes(w.toLowerCase())));
    return { ok: true, status: 200, json: async () => (hit ? systemOne(`new:${hit[0]}`, 0.95) : systemOne("talk", 0.95)) };
  });
}
export function resetKeywordJev(): void {
  setJevFetch(undefined);
  delete process.env.JILLS_TEST_JEV_KEY;
}

import { spawn, type ChildProcess } from "node:child_process";

const SERVER_JS = `
const http = require("node:http");
const map = JSON.parse(process.argv[1]);
const answer = (route) => ({ model: "jev-1.13.0", answers: {
  route: { type: "choice", choice: route, probabilities: { [route]: 0.95, other: 0.05 }, confidence: 0.9 },
  action: { type: "noul", noul: 0.95 }, refers_back: { type: "noul", noul: 0.05 } } });
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const said = String(JSON.parse(body).state.latest_message).toLowerCase();
    const hit = Object.entries(map).find(([, words]) => words.some((w) => said.includes(w.toLowerCase())));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer(hit ? "new:" + hit[0] : "talk")));
  });
}).listen(0, "127.0.0.1", function () { console.log(this.address().port); });
`;

/**
 * A fake Jev as a separate process, for tests that block the event loop (spawnSync of the CLI).
 * Same keyword routing as keywordJev. Call `stop()` when done.
 */
export async function jevServer(map: Record<string, string[]>): Promise<{ url: string; stop: () => void }> {
  const child: ChildProcess = spawn(process.execPath, ["-e", SERVER_JS, JSON.stringify(map)], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.stdout!.once("data", (d) => resolve(String(d).trim()));
  });
  return { url: `http://127.0.0.1:${port}/v1/systemone`, stop: () => void child.kill() };
}
