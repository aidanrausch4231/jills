import type { CheckPlugin } from "./types.js";

/** A step passes when its process exits 0 without timeout or abort. */
const exitCodeCheck: CheckPlugin = {
  slot: "check",
  apiVersion: 1,
  name: "exit-code",
  check: async ({ result }) => {
    if (result.timedOut) return { ok: false, reason: "timed out" };
    if (result.aborted) return { ok: false, reason: "stopped" };
    if (result.exitCode === 0) return { ok: true };
    return { ok: false, reason: result.signal ? `killed by ${result.signal}` : `exit code ${result.exitCode}` };
  },
};
export default exitCodeCheck;
