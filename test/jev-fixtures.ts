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
