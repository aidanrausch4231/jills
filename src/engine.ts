import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TIMEOUT, type JillsConfig } from "./config.js";
import { MAX_DEPTH, type JillDef, type StepDef } from "./jillfile.js";
import type { PluginSet } from "./plugins/index.js";
import type { IsolationPlugin, RunnerPlugin, Workspace } from "./plugins/types.js";
import { bootId } from "./proc.js";
import { loadRecord, saveHeartbeat, saveRecord, TERMINAL, type RunEvent, type RunRecord, type RunState, type StepRecord } from "./runs.js";
import { renderShellTemplate, renderTemplate } from "./template.js";
import { KeyedMutex, MAX_TIMER_MS, parseDuration } from "./util.js";

export type Outcome = "done" | "failed" | "stuck" | "needs-you";
export type EventListener = (e: RunEvent, r: RunRecord) => void;
type Outputs = Record<string, { output: string }>;

const OUTPUT_LIMIT = 8000;
/** How often a runner writes its heartbeat into the run record. */
export const HEARTBEAT_MS = 5_000;

/**
 * The total time limit a run uses: the Jill's timeout, else config
 * default_timeout, else 2h. A value <= 0 falls through to the next one; the
 * result is clamped to the largest timer Node allows. `label` names the value used.
 */
export function totalLimit(jillTimeout: unknown, configDefault: unknown): { label: string; ms: number } {
  for (const v of [jillTimeout, configDefault, DEFAULT_TIMEOUT]) {
    const ms = parseDuration(v);
    if (ms === undefined || !(ms > 0)) continue;
    return ms > MAX_TIMER_MS ? { label: `${MAX_TIMER_MS}ms`, ms: MAX_TIMER_MS } : { label: String(v), ms };
  }
  return { label: DEFAULT_TIMEOUT, ms: 7_200_000 };
}

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

export interface StepCtx {
  config: JillsConfig;
  plugins: PluginSet;
  runId: string;
  key: string;
  cwd: string;
  copy?: number;
  steps: Outputs;
}

/**
 * One step's command, shared by real and dry runs: the runner that claims it,
 * the rendered text (run: commands get env references, never values), the
 * JILLS_* env and the step timeout.
 */
export function stepCommand(step: StepDef, jill: JillDef, inputs: Record<string, string>, c: StepCtx) {
  const runner: RunnerPlugin | undefined = c.plugins.runners.find((p) => p.canRun(step));
  const vars = { inputs, task: inputs.task, copy: c.copy, run_id: c.runId, steps: c.steps };
  const shell = step.run !== undefined ? renderShellTemplate(step.run, vars) : undefined;
  const text = shell ? shell.text : renderTemplate(step.task ?? "{{task}}", vars);
  const env: Record<string, string> = { JILLS_HOME: c.config.home, JILLS_RUN_ID: c.runId, JILLS_STEP: c.key, JILLS_JILL: jill.name, JILLS_WORKSPACE: c.cwd };
  if (c.copy !== undefined) env.JILLS_COPY = String(c.copy);
  for (const [k, v] of Object.entries(inputs)) env[`JILLS_INPUT_${k.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`] = v;
  const ms = parseDuration(step.timeout);
  return { runner, text, env: { ...env, ...shell?.env }, shellEnv: shell?.env ?? {}, timeoutMs: ms && ms > 0 ? Math.min(ms, MAX_TIMER_MS) : undefined };
}

function readOutput(path: string | undefined): string {
  if (!path || !existsSync(path)) return "";
  return readFileSync(path, "utf8").slice(-OUTPUT_LIMIT).trim();
}

const now = () => new Date().toISOString();

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
  private mutex = new KeyedMutex();
  private hooks: Promise<unknown>[] = [];
  private isolation: IsolationPlugin | undefined;
  /** The state this runner last wrote; an observer's terminal state on disk is never overwritten. */
  private written: RunState = "queued";
  private lost = false;

  constructor(
    private record: RunRecord,
    private o: EngineOpts,
  ) {}

  private save(): void {
    const home = this.o.config.home;
    if (!this.lost && !TERMINAL.has(this.written)) {
      const disk = loadRecord(home, this.record.id);
      if (disk && TERMINAL.has(disk.state)) {
        this.lost = true; // an observer marked it stuck: stop our steps, keep its record
        this.halt(disk.state as Outcome, `marked ${disk.state} by an observer: ${disk.error ?? ""}`);
      }
    }
    if (this.lost) return;
    saveRecord(home, this.record);
    this.written = this.record.state;
  }

  private emit(type: RunEvent["type"], step?: string, note?: string): void {
    const e: RunEvent = { at: now(), type, step, note };
    this.record.events.push(e);
    this.save();
    const r = this.record;
    for (const fn of [() => this.o.onEvent?.(e, r), ...this.o.plugins.hooks.map((h) => () => h.on(e, r, this.o.config))]) {
      try {
        this.hooks.push(Promise.resolve(fn()).catch(() => undefined)); // listeners never break a run
      } catch {
        /* ignore */
      }
    }
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
    const beat = () => (r.heartbeat = { at: now(), mono: String(process.hrtime.bigint()), since, bootId: boot });
    beat();
    const heart = setInterval(() => {
      if (!this.lost && !saveHeartbeat(c.home, r.id, beat())) this.save(); // terminal on disk → save() halts
    }, HEARTBEAT_MS);
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
      const { label, ms } = totalLimit(jill.timeout, c.default_timeout);
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
      this.finish(this.outcome ?? (await this.runGraph(jill, ws, r.inputs, 1, [jill.name], "")));
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

  private async runGraph(jill: JillDef, ws: Workspace, inputs: Record<string, string>, depth: number, stack: string[], prefix: string): Promise<Outcome> {
    if (depth > MAX_DEPTH) throw new Error(`Jill nesting too deep: ${stack.join(" -> ")} (max depth ${MAX_DEPTH})`);
    const parallel = ws.isolated ? parallelWriters(jill, this.o.lookup) : new Set<string>();
    const state = new Map(jill.steps.map((s) => [s.name, "pending" as "pending" | "running" | "done" | "failed"]));
    const outputs: Outputs = {};
    const running = new Map<string, Promise<void>>();
    for (;;) {
      for (const s of this.outcome ? [] : jill.steps) {
        if (state.get(s.name) !== "pending" || !s.needs.every((n) => state.get(n) === "done")) continue;
        state.set(s.name, "running");
        const copies = Array.from({ length: s.copies }, (_, i) =>
          this.runInstance(jill, s, s.copies > 1 ? i + 1 : undefined, ws, inputs, depth, stack, prefix, parallel.has(s.name), outputs),
        );
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
    outputs: Outputs,
  ): Promise<{ ok: boolean; output: string }> {
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
        const vars = { inputs, copy, run_id: this.record.id, steps: outputs };
        const childInputs = step.inputs ? Object.fromEntries(Object.entries(step.inputs).map(([k, v]) => [k, renderTemplate(v, vars)])) : { ...inputs };
        for (const i of child.inputs) if (childInputs[i.name] === undefined && i.default !== undefined) childInputs[i.name] = i.default;
        const out = await this.runGraph(child, iws, childInputs, depth + 1, [...stack, child.name], `${key}/`);
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
      if (iws.isolated && iso && step.writes && !step.jill) {
        rec.commit = (await this.mutex.run(iws.dir, () => iso.commit(iws, `jills(${jill.name}): ${key}`))) ?? rec.commit;
      }
      if (iws !== ws && iso) {
        const m = await this.mutex.run(ws.dir, () => iso.mergeBack(ws, iws, `jills(${jill.name}): merge ${key}`));
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
