import type { MatcherPlugin } from "./types.js";

function hits(message: string, keywords: string[]): number {
  const m = message.toLowerCase();
  let n = 0;
  for (const k of keywords) {
    const kw = k.toLowerCase().trim();
    if (!kw) continue;
    const re = new RegExp(`(^|[^a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
    if (re.test(m)) n++;
  }
  return n;
}

/** Longest message text the matcher puts into an input. */
const MAX_INPUT = 4000;

/**
 * Fallback matcher: a Jill whose `keywords:` appear in the message is a new task.
 * One hit = 0.75 confidence, two = 0.9, three or more = 0.95. A Jill with exactly one
 * required input (no default) gets the message as that input, so Start can run it.
 */
const keywordsMatcher: MatcherPlugin = {
  slot: "matcher",
  apiVersion: 1,
  name: "keywords",
  async match({ message, jills }) {
    let best: { jill: (typeof jills)[number]; n: number } | undefined;
    for (const j of jills) {
      const n = hits(message, j.keywords);
      if (n > 0 && (!best || n > best.n)) best = { jill: j, n };
    }
    if (!best) return { label: "talk", confidence: 0.5, matcher: "keywords" };
    const confidence = best.n >= 3 ? 0.95 : best.n === 2 ? 0.9 : 0.75;
    const [only, ...more] = best.jill.required ?? [];
    const text = message.trim().slice(0, MAX_INPUT);
    const inputs = only !== undefined && !more.length && text ? { [only]: text } : {};
    return { label: "new", jill: best.jill.name, inputs, confidence, matcher: "keywords" };
  },
};
export default keywordsMatcher;
