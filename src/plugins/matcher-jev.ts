import type { JillsConfig } from "../config.js";
import type { JillSummary, MatchInput, MatchResult, MatcherPlugin } from "./types.js";

/** Config `jev:` with defaults (model, key_env, url, timeout_ms). */
export function jevConfig(config: JillsConfig) {
  const j = (config.raw.jev ?? {}) as Record<string, unknown>;
  return {
    model: String(j.model ?? "typesafe/jev-router"),
    key_env: String(j.key_env ?? "OPENROUTER_API_KEY"),
    url: String(j.url ?? "https://openrouter.ai/api/v1/chat/completions"),
    timeout_ms: typeof j.timeout_ms === "number" ? j.timeout_ms : 8000,
  };
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

let fetchImpl: FetchLike | undefined;
/** Tests inject a fake fetch here. */
export function setJevFetch(f: FetchLike | undefined): void {
  fetchImpl = f;
}

export const JEV_SYSTEM_PROMPT = [
  "You are Jev, a quiet matcher. Read the new chat message and decide one label:",
  '- "talk": chat, questions, or anything that is not a task for a saved Jill.',
  '- "same": the message continues a task already suggested or running in this chat.',
  '- "new": the message starts a new task that one saved Jill fits by meaning (action + target).',
  'Reply with JSON only: {"label":"talk|same|new","jill":"<name when new>","inputs":{"<input>":"<value>"},"confidence":0..1}.',
  "Only fill inputs the Jill declares, with values taken from the message. Be conservative: low confidence when unsure.",
].join("\n");

export function buildJevRequest(input: MatchInput): { model: string; messages: { role: string; content: string }[]; temperature: number; response_format: { type: string } } {
  const jills = input.jills.map((j) => ({ name: j.name, when: j.when ?? "", description: j.description, inputs: j.inputs }));
  const user = [
    `Jills: ${JSON.stringify(jills)}`,
    `Last turns: ${JSON.stringify(input.recent.slice(-3))}`,
    `Already this chat: ${input.already.length ? input.already.join(", ") : "none"}`,
    `New message: ${JSON.stringify(input.message)}`,
  ].join("\n");
  return {
    model: jevConfig(input.config).model,
    messages: [
      { role: "system", content: JEV_SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    temperature: 0,
    response_format: { type: "json_object" },
  };
}

/**
 * Parse Jev's JSON reply. `jills` maps each known Jill to the inputs it declares
 * (a plain name list means "known Jills, no declared inputs"). Inputs the named
 * Jill does not declare are dropped, so a chatty reply cannot set `repo` or
 * other undeclared keys.
 */
export function parseJevReply(content: string, jills: string[] | Pick<JillSummary, "name" | "inputs">[]): MatchResult | undefined {
  const declared = new Map<string, string[]>(jills.map((j) => (typeof j === "string" ? [j, []] : [j.name, j.inputs])));
  const m = /\{[\s\S]*\}/.exec(content);
  if (!m) return undefined;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const label = o.label;
  if (label !== "talk" && label !== "same" && label !== "new") return undefined;
  const confidence = typeof o.confidence === "number" ? Math.max(0, Math.min(1, o.confidence)) : 0;
  const jill = typeof o.jill === "string" && declared.has(o.jill) ? o.jill : undefined;
  if (label === "new" && !jill) return { label: "talk", confidence, matcher: "jev", note: "jev named no known Jill" };
  const inputs: Record<string, string> = {};
  const allowed = new Set(jill ? declared.get(jill) : []);
  if (o.inputs && typeof o.inputs === "object" && !Array.isArray(o.inputs))
    for (const [k, v] of Object.entries(o.inputs as Record<string, unknown>))
      if (allowed.has(k) && v !== null && v !== undefined && typeof v !== "object") inputs[k] = String(v);
  return { label, jill, inputs, confidence, matcher: "jev" };
}

/**
 * Jev: one stateless OpenRouter chat call per message. The key comes from the
 * harness's own login (input.jevKey), else the env var named by jev.key_env; it
 * is never logged or stored. No key, a network error
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
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-title": "jills" },
        body: JSON.stringify(buildJevRequest(input)),
        signal: AbortSignal.timeout(jev.timeout_ms),
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") return undefined;
      return parseJevReply(content, input.jills);
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
