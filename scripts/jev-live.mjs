// Live check (not part of `pnpm test`): five sample messages through the real Jev matcher.
// Needs TYPESAFE_API_KEY in the environment. Prints label, jill, probabilities and latency; never the key.
import { loadConfig } from "../dist/src/config.js";
import jevMatcher from "../dist/src/plugins/matcher-jev.js";

if (!process.env.TYPESAFE_API_KEY) {
  console.error("TYPESAFE_API_KEY is not set");
  process.exit(1);
}
const config = loadConfig(process.env.JILLS_HOME ?? "/nonexistent-jills-home");
const jills = [
  { name: "fix-bug", description: "Find and fix a bug in the repo, with a test", when: "The user reports something broken or a bug to fix", inputs: ["task"], keywords: [], required: ["task"] },
  { name: "research", description: "Research how something works and write a short report", when: "The user asks to investigate or compare options and wants a written result", inputs: ["topic"], keywords: [], required: ["topic"] },
  { name: "release-notes", description: "Draft release notes from the merged PRs", when: "The user wants release notes or a changelog", inputs: [], keywords: [] },
];
const earlier = [
  { role: "user", text: "The checkout total shows 10.01 instead of 10.00 for two items." },
  { role: "assistant", text: "That looks like a rounding bug in the cart code." },
];
const cases = [
  { message: "The login page throws a 500 when the password has a quote in it", recent: [], already: [] },
  { message: "thanks, that makes sense!", recent: earlier, already: [] },
  { message: "fix it", recent: earlier, already: [] },
  { message: "can you compare sqlite and postgres for our job queue and write it up?", recent: [], already: [] },
  { message: "also make sure the quote case is covered", recent: earlier, already: ["fix-bug"] },
];
for (const c of cases) {
  const t0 = Date.now();
  const r = await jevMatcher.match({ ...c, jills, config });
  const ms = Date.now() - t0;
  console.log(JSON.stringify({ message: c.message, ms, result: r ?? "undefined (no answer)" }));
}
