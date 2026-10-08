import type { MatchInput, MatchResult, MatcherPlugin } from "./types.js";

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
    model: input.config.jev.model,
    messages: [
      { role: "system", content: JEV_SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    temperature: 0,
    response_format: { type: "json_object" },
  };
}

export function parseJevReply(content: string, knownJills: string[]): MatchResult | undefined {
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
  const jill = typeof o.jill === "string" && knownJills.includes(o.jill) ? o.jill : undefined;
  if (label === "new" && !jill) return { label: "talk", confidence, matcher: "jev", note: "jev named no known Jill" };
  const inputs: Record<string, string> = {};
  if (o.inputs && typeof o.inputs === "object")
    for (const [k, v] of Object.entries(o.inputs as Record<string, unknown>)) if (v !== null && v !== undefined) inputs[k] = String(v);
  return { label, jill, inputs, confidence, matcher: "jev" };
}

/**
 * Jev: one stateless OpenRouter chat call per message. The key comes ONLY from
 * the env var named by jev.key_env and is never logged. No key, a network error
 * or a bad reply returns undefined so the keywords matcher answers instead.
 */
const jevMatcher: MatcherPlugin = {
  slot: "matcher",
  apiVersion: 1,
  name: "jev",
  async match(input) {
    const key = process.env[input.config.jev.key_env];
    if (!key) return undefined;
    const f: FetchLike = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    try {
      const res = await f(input.config.jev.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-title": "jills" },
        body: JSON.stringify(buildJevRequest(input)),
        signal: AbortSignal.timeout(input.config.jev.timeout_ms),
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") return undefined;
      return parseJevReply(content, input.jills.map((j) => j.name));
    } catch {
      return undefined;
    }
  },
};
export default jevMatcher;
