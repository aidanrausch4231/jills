import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TIMEOUT, type JillsConfig } from "./config.js";
import { MAX_DEPTH, type JillDef, type StepDef } from "./jillfile.js";
import type { PluginSet } from "./plugins/index.js";
import type { IsolationPlugin, RunnerPlugin, Workspace } from "./plugins/types.js";
import { bootId } from "./proc.js";
import { heartbeatPath, loadRecord, saveRecord, TERMINAL, type RunEvent, type RunRecord, type RunState, type StepRecord } from "./runs.js";
import { renderShellTemplate, renderTemplate, type TemplateVars } from "./template.js";
import { MAX_TIMER_MS, parseLimit, writeJsonAtomic } from "./util.js";

export type Outcome = "done" | "failed" | "stuck" | "needs-you";
export type EventListener = (e: RunEvent, r: RunRecord) => void;
type Outputs = Record<string, { output: string }>;
/** One Jill's graph inside a run: nested Jills get their own frame (deeper, own prefix). */
type Frame = { jill: JillDef; ws: Workspace; inputs: Record<string, string>; depth: number; stack: string[]; prefix: string };

const OUTPUT_LIMIT = 8000;
/** How often a runner writes its heartbeat file (never the run record). */
export const HEARTBEAT_MS = 5_000;

/** Steps that write and may run at the same time as another writer → child worktrees. */
export function parallelWriters(jill: JillDef, lookup: (n: string) => JillDef | undefined): Set<string> {
  const by = new Map(jill.steps.map((s) => [s.name, s]));
  const anc = (n: string, seen = new Set<string>()): Set<string> => {
    for (const d of by.get(n)?.needs ?? []) if (!seen.has(d)) anc(d, seen.add(d));
    return seen;
  };
  const writes = (s: StepDef, seen: Set<string>): boolean => {
    if (s.writes) return true;
    const j = s.jill && !seen.has(s.jill) ? lookup(s.jill) : undefined;
    return !!j && j.steps.some((x) => writes(x, seen.add(j.name)));
  };
  const writers = jill.steps.filter((s) => writes(s, new Set()));
  const out = new Set<string>();
  for (const w of writers) {
    if (w.copies > 1) out.add(w.name);
    for (const o of writers) if (o !== w && !anc(w.name).has(o.name) && !anc(o.name).has(w.name)) out.add(w.name);
  }
  return out;
}

/**
 * One step's command, shared by real and dry runs: the runner that claims it,
 * the rendered text (run: commands get env references, never values), the
 * JILLS_* env and the step timeout.
 */
type StepCtx = { config: JillsConfig; plugins: PluginSet; runId: string; key: string; cwd: string; copy?: number; steps: Outputs };
export function stepCommand(step: StepDef, jill: JillDef, inputs: Record<string, string>, c: StepCtx) {
  const runner: RunnerPlugin | undefined = c.plugins.runners.find((p) => p.canRun(step));
  const vars = { inputs, task: inputs.task, copy: c.copy, run_id: c.runId, steps: c.steps };
  const shell = step.run !== undefined ? renderShellTemplate(step.run, vars) : undefined;
  const text = shell ? shell.text : renderTemplate(step.task ?? "{{task}}", vars);
  const env: Record<string, string> = { JILLS_HOME: c.config.home, JILLS_RUN_ID: c.runId, JILLS_STEP: c.key, JILLS_JILL: jill.name, JILLS_WORKSPACE: c.cwd };
  if (c.copy !== undefined) env.JILLS_COPY = String(c.copy);
  for (const [k, v] of Object.entries(inputs)) env[`JILLS_INPUT_${k.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`] = v;
  return { runner, text, env: { ...env, ...shell?.env }, shellEnv: shell?.env ?? {}, timeoutMs: parseLimit(step.timeout) };
}

const readOutput = (path?: string) => (path && existsSync(path) ? readFileSync(path, "utf8").slice(-OUTPUT_LIMIT).trim() : "");

const now = () => new Date().toISOString();

/** A nested Jill's inputs: the step's `inputs:` rendered with the parent's vars (else the parent's inputs), then the child's defaults. */
export function nestedInputs(step: StepDef, child: JillDef, vars: TemplateVars): Record<string, string> {
  const out = step.inputs ? Object.fromEntries(Object.entries(step.inputs).map(([k, v]) => [k, renderTemplate(v, vars)])) : { ...vars.inputs };
  for (const i of child.inputs) if (out[i.name] === undefined && i.default !== undefined) out[i.name] = i.default;
  return out;
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
 * same run and workspace. The first failing step stops the run. Only this
 * runner signals the step processes it spawned.
 */
export class RunEngine {
  private abort = new AbortController();
  private outcome: Outcome | undefined;
  private hooks: Promise<unknown>[] = [];
  private isolation: IsolationPlugin | undefined;
  /** The state this runner last wrote; an observer's terminal state on disk is never overwritten. */
  private written: RunState = "queued";
  private lost = false;

  constructor(
    private record: RunRecord,
    private o: EngineOpts,
  ) {}

  /** True once an observer wrote a terminal state on disk: then stop our steps and keep its record. */
  private isLost(): boolean {
    if (this.lost || TERMINAL.has(this.written)) return this.lost;
    const disk = loadRecord(this.o.config.home, this.record.id);
    if (disk && TERMINAL.has(disk.state)) {
      this.lost = true;
      this.halt(disk.state as Outcome, `marked ${disk.state} by an observer: ${disk.error ?? ""}`);
    }
    return this.lost;
  }

  private save(): void {
    if (this.isLost()) return;
    saveRecord(this.o.config.home, this.record);
    this.written = this.record.state;
  }

  private emit(type: RunEvent["type"], step?: string, note?: string): void {
    const e: RunEvent = { at: now(), type, step, note };
    this.record.events.push(e);
    this.save();
    const r = this.record;
    for (const fn of [() => this.o.onEvent?.(e, r), ...this.o.plugins.hooks.map((h) => () => h.on(e, r, this.o.config))])
      this.hooks.push(Promise.resolve().then(fn).catch(() => undefined)); // listeners never break a run
  }

  /** Stop the run with this outcome (first one wins) and kill running steps. */
  private halt(outcome: Outcome, reason: string): void {
    if (this.outcome) return;
    this.outcome = outcome;
    this.record.error ??= reason;
    this.abort.abort();
  }

  async execute(): Promise<RunRecord> {
    const r = this.record;
    const c = this.o.config;
    r.state = "running";
    r.started = now();
    r.pid = process.pid;
    const since = String(process.hrtime.bigint());
    const boot = bootId();
    const beat = () => writeJsonAtomic(heartbeatPath(c.home, r.id), { at: now(), mono: String(process.hrtime.bigint()), since, bootId: boot });
    beat();
    // A beat writes only its own file; it then reads the record to notice an observer's stuck mark.
    const heart = setInterval(() => (beat(), this.isLost()), HEARTBEAT_MS);
    heart.unref();
    this.emit("started", undefined, r.jill);
    let totalTimer: NodeJS.Timeout | undefined;
    const ext = this.o.signal;
    const onStop = () => this.halt("failed", `runner stopped: ${String(ext?.reason ?? "aborted")}`);
    if (ext?.aborted) onStop();
    else ext?.addEventListener("abort", onStop, { once: true });
    try {
      const jill = this.o.lookup(r.jill);
      if (!jill) throw new Error(`unknown Jill "${r.jill}"`);
      // Total limit: the Jill's timeout, else config default, else 2h; <= 0 falls through, parseLimit clamps.
      const v = [jill.timeout, c.default_timeout, DEFAULT_TIMEOUT].find((x) => parseLimit(x));
      const ms = parseLimit(v)!;
      const label = ms === MAX_TIMER_MS ? `${ms}ms` : String(v);
      Object.assign(r, { timeLimit: label, timeLimitMs: ms, deadline: new Date(Date.now() + ms).toISOString() });
      this.save();
      totalTimer = setTimeout(() => this.halt("stuck", `total time limit ${label} reached`), ms);
      let ws: Workspace = { dir: r.repo, isolated: false };
      if (jill.worktree || jill.box) {
        const isoName = jill.box ?? (typeof jill.extra.isolation === "string" ? jill.extra.isolation : "worktree");
        this.isolation = this.o.plugins.isolation.get(isoName);
        if (!this.isolation) throw new Error(`no isolation plug-in "${isoName}"`);
        ws = await this.isolation.prepare({ repo: r.repo, jill: jill.name, runId: r.id, config: c });
      }
      Object.assign(r, { workspace: ws.dir, branch: ws.branch, isolated: ws.isolated });
      this.save();
      this.finish(this.outcome ?? (await this.runGraph({ jill, ws, inputs: r.inputs, depth: 1, stack: [jill.name], prefix: "" })));
    } catch (e) {
      r.error ??= (e as Error).message;
      this.finish(this.outcome ?? "failed");
    } finally {
      clearTimeout(totalTimer);
      clearInterval(heart);
      ext?.removeEventListener("abort", onStop);
    }
    await Promise.all(this.hooks);
    return this.lost ? (loadRecord(c.home, r.id) ?? r) : r;
  }

  private finish(outcome: Outcome): void {
    const r = this.record;
    r.state = outcome;
    r.finished = now();
    for (const s of Object.values(r.steps)) if (s.state === "pending") s.state = "skipped";
    if (outcome === "done") delete r.error;
    this.emit(outcome === "done" ? "finished" : outcome, undefined, r.error);
  }

  private async runGraph(f: Frame): Promise<Outcome> {
    const { jill, ws, depth, stack } = f;
    if (depth > MAX_DEPTH) throw new Error(`Jill nesting too deep: ${stack.join(" -> ")} (max depth ${MAX_DEPTH})`);
    const parallel = ws.isolated ? parallelWriters(jill, this.o.lookup) : new Set<string>();
    const state = new Map(jill.steps.map((s) => [s.name, "pending" as "pending" | "running" | "done" | "failed"]));
    const outputs: Outputs = {};
    const running = new Map<string, Promise<void>>();
    for (;;) {
      for (const s of this.outcome ? [] : jill.steps) {
        if (state.get(s.name) !== "pending" || !s.needs.every((n) => state.get(n) === "done")) continue;
        state.set(s.name, "running");
        const copies = Array.from({ length: s.copies }, (_, i) => this.runInstance(f, outputs, s, s.copies > 1 ? i + 1 : undefined, parallel.has(s.name)));
        const p = Promise.all(copies).then((res) => {
          outputs[s.name] = { output: res.map((x) => x.output).filter(Boolean).join("\n\n---\n\n") };
          state.set(s.name, res.every((x) => x.ok) ? "done" : "failed");
          running.delete(s.name);
        });
        running.set(s.name, p);
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }
    return this.outcome ?? ([...state.values()].every((v) => v === "done") ? "done" : "failed");
  }

  private async runInstance(f: Frame, outputs: Outputs, step: StepDef, copy: number | undefined, useChild: boolean): Promise<{ ok: boolean; output: string }> {
    const { jill, ws, inputs, stack, prefix } = f;
    const key = `${prefix}${step.name}${copy !== undefined ? `#${copy}` : ""}`;
    const rec: StepRecord = { key, step: step.name, jill: jill.name, copy, kind: step.jill ? "jill" : step.agent ? "agent" : "run", state: "skipped" };
    this.record.steps[key] = rec;
    if (this.outcome) return { ok: false, output: "" };
    Object.assign(rec, { state: "running", started: now() });
    this.emit("step-started", key);
    /** End this step without success; halt = stop the whole run with that outcome. */
    const fail = (state: "failed" | "stuck" | "needs-you", reason: string, halt = true) => {
      Object.assign(rec, { state, reason, finished: now() });
      if (halt) this.halt(state, `step ${key}: ${reason}`);
      this.emit("step-done", key, `${state}: ${reason}`);
      return { ok: false, output: "" };
    };
    try {
      const iws = useChild && this.isolation ? await this.isolation.child(ws, { key, runId: this.record.id, config: this.o.config }) : ws;
      Object.assign(rec, { workspace: iws.dir, branch: iws.branch });
      let output = "";
      if (step.jill) {
        const child = this.o.lookup(step.jill);
        if (!child) return fail("failed", `unknown Jill "${step.jill}"`);
        if (stack.includes(child.name)) return fail("failed", `recursion refused: ${[...stack, child.name].join(" -> ")}`);
        const childInputs = nestedInputs(step, child, { inputs, copy, run_id: this.record.id, steps: outputs });
        const out = await this.runGraph({ jill: child, ws: iws, inputs: childInputs, depth: f.depth + 1, stack: [...stack, child.name], prefix: `${key}/` });
        if (out !== "done") return fail(out, `nested Jill ${child.name} ended ${out}`);
        const inner = Object.entries(this.record.steps).filter(([k]) => k.startsWith(`${key}/`));
        output = inner.map(([, s]) => readOutput(s.log)).filter(Boolean).slice(-1).join("");
      } else {
        const cmd = stepCommand(step, jill, inputs, { config: this.o.config, plugins: this.o.plugins, runId: this.record.id, key, cwd: iws.dir, copy, steps: outputs });
        if (!cmd.runner) return fail("failed", "no runner plug-in can run this step");
        const logPath = join(this.record.logDir, `${key.replace(/[^A-Za-z0-9_.#-]/g, "_")}.log`);
        rec.log = logPath;
        this.save();
        const res = await cmd.runner.run({ runId: this.record.id, stepKey: key, step, jill, cwd: iws.dir, text: cmd.text, logPath, timeoutMs: cmd.timeoutMs, signal: this.abort.signal, env: cmd.env, config: this.o.config });
        rec.exitCode = res.exitCode;
        for (const cn of ["exit-code", ...(Array.isArray(step.extra.checks) ? step.extra.checks.map(String) : [])]) {
          const c = this.o.plugins.checks.get(cn);
          if (!c) return fail("failed", `no check plug-in "${cn}"`);
          const cr = await c.check({ step, result: res, logPath });
          if (cr.ok) continue;
          if (res.timedOut) return fail("stuck", `timed out after ${String(step.timeout)}; process group killed`);
          if (res.aborted) return fail("failed", "stopped: the run ended", false);
          return fail("failed", cr.reason ?? `check ${cn} failed`);
        }
        output = readOutput(logPath);
      }
      const iso = this.isolation;
      // Git stays outside agents: Jills commits after each writing step.
      if (iws.isolated && iso && step.writes && !step.jill) rec.commit = (await iso.commit(iws, `jills(${jill.name}): ${key}`)) ?? rec.commit;
      if (iws !== ws && iso) {
        const m = await iso.mergeBack(ws, iws, `jills(${jill.name}): merge ${key}`);
        if (!m.ok) {
          this.record.conflicts = [...new Set([...(this.record.conflicts ?? []), ...m.conflicts])];
          return fail("needs-you", m.message);
        }
        rec.commit = m.commit;
      }
      Object.assign(rec, { state: "done", finished: now() });
      this.emit("step-done", key, "done");
      return { ok: true, output };
    } catch (e) {
      return fail("failed", (e as Error).message);
    }
  }
}
