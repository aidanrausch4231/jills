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
