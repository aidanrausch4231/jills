import { existsSync, readFileSync } from "node:fs";
import type { CheckPlugin } from "./types.js";

/**
 * A step with `verdict: true` passes only when the last `VERDICT:` line of its
 * output says `VERDICT: clean` (case-insensitive; trailing `.`, `*`, `_` or `` ` ``
 * ignored). A missing line fails. Steps without `verdict: true` always pass.
 */
const verdictCheck: CheckPlugin = {
  slot: "check",
  apiVersion: 1,
  name: "verdict",
  check: async ({ step, logPath }) => {
    if (step.extra.verdict !== true) return { ok: true };
    const text = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const last = [...text.matchAll(/VERDICT:[ \t]*([^\r\n]*)/gi)].pop();
    if (!last) return { ok: false, reason: "no VERDICT: line in the output (want VERDICT: clean)" };
    const verdict = last[1]!.replace(/[\s.*_`]+$/, "");
    return /^clean$/i.test(verdict) ? { ok: true } : { ok: false, reason: `VERDICT: ${verdict || "(empty)"}` };
  },
};
export default verdictCheck;
