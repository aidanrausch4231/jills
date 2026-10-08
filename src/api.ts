import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jillsHome, loadConfig, setConfigValue, type JillsConfig } from "./config.js";
import { parallelWriters, RunEngine, stepCommand, type EventListener } from "./engine.js";
import { checkNesting, NO_WORKTREE_NOTE, refusal, scanJills, type JillDef } from "./jillfile.js";
import { loadPlugins, type PluginSet } from "./plugins/index.js";
import type { JillSummary, MatchResult, Turn } from "./plugins/types.js";
import { stopTagged } from "./proc.js";
import { listRecords, loadRecord, refreshRecord, resultLine, runLogDir, saveRecord, TERMINAL, waitForRun, type RunRecord, type WaitOpts } from "./runs.js";
import { isMuted, loadSession, muteRepo, saveSession, SUGGEST_EVERY, unmuteRepo, updateSession, type SessionState } from "./session.js";
import { newId } from "./util.js";

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

export interface Suggestion {
  action: "suggest" | "quiet";
  reason: string;
  jill?: string;
  description?: string;
  inputs?: Record<string, string>;
  confidence?: number;
  label?: MatchResult["label"];
  matcher?: string;
  /** Global auto switch: when true the main agent should start the Jill itself. */
  auto: boolean;
  /** Text to show the user. */
  text?: string;
  /** Text for the main agent's context. */
  agentContext?: string;
  /** Whether the suggested Jill runs in its own worktree. */
  worktree?: boolean;
  /** Short warning to show with the suggestion (e.g. "no worktree: edits your checkout directly"). */
  warning?: string;
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

/** Jev (not keywords) named a Jill with inputs that differ from the ignored suggestion's. */
function isNewTarget(m: MatchResult, last: SessionState["lastSuggestion"]): boolean {
  const given = Object.entries(m.inputs ?? {}).filter(([, v]) => String(v).trim() !== "");
  if (m.matcher === "keywords" || !given.length) return false;
  return !last || last.jill !== m.jill || given.some(([k, v]) => (last.inputs ?? {})[k] !== v);
}

/** The main agent's instructions for a suggestion (manual: ask the user; auto: start it). */
function agentText(auto: boolean, what: string, startCmd: string): string {
  return auto
    ? `[Jills] Jev matched ${what}. Auto mode is on: start it with the start_jill MCP tool (or \`${startCmd}\`), tell the user you started it, then run \`jills wait <run-id>\` in the background and report the one-line result (branch + logs). Nothing merges itself.`
    : `[Jills] Jev suggests ${what}. Manual mode: do NOT start it yourself. Ask the user whether to run it; they can type /jills go to start it, /jills dismiss to quiet this chat, or /jills never to mute it for this repo.`;
}

/**
 * Jev check for one chat message. Applies the anti-nag rules, then asks the
 * matchers (Jev, then keywords). Stateless per call apart from the session file.
 */
export async function suggest(o: SuggestOpts): Promise<Suggestion> {
  const c = await context(o);
  const home = c.config.home;
  const auto = c.config.auto;
  const s = loadSession(home, o.session);
  s.messages += 1;
  const quiet = (reason: string, extra: Partial<Suggestion> = {}): Suggestion => {
    saveSession(home, s);
    return { action: "quiet", reason, auto, ...extra };
  };
  const last = s.lastSuggestion;
  // A suggestion nobody acted on before this message counts as ignored.
  if (last && !last.resolved && last.at < s.messages) last.resolved = s.waitingForNew = true;
  if (s.quiet) return quiet("quiet mode is on for this chat (/jills on to resume)");
  if (s.dismissed) return quiet("dismissed in this chat");
  s.runs = s.runs.filter((id) => {
    const r = refreshRecord(home, id);
    return !!r && !TERMINAL.has(r.state);
  });
  if (s.runs.length) return quiet(`a Jill is running in this chat (${s.runs.join(", ")})`);
  if (last && s.messages - last.at < SUGGEST_EVERY) return quiet(`at most one suggestion per ${SUGGEST_EVERY} messages`);
  const repo = await resolveRepo(o.repo, o.cwd);
  const jills = [...c.jills.values()].filter((j) => !isMuted(home, repo, j.name)).map(summarize);
  if (!jills.length) return quiet("no Jills to suggest");
  const input = { message: o.message, recent: (o.recent ?? []).slice(-3), jills, already: [...new Set(s.suggested)], config: c.config };
  let m: MatchResult | undefined;
  for (const matcher of c.plugins.matchers) if ((m = await matcher.match(input))) break;
  if (!m) return quiet("no matcher answered");
  // Whatever a matcher plug-in returns, keep only inputs the named Jill declares.
  if (m.jill) m = { ...m, inputs: declaredInputs(c.lookup(m.jill), m.inputs) };
  const base = { label: m.label, matcher: m.matcher, confidence: m.confidence };
  if (m.label !== "new" || !m.jill) return quiet(m.label === "same" ? "same task as before" : "just talk", base);
  if (s.waitingForNew) {
    // Ignored → wait for a new task: the ignored Jill (or one already suggested
    // here) stays quiet until a different Jill matches, or Jev names the same
    // Jill for a different target (other inputs). Keyword hits are never "new".
    const ignored = new Set([...(last ? [last.jill] : []), ...s.suggested]);
    if (ignored.has(m.jill) && !isNewTarget(m, last)) return quiet("ignored; waiting for a new task", { ...base, jill: m.jill });
    s.waitingForNew = false;
  }
  if (m.confidence < c.config.threshold) return quiet(`not confident enough (${m.confidence} < ${c.config.threshold})`, { ...base, jill: m.jill });
  const j = c.lookup(m.jill);
  if (!j) return quiet(`matcher named unknown Jill ${m.jill}`, base);
  const inputs = m.inputs ?? {};
  s.lastSuggestion = { jill: j.name, at: s.messages, resolved: false, inputs };
  s.suggested.push(j.name);
  saveSession(home, s);
  const inputText = Object.keys(inputs).length ? ` with ${Object.entries(inputs).map(([k, v]) => `${k}=${v}`).join(", ")}` : "";
  const warning = j.worktree ? undefined : NO_WORKTREE_NOTE;
  const warnText = warning ? ` (${warning})` : "";
  const text = `Jev: this looks like a job for Jill "${j.name}"${inputText}: ${j.description}${warnText}`;
  const startCmd = `jills start ${j.name}${Object.entries(inputs).map(([k, v]) => ` --input ${k}=${JSON.stringify(v)}`).join("")} --session ${o.session}`;
  const agentContext = agentText(auto, `Jill "${j.name}"${inputText} (confidence ${m.confidence})${warnText}`, startCmd);
  return { action: "suggest", reason: "new task fits a saved Jill", jill: j.name, description: j.description, inputs, ...base, auto, text, agentContext, worktree: j.worktree, ...(warning ? { warning } : {}) };
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
  if (o.session)
    updateSession(c.config.home, o.session, (s) => {
      s.runs.push(record.id);
      if (s.lastSuggestion) s.lastSuggestion.resolved = true;
      s.waitingForNew = false;
    });
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
  const at = new Date().toISOString();
  Object.assign(after, { state: "failed", error: "stopped by jills stop", finished: at });
  for (const s of Object.values(after.steps)) if (s.state === "running") Object.assign(s, { state: "failed", reason: "stopped by jills stop", finished: at });
  after.events.push({ at, type: "failed", note: after.error });
  saveRecord(home, after);
  return { record: after, pids };
}

// ---------------------------------------------------------------- chat controls

const settle = (s: SessionState) => void (s.lastSuggestion && (s.lastSuggestion.resolved = true));

/** `dismiss` quiets this chat; `quiet` turns on quiet mode; `on` resumes suggestions. */
export function chat(session: string, change: "dismiss" | "quiet" | "on", o: BaseOpts = {}): SessionState {
  return updateSession(homeOf(o), session, (s) => {
    if (change === "dismiss") {
      s.dismissed = true;
      settle(s);
    }
    else if (change === "quiet") s.quiet = true;
    else [s.quiet, s.dismissed, s.waitingForNew] = [false, false, false];
  });
}
export const dismiss = (session: string, o: BaseOpts = {}) => chat(session, "dismiss", o);
export const quiet = (session: string, o: BaseOpts = {}) => chat(session, "quiet", o);

export async function on(session: string, o: BaseOpts & { repo?: string; cwd?: string; unmute?: boolean } = {}): Promise<SessionState> {
  const repo = o.unmute ? await resolveRepo(o.repo, o.cwd) : undefined;
  if (repo) unmuteRepo(homeOf(o), repo);
  return chat(session, "on", o);
}

/** Mute a Jill (default: the last one suggested in this chat; else all) for this repo. */
export async function never(o: BaseOpts & { repo?: string; cwd?: string; jill?: string; session?: string } = {}): Promise<string> {
  const home = homeOf(o);
  const jill = o.jill ?? (o.session ? loadSession(home, o.session).lastSuggestion?.jill : undefined);
  const repo = await resolveRepo(o.repo, o.cwd);
  if (!repo) throw new Error("never: not in a git repo; pass --repo <path>");
  muteRepo(home, repo, jill ?? "*");
  if (o.session) updateSession(home, o.session, settle);
  return `muted ${jill ?? "all Jills"} for ${repo}`;
}

/** The last suggestion in a chat with the inputs Jev proposed (saved in the session state). */
export function lastSuggested(session: string, o: BaseOpts = {}): { jill: string; inputs: Record<string, string> } | undefined {
  const last = loadSession(homeOf(o), session).lastSuggestion;
  return last ? { jill: last.jill, inputs: { ...last.inputs } } : undefined;
}

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
  const last = lastSuggested(o.session, o);
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
    for (const s of j.steps.filter((s) => !s.jill)) {
      const runner = c.plugins.runners.find((p) => p.canRun(s));
      if (!runner) err(`step ${s.name}: no runner plug-in can run this step`);
      else
        try {
          runner.describe({ runId: "<run-id>", stepKey: s.name, step: s, jill: j, cwd: "<workspace>", text: "", env: {}, config: c.config });
        } catch (e) {
          err(`step ${s.name}: ${(e as Error).message}`);
        }
    }
  }
  return { errors, warnings, jills: [...c.jills.keys()] };
}

/** Describe what a run would do, without running anything. */
export async function dryRun(jillName: string, o: StartOpts = {}): Promise<string[]> {
  const c = await context(o);
  const { j, inputs } = validate(c, jillName, o.inputs);
  const repo = resolve(inputs.repo ?? o.cwd ?? process.cwd());
  const lines = [
    `Jill ${j.name}: ${j.description}`,
    j.worktree ? `workspace: new worktree on branch jills/${j.name}-<run-id> from ${repo} (under ${join(c.config.home, "worktrees")})` : `workspace: ${repo} (${NO_WORKTREE_NOTE}; no commits)`,
    `inputs: ${JSON.stringify(inputs)}`,
  ];
  const walk = (jill: JillDef, indent: string) => {
    const par = j.worktree ? parallelWriters(jill, c.lookup) : new Set<string>();
    for (const s of jill.steps) {
      const meta = [s.needs.length ? `needs ${s.needs.join(",")}` : "", s.copies > 1 ? `copies ${s.copies}` : "", s.writes ? "writes" : "", par.has(s.name) ? "child worktree" : "", s.timeout ? `timeout ${String(s.timeout)}` : ""];
      const tag = meta.some(Boolean) ? ` (${meta.filter(Boolean).join("; ")})` : "";
      const head = `${indent}- ${s.name}${tag}`;
      if (s.jill) {
        lines.push(`${indent}- ${s.name}: jill ${s.jill}${tag}`);
        walk(c.lookup(s.jill)!, indent + "  ");
        continue;
      }
      try {
        const cmd = stepCommand(s, jill, inputs, { config: c.config, plugins: c.plugins, runId: "<run-id>", key: s.name, cwd: "<workspace>", copy: s.copies > 1 ? 1 : undefined, steps: {} });
        const desc = cmd.runner ? cmd.runner.describe({ runId: "<run-id>", stepKey: s.name, step: s, jill, cwd: "<workspace>", text: cmd.text, env: {}, config: c.config }) : "NO RUNNER";
        const env = Object.entries(cmd.shellEnv).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
        lines.push(`${head}: ${desc}${env.length ? `  env ${env.join(" ")}` : ""}`);
      } catch (e) {
        lines.push(`${head}: ERROR: ${(e as Error).message}`);
      }
    }
  };
  walk(j, "");
  return lines;
}

/** Scaffold <first jill_path>/<name>/JILL.md. Returns the file path. */
export function newJill(name: string, o: BaseOpts = {}): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`bad Jill name "${name}"`);
  const dir = join(loadConfig(o.home ?? jillsHome()).jill_paths[0]!, name);
  const file = join(dir, "JILL.md");
  if (existsSync(file)) throw new Error(`${file} already exists`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    file,
    `---
name: ${name}
description: One line on what this Jill does.
when: When the user asks to ... (Jev reads this to match chat messages)
keywords: [${name}]
inputs:
  - name: task
    description: What to do
    required: true
worktree: true  # strongly recommended: agents work in their own git worktree; false edits your checkout directly
timeout: 30m
steps:
  first:
    run: echo "working on {{inputs.task}}"
  # second:
  #   agent: harness-implementer
  #   task: "{{inputs.task}}"
  #   needs: [first]
  #   writes: true
---
Notes for people reading this Jill.
`,
  );
  return file;
}
