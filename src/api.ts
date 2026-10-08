import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jillsHome, loadConfig, setConfigValue, type JillsConfig } from "./config.js";
import { parallelWriters, RunEngine, stepCommand, type EventListener } from "./engine.js";
import { checkNesting, NO_WORKTREE_NOTE, refusal, scanJills, type JillDef } from "./jillfile.js";
import { loadPlugins, type PluginSet } from "./plugins/index.js";
import type { ChatChange, JillSummary, LastSuggestion, MatchResult, SuggestCtx, Suggestion, Turn } from "./plugins/types.js";
import { stopTagged } from "./proc.js";
import { listRecords, loadRecord, markTerminal, refreshRecord, resultLine, runLogDir, saveRecord, TERMINAL, waitForRun, type RunRecord, type WaitOpts } from "./runs.js";
import { newId, writeFileAtomic } from "./util.js";

export interface BaseOpts {
  /** Jills home; defaults to $JILLS_HOME or ~/.jills. */
  home?: string;
}

interface Ctx {
  config: JillsConfig;
  plugins: PluginSet;
  jills: Map<string, JillDef>;
  lookup: (name: string) => JillDef | undefined;
}

const homeOf = (o: BaseOpts) => loadConfig(o.home ?? jillsHome()).home;

async function context(o: BaseOpts = {}): Promise<Ctx> {
  const config = loadConfig(o.home ?? jillsHome());
  const jills = scanJills(config.jill_paths).items;
  return { config, plugins: await loadPlugins(config), jills, lookup: (n) => jills.get(n) };
}

function summarize(j: JillDef): JillSummary {
  return { name: j.name, description: j.description, when: j.when, inputs: j.inputs.map((i) => i.name), keywords: j.keywords };
}

/** List saved Jills (first match per name across jill_paths). */
export async function listJills(o: BaseOpts = {}): Promise<(JillSummary & { path: string })[]> {
  return [...(await context(o)).jills.values()].map((j) => ({ ...summarize(j), path: j.path }));
}

// ---------------------------------------------------------------- suggest

export interface SuggestOpts extends BaseOpts {
  /** Chat session id (anti-nag state is kept per id). */
  session: string;
  message: string;
  /** Recent turns before this message; the last 3 are used. */
  recent?: Turn[];
  /** Repo the chat works in (for per-repo "never"). Defaults to the git root of cwd. */
  repo?: string;
  cwd?: string;
}

/** The repo a chat works in: `repo`, else the git root of cwd (undefined outside git). */
async function resolveRepo(repo?: string, cwd?: string): Promise<string | undefined> {
  if (repo) return resolve(repo);
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: cwd ?? process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/** Keep only the inputs a Jill declares (drops `repo` and other undeclared keys). */
export function declaredInputs(j: Pick<JillDef, "inputs"> | undefined, given: Record<string, string> | undefined): Record<string, string> {
  const names = new Set(j?.inputs.map((i) => i.name));
  return Object.fromEntries(Object.entries(given ?? {}).filter(([k]) => names.has(k)));
}

/**
 * Jev check for one chat message: the suggest plug-in (default: anti-nag rules)
 * asks the matchers; core keeps only inputs the named Jill declares.
 */
export async function suggest(o: SuggestOpts): Promise<Suggestion> {
  const c = await context(o);
  const declared = (m: MatchResult | undefined) => (m?.jill ? { ...m, inputs: declaredInputs(c.lookup(m.jill), m.inputs) } : m);
  const match: SuggestCtx["match"] = async (input) => {
    for (const matcher of c.plugins.matchers) {
      const m = await matcher.match(input);
      if (m) return declared(m);
    }
    return undefined;
  };
  const jills = [...c.jills.values()].map((j) => ({ ...summarize(j), worktree: j.worktree }));
  const input = { session: o.session, message: o.message, recent: (o.recent ?? []).slice(-3), repo: await resolveRepo(o.repo, o.cwd) };
  const s = await c.plugins.suggest.suggest(input, { jills, config: c.config, match });
  return s.jill && s.inputs ? { ...s, inputs: declaredInputs(c.lookup(s.jill), s.inputs) } : s;
}

// ---------------------------------------------------------------- start / run

export interface StartOpts extends BaseOpts {
  inputs?: Record<string, string>;
  /** Repo/folder to run in; defaults to inputs.repo, then process.cwd(). */
  cwd?: string;
  session?: string;
}

/** Look up a Jill, refuse what v1 cannot run, check nesting, fill defaults and required inputs. */
function validate(c: Ctx, name: string, given: Record<string, string> = {}): { j: JillDef; inputs: Record<string, string> } {
  const j = c.lookup(name);
  if (!j) throw new Error(`no Jill named "${name}" (jill_paths: ${c.config.jill_paths.join(", ")})`);
  const refused = refusal(j, c.plugins.isolation);
  if (refused) throw new Error(refused);
  checkNesting(j, c.lookup);
  const inputs = { ...given };
  for (const i of j.inputs) if (inputs[i.name] === undefined && i.default !== undefined) inputs[i.name] = i.default;
  const missing = j.inputs.filter((i) => i.required && inputs[i.name] === undefined).map((i) => i.name);
  if (missing.length) throw new Error(`Jill "${j.name}" needs input(s): ${missing.join(", ")} (use --input name=value)`);
  return { j, inputs };
}

/** Validate a start request and save the queued run record. */
async function prepareRun(name: string, o: StartOpts): Promise<{ c: Ctx; record: RunRecord }> {
  const c = await context(o);
  const { j, inputs } = validate(c, name, o.inputs);
  const repo = resolve(inputs.repo ?? o.cwd ?? process.cwd());
  if (!existsSync(repo)) throw new Error(`repo folder ${repo} does not exist`);
  const id = newId();
  const created = new Date().toISOString();
  const logDir = runLogDir(c.config.home, id);
  const record: RunRecord = { version: 1, id, jill: j.name, jillPath: j.path, inputs, state: "queued", created, repo, session: o.session, logDir, steps: {}, events: [] };
  mkdirSync(logDir, { recursive: true });
  saveRecord(c.config.home, record);
  return { c, record };
}

const engine = (c: Ctx, r: RunRecord, o: { onEvent?: EventListener; signal?: AbortSignal }) =>
  new RunEngine(r, { config: c.config, plugins: c.plugins, lookup: c.lookup, ...o });

/**
 * Start a Jill as a detached runner process (no background service). Returns
 * the queued run record at once; watch it with wait() or `jills wait <id>`.
 * The runner and every process it starts carry JILLS_RUN_ID=<id> (see stop()).
 */
export async function start(jillName: string, o: StartOpts = {}): Promise<RunRecord> {
  const { c, record } = await prepareRun(jillName, o);
  const fd = openSync(join(record.logDir, "runner.log"), "a");
  try {
    const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
    const env = { ...process.env, JILLS_HOME: c.config.home, JILLS_RUN_ID: record.id };
    spawn(process.execPath, [cli, "__run", record.id], { detached: true, stdio: ["ignore", fd, fd], env, cwd: record.repo }).unref();
  } finally {
    closeSync(fd);
  }
  if (o.session) c.plugins.suggest.chat(o.session, { kind: "started", run: record.id }, c.config);
  return record;
}

/** Execute a queued run in this process (used by the detached runner). */
export async function executeRun(id: string, o: BaseOpts & { onEvent?: EventListener; signal?: AbortSignal } = {}): Promise<RunRecord> {
  const c = await context(o);
  const r = loadRecord(c.config.home, id);
  if (!r) throw new Error(`no run ${id}`);
  if (r.state !== "queued") throw new Error(`run ${id} is ${r.state}, not queued`);
  return engine(c, r, o).execute();
}

/** Run a Jill in the foreground, in this process. Resolves with the final record. */
export async function runNow(jillName: string, o: StartOpts & { onEvent?: EventListener } = {}): Promise<RunRecord> {
  const { c, record } = await prepareRun(jillName, o);
  return engine(c, record, o).execute();
}

export interface WaitResult {
  record: RunRecord;
  timedOut: boolean;
  line: string;
}

/** Block until a run is done/failed/stuck/needs-you; returns a one-line result. */
export async function wait(id: string, o: BaseOpts & WaitOpts = {}): Promise<WaitResult> {
  const { record, timedOut } = await waitForRun(homeOf(o), id, o);
  return { record, timedOut, line: timedOut ? `jills run ${id} still ${record.state} (wait timed out)` : resultLine(record) };
}

/** One run's record, or the recent runs when no id is given. Never signals anything. */
export function status(id: string, o?: BaseOpts): RunRecord | undefined;
export function status(id?: undefined, o?: BaseOpts): RunRecord[];
export function status(id?: string, o: BaseOpts = {}): RunRecord | RunRecord[] | undefined {
  const home = homeOf(o);
  if (id) return refreshRecord(home, id);
  return listRecords(home).map((r) => (TERMINAL.has(r.state) ? r : (refreshRecord(home, r.id) ?? r)));
}

/**
 * `jills stop <run>`: SIGTERM (then SIGKILL) only the processes whose environment
 * holds JILLS_RUN_ID=<run>, on the boot that recorded the run. A live runner
 * records its own outcome; otherwise the run is recorded as failed here.
 */
export async function stop(id: string, o: BaseOpts & { graceMs?: number } = {}): Promise<{ record: RunRecord; pids: number[] }> {
  const home = homeOf(o);
  const r = loadRecord(home, id);
  if (!r) throw new Error(`no run ${id}`);
  const pids = await stopTagged(id, r.heartbeat?.bootId, o.graceMs);
  const after = loadRecord(home, id) ?? r;
  if (TERMINAL.has(after.state)) return { record: after, pids };
  return { record: markTerminal(home, after, "failed", "stopped by jills stop") ?? after, pids };
}

// ---------------------------------------------------------------- chat controls

/** Apply a chat control through the suggest plug-in; returns the chat's last suggestion afterwards. */
async function chatChange(session: string | undefined, change: ChatChange, o: BaseOpts): Promise<LastSuggestion | undefined> {
  const c = await context(o);
  return c.plugins.suggest.chat(session, change, c.config);
}

/** `dismiss` quiets this chat; `quiet` turns on quiet mode; `on` resumes suggestions. */
export const chat = (session: string, change: "dismiss" | "quiet" | "on", o: BaseOpts = {}) => chatChange(session, { kind: change }, o);
export const dismiss = (session: string, o: BaseOpts = {}) => chat(session, "dismiss", o);
export const quiet = (session: string, o: BaseOpts = {}) => chat(session, "quiet", o);

export async function on(session: string, o: BaseOpts & { repo?: string; cwd?: string; unmute?: boolean } = {}): Promise<LastSuggestion | undefined> {
  return chatChange(session, { kind: "on", unmute: o.unmute ? await resolveRepo(o.repo, o.cwd) : undefined }, o);
}

/** Mute a Jill (default: the last one suggested in this chat; else all) for this repo. */
export async function never(o: BaseOpts & { repo?: string; cwd?: string; jill?: string; session?: string } = {}): Promise<string> {
  const repo = await resolveRepo(o.repo, o.cwd);
  if (!repo) throw new Error("never: not in a git repo; pass --repo <path>");
  const last = await chatChange(o.session, { kind: "never", repo, jill: o.jill }, o);
  return `muted ${o.jill ?? last?.jill ?? "all Jills"} for ${repo}`;
}

/** The last suggestion in a chat with the inputs Jev proposed. */
export const lastSuggested = (session: string, o: BaseOpts = {}) => chatChange(session, { kind: "last" }, o);

export interface GoOpts extends BaseOpts {
  session: string;
  /** Jill to start; defaults to the one last suggested in this chat. */
  jill?: string;
  /** Inputs given by hand; they override the saved suggestion's inputs. */
  inputs?: Record<string, string>;
  cwd?: string;
}

/**
 * `/jills go`: start the Jill last suggested in this chat (or `jill`) with the
 * inputs Jev proposed, overridden by any given by hand. Only inputs the Jill
 * declares are kept; `dropped` names the rest.
 */
export async function go(o: GoOpts): Promise<{ record: RunRecord; inputs: Record<string, string>; dropped: string[] }> {
  const last = await lastSuggested(o.session, o);
  const name = o.jill ?? last?.jill;
  if (!name) throw new Error("nothing was suggested in this chat; use jills start <jill>");
  const j = (await context(o)).lookup(name);
  const merged = { ...(last?.jill === name ? last.inputs : {}), ...o.inputs };
  const inputs = declaredInputs(j, merged);
  const record = await start(name, { home: o.home, inputs, cwd: o.cwd, session: o.session });
  return { record, inputs, dropped: Object.keys(merged).filter((k) => !(k in inputs)) };
}

export const setAuto = (onOff: boolean, o: BaseOpts = {}) => setConfigValue("auto", onOff, o.home ?? jillsHome());

// ---------------------------------------------------------------- check / try / new

export interface CheckReport {
  errors: string[];
  warnings: string[];
  jills: string[];
}

/** Validate config, Jills and their steps (each runner plug-in describes its steps). Duplicate names are warnings. */
export async function check(o: BaseOpts = {}): Promise<CheckReport> {
  const warnings: string[] = [];
  let c: Ctx;
  try {
    c = await context(o);
  } catch (e) {
    return { errors: [(e as Error).message], warnings, jills: [] };
  }
  const scan = scanJills(c.config.jill_paths);
  const errors = [...scan.errors];
  for (const [n, paths] of scan.duplicates) warnings.push(`Jill "${n}" found more than once; using ${paths[0]} (also: ${paths.slice(1).join(", ")})`);
  for (const p of c.config.jill_paths) if (!existsSync(p)) warnings.push(`jill path ${p} does not exist`);
  for (const r of c.plugins.runners) {
    const found = r.check?.(c.config);
    errors.push(...(found?.errors ?? []));
    warnings.push(...(found?.warnings ?? []));
  }
  for (const j of c.jills.values()) {
    const err = (m: string) => errors.push(`${j.path}: ${m}`);
    const refused = refusal(j, c.plugins.isolation);
    if (refused) err(refused);
    if (!j.worktree)
      warnings.push(`Jill "${j.name}" sets worktree: false (${NO_WORKTREE_NOTE}; Jills never commits). Worktrees are strongly recommended: remove the line or set worktree: true.`);
    try {
      checkNesting(j, c.lookup);
    } catch (e) {
      err((e as Error).message);
    }
    for (const d of describeSteps(c, j, {}, false)) if (d.error) err(d.error);
  }
  return { errors, warnings, jills: [...c.jills.keys()] };
}

/**
 * Each step of `root` as one dry-run line (nested Jills too, when `deep`), with
 * placeholder run id and workspace. `error` is set when no runner can run a step.
 */
function* describeSteps(c: Ctx, root: JillDef, inputs: Record<string, string>, deep = true, jill = root, indent = ""): Generator<{ line: string; error?: string }> {
  const par = root.worktree ? parallelWriters(jill, c.lookup) : new Set<string>();
  for (const s of jill.steps) {
    const meta = [s.needs.length ? `needs ${s.needs.join(",")}` : "", s.copies > 1 ? `copies ${s.copies}` : "", s.writes ? "writes" : "", par.has(s.name) ? "child worktree" : "", s.timeout ? `timeout ${String(s.timeout)}` : ""].filter(Boolean);
    const head = `${indent}- ${s.name}${s.jill ? `: jill ${s.jill}` : ""}${meta.length ? ` (${meta.join("; ")})` : ""}`;
    if (s.jill) {
      yield { line: head };
      if (deep) yield* describeSteps(c, root, inputs, deep, c.lookup(s.jill)!, indent + "  ");
      continue;
    }
    try {
      const ph = { runId: "<run-id>", cwd: "<workspace>", config: c.config };
      const cmd = stepCommand(s, jill, inputs, { ...ph, plugins: c.plugins, key: s.name, copy: s.copies > 1 ? 1 : undefined, steps: {} });
      if (!cmd.runner) throw new Error("no runner plug-in can run this step");
      const desc = cmd.runner.describe({ ...ph, stepKey: s.name, step: s, jill, text: cmd.text, env: {} });
      const env = Object.entries(cmd.shellEnv).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
      yield { line: `${head}: ${desc}${env.length ? `  env ${env.join(" ")}` : ""}` };
    } catch (e) {
      yield { line: `${head}: ERROR: ${(e as Error).message}`, error: `step ${s.name}: ${(e as Error).message}` };
    }
  }
}

/** Describe what a run would do, without running anything. */
export async function dryRun(jillName: string, o: StartOpts = {}): Promise<string[]> {
  const c = await context(o);
  const { j, inputs } = validate(c, jillName, o.inputs);
  const repo = resolve(inputs.repo ?? o.cwd ?? process.cwd());
  return [
    `Jill ${j.name}: ${j.description}`,
    j.worktree ? `workspace: new worktree on branch jills/${j.name}-<run-id> from ${repo} (under ${join(c.config.home, "worktrees")})` : `workspace: ${repo} (${NO_WORKTREE_NOTE}; no commits)`,
    `inputs: ${JSON.stringify(inputs)}`,
    ...[...describeSteps(c, j, inputs)].map((d) => d.line),
  ];
}

/** Scaffold <first jill_path>/<name>/JILL.md from examples/JILL.template.md. Returns the file path. */
export function newJill(name: string, o: BaseOpts = {}): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`bad Jill name "${name}"`);
  const file = join(loadConfig(o.home ?? jillsHome()).jill_paths[0]!, name, "JILL.md");
  if (existsSync(file)) throw new Error(`${file} already exists`);
  const template = readFileSync(new URL("../../examples/JILL.template.md", import.meta.url), "utf8");
  writeFileAtomic(file, template.replaceAll("__NAME__", name));
  return file;
}
