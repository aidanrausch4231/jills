import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { StepRunResult } from "./plugins/types.js";
import { sleep } from "./util.js";

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

/** This boot's id (Linux); undefined elsewhere. */
export function bootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return undefined;
  }
}

/** Pids whose environment holds JILLS_RUN_ID=<runId> (the runner, its steps and their children). */
export function taggedPids(runId: string): number[] {
  const tag = `JILLS_RUN_ID=${runId}`;
  const out: number[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync("/proc");
  } catch {
    return out;
  }
  for (const e of entries) {
    const pid = Number(e);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    try {
      if (readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(tag)) out.push(pid);
    } catch {
      /* gone or not ours */
    }
  }
  return out;
}

/**
 * `jills stop`: SIGTERM every process tagged with this run id, then SIGKILL the
 * ones still tagged after the grace. Nothing else is ever signaled; a record
 * from another boot (bootId differs) signals nothing. Returns the pids signaled.
 */
export async function stopTagged(runId: string, recordedBoot: string | undefined, graceMs = 3000): Promise<number[]> {
  if (recordedBoot && recordedBoot !== bootId()) return [];
  const hit = taggedPids(runId);
  for (const pid of hit) signal(pid, "SIGTERM");
  for (let t = 0; t < graceMs && taggedPids(runId).length; t += 100) await sleep(100);
  for (const pid of taggedPids(runId)) signal(pid, "SIGKILL"); // re-scanned: a recycled pid is not tagged
  return hit;
}

function signal(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(pid, sig);
  } catch {
    /* already gone */
  }
}
