import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { bootId } from "./proc.js";
import { readJson, sleep, writeJsonAtomic } from "./util.js";

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
}

export interface RunEvent {
  at: string;
  type: "started" | "step-started" | "step-done" | "finished" | "failed" | "stuck" | "needs-you";
  step?: string;
  note?: string;
}

/** Written by the runner every few seconds. mono/since are process.hrtime.bigint() (ns, one clock for every process on a boot). */
export interface Heartbeat {
  at: string;
  mono: string;
  since: string;
  bootId?: string;
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
  /** The runner process (it has JILLS_RUN_ID=<id> in its env when started detached). */
  pid?: number;
  heartbeat?: Heartbeat;
  logDir: string;
  steps: Record<string, StepRecord>;
  events: RunEvent[];
  error?: string;
  conflicts?: string[];
  /** Total time limit as written, and in ms after defaults and clamping. */
  timeLimit?: string;
  timeLimitMs?: number;
  /** When the total time limit runs out (ISO time); set when the run starts. */
  deadline?: string;
}

export const runsDir = (home: string) => join(home, "runs");
export const recordPath = (home: string, id: string) => join(runsDir(home), `${id}.json`);
export const runLogDir = (home: string, id: string) => join(runsDir(home), id);

export function saveRecord(home: string, r: RunRecord): void {
  writeJsonAtomic(recordPath(home, r.id), r);
}

export function loadRecord(home: string, id: string): RunRecord | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return undefined;
  return readJson<RunRecord>(recordPath(home, id));
}

/** Write only the heartbeat; never touches a record that is already terminal on disk. Returns false then. */
export function saveHeartbeat(home: string, id: string, hb: Heartbeat): boolean {
  const r = loadRecord(home, id);
  if (!r || TERMINAL.has(r.state)) return false;
  r.heartbeat = hb;
  saveRecord(home, r);
  return true;
}

export function listRecords(home: string): RunRecord[] {
  const dir = runsDir(home);
  if (!existsSync(dir)) return [];
  const out = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => readJson<RunRecord>(join(dir, f)));
  return (out.filter(Boolean) as RunRecord[]).sort((a, b) => (a.created < b.created ? 1 : -1));
}

const QUEUED_GRACE_MS = 60_000;
/** A running record this long past its deadline may be stuck. */
export const DEADLINE_GRACE_MS = 30_000;
/** A heartbeat whose monotonic stamp is this old (on the observer's clock) means the runner hangs. */
export const STALE_MS = 30_000;

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Why an observer should call this running record stuck, or undefined. Stateless:
 * - the runner is gone (another boot, or its pid no longer exists);
 * - past the deadline (wall clock) and the runner's own monotonic time is past
 *   the limit, or its stamp stopped advancing on this observer's monotonic clock.
 * A suspend moves wall time but not the monotonic clock, so it alone never decides it.
 */
export function stuckReason(r: RunRecord, staleMs = STALE_MS): string | undefined {
  const hb = r.heartbeat;
  const sameBoot = !hb?.bootId || hb.bootId === bootId();
  if (!sameBoot || (r.pid !== undefined && !pidAlive(r.pid))) return "the runner process is gone";
  if (!r.deadline || Date.now() <= Date.parse(r.deadline) + DEADLINE_GRACE_MS) return undefined;
  if (!hb?.mono || !hb.since) return `total time limit ${r.timeLimit ?? "?"} passed and the runner never beat`;
  const ns = (ms: number) => BigInt(Math.round(ms)) * 1_000_000n;
  if (r.timeLimitMs !== undefined && BigInt(hb.mono) - BigInt(hb.since) > ns(r.timeLimitMs + DEADLINE_GRACE_MS))
    return `total time limit ${r.timeLimit ?? "?"} passed and the runner did not stop the run`;
  if (process.hrtime.bigint() - BigInt(hb.mono) > ns(staleMs)) return `total time limit ${r.timeLimit ?? "?"} passed and the runner stopped beating`;
  return undefined;
}

/**
 * Read a record and notice a dead or hung runner. Observers never signal
 * anything: a queued run whose runner never started becomes failed; a running
 * one with a stuckReason becomes stuck (`jills stop <id>` stops its processes).
 */
export function refreshRecord(home: string, id: string, staleMs?: number): RunRecord | undefined {
  const r = loadRecord(home, id);
  if (!r || TERMINAL.has(r.state)) return r;
  const at = new Date().toISOString();
  if (r.state === "queued") {
    if (Date.now() - Date.parse(r.created) <= QUEUED_GRACE_MS) return r;
    r.state = "failed";
    r.error = "runner never started";
  } else {
    const why = stuckReason(r, staleMs);
    if (!why) return r;
    r.state = "stuck";
    r.error = `${why}; run \`jills stop ${r.id}\` to stop its processes`;
    for (const s of Object.values(r.steps)) if (s.state === "running") Object.assign(s, { state: "stuck", reason: why, finished: at });
  }
  r.finished = at;
  r.events.push({ at, type: r.state as RunEvent["type"], note: r.error });
  const again = loadRecord(home, id); // lower the race with a finishing runner
  if (!again || TERMINAL.has(again.state)) return again;
  saveRecord(home, r);
  return r;
}

export interface WaitOpts {
  timeoutMs?: number;
  pollMs?: number;
  /** Observer-clock age of a heartbeat stamp that counts as stopped (default STALE_MS). */
  staleMs?: number;
  onUpdate?: (r: RunRecord) => void;
}

/** Block until the run reaches a terminal state (or timeoutMs passes). */
export async function waitForRun(home: string, id: string, o: WaitOpts = {}): Promise<{ record: RunRecord; timedOut: boolean }> {
  const t0 = Date.now();
  let lastEvents = -1;
  for (;;) {
    const r = refreshRecord(home, id, o.staleMs);
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
