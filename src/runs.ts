import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { groupAlive, groupIsOurs, sameProcess } from "./proc.js";
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
  /** Start token of the step's process (group leader); see procStartToken. */
  pidStart?: string;
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
  /** Start token of the runner process; signals go only to this exact process. */
  pidStart?: string;
  /** Written by the runner every few seconds: wall time and its own monotonic elapsed time. */
  heartbeat?: { at: string; elapsedMs: number };
  logDir: string;
  steps: Record<string, StepRecord>;
  events: RunEvent[];
  error?: string;
  conflicts?: string[];
  /** Total time limit as written (Jill timeout or config default_timeout). */
  timeLimit?: string;
  /** Total time limit actually used, in ms (after defaults and clamping). */
  timeLimitMs?: number;
  /** When the total time limit runs out (ISO time); set when the run starts. */
  deadline?: string;
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
/** A running record this long past its deadline may be stuck (see refreshRecord). */
export const DEADLINE_GRACE_MS = 30_000;
/** A heartbeat older than this (wall clock) is stale; stuck needs it stale this long on the observer's own clock too. */
export const STALE_MS = 30_000;
/** Grace between SIGTERM and SIGKILL when an observer stops a runner or its steps. */
export const KILL_GRACE_MS = 5_000;

export interface RefreshOpts {
  /** Observer-clock window a stale heartbeat must stay unchanged before stuck (default STALE_MS). */
  staleMs?: number;
  /** Grace between SIGTERM and SIGKILL (default KILL_GRACE_MS). */
  killGraceMs?: number;
}

/** Is the recorded runner still the same live process? */
function runnerAlive(r: RunRecord): boolean {
  if (r.pid === undefined) return false;
  if (r.pidStart) return sameProcess(r.pid, r.pidStart);
  return isPidAlive(r.pid); // records from before start tokens
}

/** First time (observer's monotonic clock) each run's current stale heartbeat was seen. */
const staleSeen = new Map<string, { beat: string; since: number }>();

/**
 * Decide stuck for a running record whose runner is alive. The wall-clock
 * deadline alone never decides it (a suspend or clock jump moves wall time
 * while the runner's own timer, on the monotonic clock, has not fired):
 * - the runner's heartbeat says its own elapsed time is past the limit → stuck;
 * - a fresh heartbeat → alive and progressing → not stuck;
 * - a stale heartbeat → stuck only after it stays unchanged for staleMs of this
 *   observer's monotonic time (a resumed runner beats again within seconds).
 */
function isStuck(r: RunRecord, o: RefreshOpts, now = Date.now()): boolean {
  if (r.state !== "running" || !r.deadline) return false;
  const t = Date.parse(r.deadline);
  if (!Number.isFinite(t) || now <= t + DEADLINE_GRACE_MS) {
    staleSeen.delete(r.id);
    return false;
  }
  const hb = r.heartbeat;
  if (hb && r.timeLimitMs !== undefined && hb.elapsedMs > r.timeLimitMs + DEADLINE_GRACE_MS) return true;
  const staleMs = o.staleMs ?? STALE_MS;
  const beat = hb ? hb.at : "none";
  if (hb && now - Date.parse(hb.at) <= staleMs) {
    staleSeen.delete(r.id);
    return false;
  }
  const seen = staleSeen.get(r.id);
  const mono = performance.now();
  if (!seen || seen.beat !== beat) {
    staleSeen.set(r.id, { beat, since: mono });
    return staleMs <= 0;
  }
  return mono - seen.since >= staleMs;
}

/** Runs being stopped by this process: SIGTERM sent, SIGKILL pending. */
const reaping = new Map<string, Promise<void>>();

/** Resolves once this process has finished stopping run id (no-op when it is not). */
export function reaped(id: string): Promise<void> {
  return reaping.get(id) ?? Promise.resolve();
}

interface Target {
  pid: number;
  token?: string;
  group: boolean;
}

function targetOurs(t: Target): boolean {
  return t.group ? groupIsOurs(t.pid, t.token) : t.pid !== process.pid && sameProcess(t.pid, t.token);
}
function targetAlive(t: Target): boolean {
  return t.group ? groupAlive(t.pid) && groupIsOurs(t.pid, t.token) : sameProcess(t.pid, t.token);
}
function signal(t: Target, sig: NodeJS.Signals): void {
  if (!targetOurs(t)) return; // never signal a recycled pid
  try {
    process.kill(t.group ? -t.pid : t.pid, sig);
  } catch {
    /* already gone */
  }
}

/**
 * Stop targets without killing blindly: identity-checked SIGTERM now, then
 * identity-checked SIGKILL for survivors after the grace. Once they are gone,
 * save `final` again in case a dying runner wrote over it.
 */
function stopTargets(home: string, final: RunRecord, targets: Target[], graceMs: number): void {
  const mine = targets.filter(targetOurs);
  for (const t of mine) signal(t, "SIGTERM");
  if (!mine.length) return;
  const job = (async () => {
    const t0 = performance.now();
    while (mine.some(targetAlive) && performance.now() - t0 < graceMs) await sleep(100);
    for (const t of mine) if (targetAlive(t)) signal(t, "SIGKILL");
    for (let i = 0; i < 20 && mine.some(targetAlive); i++) await sleep(50);
    const disk = loadRecord(home, final.id);
    if (disk && (disk.state !== final.state || disk.finished !== final.finished)) saveRecord(home, final);
  })().finally(() => reaping.delete(final.id));
  reaping.set(final.id, job);
}

function stepTargets(r: RunRecord): Target[] {
  return Object.values(r.steps)
    .filter((s) => s.state === "running" && s.pid)
    .map((s) => ({ pid: s.pid!, token: s.pidStart, group: true }));
}

/**
 * Read a record and notice a dead or stuck runner: a running record whose
 * runner is gone (or a queued one that never started) becomes failed; one that
 * is stuck (see isStuck) becomes stuck. Processes are stopped with SIGTERM,
 * then SIGKILL after a grace, and only after their identity is checked.
 */
export function refreshRecord(home: string, id: string, o: RefreshOpts = {}): RunRecord | undefined {
  const r = loadRecord(home, id);
  if (!r || TERMINAL.has(r.state)) return r;
  if (reaping.has(id)) return r;
  const dead =
    (r.state === "running" && r.pid !== undefined && !runnerAlive(r)) ||
    (r.state === "queued" && Date.now() - Date.parse(r.created) > QUEUED_GRACE_MS && !runnerAlive(r));
  if (!dead && !isStuck(r, o)) return r;
  // Re-read right before writing to lower the race with a finishing runner.
  const again = loadRecord(home, id);
  if (!again || TERMINAL.has(again.state)) return again;
  if (!dead) return markStuck(home, again, o);
  const wasQueued = again.state === "queued";
  const targets = stepTargets(again);
  again.state = "failed";
  again.error = wasQueued ? "runner never started" : "runner process exited without finishing the run";
  again.finished = new Date().toISOString();
  // The runner is gone, but its step process groups may still be running and
  // editing the worktree: stop each step group still marked running.
  for (const s of Object.values(again.steps)) {
    if (s.state !== "running") continue;
    s.state = "failed";
    s.reason = "runner died; step process group stopped";
    s.finished = again.finished;
  }
  again.events.push({ at: again.finished, type: "failed", note: again.error });
  saveRecord(home, again);
  stopTargets(home, again, targets, o.killGraceMs ?? KILL_GRACE_MS);
  return again;
}

/**
 * The runner let the run go past its total time limit (it hangs or ignored its
 * timer): record stuck, then stop the runner and every step group still
 * running (SIGTERM, SIGKILL after a grace, identity-checked so a recycled pid
 * is never hit). The stuck record is saved again after they are gone, so a
 * dying runner cannot leave its own outcome behind.
 */
function markStuck(home: string, r: RunRecord, o: RefreshOpts): RunRecord {
  const targets = stepTargets(r);
  if (r.pid && r.pid !== process.pid) targets.unshift({ pid: r.pid, token: r.pidStart, group: false });
  const at = new Date().toISOString();
  for (const s of Object.values(r.steps)) {
    if (s.state !== "running") continue;
    s.state = "stuck";
    s.reason = "run passed its total time limit; step process group stopped";
    s.finished = at;
  }
  r.state = "stuck";
  r.error = `total time limit ${r.timeLimit ?? "?"} passed and the runner did not stop the run; runner and steps stopped`;
  r.finished = at;
  r.events.push({ at, type: "stuck", note: r.error });
  saveRecord(home, r);
  staleSeen.delete(r.id);
  stopTargets(home, r, targets, o.killGraceMs ?? KILL_GRACE_MS);
  return r;
}

export interface WaitOpts extends RefreshOpts {
  timeoutMs?: number;
  pollMs?: number;
  onUpdate?: (r: RunRecord) => void;
}

/** Block until the run reaches a terminal state (or timeoutMs passes). */
export async function waitForRun(home: string, id: string, o: WaitOpts = {}): Promise<{ record: RunRecord; timedOut: boolean }> {
  const t0 = Date.now();
  let lastEvents = -1;
  for (;;) {
    let r = refreshRecord(home, id, o);
    if (!r) throw new Error(`no run ${id}`);
    if (TERMINAL.has(r.state) && reaping.has(id)) {
      await reaped(id);
      r = loadRecord(home, id) ?? r;
    }
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
