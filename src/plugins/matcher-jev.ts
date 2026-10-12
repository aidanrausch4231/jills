import type { JillsConfig } from "../config.js";
import { buildSystemOneRequest, parseSystemOne } from "./jev-system-one.js";
import type { MatchInput, MatcherPlugin } from "./types.js";

/** Config `jev:` with defaults (model, key_env, url, timeout_ms, threshold). */
export function jevConfig(config: JillsConfig) {
  const j = (config.raw.jev ?? {}) as Record<string, unknown>;
  return {
    model: String(j.model ?? "jev-latest"),
    key_env: String(j.key_env ?? "TYPESAFE_API_KEY"),
    url: String(j.url ?? "https://api.typesafe.ai/v1/systemone"),
    timeout_ms: typeof j.timeout_ms === "number" ? j.timeout_ms : 8000,
    threshold: typeof j.threshold === "number" ? j.threshold : 0.5,
  };
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

let fetchImpl: FetchLike | undefined;
/** Tests inject a fake fetch here. */
export function setJevFetch(f: FetchLike | undefined): void {
  fetchImpl = f;
}

/**
 * Jev: one stateless TypeSafe System One call per message (Choice + two Noul
 * questions, real probabilities, no generated text). The key comes from
 * input.jevKey (a lookup of exactly jev.key_env), else the env var named by
 * jev.key_env; it is never logged or stored. No key, an HTTP or network error
 * or a bad reply returns undefined so the keywords matcher answers instead.
 */
const jevMatcher: MatcherPlugin = {
  slot: "matcher",
  apiVersion: 1,
  name: "jev",
  async match(input) {
    const jev = jevConfig(input.config);
    const own: unknown = await Promise.resolve().then(() => input.jevKey?.()).catch(() => undefined);
    const key = (typeof own === "string" && own.trim()) || process.env[jev.key_env];
    if (!key) return undefined;
    const f: FetchLike = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    try {
      const res = await f(jev.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(buildSystemOneRequest(input, jev.model)),
        signal: AbortSignal.timeout(jev.timeout_ms),
      });
      if (!res.ok) return undefined;
      return parseSystemOne(await res.json(), input, jev.threshold);
    } catch {
      return undefined;
    }
  },
};
export default jevMatcher;

/** Core: give only this built-in matcher a key lookup, locked to jev.key_env (other matchers get none). */
export function withJevKey(m: MatcherPlugin, input: MatchInput, lookup: ((name: string) => Promise<string | undefined>) | undefined, config: JillsConfig): MatchInput {
  const { jevKey: _drop, ...rest } = input; // never pass on a lookup the caller supplied
  return m === jevMatcher && lookup ? { ...rest, jevKey: () => lookup(jevConfig(config).key_env) } : rest;
}
