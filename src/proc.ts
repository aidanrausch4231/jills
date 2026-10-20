import { readdirSync, readFileSync } from "node:fs";
import { sleep } from "./util.js";

/** This boot's id (Linux); undefined elsewhere. */
export function bootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return undefined;
  }
}

/** process.kill without throwing. With sig 0 it only probes: true while the pid exists (EPERM counts). */
export function signal(pid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    return process.kill(pid, sig);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Pids whose environment holds JILLS_RUN_ID=<runId> (the runner, its steps and
 * their children); with `pgrp`, only members of that process group (/proc/<pid>/stat).
 */
export function taggedPids(runId: string, pgrp?: number): number[] {
  const tag = `JILLS_RUN_ID=${runId}`;
  let entries: string[] = [];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  return entries.map(Number).filter((pid) => {
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); // "pid (comm) state ppid pgrp ..."
      if (pgrp !== undefined && Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) !== pgrp) return false;
      return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(tag);
    } catch {
      return false; // gone or not ours
    }
  });
}

/**
 * `jills stop`: SIGTERM every process tagged with this run id, then SIGKILL the
 * ones still tagged after the grace. Nothing else is ever signaled; a record
 * from another boot (bootId differs) signals nothing. Returns the pids signaled.
 */
export async function stopTagged(runId: string, recordedBoot: string | undefined, graceMs = 3000, preserve: number[] = []): Promise<number[]> {
  if (recordedBoot && recordedBoot !== bootId()) return [];
  const targets = () => taggedPids(runId).filter((pid) => !preserve.includes(pid));
  const hit = targets();
  for (const pid of hit) signal(pid, "SIGTERM");
  for (let t = 0; t < graceMs && targets().length; t += 100) await sleep(100);
  for (const pid of targets()) signal(pid, "SIGKILL"); // re-scanned: a recycled pid is not tagged
  return hit;
}
