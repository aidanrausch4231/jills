import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { StepRunResult } from "./plugins/types.js";

export interface SpawnOpts {
  cmd: string;
  args: string[];
  cwd: string;
  logPath: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Grace period between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  /** Called with the pid (= process group id) right after spawn. */
  onSpawn?: (pid: number) => void;
}

export function killGroup(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run a process in its own process group, output to logPath.
 * On timeout or abort the whole group gets SIGTERM, then SIGKILL.
 */
export function spawnLogged(o: SpawnOpts): Promise<StepRunResult> {
  mkdirSync(dirname(o.logPath), { recursive: true });
  const fd = openSync(o.logPath, "a");
  return new Promise((resolve) => {
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(o.cmd, o.args, {
      cwd: o.cwd,
      env: { ...process.env, ...(o.env ?? {}) },
      stdio: ["ignore", fd, fd],
      detached: true,
    });
    const pid = child.pid;
    if (pid) {
      try {
        o.onSpawn?.(pid);
      } catch {
        /* never break a step */
      }
    }
    const stop = () => {
      if (!pid) return;
      killGroup(pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(pid, "SIGKILL"), o.killGraceMs ?? 2000);
      killTimer.unref();
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (o.timeoutMs && o.timeoutMs > 0)
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, o.timeoutMs);
    if (o.signal) {
      if (o.signal.aborted) onAbort();
      else o.signal.addEventListener("abort", onAbort, { once: true });
    }
    const finish = (r: StepRunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      // Make sure no grandchild survives a timeout/abort.
      if ((timedOut || aborted) && pid) killGroup(pid, "SIGKILL");
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    child.on("error", (e) => {
      try {
        writeSync(fd, `\n[jills] failed to start ${o.cmd}: ${e.message}\n`);
      } catch {
        /* ignore */
      }
      finish({ exitCode: 127, timedOut, aborted, pid });
    });
    child.on("exit", (code, sig) => {
      finish({ exitCode: code, timedOut, aborted, signal: sig ?? undefined, pid });
    });
  });
}

/**
 * A token that names one process instance: its start time. Linux reads
 * /proc/<pid>/stat (start time in clock ticks since boot); elsewhere `ps -o lstart=`.
 * A recycled pid gets a different token. undefined = no such process / unknown.
 */
export function procStartToken(pid: number | undefined): string | undefined {
  if (!pid || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 2 (comm) may hold spaces and parens; the rest follows the last ")".
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const start = rest[19]; // field 22: starttime
      return start ? `linux:${start}` : undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out ? `ps:${out}` : undefined;
  } catch {
    return undefined;
  }
}

/** True only when pid is alive AND is the same process instance as token. */
export function sameProcess(pid: number | undefined, token: string | undefined): boolean {
  if (!pid || !token) return false;
  return procStartToken(pid) === token;
}

/**
 * May we signal the process group led by pid (recorded with token)? Yes when
 * the leader is still the recorded process, or when the leader is gone (a pid
 * still used as a group id is never handed out again, so the group can only
 * be ours). No when the pid now names another process, or when no token was
 * recorded and the leader is alive (identity cannot be checked).
 */
export function groupIsOurs(pid: number | undefined, token: string | undefined): boolean {
  if (!pid || pid <= 1) return false;
  const now = procStartToken(pid);
  if (now === undefined) return true;
  return token !== undefined && now === token;
}

/** Does any process in group pid still exist? */
export function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
