import { join } from "node:path";
import { DEFAULT_TIMEOUT, type JillsConfig } from "./config.js";
import { ancestors, checkNesting, type JillDef, type StepDef } from "./jillfile.js";
import type { PluginSet } from "./plugins/index.js";
import type { IsolationPlugin, Workspace } from "./plugins/types.js";
import { nestedInputs, stepCommand, type Outputs, type Loop } from "./plugins/engine-command.js";
import { readOutput, resumeSteps, savedWorkspace, savedStep, stepOutput } from "./plugins/resume.js";
export { nestedInputs, stepCommand } from "./plugins/engine-command.js";
import { bootId } from "./proc.js";
import { loadRecord, saveRecord, TERMINAL, type RunEvent, type RunRecord, type RunState, type StepRecord } from "./runs.js";
import { MAX_TIMER_MS, parseLimit } from "./util.js";

export type Outcome = "done" | "failed" | "stuck" | "needs-you";
export type EventListener = (e: RunEvent, r: RunRecord) => void;
/** One Jill's graph inside a run: nested Jills get their own frame (own inputs and key prefix). */
type Frame = { jill: JillDef; ws: Workspace; inputs: Record<string, string>; prefix: string };

/** How often a runner writes its heartbeat (never the run record). */
export const HEARTBEAT_MS = 5_000;

const now = () => new Date().toISOString();

export interface EngineOpts {
  config: JillsConfig;
  plugins: PluginSet;
  lookup: (name: string) => JillDef | undefined;
  onEvent?: EventListener;
  /** Abort from outside (e.g. the runner got SIGTERM): kills running steps, run ends failed. */
  signal?: AbortSignal;
  resume?: boolean;
}

/**
 * Runs one Jill's step graph for a run record. Steps whose `needs` are done
 * start in parallel; `copies` start N instances; `jill:` steps run inline in the
 * same run and workspace. The first failing step stops the run, unless its
 * `on_fail` back-arrow sends work back to an earlier step (bounded rounds; then
 * needs-you). Only this runner signals the step processes it spawned.
 */
export class RunEngine {
  private abort = new AbortController();
  private outcome: Outcome | undefined;
  private hooks: Promise<unknown>[] = [];
  private isolation: IsolationPlugin | undefined;
  /** The state this runner last wrote; an observer's terminal state on disk is never overwritten. */
  private written: RunState = "queued";
  private lost = false;
  /** `<prefix><step>` a back-arrow reset while it ran: it is stopped, its writes dropped, its result ignored. */
  private stale = new Set<string>();
  /** Per step instance (key): stops just that step (stale), linked to the run's abort. */
  private live = new Map<string, AbortController>();
  /** True for a stale step id itself, its copies and rounds (`#`, `@`) and its nested steps (`/`). */
  private isStale = (key: string) => [...this.stale].some((id) => key.startsWith(id) && /^($|[#@/])/.test(key.slice(id.length)));

  constructor(
    private record: RunRecord,
    private o: EngineOpts,
  ) {}

  /** True once an observer wrote a terminal state on disk: then stop our steps and keep its record. */
  private isLost(): boolean {
    if (this.lost || TERMINAL.has(this.written)) return this.lost;
    const disk = loadRecord(this.o.config.home, this.record.id, this.o.plugins.backend);
    if (disk && TERMINAL.has(disk.state)) {
      this.lost = true;
      this.halt(disk.state as Outcome, `marked ${disk.state} by an observer: ${disk.error ?? ""}`);
    }
    return this.lost;
  }

  private save(): void {
    if (this.isLost()) return;
    saveRecord(this.o.config.home, this.record, this.o.plugins.backend);
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
    const { record: r, o: { config: c } } = this;
    Object.assign(r, { state: "running", started: now(), pid: process.pid });
    for (const k of ["JILLS_BASE_REPO", "JILLS_BASE_BRANCH", "JILLS_RUN_BRANCH"]) delete process.env[k]; // only a merges: true step gets these
    const since = String(process.hrtime.bigint());
    const boot = bootId();
    const beat = () => this.o.plugins.backend.beat(c.home, r.id, { at: now(), mono: String(process.hrtime.bigint()), since, bootId: boot });
    beat();
    // A beat writes separately; it then reads the record to notice an observer's stuck mark.
    const heart = setInterval(() => (beat(), this.isLost()), HEARTBEAT_MS).unref();
    this.emit("started", undefined, this.o.resume ? `resumed (${Object.values(r.steps).filter((s) => s.state === "done").length} steps already done)` : r.jill);
    let totalTimer: NodeJS.Timeout | undefined;
    const ext = this.o.signal;
    const onStop = () => this.halt("failed", `runner stopped: ${String(ext?.reason ?? "aborted")}`);
    if (ext?.aborted) onStop();
    else ext?.addEventListener("abort", onStop, { once: true });
    try {
      const jill = this.o.lookup(r.jill);
      if (!jill) throw new Error(`unknown Jill "${r.jill}"`);
      checkNesting(jill, this.o.lookup); // unknown, recursive or too-deep nested Jills fail before any step
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
        ws = savedWorkspace(r) ?? await this.isolation.prepare({ repo: r.repo, jill: jill.name, runId: r.id, config: c });
      } else ws = savedWorkspace(r) ?? ws;
      Object.assign(r, { workspace: ws.dir, branch: ws.branch, base: ws.base, isolated: ws.isolated });
      this.save();
      this.finish(this.outcome ?? (await this.runGraph({ jill, ws, inputs: r.inputs, prefix: "" })));
    } catch (e) {
      r.error ??= (e as Error).message;
      this.finish(this.outcome ?? "failed");
    } finally {
      clearTimeout(totalTimer);
      clearInterval(heart);
      ext?.removeEventListener("abort", onStop);
    }
    await Promise.all(this.hooks);
    return this.lost ? (loadRecord(c.home, r.id, this.o.plugins.backend) ?? r) : r;
  }

  private finish(outcome: Outcome): void {
    const r = Object.assign(this.record, { state: outcome, finished: now() });
    for (const s of Object.values(r.steps)) if (s.state === "pending") s.state = "skipped";
    if (outcome === "done") delete r.error;
    this.emit(outcome === "done" ? "finished" : outcome, undefined, r.error);
  }

  private async runGraph(f: Frame): Promise<Outcome> {
    const { jill, ws } = f;
    const parallel = (ws.isolated && this.isolation?.parallel?.(jill, this.o.lookup)) || new Set<string>();
    const state = new Map(jill.steps.map((s) => [s.name, "pending" as "pending" | "running" | "done" | "failed"]));
    const outputs: Outputs = {};
    const running = new Map<string, Promise<void>>();
    const [rounds, loops] = [new Map<string, number>(), new Map<string, number>()]; // starts per step; back-arrows taken per failing step
    if (this.o.resume) resumeSteps(this.record, jill, f.prefix, state, outputs, rounds);
    let feedback = "";
    /** A back-arrow waiting for its stale steps to stop: the steps to rerun and whether stale writes hit the shared worktree. */
    let back: { steps: string[]; discard: boolean } | undefined;
    for (;;) {
      if (back && !back.steps.some((n) => running.has(n))) {
        if (ws.isolated && this.isolation?.retry) await this.isolation.retry(ws, back);
        for (const n of back.steps) (state.set(n, "pending"), this.stale.delete(f.prefix + n));
        back = undefined;
      }
      for (const s of this.outcome || back || this.isStale(f.prefix) ? [] : jill.steps) {
        if (state.get(s.name) !== "pending" || !s.needs.every((n) => state.get(n) === "done")) continue;
        state.set(s.name, "running");
        const round = (rounds.get(s.name) ?? 0) + 1;
        rounds.set(s.name, round);
        const loop = { round, feedback: round > 1 ? feedback : "" };
        const copies = Array.from({ length: s.copies }, (_, i) => this.runInstance(f, outputs, s, s.copies > 1 ? i + 1 : undefined, parallel.has(s.name), loop));
        const p = Promise.all(copies).then((res) => {
          running.delete(s.name);
          // stale (reset here, or inside a stale nested Jill): its result is dropped, never a failure with its own back-arrow
          if (back?.steps.includes(s.name) || this.isStale(f.prefix + s.name))
            return void res.forEach((x) => Object.assign(this.record.steps[x.key]!, { state: "skipped", reason: "stale: a back-arrow reran an earlier step" }));
          outputs[s.name] = { output: res.map((x) => x.output).filter(Boolean).join("\n\n---\n\n") };
          const bad = res.find((x) => !x.ok);
          state.set(s.name, bad ? "failed" : "done");
          // Back-arrow: only a real failure (non-zero exit, failed check) gets here without a halt.
          if (!bad || !s.onFail || this.outcome) return;
          const n = (loops.get(s.name) ?? 0) + 1;
          if (n >= s.onFail.maxRounds) return this.halt("needs-you", `${f.prefix}${s.name} failed ${n} rounds`);
          loops.set(s.name, n);
          feedback = bad.output;
          const steps = jill.steps.filter((x) => x.name === s.onFail!.backTo || ancestors(jill.steps, x.name).has(s.onFail!.backTo)).map((x) => x.name);
          const busy = steps.filter((x) => running.has(x));
          back = { steps: [...new Set([...(back?.steps ?? []), ...steps])], discard: !!back?.discard || busy.some((x) => !parallel.has(x)) };
          for (const x of busy) this.stale.add(f.prefix + x);
          for (const [k, ac] of this.live) if (this.isStale(k)) ac.abort("stale");
        });
        running.set(s.name, p);
      }
      if (running.size === 0 && !back) break;
      if (running.size) await Promise.race(running.values());
    }
    return this.outcome ?? ([...state.values()].every((v) => v === "done") ? "done" : "failed");
  }

  private async runInstance(f: Frame, outputs: Outputs, step: StepDef, copy: number | undefined, useChild: boolean, loop: Loop): Promise<{ ok: boolean; output: string; key: string }> {
    const { jill, ws, inputs, prefix } = f;
    const key = `${prefix}${step.name}${copy !== undefined ? `#${copy}` : ""}${loop.round > 1 ? `@${loop.round}` : ""}`;
    const saved = this.o.resume ? savedStep(this.record, key) : undefined;
    if (loop.round === 1 && saved?.state === "done") return { ok: true, output: stepOutput(this.record, saved), key: saved.key };
    const rec: StepRecord = { key, step: step.name, jill: jill.name, copy, kind: step.jill ? "jill" : step.agent ? "agent" : "run", state: "skipped" };
    this.record.steps[key] = rec;
    const ac = new AbortController();
    this.live.set(key, ac);
    if (this.outcome || this.isStale(key)) return { ok: false, output: "", key };
    Object.assign(rec, { state: "running", started: now() });
    this.emit("step-started", key);
    /** End this step without success; halt = stop the whole run with that outcome (else its output tail is the feedback). */
    const fail = (state: "failed" | "stuck" | "needs-you" | "skipped", reason: string, halt = true) => {
      if (this.isStale(key)) [state, reason] = ["skipped", "stale: a back-arrow reran an earlier step"];
      Object.assign(rec, { state, reason, finished: now() });
      halt &&= state !== "skipped"; // a stale step's result is dropped, never stops the run
      if (halt) this.halt(state as Outcome, `step ${key}: ${reason}`);
      this.emit("step-done", key, `${state}: ${reason}`);
      return { ok: false, output: halt ? "" : readOutput(rec.log), key };
    };
    const iso = this.isolation;
    try {
      const previous = saved?.workspace && useChild ? savedWorkspace({ ...saved, repo: ws.repo ?? this.record.repo, isolated: ws.isolated }) : undefined;
      const iws = previous ?? (useChild && this.isolation ? await this.isolation.child(ws, { key, runId: this.record.id, config: this.o.config }) : ws);
      Object.assign(rec, { workspace: iws.dir, branch: iws.branch });
      let [output, note] = ["", "done"];
      if (step.jill) {
        const child = this.o.lookup(step.jill)!;
        const childInputs = nestedInputs(step, child, { inputs, copy, run_id: this.record.id, steps: outputs, ...loop });
        const childPrefix = `${loop.round === 1 && saved ? saved.key : key}/`;
        const out = await this.runGraph({ jill: child, ws: iws, inputs: childInputs, prefix: childPrefix });
        if (out !== "done") return fail(out, `nested Jill ${child.name} ended ${out}`);
        const inner = Object.values(this.record.steps).filter((s) => s.key.startsWith(childPrefix) && readOutput(s.log));
        rec.log = inner.at(-1)?.log;
        output = readOutput(rec.log);
      } else {
        const cmd = stepCommand(step, jill, inputs, { config: this.o.config, plugins: this.o.plugins, runId: this.record.id, key, cwd: iws.dir, copy, steps: outputs, loop });
        if (!cmd.runner) return fail("failed", "no runner plug-in can run this step");
        // merges: true — the isolation plug-in refuses a dirty or switched checkout, then judges the result; a bad result never loops.
        const base = this.record.base ?? "";
        let start: object | undefined;
        if (step.merges) {
          if (!iso?.mergeStart || !iso.mergeCheck || !iws.isolated || !base) return fail("failed", "merges: true needs a worktree run started on a branch");
          rec.commit = (await iso.commit(iws, `jills(${jill.name}): ${key} (before merging)`)) ?? rec.commit;
          const s = await iso.mergeStart(iws, base);
          if (typeof s === "string") return fail("needs-you", s);
          start = s;
          Object.assign(cmd.env, { JILLS_BASE_REPO: iws.repo, JILLS_BASE_BRANCH: base, JILLS_RUN_BRANCH: iws.branch });
        }
        const logPath = join(this.record.logDir, `${key.replace(/[^A-Za-z0-9_.#@-]/g, "_")}.log`);
        rec.log = logPath;
        this.save();
        const res = await cmd.runner.run({ runId: this.record.id, stepKey: key, step, jill, cwd: iws.dir, text: cmd.text, logPath, timeoutMs: cmd.timeoutMs, signal: AbortSignal.any([this.abort.signal, ac.signal]), env: cmd.env, config: this.o.config });
        rec.exitCode = res.exitCode;
        const merged = start && (await iso!.mergeCheck!(iws, base, start));
        const said = merged && merged.state !== "untouched" ? (merged.reason ?? `merged into ${base}`) : undefined;
        if (said && this.outcome) this.record.error = `merge step: ${said}; ${this.record.error}`;
        if (merged && merged.state === "bad") return fail("needs-you", `the merge step left your checkout modified: ${merged.reason}`);
        for (const cn of ["exit-code", "verdict", ...(Array.isArray(step.extra.checks) ? step.extra.checks.map(String) : [])]) {
          const c = this.o.plugins.checks.get(cn);
          if (!c) return fail("failed", `no check plug-in "${cn}"`);
          const cr = await c.check({ step, result: res, logPath });
          if (cr.ok) continue;
          if (said === `merged into ${base}`) return fail("needs-you", `the merge step failed after merging into ${base}; check ${base} by hand`);
          if (res.timedOut) return fail("stuck", `timed out after ${String(step.timeout)}; process group killed`);
          if (res.aborted) return fail("failed", "stopped: the run ended", false);
          return fail("failed", cr.reason ?? `check ${cn} failed`, !step.onFail);
        }
        if (merged && merged.state === "untouched") return fail("failed", `nothing was merged into ${base}`, !step.onFail);
        output = readOutput(logPath);
        if (said) note = `done: ${said}`;
      }
      if (this.isStale(key)) return fail("skipped", "stale", false); // never committed or merged back
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
      this.emit("step-done", key, note);
      return { ok: true, output, key };
    } catch (e) {
      return fail("failed", (e as Error).message);
    }
  }
}
