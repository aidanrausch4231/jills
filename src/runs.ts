import { bootId, signal } from "./proc.js";
import jsonBackend from "./plugins/backend-json.js";
import type { BackendPlugin } from "./plugins/types.js";
export { runsDir, recordPath, runLogDir, heartbeatPath } from "./plugins/backend-json.js";

export type RunState = "queued" | "running" | "done" | "failed" | "stuck" | "needs-you";
export type StepState = "pending" | "running" | "done" | "failed" | "stuck" | "needs-you" | "skipped";

export const TERMINAL: ReadonlySet<RunState> = new Set(["done", "failed", "stuck", "needs-you"]);

/** One step instance; key = `<nested prefix/><step>[#copy][@round]` (round 2+ of a back-arrow loop). */
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
  /** Where it ran: workspace folder, git branch, and the commit Jills made for it. */
  workspace?: string;
  branch?: string;
  commit?: string;
}

export type RunEvent = { at: string; type: "started" | "step-started" | "step-done" | "finished" | "failed" | "stuck" | "needs-you"; step?: string; note?: string };

/**
 * Written by the runner every few seconds, separately from the run record.
 * mono/since are process.hrtime.bigint() (ns, one clock for every process on a boot).
 */
export type Heartbeat = { at: string; mono: string; since: string; bootId?: string };

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
  /** The branch the run started from (worktree runs); a `merges: true` step merges into it. */
  base?: string;
  isolated?: boolean;
  session?: string;
  /** The runner process (it has JILLS_RUN_ID=<id> in its env when started detached). */
  pid?: number;
  /** Detached executor supervisor; its heartbeat spans engine retries. */
  executorPid?: number;
  executorBootId?: string;
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

/** Storage helpers accept the selected backend; standalone callers default to JSON. */
export const loadHeartbeat = (home: string, id: string, backend = jsonBackend) => backend.loadBeat(home, id);
export const saveRecord = (home: string, r: RunRecord, backend = jsonBackend): void => backend.save(home, r);
export const loadRecord = (home: string, id: string, backend = jsonBackend) => backend.load(home, id);
export const listRecords = (home: string, backend = jsonBackend) => backend.list(home);

const QUEUED_GRACE_MS = 60_000;
/** A running record this long past its deadline may be stuck. */
export const DEADLINE_GRACE_MS = 30_000;
/** A heartbeat whose monotonic stamp is this old (on the observer's clock) means the runner hangs. */
export const STALE_MS = 30_000;

/**
 * Why an observer should call this running record stuck, or undefined. Stateless:
 * - the runner is gone (another boot, or its pid no longer exists);
 * - past the deadline (wall clock) and the runner's own monotonic time is past
 *   the limit, or its stamp stopped advancing on this observer's monotonic clock.
 * A suspend moves wall time but not the monotonic clock, so it alone never decides it.
 */
export function stuckReason(r: RunRecord, hb: Heartbeat | undefined, staleMs = STALE_MS): string | undefined {
  const sameBoot = !hb?.bootId || hb.bootId === bootId();
  if (!sameBoot || (r.pid !== undefined && !(r.pid > 0 && signal(r.pid, 0)))) return "the runner process is gone";
  if (!r.deadline || Date.now() <= Date.parse(r.deadline) + DEADLINE_GRACE_MS) return undefined;
  if (!hb?.mono || !hb.since) return `total time limit ${r.timeLimit ?? "?"} passed and the runner never beat`;
  const ns = (ms: number) => BigInt(Math.round(ms)) * 1_000_000n;
  if (r.timeLimitMs !== undefined && BigInt(hb.mono) - BigInt(hb.since) > ns(r.timeLimitMs + DEADLINE_GRACE_MS))
    return `total time limit ${r.timeLimit ?? "?"} passed and the runner did not stop the run`;
  if (process.hrtime.bigint() - BigInt(hb.mono) > ns(staleMs)) return `total time limit ${r.timeLimit ?? "?"} passed and the runner stopped beating`;
  return undefined;
}

/**
 * Write an observer's terminal mark: the run and its running steps end as
 * `state`. Re-reads first, so a record its runner finished meanwhile wins.
 */
export function markTerminal(home: string, r: RunRecord, state: "failed" | "stuck", error: string, stepReason = error, backend: BackendPlugin = jsonBackend): RunRecord | undefined {
  const at = new Date().toISOString();
  Object.assign(r, { state, error, finished: at });
  for (const s of Object.values(r.steps)) if (s.state === "running") Object.assign(s, { state, reason: stepReason, finished: at });
  r.events.push({ at, type: state, note: error });
  const again = loadRecord(home, r.id, backend); // lower the race with a finishing runner
  if (!again || TERMINAL.has(again.state)) return again;
  saveRecord(home, r, backend);
  return r;
}

/**
 * Read a record and notice a dead or hung runner. Observers never signal
 * anything: a queued run whose runner never started becomes failed; a running
 * one with a stuckReason becomes stuck (`jills stop <id>` stops its processes).
 */
export function refreshRecord(home: string, id: string, staleMs?: number, backend: BackendPlugin = jsonBackend): RunRecord | undefined {
  const r = loadRecord(home, id, backend);
  if (!r || TERMINAL.has(r.state)) return r;
  const hb = loadHeartbeat(home, id, backend);
  if (r.executorPid && (!r.executorBootId || r.executorBootId === bootId()) && signal(r.executorPid, 0) && hb?.mono &&
    process.hrtime.bigint() - BigInt(hb.mono) <= BigInt(staleMs ?? STALE_MS) * 1_000_000n) return r;
  if (r.state === "queued") return Date.now() - Date.parse(r.created) <= QUEUED_GRACE_MS ? r : markTerminal(home, r, "failed", "runner never started", undefined, backend);
  const why = stuckReason(r, hb, staleMs);
  return why ? markTerminal(home, r, "stuck", `${why}; run \`jills stop ${r.id}\` to stop its processes`, why, backend) : r;
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
