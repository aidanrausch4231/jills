import { spawnLogged } from "../proc.js";
import type { RunnerPlugin } from "./types.js";

/** Runs `run:` steps with bash -c in the step's workspace. */
const commandRunner: RunnerPlugin = {
  slot: "runner",
  apiVersion: 1,
  name: "command",
  canRun: (step) => step.run !== undefined,
  describe: (ctx) => `bash -c ${JSON.stringify(ctx.text)}  (cwd ${ctx.cwd})`,
  run: (ctx) => spawnLogged({ cmd: "bash", args: ["-c", ctx.text], cwd: ctx.cwd, logPath: ctx.logPath, env: ctx.env, timeoutMs: ctx.timeoutMs, signal: ctx.signal }),
};
export default commandRunner;
