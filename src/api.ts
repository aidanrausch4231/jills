import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TIMEOUT, jillsHome, loadConfig, setConfigValue, type JillsConfig } from "./config.js";
import { nestedInputs, RunEngine, stepCommand, type EventListener } from "./engine.js";
import { checkNesting, NO_WORKTREE_NOTE, refusal, scanJills, uncheckedWriters, type JillDef } from "./jillfile.js";
import { loadPlugins, type PluginSet } from "./plugins/index.js";
import { withJevKey } from "./plugins/matcher-jev.js";
import type { ChatChange, JillSummary, MatchResult, SuggestCtx, Suggestion, Turn } from "./plugins/types.js";
import { stopTagged } from "./proc.js";
import { listRecords, loadHeartbeat, loadRecord, markTerminal, refreshRecord, resultLine, runLogDir, saveRecord, TERMINAL, type RunRecord } from "./runs.js";
import { newId, parseLimit, sleep, writeFileAtomic } from "./util.js";

/** `home`: Jills home; defaults to $JILLS_HOME or ~/.jills. */
export type BaseOpts = { home?: string };

type Ctx = { config: JillsConfig; plugins: PluginSet; jills: Map<string, JillDef>; lookup: (name: string) => JillDef | undefined };

const configOf = (o: BaseOpts) => loadConfig(o.home ?? jillsHome());
const homeOf = (o: BaseOpts) => configOf(o).home;
const storage = async (o: BaseOpts) => ({ home: homeOf(o), backend: (await loadPlugins(configOf(o), true)).backend });
export { executeRun } from "./plugins/execute-run.js";

async function context(o: BaseOpts = {}): Promise<Ctx> {
  const config = configOf(o);
  const jills = scanJills(config.jill_paths).items;
  return { config, plugins: await loadPlugins(config), jills, lookup: (n) => jills.get(n) };
}

const summarize = (j: JillDef): JillSummary => ({ name: j.name, description: j.description, when: j.when, inputs: j.inputs.map((i) => i.name), required: j.inputs.filter((i) => i.required && i.default === undefined).map((i) => i.name) });

/** List saved Jills (first match per name across jill_paths). */
export async function listJills(o: BaseOpts = {}): Promise<(JillSummary & { path: string })[]> {
  return [...(await context(o)).jills.values()].map((j) => ({ ...summarize(j), path: j.path }));
}

export interface SuggestOpts extends BaseOpts {
  /** Chat session id (anti-nag state is kept per id) and the message to check. */
  session: string; message: string;
  /** Recent turns before this message; the last 3 are used. */
  recent?: Turn[];
  /** Repo the chat works in (for per-repo "never"). Defaults to the git root of cwd. */
  repo?: string;
  cwd?: string;
  /** The harness's own key lookup for Jev (gets jev.key_env's name); core passes it only to the Jev matcher, never stored. */
  jevKey?: (name: string) => Promise<string | undefined>;
}

/** The repo a chat works in: `repo`, else the git root of cwd (undefined outside git). */
async function resolveRepo(repo?: string, cwd?: string): Promise<string | undefined> {
  try {
    return repo ? resolve(repo) : execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: cwd ?? process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
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
  if (process.env.JILLS_RUN_ID) return { action: "quiet", reason: "inside a Jills run", auto: false }; // workers: no Jev call, no state write
  const c = await context(o);
  const declared = (m: MatchResult | undefined) => (m?.jill ? { ...m, inputs: declaredInputs(c.lookup(m.jill), m.inputs) } : m);
  const match: SuggestCtx["match"] = async (input) => {
    for (const matcher of c.plugins.matchers) {
      const m = await matcher.match(withJevKey(matcher, input, o.jevKey, c.config));
      if (m) return declared(m);
    }
    return undefined;
  };
  const merges = (j: JillDef | undefined, seen = new Set<string>()): boolean => !!j && j.steps.some((s) => s.merges || (!!s.jill && !seen.has(s.jill) && merges(c.lookup(s.jill), seen.add(s.jill))));
  const jills = [...c.jills.values()].map((j) => ({ ...summarize(j), worktree: j.worktree, merges: merges(j) }));
  const input = { session: o.session, message: o.message, recent: (o.recent ?? []).slice(-3), repo: await resolveRepo(o.repo, o.cwd) };
  const s = await c.plugins.suggest.suggest(input, { jills, config: c.config, backend: c.plugins.backend, match });
  return s.jill && s.inputs ? { ...s, inputs: declaredInputs(c.lookup(s.jill), s.inputs) } : s;
}

export interface StartOpts extends BaseOpts {
  inputs?: Record<string, string>;
  /** Repo/folder to run in; defaults to inputs.repo, then process.cwd(). */
  cwd?: string;
  session?: string;
}

/** Look up a Jill, refuse what v1 cannot run, check nesting, fill defaults and required inputs; resolve the repo. */
function validate(c: Ctx, name: string, o: StartOpts): { j: JillDef; inputs: Record<string, string>; repo: string } {
  const j = c.lookup(name);
  if (!j) throw new Error(`no Jill named "${name}" (jill_paths: ${c.config.jill_paths.join(", ")})`);
  const refused = refusal(j, c.plugins.isolation);
  if (refused) throw new Error(refused);
  checkNesting(j, c.lookup);
  const inputs = { ...o.inputs };
  for (const i of j.inputs) if (inputs[i.name] === undefined && i.default !== undefined) inputs[i.name] = i.default;
  const missing = j.inputs.filter((i) => i.required && inputs[i.name] === undefined).map((i) => i.name);
  if (missing.length) throw new Error(`Jill "${j.name}" needs input(s): ${missing.join(", ")} (use --input name=value)`);
  return { j, inputs, repo: resolve(inputs.repo ?? o.cwd ?? process.cwd()) };
}

/** Validate a start request and save the queued run record. */
async function prepareRun(name: string, o: StartOpts): Promise<{ c: Ctx; record: RunRecord }> {
  const c = await context(o);
  const { j, inputs, repo } = validate(c, name, o);
  if (!existsSync(repo)) throw new Error(`repo folder ${repo} does not exist`);
  const id = newId();
  const logDir = runLogDir(c.config.home, id);
  const record: RunRecord = { version: 1, id, jill: j.name, jillPath: j.path, inputs, state: "queued", created: new Date().toISOString(), repo, session: o.session, logDir, steps: {}, events: [] };
  // Executors need the effective limit before the engine starts (same fallback and clamp).
  record.timeLimitMs = [j.timeout, c.config.default_timeout, DEFAULT_TIMEOUT].map(parseLimit).find((ms) => ms !== undefined)!;
  mkdirSync(logDir, { recursive: true });
  saveRecord(c.config.home, record, c.plugins.backend);
  return { c, record };
}

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

/** Run a Jill in the foreground, in this process. Resolves with the final record. */
export async function runNow(jillName: string, o: StartOpts & { onEvent?: EventListener } = {}): Promise<RunRecord> {
  const { c, record } = await prepareRun(jillName, o);
  return new RunEngine(record, { ...c, onEvent: o.onEvent }).execute();
}

export interface WaitOpts extends BaseOpts {
  timeoutMs?: number; pollMs?: number;
  /** Observer-clock age of a heartbeat stamp that counts as stopped (default STALE_MS). */
  staleMs?: number;
  onUpdate?: (r: RunRecord) => void;
}

/** Block until a run is done/failed/stuck/needs-you (or timeoutMs passes); returns a one-line result. */
export async function wait(id: string, o: WaitOpts = {}): Promise<{ record: RunRecord; timedOut: boolean; line: string }> {
  const { home, backend } = await storage(o);
  const t0 = Date.now();
  for (let seen = -1; ; await sleep(o.pollMs ?? 250)) {
    const r = refreshRecord(home, id, o.staleMs, backend);
    if (!r) throw new Error(`no run ${id}`);
    if (r.events.length !== seen) o.onUpdate?.(r);
    seen = r.events.length;
    if (TERMINAL.has(r.state)) return { record: r, timedOut: false, line: resultLine(r) };
    if (o.timeoutMs !== undefined && Date.now() - t0 >= o.timeoutMs) return { record: r, timedOut: true, line: `jills run ${id} still ${r.state} (wait timed out)` };
  }
}

/** One run's record, or the recent runs when no id is given. Never signals anything. */
export function status(id: string, o?: BaseOpts): Promise<RunRecord | undefined>;
export function status(id?: undefined, o?: BaseOpts): Promise<RunRecord[]>;
export async function status(id?: string, o: BaseOpts = {}): Promise<RunRecord | RunRecord[] | undefined> {
  const { home, backend } = await storage(o);
  if (id) return refreshRecord(home, id, undefined, backend);
  return listRecords(home, backend).map((r) => (TERMINAL.has(r.state) ? r : (refreshRecord(home, r.id, undefined, backend) ?? r)));
}

/**
 * `jills stop <run>`: SIGTERM (then SIGKILL) only the processes whose environment
 * holds JILLS_RUN_ID=<run>, on the boot that recorded the run. A live runner
 * records its own outcome; otherwise the run is recorded as failed here.
 */
export async function stop(id: string, o: BaseOpts & { graceMs?: number } = {}): Promise<{ record: RunRecord; pids: number[] }> {
  const { home, backend } = await storage(o);
  const r = loadRecord(home, id, backend);
  if (!r) throw new Error(`no run ${id}`);
  const pids = await stopTagged(id, loadHeartbeat(home, id, backend)?.bootId, o.graceMs);
  const after = loadRecord(home, id, backend) ?? r;
  return { record: TERMINAL.has(after.state) ? after : (markTerminal(home, after, "failed", "stopped by jills stop", undefined, backend) ?? after), pids };
}

/**
 * Apply a chat control (dismiss, quiet, on, last, ...) through the suggest plug-in;
 * returns the chat's last suggestion afterwards. `on` with `unmute: true` unmutes
 * the git root of `o.cwd`; a path in `unmute` names the repo itself.
 */
export async function chat(session: string | undefined, change: ChatChange | { kind: "on"; unmute?: string | true }, o: BaseOpts & { cwd?: string } = {}) {
  const c = await context(o);
  if (change.kind === "on" && change.unmute !== undefined) change = { kind: "on", unmute: await resolveRepo(change.unmute === true ? undefined : change.unmute, o.cwd) };
  return c.plugins.suggest.chat(session, change as ChatChange, c.config);
}

/** Mute a Jill (default: the last one suggested in this chat; else all) for this repo. */
export async function never(o: BaseOpts & { repo?: string; cwd?: string; jill?: string; session?: string } = {}): Promise<string> {
  const repo = await resolveRepo(o.repo, o.cwd);
  if (!repo) throw new Error("never: not in a git repo; pass --repo <path>");
  const last = await chat(o.session, { kind: "never", repo, jill: o.jill }, o);
  return `muted ${o.jill ?? last?.jill ?? "all Jills"} for ${repo}`;
}

export interface GoOpts extends BaseOpts {
  session: string;
  /** Jill to start; defaults to the one last suggested in this chat. */
  jill?: string;
  /** Inputs given by hand; they override the saved suggestion's inputs. */
  inputs?: Record<string, string>; cwd?: string;
}

/**
 * `/jills go`: start the Jill last suggested in this chat (or `jill`) with the
 * inputs Jev proposed, overridden by any given by hand. Only inputs the Jill
 * declares are kept; `dropped` names the rest.
 */
export async function go(o: GoOpts): Promise<{ record: RunRecord; inputs: Record<string, string>; dropped: string[] }> {
  const last = await chat(o.session, { kind: "last" }, o);
  const name = o.jill ?? last?.jill;
  if (!name) throw new Error("nothing was suggested in this chat; use jills start <jill>");
  const merged = { ...(last?.jill === name ? last.inputs : {}), ...o.inputs };
  const inputs = declaredInputs((await context(o)).lookup(name), merged);
  const record = await start(name, { home: o.home, inputs, cwd: o.cwd, session: o.session });
  return { record, inputs, dropped: Object.keys(merged).filter((k) => !(k in inputs)) };
}

export const setAuto = (onOff: boolean, o: BaseOpts = {}) => setConfigValue("auto", onOff, homeOf(o));

/** Validate config, Jills and their steps (each runner plug-in describes its steps). Duplicate names are warnings. */
export async function check(o: BaseOpts = {}): Promise<{ errors: string[]; warnings: string[]; jills: string[] }> {
  const warnings: string[] = [];
  const c = await context(o).catch((e: Error) => e);
  if (c instanceof Error) return { errors: [c.message], warnings, jills: [] };
  const scan = scanJills(c.config.jill_paths);
  const errors = [...scan.errors];
  warnings.push(...c.plugins.warnings);
  for (const [n, paths] of scan.duplicates) warnings.push(`Jill "${n}" found more than once; using ${paths[0]} (also: ${paths.slice(1).join(", ")})`);
  for (const p of c.config.jill_paths) if (!existsSync(p)) warnings.push(`jill path ${p} does not exist`);
  for (const r of [...c.plugins.runners, c.plugins.backend, ...c.plugins.executor ? [c.plugins.executor] : []]) {
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
    warnings.push(...uncheckedWriters(j));
    for (const s of j.steps.filter((x) => x.merges)) warnings.push(`Jill "${j.name}" step ${s.name} merges into the branch the run started from when done (merges: true)`);
    try {
      checkNesting(j, c.lookup); // first: the walk below follows nested Jills
      for (const d of describeSteps(c, j, {})) if (d.error) err(d.error);
    } catch (e) {
      err((e as Error).message);
    }
  }
  return { errors, warnings, jills: [...c.jills.keys()] };
}

/**
 * Each step of `root` as one dry-run line (nested Jills too), with
 * placeholder run id and workspace. `error` is set when no runner can run a step.
 */
function* describeSteps(c: Ctx, root: JillDef, inputs: Record<string, string>, jill = root, indent = ""): Generator<{ line: string; error?: string }> {
  const par = (root.worktree && c.plugins.isolation.get(root.box ?? "worktree")?.parallel?.(jill, c.lookup)) || new Set<string>();
  for (const s of jill.steps) {
    const loop = s.onFail ? `on fail back to ${s.onFail.backTo}, max ${s.onFail.maxRounds} rounds` : "";
    const meta = [s.needs.length ? `needs ${s.needs.join(",")}` : "", s.copies > 1 ? `copies ${s.copies}` : s.extra.foreach !== undefined ? `foreach ${String(s.extra.foreach)}` : "", s.writes ? "writes" : "", par.has(s.name) ? "child worktree" : "", s.timeout ? `timeout ${String(s.timeout)}` : "", loop, s.merges ? "merges into your branch" : ""].filter(Boolean);
    const head = `${indent}- ${s.name}${s.jill ? `: jill ${s.jill}` : ""}${meta.length ? ` (${meta.join("; ")})` : ""}`;
    if (s.jill) { // nested Jill: the same inputs the engine gives it
      yield { line: head };
      yield* describeSteps(c, root, nestedInputs(s, c.lookup(s.jill)!, { inputs, run_id: "<run-id>", steps: {} }), c.lookup(s.jill)!, indent + "  ");
      continue;
    }
    try {
      const ph = { runId: "<run-id>", cwd: "<workspace>", config: c.config };
      const cmd = stepCommand(s, jill, inputs, { ...ph, plugins: c.plugins, box: root.box, key: s.name, copy: s.copies > 1 ? 1 : undefined, steps: {} });
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
  const { j, inputs, repo } = validate(c, jillName, o);
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
  const file = join(configOf(o).jill_paths[0]!, name, "JILL.md");
  if (existsSync(file)) throw new Error(`${file} already exists`);
  const template = readFileSync(new URL("../../examples/JILL.template.md", import.meta.url), "utf8");
  writeFileAtomic(file, template.replaceAll("__NAME__", name));
  return file;
}
