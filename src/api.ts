import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanAgents } from "./agents.js";
import { jillsHome, loadConfig, setConfigValue, type JillsConfig } from "./config.js";
import { RunEngine, parallelWriters, type EventListener } from "./engine.js";
import { repoRoot } from "./git.js";
import { checkNesting, scanJills, v1Refusal, type JillDef, type JillScan } from "./jillfile.js";
import { loadPlugins, type PluginSet } from "./plugins/index.js";
import type { JillSummary, MatchResult, Turn } from "./plugins/types.js";
import {
  listRecords,
  loadRecord,
  refreshRecord,
  resultLine,
  runLogDir,
  saveRecord,
  TERMINAL,
  waitForRun,
  type RunRecord,
} from "./runs.js";
import { isMuted, loadSession, muteRepo, saveSession, SUGGEST_EVERY, unmuteRepo, updateSession, type SessionState } from "./session.js";
import { renderTemplate } from "./template.js";
import { newId } from "./util.js";

export interface BaseOpts {
  /** Jills home; defaults to $JILLS_HOME or ~/.jills. */
  home?: string;
}

export interface Ctx {
  config: JillsConfig;
  plugins: PluginSet;
  scan: JillScan;
  lookup: (name: string) => JillDef | undefined;
}

export async function context(o: BaseOpts = {}): Promise<Ctx> {
  const config = loadConfig(o.home ?? jillsHome());
  const plugins = await loadPlugins(config);
  const scan = scanJills(config.jill_paths);
  return { config, plugins, scan, lookup: (n) => scan.jills.get(n) };
}

function summarize(j: JillDef): JillSummary {
  return { name: j.name, description: j.description, when: j.when, inputs: j.inputs.map((i) => i.name), keywords: j.keywords };
}

/** List saved Jills (first match per name across jill_paths). */
export async function listJills(o: BaseOpts = {}): Promise<(JillSummary & { path: string })[]> {
  const c = await context(o);
  return [...c.scan.jills.values()].map((j) => ({ ...summarize(j), path: j.path }));
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
}

async function resolveRepo(repo: string | undefined, cwd: string | undefined): Promise<string | undefined> {
  if (repo) return resolve(repo);
  return repoRoot(cwd ?? process.cwd());
}

function runIsActive(home: string, id: string): boolean {
  const r = refreshRecord(home, id);
  return !!r && !TERMINAL.has(r.state);
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
  // A suggestion nobody acted on before this message counts as ignored.
  if (s.lastSuggestion && !s.lastSuggestion.resolved && s.lastSuggestion.at < s.messages) {
    s.lastSuggestion.resolved = true;
    s.waitingForNew = true;
  }
  if (s.quiet) return quiet("quiet mode is on for this chat (/jills on to resume)");
  if (s.dismissed) return quiet("dismissed in this chat");
  s.runs = s.runs.filter((id) => runIsActive(home, id));
  if (s.runs.length) return quiet(`a Jill is running in this chat (${s.runs.join(", ")})`);
  if (s.lastSuggestion && s.messages - s.lastSuggestion.at < SUGGEST_EVERY) return quiet(`at most one suggestion per ${SUGGEST_EVERY} messages`);
  const repo = await resolveRepo(o.repo, o.cwd);
  const jills = [...c.scan.jills.values()].filter((j) => !isMuted(home, repo, j.name)).map(summarize);
  if (!jills.length) return quiet("no Jills to suggest");
  const input = { message: o.message, recent: (o.recent ?? []).slice(-3), jills, already: [...new Set(s.suggested)], config: c.config };
  let m: MatchResult | undefined;
  for (const matcher of c.plugins.matchers) {
    m = await matcher.match(input);
    if (m) break;
  }
  if (!m) return quiet("no matcher answered");
  const base = { label: m.label, matcher: m.matcher, confidence: m.confidence };
  if (m.label !== "new" || !m.jill) return quiet(m.label === "same" ? "same task as before" : "just talk", base);
  s.waitingForNew = false;
  if (m.confidence < c.config.jev.threshold) return quiet(`not confident enough (${m.confidence} < ${c.config.jev.threshold})`, { ...base, jill: m.jill });
  const j = c.lookup(m.jill);
  if (!j) return quiet(`matcher named unknown Jill ${m.jill}`, base);
  s.lastSuggestion = { jill: j.name, at: s.messages, resolved: false };
  s.suggested.push(j.name);
  saveSession(home, s);
  const inputs = m.inputs ?? {};
  const inputText = Object.keys(inputs).length ? ` with ${Object.entries(inputs).map(([k, v]) => `${k}=${v}`).join(", ")}` : "";
  const text = `Jev: this looks like a job for Jill "${j.name}"${inputText}: ${j.description}`;
  const inputArgs = Object.entries(inputs).map(([k, v]) => ` --input ${k}=${JSON.stringify(v)}`).join("");
  const agentContext = auto
    ? `[Jills] Jev matched Jill "${j.name}"${inputText} (confidence ${m.confidence}). Auto mode is on: start it with the start_jill MCP tool (or \`jills start ${j.name}${inputArgs} --session ${o.session}\`), tell the user you started it, then run \`jills wait <run-id>\` in the background and report the one-line result (branch + logs). Nothing merges itself.`
    : `[Jills] Jev suggests Jill "${j.name}"${inputText} (confidence ${m.confidence}). Manual mode: do NOT start it yourself. Ask the user whether to run it; they can type /jills go to start it, /jills dismiss to quiet this chat, or /jills never to mute it for this repo.`;
  return { action: "suggest", reason: "new task fits a saved Jill", jill: j.name, description: j.description, inputs, ...base, auto, text, agentContext };
}

// ---------------------------------------------------------------- start / run

export interface StartOpts extends BaseOpts {
  inputs?: Record<string, string>;
  /** Repo/folder to run in; defaults to inputs.repo, then process.cwd(). */
  cwd?: string;
  session?: string;
}

function resolveInputs(j: JillDef, given: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...given };
  const missing: string[] = [];
  for (const i of j.inputs) {
    if (out[i.name] === undefined && i.default !== undefined) out[i.name] = i.default;
    if (out[i.name] === undefined && i.required) missing.push(i.name);
  }
  if (missing.length) throw new Error(`Jill "${j.name}" needs input(s): ${missing.join(", ")} (use --input name=value)`);
  return out;
}

/** Validate a start request and build the queued run record (not saved). */
async function prepareRun(jillName: string, o: StartOpts): Promise<{ c: Ctx; record: RunRecord }> {
  const c = await context(o);
  const j = c.lookup(jillName);
  if (!j) throw new Error(`no Jill named "${jillName}" (jill_paths: ${c.config.jill_paths.join(", ")})`);
  const refusal = v1Refusal(j);
  if (refusal) throw new Error(refusal);
  checkNesting(j, c.lookup);
  const inputs = resolveInputs(j, o.inputs ?? {});
  const repo = resolve(inputs.repo ?? o.cwd ?? process.cwd());
  if (!existsSync(repo)) throw new Error(`repo folder ${repo} does not exist`);
  const id = newId();
  const record: RunRecord = {
    version: 1,
    id,
    jill: j.name,
    jillPath: j.path,
    inputs,
    state: "queued",
    created: new Date().toISOString(),
    repo,
    session: o.session,
    logDir: runLogDir(c.config.home, id),
    steps: {},
    events: [],
  };
  return { c, record };
}

function cliPath(): string {
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

/**
 * Start a Jill as a detached runner process (no background service). Returns
 * the queued run record at once; watch it with wait() or `jills wait <id>`.
 */
export async function start(jillName: string, o: StartOpts = {}): Promise<RunRecord> {
  const { c, record } = await prepareRun(jillName, o);
  const home = c.config.home;
  mkdirSync(record.logDir, { recursive: true });
  saveRecord(home, record);
  const fd = openSync(join(record.logDir, "runner.log"), "a");
  try {
    const child = spawn(process.execPath, [cliPath(), "__run", record.id], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, JILLS_HOME: home },
      cwd: record.repo,
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  if (o.session) {
    updateSession(home, o.session, (s) => {
      s.runs.push(record.id);
      if (s.lastSuggestion) s.lastSuggestion.resolved = true;
      s.waitingForNew = false;
    });
  }
  return record;
}

/** Execute a queued run in this process (used by the detached runner). */
export async function executeRun(id: string, o: BaseOpts & { onEvent?: EventListener } = {}): Promise<RunRecord> {
  const c = await context(o);
  const r = loadRecord(c.config.home, id);
  if (!r) throw new Error(`no run ${id}`);
  if (r.state !== "queued") throw new Error(`run ${id} is ${r.state}, not queued`);
  return new RunEngine(r, { config: c.config, plugins: c.plugins, lookup: c.lookup, onEvent: o.onEvent }).execute();
}

/** Run a Jill in the foreground, in this process. Resolves with the final record. */
export async function runNow(jillName: string, o: StartOpts & { onEvent?: EventListener } = {}): Promise<RunRecord> {
  const { c, record } = await prepareRun(jillName, o);
  mkdirSync(record.logDir, { recursive: true });
  saveRecord(c.config.home, record);
  return new RunEngine(record, { config: c.config, plugins: c.plugins, lookup: c.lookup, onEvent: o.onEvent }).execute();
}

export interface WaitResult {
  record: RunRecord;
  timedOut: boolean;
  line: string;
}

/** Block until a run is done/failed/stuck/needs-you; returns a one-line result. */
export async function wait(id: string, o: BaseOpts & { timeoutMs?: number; pollMs?: number; onUpdate?: (r: RunRecord) => void } = {}): Promise<WaitResult> {
  const home = loadConfig(o.home ?? jillsHome()).home;
  const { record, timedOut } = await waitForRun(home, id, o);
  return { record, timedOut, line: timedOut ? `jills run ${id} still ${record.state} (wait timed out)` : resultLine(record) };
}

/** One run's record, or the recent runs when no id is given. */
export function status(id: string, o?: BaseOpts): RunRecord | undefined;
export function status(id?: undefined, o?: BaseOpts): RunRecord[];
export function status(id?: string, o: BaseOpts = {}): RunRecord | RunRecord[] | undefined {
  const home = loadConfig(o.home ?? jillsHome()).home;
  if (id) return refreshRecord(home, id);
  return listRecords(home).map((r) => (TERMINAL.has(r.state) ? r : (refreshRecord(home, r.id) ?? r)));
}

// ---------------------------------------------------------------- chat controls

export function dismiss(session: string, o: BaseOpts = {}): SessionState {
  return updateSession(loadConfig(o.home ?? jillsHome()).home, session, (s) => {
    s.dismissed = true;
    if (s.lastSuggestion) s.lastSuggestion.resolved = true;
  });
}

export async function never(o: BaseOpts & { repo?: string; cwd?: string; jill?: string; session?: string } = {}): Promise<string> {
  const home = loadConfig(o.home ?? jillsHome()).home;
  let jill = o.jill;
  if (!jill && o.session) jill = loadSession(home, o.session).lastSuggestion?.jill;
  const repo = await resolveRepo(o.repo, o.cwd);
  if (!repo) throw new Error("never: not in a git repo; pass --repo <path>");
  muteRepo(home, repo, jill ?? "*");
  if (o.session) updateSession(home, o.session, (s) => {
    if (s.lastSuggestion) s.lastSuggestion.resolved = true;
  });
  return `muted ${jill ?? "all Jills"} for ${repo}`;
}

export function quiet(session: string, o: BaseOpts = {}): SessionState {
  return updateSession(loadConfig(o.home ?? jillsHome()).home, session, (s) => {
    s.quiet = true;
  });
}

export async function on(session: string, o: BaseOpts & { repo?: string; cwd?: string; unmute?: boolean } = {}): Promise<SessionState> {
  const home = loadConfig(o.home ?? jillsHome()).home;
  if (o.unmute) {
    const repo = await resolveRepo(o.repo, o.cwd);
    if (repo) unmuteRepo(home, repo);
  }
  return updateSession(home, session, (s) => {
    s.quiet = false;
    s.dismissed = false;
    s.waitingForNew = false;
  });
}

/** The Jill last suggested in a chat (for /jills go). */
export function lastSuggestion(session: string, o: BaseOpts = {}): string | undefined {
  return loadSession(loadConfig(o.home ?? jillsHome()).home, session).lastSuggestion?.jill;
}

export function setAuto(onOff: boolean, o: BaseOpts = {}): void {
  setConfigValue("auto", onOff, o.home ?? jillsHome());
}

// ---------------------------------------------------------------- check / try / new

export interface CheckReport {
  errors: string[];
  warnings: string[];
  jills: string[];
  agents: number;
}

/** Validate config, Jills and agents. Duplicate names are warnings. */
export async function check(o: BaseOpts = {}): Promise<CheckReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let c: Ctx;
  try {
    c = await context(o);
  } catch (e) {
    return { errors: [(e as Error).message], warnings, jills: [], agents: 0 };
  }
  errors.push(...c.scan.errors);
  for (const [n, paths] of c.scan.duplicates) warnings.push(`Jill "${n}" found more than once; using ${paths[0]} (also: ${paths.slice(1).join(", ")})`);
  const agents = scanAgents(c.config.agent_paths);
  errors.push(...agents.errors);
  for (const [n, paths] of agents.duplicates) warnings.push(`agent "${n}" found more than once; using ${paths[0]} (also: ${paths.slice(1).join(", ")})`);
  for (const p of c.config.agent_paths) if (!existsSync(p)) warnings.push(`agent path ${p} does not exist`);
  for (const p of c.config.jill_paths) if (!existsSync(p)) warnings.push(`jill path ${p} does not exist`);
  for (const j of c.scan.jills.values()) {
    const refusal = v1Refusal(j);
    if (refusal) warnings.push(refusal);
    try {
      checkNesting(j, c.lookup);
    } catch (e) {
      errors.push(`${j.path}: ${(e as Error).message}`);
    }
    for (const s of j.steps)
      if (s.agent && !agents.agents.has(s.agent)) errors.push(`${j.path}: step ${s.name} uses unknown agent "${s.agent}"`);
  }
  return { errors, warnings, jills: [...c.scan.jills.keys()], agents: agents.agents.size };
}

/** Describe what a run would do, without running anything. */
export async function dryRun(jillName: string, o: StartOpts = {}): Promise<string[]> {
  const c = await context(o);
  const j = c.lookup(jillName);
  if (!j) throw new Error(`no Jill named "${jillName}"`);
  const refusal = v1Refusal(j);
  if (refusal) throw new Error(refusal);
  checkNesting(j, c.lookup);
  const inputs = resolveInputs(j, o.inputs ?? {});
  const repo = resolve(inputs.repo ?? o.cwd ?? process.cwd());
  const lines: string[] = [];
  lines.push(`Jill ${j.name}: ${j.description}`);
  lines.push(j.worktree ? `workspace: new worktree on branch jills/${j.name}-<run-id> from ${repo} (under ${join(c.config.home, "worktrees")})` : `workspace: ${repo} (worktree: false, no commits)`);
  lines.push(`inputs: ${JSON.stringify(inputs)}`);
  const walk = (jill: JillDef, indent: string, isolated: boolean) => {
    const par = isolated ? parallelWriters(jill, c.lookup) : new Set<string>();
    for (const s of jill.steps) {
      const meta = [s.needs.length ? `needs ${s.needs.join(",")}` : "", s.copies > 1 ? `copies ${s.copies}` : "", s.writes ? "writes" : "", par.has(s.name) ? "child worktree" : "", s.timeout ? `timeout ${String(s.timeout)}` : ""].filter(Boolean).join("; ");
      if (s.jill) {
        lines.push(`${indent}- ${s.name}: jill ${s.jill}${meta ? ` (${meta})` : ""}`);
        const nested = c.lookup(s.jill)!;
        walk(nested, indent + "  ", isolated);
        continue;
      }
      const runner = c.plugins.runners.find((p) => p.canRun(s));
      const vars = { inputs, task: inputs.task, copy: s.copies > 1 ? 1 : undefined, run_id: "<run-id>", steps: {} };
      const text = s.run !== undefined ? renderTemplate(s.run, vars, { shell: true }) : renderTemplate(s.task ?? "{{task}}", vars);
      let desc: string;
      try {
        desc = runner ? runner.describe({ runId: "<run-id>", stepKey: s.name, step: s, jill, cwd: "<workspace>", text, timeoutMs: undefined, env: {}, config: c.config }) : "NO RUNNER";
      } catch (e) {
        desc = `ERROR: ${(e as Error).message}`;
      }
      lines.push(`${indent}- ${s.name}${meta ? ` (${meta})` : ""}: ${desc}`);
    }
  };
  walk(j, "", j.worktree);
  return lines;
}

/** Scaffold <first jill_path>/<name>/JILL.md. Returns the file path. */
export function newJill(name: string, o: BaseOpts = {}): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`bad Jill name "${name}"`);
  const config = loadConfig(o.home ?? jillsHome());
  const dir = join(config.jill_paths[0]!, name);
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
worktree: true
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
