import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { killGroup } from "./proc.js";
import { isPidAlive, readJson, sleep, writeJsonAtomic } from "./util.js";

export type RunState = "queued" | "running" | "done" | "failed" | "stuck" | "needs-you";
export type StepState = "pending" | "running" | "done" | "failed" | "stuck" | "needs-you" | "skipped";

export const TERMINAL: ReadonlySet<RunState> = new Set(["done", "failed", "stuck", "needs-you"]);

export interface StepRecord {
  key: string;
  step: string;
  jill: string;
  copy?: number;
  kind: "run" | "agent" | "jill";
  state: StepState;
  started?: string;
  finished?: string;
  exitCode?: number | null;
  reason?: string;
  log?: string;
  workspace?: string;
  branch?: string;
  commit?: string;
  pid?: number;
}

export interface RunEvent {
  at: string;
  type: "started" | "step-started" | "step-done" | "finished" | "failed" | "stuck" | "needs-you";
  step?: string;
  note?: string;
}

export interface RunRecord {
  version: 1;
  id: string;
  jill: string;
  jillPath: string;
  inputs: Record<string, string>;
  state: RunState;
  created: string;
  started?: string;
  finished?: string;
  repo: string;
  workspace?: string;
  branch?: string;
  isolated?: boolean;
  session?: string;
  pid?: number;
  logDir: string;
  steps: Record<string, StepRecord>;
  events: RunEvent[];
  error?: string;
  conflicts?: string[];
}

export function runsDir(home: string): string {
  return join(home, "runs");
}
export function recordPath(home: string, id: string): string {
  return join(runsDir(home), `${id}.json`);
}
export function runLogDir(home: string, id: string): string {
  return join(runsDir(home), id);
}

export function saveRecord(home: string, r: RunRecord): void {
  writeJsonAtomic(recordPath(home, r.id), r);
}

export function loadRecord(home: string, id: string): RunRecord | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return undefined;
  return readJson<RunRecord>(recordPath(home, id));
}

export function listRecords(home: string): RunRecord[] {
  const dir = runsDir(home);
  if (!existsSync(dir)) return [];
  const out: RunRecord[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const r = readJson<RunRecord>(join(dir, f));
    if (r) out.push(r);
  }
  return out.sort((a, b) => (a.created < b.created ? 1 : -1));
}

const QUEUED_GRACE_MS = 60_000;

/**
 * Read a record and notice a dead runner: a running record whose runner pid is
 * gone (or a queued one that never started) becomes failed.
 */
export function refreshRecord(home: string, id: string): RunRecord | undefined {
  const r = loadRecord(home, id);
  if (!r || TERMINAL.has(r.state)) return r;
  const dead =
    (r.state === "running" && r.pid !== undefined && !isPidAlive(r.pid)) ||
    (r.state === "queued" && Date.now() - Date.parse(r.created) > QUEUED_GRACE_MS && !isPidAlive(r.pid));
  if (!dead) return r;
  // Re-read right before writing to lower the race with a finishing runner.
  const again = loadRecord(home, id);
  if (!again || TERMINAL.has(again.state)) return again;
  const wasQueued = again.state === "queued";
  again.state = "failed";
  again.error = wasQueued ? "runner never started" : "runner process exited without finishing the run";
  again.finished = new Date().toISOString();
  // The runner is gone, but its step process groups may still be running and
  // editing the worktree: kill each step group still marked running.
  for (const s of Object.values(again.steps)) {
    if (s.state !== "running") continue;
    if (s.pid) killGroup(s.pid, "SIGKILL");
    s.state = "failed";
    s.reason = "runner died; step process group killed";
    s.finished = again.finished;
  }
  again.events.push({ at: again.finished, type: "failed", note: again.error });
  saveRecord(home, again);
  return again;
}

export interface WaitOpts {
  timeoutMs?: number;
  pollMs?: number;
  onUpdate?: (r: RunRecord) => void;
}

/** Block until the run reaches a terminal state (or timeoutMs passes). */
export async function waitForRun(home: string, id: string, o: WaitOpts = {}): Promise<{ record: RunRecord; timedOut: boolean }> {
  const t0 = Date.now();
  let lastEvents = -1;
  for (;;) {
    const r = refreshRecord(home, id);
    if (!r) throw new Error(`no run ${id}`);
    if (r.events.length !== lastEvents) {
      lastEvents = r.events.length;
      o.onUpdate?.(r);
    }
    if (TERMINAL.has(r.state)) return { record: r, timedOut: false };
    if (o.timeoutMs !== undefined && Date.now() - t0 >= o.timeoutMs) return { record: r, timedOut: true };
    await sleep(o.pollMs ?? 250);
  }
}

/** One-line result, e.g. for `jills wait`. */
export function resultLine(r: RunRecord): string {
  const parts = [`jills run ${r.id} ${r.state}: ${r.jill}`];
  if (r.branch) parts.push(`branch ${r.branch}`);
  if (r.workspace) parts.push(`worktree ${r.workspace}`);
  parts.push(`logs ${r.logDir}`);
  if (r.state === "needs-you" && r.conflicts?.length) parts.push(`conflicts: ${r.conflicts.join(", ")}`);
  if (r.error && r.state !== "done") parts.push(`(${r.error})`);
  return parts.join(" | ");
}
