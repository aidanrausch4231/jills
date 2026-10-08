import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TIMEOUT, type JillsConfig } from "./config.js";
import { checkNesting, MAX_DEPTH, v1Refusal, type JillDef, type StepDef } from "./jillfile.js";
import type { PluginSet } from "./plugins/index.js";
import type { IsolationPlugin, RunnerPlugin, Workspace } from "./plugins/types.js";
import { saveRecord, TERMINAL, type RunEvent, type RunRecord, type RunState, type StepRecord } from "./runs.js";
import { renderShellTemplate, renderTemplate } from "./template.js";
import { clampTimerMs, KeyedMutex, MAX_TIMER_MS, parseDuration } from "./util.js";
import { procStartToken } from "./proc.js";

export type Outcome = "done" | "failed" | "stuck" | "needs-you";
export type EventListener = (e: RunEvent, r: RunRecord) => void;

const OUTPUT_LIMIT = 8000;
/** How often a runner writes its heartbeat into the run record. */
export const HEARTBEAT_MS = 5_000;

/**
 * The total time limit a run actually uses: the Jill's timeout, else config
 * default_timeout, else 2h. A value that parses to <= 0 falls through to the
 * next one; the result is clamped to the largest timer Node allows. `label`
 * names the value used (recorded as timeLimit).
 */
export function totalLimit(jillTimeout: unknown, configDefault: unknown): { label: string; ms: number } {
  for (const v of [jillTimeout, configDefault, DEFAULT_TIMEOUT]) {
    const ms = parseDuration(v);
    if (ms === undefined || !(ms > 0)) continue;
    if (ms > MAX_TIMER_MS) return { label: `${MAX_TIMER_MS}ms`, ms: MAX_TIMER_MS };
    return { label: String(v), ms };
  }
  return { label: DEFAULT_TIMEOUT, ms: parseDuration(DEFAULT_TIMEOUT)! };
}

/** Steps that write and may run at the same time as another writer → child worktrees. */
export function parallelWriters(jill: JillDef, lookup: (n: string) => JillDef | undefined): Set<string> {
  const by = new Map(jill.steps.map((s) => [s.name, s]));
  const ancestors = new Map<string, Set<string>>();
  const anc = (n: string): Set<string> => {
    const hit = ancestors.get(n);
    if (hit) return hit;
    const set = new Set<string>();
    ancestors.set(n, set);
    for (const d of by.get(n)?.needs ?? []) {
      set.add(d);
      for (const x of anc(d)) set.add(x);
    }
    return set;
  };
  const writers = jill.steps.filter((s) => stepWrites(s, lookup, new Set()));
  const out = new Set<string>();
  for (const w of writers) {
    if (w.copies > 1) out.add(w.name);
    for (const o of writers) {
      if (o === w) continue;
      if (!anc(w.name).has(o.name) && !anc(o.name).has(w.name)) out.add(w.name);
    }
  }
  return out;
}

function stepWrites(s: StepDef, lookup: (n: string) => JillDef | undefined, seen: Set<string>): boolean {
  if (s.writes) return true;
  if (!s.jill || seen.has(s.jill)) return false;
  const j = lookup(s.jill);
  if (!j) return false;
  seen.add(s.jill);
  return j.steps.some((x) => stepWrites(x, lookup, seen));
}

function readOutput(path: string | undefined): string {
  if (!path || !existsSync(path)) return "";
  const t = readFileSync(path, "utf8");
  return (t.length > OUTPUT_LIMIT ? t.slice(-OUTPUT_LIMIT) : t).trim();
}

function now(): string {
  return new Date().toISOString();
}

export interface EngineOpts {
  config: JillsConfig;
  plugins: PluginSet;
  lookup: (name: string) => JillDef | undefined;
  onEvent?: EventListener;
  /** Abort from outside (e.g. the runner got SIGTERM): kills running steps, run ends failed. */
  signal?: AbortSignal;
}

/**
 * Runs one Jill's step graph for a run record. Steps whose `needs` are done
 * start in parallel; `copies` start N instances; `jill:` steps run inline in the
 * same run and workspace. The first failing step stops the run.
 */
export class RunEngine {
  private record: RunRecord;
  private o: EngineOpts;
  private abort = new AbortController();
  private outcome: Outcome | undefined;
  private mutex = new KeyedMutex();
  private saving: Promise<void> = Promise.resolve();
  private isolation: IsolationPlugin | undefined;

  constructor(record: RunRecord, o: EngineOpts) {
    this.record = record;
    this.o = o;
  }

  private save(): void {
    saveRecord(this.o.config.home, this.record);
  }

  private emit(type: RunEvent["type"], step?: string, note?: string): void {
    const e: RunEvent = { at: now(), type, step, note };
    this.record.events.push(e);
    this.save();
    try {
      this.o.onEvent?.(e, this.record);
    } catch {
      /* listeners never break a run */
    }
  }

  /** Stop the run with this outcome (first one wins) and kill running steps. */
  private halt(outcome: Outcome, reason: string): void {
    if (this.outcome) return;
    this.outcome = outcome;
    if (!this.record.error) this.record.error = reason;
    this.abort.abort();
  }

  async execute(): Promise<RunRecord> {
    const r = this.record;
    const jill = this.o.lookup(r.jill);
    r.state = "running";
    r.started = now();
    r.pid = process.pid;
    r.pidStart = procStartToken(process.pid);
    // Heartbeat: wall time + this runner's own monotonic elapsed time, so an
    // observer can tell a live runner after a suspend/clock jump from a hung one.
    const t0 = performance.now();
    const beat = () => {
      r.heartbeat = { at: now(), elapsedMs: Math.round(performance.now() - t0) };
    };
    beat();
    const heart = setInterval(() => {
      if (TERMINAL.has(r.state)) return;
      beat();
      this.save();
    }, HEARTBEAT_MS);
    heart.unref();
    this.emit("started", undefined, r.jill);
    let totalTimer: NodeJS.Timeout | undefined;
    const ext = this.o.signal;
    const onStop = () => this.halt("failed", `runner stopped: ${String(ext?.reason ?? "aborted")}`);
    if (ext) {
      if (ext.aborted) onStop();
      else ext.addEventListener("abort", onStop, { once: true });
    }
    try {
      if (!jill) throw new Error(`unknown Jill "${r.jill}"`);
      const refusal = v1Refusal(jill, this.o.plugins.isolation);
      if (refusal) throw new Error(refusal);
      checkNesting(jill, this.o.lookup);
      // Every run has a total time limit: the Jill's, else config default_timeout
      // (default 2h). The deadline is saved so `jills wait` can report stuck
      // even when this runner hangs past it (see refreshRecord).
      const { label, ms: totalMs } = totalLimit(jill.timeout, this.o.config.default_timeout);
      r.timeLimit = label;
      r.timeLimitMs = totalMs;
      r.deadline = new Date(Date.now() + totalMs).toISOString();
      this.save();
      totalTimer = setTimeout(() => this.halt("stuck", `total time limit ${label} reached`), totalMs);
      let ws: Workspace;
      if (jill.worktree || jill.box) {
        // box: <name> picks that isolation extension (checked by v1Refusal above).
        const isoName = jill.box ?? (typeof jill.extra.isolation === "string" ? jill.extra.isolation : "worktree");
        const iso = this.o.plugins.isolation.get(isoName);
        if (!iso) throw new Error(`no isolation plug-in "${isoName}"`);
        this.isolation = iso;
        ws = await iso.prepare({ repo: r.repo, jill: jill.name, runId: r.id, config: this.o.config });
      } else {
        ws = { dir: r.repo, isolated: false };
      }
      r.workspace = ws.dir;
      r.branch = ws.branch;
      r.isolated = ws.isolated;
      this.save();
      const out = await this.runGraph(jill, ws, r.inputs, 1, [jill.name], "");
      this.finish(this.outcome ?? out);
    } catch (e) {
      if (!r.error) r.error = (e as Error).message;
      this.finish(this.outcome ?? "failed");
    } finally {
      if (totalTimer) clearTimeout(totalTimer);
      clearInterval(heart);
      ext?.removeEventListener("abort", onStop);
    }
    await this.saving;
    return r;
  }

  private finish(outcome: Outcome): void {
    const r = this.record;
    r.state = outcome as RunState;
    r.finished = now();
    for (const s of Object.values(r.steps)) if (s.state === "pending") s.state = "skipped";
    if (outcome === "done") delete r.error;
    this.emit(outcome === "done" ? "finished" : outcome, undefined, r.error);
  }

  private stepRecord(key: string, init: Omit<StepRecord, "key" | "state">): StepRecord {
    const s: StepRecord = { key, state: "pending", ...init };
    this.record.steps[key] = s;
    return s;
  }

  private async runGraph(
    jill: JillDef,
    ws: Workspace,
    inputs: Record<string, string>,
    depth: number,
    stack: string[],
    prefix: string,
  ): Promise<Outcome> {
    if (depth > MAX_DEPTH) throw new Error(`Jill nesting too deep: ${stack.join(" -> ")} (max depth ${MAX_DEPTH})`);
    const parallel = ws.isolated ? parallelWriters(jill, this.o.lookup) : new Set<string>();
    const state = new Map<string, "pending" | "running" | "done" | "failed">();
    const outputs: Record<string, { output: string }> = {};
    for (const s of jill.steps) state.set(s.name, "pending");
    const running = new Map<string, Promise<void>>();
    for (;;) {
      if (!this.outcome) {
        for (const s of jill.steps) {
          if (state.get(s.name) !== "pending") continue;
          if (!s.needs.every((n) => state.get(n) === "done")) continue;
          state.set(s.name, "running");
          const p = this.runStep(jill, s, ws, inputs, depth, stack, prefix, parallel.has(s.name), outputs).then((ok) => {
            state.set(s.name, ok ? "done" : "failed");
            running.delete(s.name);
          });
          running.set(s.name, p);
        }
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }
    if (this.outcome) return this.outcome;
    const allDone = [...state.values()].every((v) => v === "done");
    return allDone ? "done" : "failed";
  }

  /** Runs every copy of one step. Resolves true when all copies passed. */
  private async runStep(
    jill: JillDef,
    step: StepDef,
    ws: Workspace,
    inputs: Record<string, string>,
    depth: number,
    stack: string[],
    prefix: string,
    useChild: boolean,
    outputs: Record<string, { output: string }>,
  ): Promise<boolean> {
    const n = step.copies;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => this.runInstance(jill, step, n > 1 ? i + 1 : undefined, ws, inputs, depth, stack, prefix, useChild, outputs)),
    );
    const ok = results.every((x) => x.ok);
    outputs[step.name] = { output: results.map((x) => x.output).filter(Boolean).join("\n\n---\n\n") };
    return ok;
  }

  private async runInstance(
    jill: JillDef,
    step: StepDef,
    copy: number | undefined,
    ws: Workspace,
    inputs: Record<string, string>,
    depth: number,
    stack: string[],
    prefix: string,
    useChild: boolean,
    outputs: Record<string, { output: string }>,
  ): Promise<{ ok: boolean; output: string }> {
    const key = `${prefix}${step.name}${copy !== undefined ? `#${copy}` : ""}`;
    const kind = step.jill ? "jill" : step.agent ? "agent" : "run";
    const rec = this.stepRecord(key, { step: step.name, jill: jill.name, copy, kind });
    if (this.outcome) {
      rec.state = "skipped";
      return { ok: false, output: "" };
    }
    rec.state = "running";
    rec.started = now();
    this.emit("step-started", key);
    const fail = (state: "failed" | "stuck" | "needs-you", reason: string) => {
      rec.state = state;
      rec.reason = reason;
      rec.finished = now();
      this.halt(state, `step ${key}: ${reason}`);
      this.emit("step-done", key, `${state}: ${reason}`);
      return { ok: false, output: "" };
    };
    try {
      let iws = ws;
      if (useChild && this.isolation) {
        iws = await this.isolation.child(ws, { key, runId: this.record.id, config: this.o.config });
      }
      rec.workspace = iws.dir;
      rec.branch = iws.branch;
      let output = "";
      if (step.jill) {
        const child = this.o.lookup(step.jill);
        if (!child) return fail("failed", `unknown Jill "${step.jill}"`);
        if (stack.includes(child.name)) return fail("failed", `recursion refused: ${[...stack, child.name].join(" -> ")}`);
        const vars = { inputs, copy, run_id: this.record.id, steps: outputs };
        const childInputs: Record<string, string> = step.inputs
          ? Object.fromEntries(Object.entries(step.inputs).map(([k, v]) => [k, renderTemplate(v, vars)]))
          : { ...inputs };
        for (const i of child.inputs) if (childInputs[i.name] === undefined && i.default !== undefined) childInputs[i.name] = i.default;
        const out = await this.runGraph(child, iws, childInputs, depth + 1, [...stack, child.name], `${key}/`);
        if (out !== "done") {
          rec.state = out === "needs-you" ? "needs-you" : out === "stuck" ? "stuck" : "failed";
          rec.reason = `nested Jill ${child.name} ended ${out}`;
          rec.finished = now();
          this.halt(out, `step ${key}: ${rec.reason}`);
          this.emit("step-done", key, `${rec.state}: ${rec.reason}`);
          return { ok: false, output: "" };
        }
        output = Object.entries(this.record.steps)
          .filter(([k]) => k.startsWith(`${key}/`))
          .map(([, s]) => readOutput(s.log))
          .filter(Boolean)
          .slice(-1)
          .join("");
      } else {
        const runner: RunnerPlugin | undefined = this.o.plugins.runners.find((p) => p.canRun(step));
        if (!runner) return fail("failed", "no runner plug-in can run this step");
        const vars = { inputs, task: inputs.task, copy, run_id: this.record.id, steps: outputs };
        // run: commands never get values in their text, only env var references.
        const shellTpl = step.run !== undefined ? renderShellTemplate(step.run, vars) : undefined;
        const text = shellTpl ? shellTpl.text : renderTemplate(step.task ?? "{{task}}", vars);
        const logPath = join(this.record.logDir, `${key.replace(/[^A-Za-z0-9_.#-]/g, "_")}.log`);
        rec.log = logPath;
        this.save();
        const env: Record<string, string> = {
          JILLS_HOME: this.o.config.home,
          JILLS_RUN_ID: this.record.id,
          JILLS_STEP: key,
          JILLS_JILL: jill.name,
          JILLS_WORKSPACE: iws.dir,
        };
        if (copy !== undefined) env.JILLS_COPY = String(copy);
        for (const [k, v] of Object.entries(inputs)) env[`JILLS_INPUT_${k.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`] = v;
        if (shellTpl) Object.assign(env, shellTpl.env);
        const stepMs = parseDuration(step.timeout);
        const timeoutMs = stepMs !== undefined && stepMs > 0 ? clampTimerMs(stepMs) : undefined;
        const res = await runner.run({
          runId: this.record.id,
          stepKey: key,
          step,
          jill,
          cwd: iws.dir,
          text,
          logPath,
          timeoutMs,
          signal: this.abort.signal,
          env,
          config: this.o.config,
          // Saved at spawn so a sweep can kill the group if this runner dies.
          onSpawn: (pid) => {
            rec.pid = pid;
            rec.pidStart = procStartToken(pid);
            this.save();
          },
        });
        rec.exitCode = res.exitCode;
        if (res.pid !== rec.pid) {
          rec.pid = res.pid;
          rec.pidStart = undefined;
        }
        const checkNames = ["exit-code", ...(Array.isArray(step.extra.checks) ? step.extra.checks.map(String) : [])];
        for (const cn of checkNames) {
          const c = this.o.plugins.checks.get(cn);
          if (!c) return fail("failed", `no check plug-in "${cn}"`);
          const cr = await c.check({ step, result: res, logPath });
          if (!cr.ok) {
            if (res.timedOut) return fail("stuck", `timed out after ${String(step.timeout)}; process group killed`);
            if (res.aborted) {
              rec.state = "failed";
              rec.reason = "stopped: the run ended";
              rec.finished = now();
              this.emit("step-done", key, rec.reason);
              return { ok: false, output: "" };
            }
            return fail("failed", cr.reason ?? `check ${cn} failed`);
          }
        }
        output = readOutput(logPath);
      }
      // Git stays outside agents: Jills commits after each writing step.
      if (iws.isolated && this.isolation && step.writes && !step.jill) {
        const iso = this.isolation;
        const c = await this.mutex.run(iws.dir, () => iso.commit(iws, `jills(${jill.name}): ${key}`));
        if (c) rec.commit = c;
      }
      if (iws !== ws && this.isolation) {
        const iso = this.isolation;
        const m = await this.mutex.run(ws.dir, () => iso.mergeBack(ws, iws, `jills(${jill.name}): merge ${key}`));
        if (!m.ok) {
          this.record.conflicts = [...new Set([...(this.record.conflicts ?? []), ...m.conflicts])];
          return fail("needs-you", m.message);
        }
        rec.commit = m.commit;
      }
      rec.state = "done";
      rec.finished = now();
      this.emit("step-done", key, "done");
      return { ok: true, output };
    } catch (e) {
      return fail("failed", (e as Error).message);
    }
  }
}

export function isTerminal(s: RunState): boolean {
  return TERMINAL.has(s);
}
