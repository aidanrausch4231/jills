import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { RunnerPlugin, StepRunResult } from "./types.js";

export interface SpawnOpts {
  cmd: string;
  args: string[];
  cwd: string;
  logPath: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function killGroup(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(-pid, sig);
  } catch {
    /* already gone */
  }
}

/**
 * Run a process in its own process group, output to logPath. Only the runner
 * calls this: on timeout or abort it stops the group it spawned (SIGTERM, then SIGKILL).
 */
export function spawnLogged(o: SpawnOpts): Promise<StepRunResult> {
  mkdirSync(dirname(o.logPath), { recursive: true });
  const fd = openSync(o.logPath, "a");
  return new Promise((resolve) => {
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const child = spawn(o.cmd, o.args, { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ["ignore", fd, fd], detached: true });
    const pid = child.pid;
    const stop = () => {
      if (!pid) return;
      killGroup(pid, "SIGTERM");
      setTimeout(() => killGroup(pid, "SIGKILL"), 2000).unref();
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    const timer = o.timeoutMs && o.timeoutMs > 0 ? setTimeout(() => ((timedOut = true), stop()), o.timeoutMs) : undefined;
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (r: StepRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      if ((timedOut || aborted) && pid) killGroup(pid, "SIGKILL"); // no grandchild survives
      closeSync(fd);
      resolve(r);
    };
    child.on("error", (e) => {
      try {
        writeSync(fd, `\n[jills] failed to start ${o.cmd}: ${e.message}\n`);
      } catch {
        /* ignore */
      }
      finish({ exitCode: 127, timedOut, aborted });
    });
    child.on("exit", (code, sig) => finish({ exitCode: code, timedOut, aborted, signal: sig ?? undefined }));
  });
}

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
