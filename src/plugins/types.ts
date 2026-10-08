/**
 * Jills plug-in slot interfaces, version 1.
 *
 * A plug-in is a single ESM file whose default export is one object with
 * `slot`, `apiVersion: 1`, `name`, and the slot's methods. Core refuses a
 * plug-in whose apiVersion it does not know. Core knows no harness, model or cloud.
 */
import type { JillsConfig } from "../config.js";
import type { JillDef, StepDef } from "../jillfile.js";
import type { RunEvent, RunRecord } from "../runs.js";

export const PLUGIN_API_VERSION = 1 as const;

// ---- matcher ----
export type JillSummary = { name: string; description: string; when?: string; inputs: string[]; keywords: string[] };
export type Turn = { role: "user" | "assistant"; text: string };
export interface MatchInput {
  message: string;
  /** Up to the last 3 turns before the message. */
  recent: Turn[];
  jills: JillSummary[];
  /** Jills already suggested or running in this chat. */
  already: string[];
  config: JillsConfig;
  /** Built-in Jev matcher only: the harness's own key for jev.key_env (name locked by core). Never log or store it. */
  jevKey?: () => Promise<string | undefined> | string | undefined;
}
export type MatchLabel = "talk" | "same" | "new";
export type MatchResult = { label: MatchLabel; jill?: string; inputs?: Record<string, string>; confidence: number; matcher: string; note?: string };
export interface MatcherPlugin {
  slot: "matcher";
  apiVersion: 1;
  name: string;
  /** Return undefined to let the next matcher (fallback) answer. */
  match(input: MatchInput): Promise<MatchResult | undefined>;
}

// ---- runner ----
export interface StepRunContext {
  runId: string;
  stepKey: string;
  step: StepDef;
  jill: JillDef;
  cwd: string;
  /** Fully rendered text: shell command for run:, task for agent:. */
  text: string;
  logPath: string;
  timeoutMs?: number;
  signal: AbortSignal;
  env: Record<string, string>;
  config: JillsConfig;
}
export type StepRunResult = { exitCode: number | null; timedOut: boolean; aborted: boolean; signal?: string };
export interface RunnerPlugin {
  slot: "runner";
  apiVersion: 1;
  name: string;
  canRun(step: StepDef): boolean;
  /** Describe what would run, for dry runs and `jills check` (throw for a step it cannot run). */
  describe(ctx: Omit<StepRunContext, "signal" | "logPath">): string;
  run(ctx: StepRunContext): Promise<StepRunResult>;
  /** Optional extra `jills check` findings (missing paths, duplicate names). */
  check?(config: JillsConfig): { errors: string[]; warnings: string[] };
}

// ---- isolation ----
export interface Workspace {
  /** Folder steps run in. */
  dir: string;
  /** Git branch checked out there (when git is used). */
  branch?: string;
  repo?: string;
  isolated: boolean;
}
export type MergeResult = { ok: true; commit: string } | { ok: false; conflicts: string[]; message: string };
export interface IsolationPlugin {
  slot: "isolation";
  apiVersion: 1;
  name: string;
  /** Outermost run: make the workspace. */
  prepare(opts: { repo: string; jill: string; runId: string; config: JillsConfig }): Promise<Workspace>;
  /** Make a child workspace for a parallel writer, branched from the parent. */
  child(parent: Workspace, opts: { key: string; runId: string; config: JillsConfig }): Promise<Workspace>;
  /** Merge a child back into the parent; conflict leaves it untouched. Serializes its own git work per dir (also commit). */
  mergeBack(parent: Workspace, child: Workspace, message: string): Promise<MergeResult>;
  /** Commit the workspace's changes; returns the commit or undefined when clean. */
  commit(ws: Workspace, message: string): Promise<string | undefined>;
}

// ---- check ----
export type CheckInput = { step: StepDef; result: StepRunResult; logPath: string };
export type CheckResult = { ok: boolean; reason?: string };
export interface CheckPlugin {
  slot: "check";
  apiVersion: 1;
  name: string;
  check(input: CheckInput): Promise<CheckResult>;
}

// ---- hook ----
/** Sees every run event (started, step-started, step-done, finished, failed, stuck, needs-you). Errors are ignored. */
export interface HookPlugin {
  slot: "hook";
  apiVersion: 1;
  name: string;
  on(event: RunEvent, record: RunRecord, config: JillsConfig): void | Promise<void>;
}

// ---- suggest ----
/** What Jev tells the chat about one message. */
export interface Suggestion {
  action: "suggest" | "quiet";
  reason: string;
  jill?: string;
  description?: string;
  inputs?: Record<string, string>;
  confidence?: number;
  label?: MatchLabel;
  matcher?: string;
  /** Global auto switch: when true the main agent should start the Jill itself. */
  auto: boolean;
  /** Text to show the user, and text for the main agent's context. */
  text?: string;
  agentContext?: string;
  /** Whether the suggested Jill runs in its own worktree, and a short warning when not. */
  worktree?: boolean;
  warning?: string;
}
/** `recent`: up to the last 3 turns before the message; `repo`: the chat's git root, when known. */
export type SuggestInput = { session: string; message: string; recent: Turn[]; repo?: string };
export interface SuggestCtx {
  jills: (JillSummary & { worktree: boolean })[];
  config: JillsConfig;
  /** Asks the matcher plug-ins in order; core keeps only inputs the named Jill declares. */
  match(input: MatchInput): Promise<MatchResult | undefined>;
}
/** A chat control: dismiss / quiet / on (unmute: clear repo mutes) / never (mute) / started (a run began) / last (read only). */
export type ChatChange = { kind: "dismiss" | "quiet" | "last" } | { kind: "on"; unmute?: string } | { kind: "never"; repo: string; jill?: string } | { kind: "started"; run: string };
export type LastSuggestion = { jill: string; inputs: Record<string, string> };
/** The chat policy around matchers (anti-nag, mutes); the last one loaded wins. */
export interface SuggestPlugin {
  slot: "suggest";
  apiVersion: 1;
  name: string;
  suggest(input: SuggestInput, ctx: SuggestCtx): Promise<Suggestion>;
  /** Apply a chat control; returns the chat's last suggestion afterwards. `session` is absent for a repo-wide never. */
  chat(session: string | undefined, change: ChatChange, config: JillsConfig): LastSuggestion | undefined;
}

export type AnyPlugin = MatcherPlugin | RunnerPlugin | IsolationPlugin | CheckPlugin | HookPlugin | SuggestPlugin;
