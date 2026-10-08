/**
 * Jills plug-in slot interfaces, version 1.
 *
 * A plug-in is a single ESM file whose default export is one object with
 * `slot`, `apiVersion: 1`, `name`, and the slot's methods. Core refuses a
 * plug-in whose apiVersion it does not know. Core knows no harness, model or cloud.
 */
import type { JillsConfig } from "../config.js";
import type { JillDef, StepDef } from "../jillfile.js";

export const PLUGIN_API_VERSION = 1 as const;

// ---- matcher ----
export interface JillSummary {
  name: string;
  description: string;
  when?: string;
  inputs: string[];
  keywords: string[];
}
export interface Turn {
  role: "user" | "assistant";
  text: string;
}
export interface MatchInput {
  message: string;
  /** Up to the last 3 turns before the message. */
  recent: Turn[];
  jills: JillSummary[];
  /** Jills already suggested or running in this chat. */
  already: string[];
  config: JillsConfig;
}
export type MatchLabel = "talk" | "same" | "new";
export interface MatchResult {
  label: MatchLabel;
  jill?: string;
  inputs?: Record<string, string>;
  confidence: number;
  matcher: string;
  note?: string;
}
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
  /** Call with the process (group) id as soon as the step's process starts. */
  onSpawn?: (pid: number) => void;
}
export interface StepRunResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  signal?: string;
  pid?: number;
}
export interface RunnerPlugin {
  slot: "runner";
  apiVersion: 1;
  name: string;
  canRun(step: StepDef): boolean;
  /** Describe what would run, for dry runs. */
  describe(ctx: Omit<StepRunContext, "signal" | "logPath" | "onSpawn">): string;
  run(ctx: StepRunContext): Promise<StepRunResult>;
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
  /** Merge a child back into the parent. Conflict leaves the parent untouched. */
  mergeBack(parent: Workspace, child: Workspace, message: string): Promise<MergeResult>;
  /** Commit the workspace's changes; returns the commit or undefined when clean. */
  commit(ws: Workspace, message: string): Promise<string | undefined>;
}

// ---- check ----
export interface CheckInput {
  step: StepDef;
  result: StepRunResult;
  logPath: string;
}
export interface CheckResult {
  ok: boolean;
  reason?: string;
}
export interface CheckPlugin {
  slot: "check";
  apiVersion: 1;
  name: string;
  check(input: CheckInput): Promise<CheckResult>;
}

export type AnyPlugin = MatcherPlugin | RunnerPlugin | IsolationPlugin | CheckPlugin;
