/**
 * Example hook plug-in: when a run ends, append its one-line result to the file
 * named in config `notify: {file: ...}`, or print it to the runner log.
 *
 *   # $JILLS_HOME/config.yml
 *   plugins: [/path/to/jills/dist/examples/plugins/notify.js]
 *   notify: {file: ~/jills-done.txt}
 */
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import type { HookPlugin } from "../../src/plugins/types.js";
import { resultLine } from "../../src/runs.js";

const ENDS = new Set(["finished", "failed", "stuck", "needs-you"]);

const notify: HookPlugin = {
  slot: "hook",
  apiVersion: 1,
  name: "notify",
  on(event, record, config) {
    if (!ENDS.has(event.type)) return;
    const file = (config.raw.notify as { file?: string } | undefined)?.file;
    const line = resultLine(record);
    if (file) appendFileSync(file.replace(/^~(?=\/)/, homedir()), line + "\n");
    else console.log(`[notify] ${line}`);
  },
};
export default notify;
