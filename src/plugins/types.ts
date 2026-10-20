/**
 * Jills plug-in slot interfaces, version 1.
 *
 * A plug-in is a single ESM file whose default export is one object with
 * `slot`, `apiVersion: 1`, `name`, and the slot's methods. Core refuses a
 * plug-in whose apiVersion it does not know. Core knows no harness, model or cloud.
 */
import type { JillsConfig } from "../config.js";
import type { JillDef, StepDef } from "../jillfile.js";
import type { Heartbeat, RunEvent, RunRecord } from "../runs.js";
import type { SuggestPlugin } from "./types-suggest.js";
export * from "./types-suggest.js";

export const PLUGIN_API_VERSION = 1 as const;

// ---- matcher ----
export type JillSummary = { name: string; description: string; when?: string; inputs: string[]; /** required inputs with no default */ required?: string[] };
export type Turn = { role: "user" | "assistant"; text: string };
export interface MatchInput {
  message: string;
  /** Up to the last 3 turns before the message. */
  recent: Turn[];
  jills: JillSummary[];
  already: string[]; // Jills already suggested or running in this chat
  suggestedTask?: { jill: string; task: string }; // last Jill suggested here (maybe ignored) and the message behind it
  config: JillsConfig;
  /** Built-in Jev matcher only: the harness's own key for jev.key_env (name locked by core). Never log or store it. */
  jevKey?: () => Promise<string | undefined> | string | undefined;
}
export type MatchLabel = "talk" | "same" | "new";
export type MatchResult = { label: MatchLabel; jill?: string; inputs?: Record<string, string>; confidence: number; matcher: string; note?: string; /** P(this message continues a task already suggested or running); Jev only */ sameProb?: number };
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
  canRun(step: StepDef, config?: JillsConfig): boolean; // config is optional: older plug-ins read only the step
  /** Describe what would run, for dry runs and `jills check` (throw for a step it cannot run). */
  describe(ctx: Omit<StepRunContext, "signal" | "logPath">): string;
  run(ctx: StepRunContext): Promise<StepRunResult>;
  /** Optional extra `jills check` findings (missing paths, duplicate names). */
  check?(config: JillsConfig): { errors: string[]; warnings: string[] };
}
// ---- isolation ----
/** `dir`: folder steps run in; `branch`: git branch checked out there; `base`: branch the outermost run started from. */
export interface Workspace {
  dir: string;
  branch?: string;
  repo?: string;
  base?: string;
  isolated: boolean;
}
export type MergeCheck = { state: "merged" | "untouched" | "bad"; reason?: string };
export type MergeResult = { ok: true; commit: string } | { ok: false; conflicts: string[]; message: string };
export interface IsolationPlugin {
  slot: "isolation";
  apiVersion: 1;
  name: string;
  /** prepare: the outermost workspace; child: one for a parallel writer, from the parent; mergeBack: child into parent (a conflict leaves it untouched). */
  prepare(opts: { repo: string; jill: string; runId: string; config: JillsConfig }): Promise<Workspace>;
  child(parent: Workspace, opts: { key: string; runId: string; config: JillsConfig }): Promise<Workspace>;
  mergeBack(parent: Workspace, child: Workspace, message: string): Promise<MergeResult>;
  /** commit: the workspace's changes (the commit, or undefined when clean). parallel: steps that get a child workspace. */
  commit(ws: Workspace, message: string): Promise<string | undefined>;
  parallel?(jill: JillDef, lookup: (name: string) => JillDef | undefined): Set<string>;
  /** Optional, needed for `merges: true`: mergeStart refuses (reason) an unsafe checkout, else snapshots it; mergeCheck judges the result. */
  mergeStart?(ws: Workspace, base: string): Promise<object | string>;
  mergeCheck?(ws: Workspace, base: string, start: object): Promise<MergeCheck>;
  /** Optional, before a back-arrow reruns: drop a stale step's changes (`discard`). Never merges or commits. */
  retry?(ws: Workspace, o: { discard?: boolean }): Promise<void>;
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
// ---- backend (run storage) ----
/** Where run records and heartbeats live. Log files stay plain files in RunRecord.logDir. */
export interface BackendPlugin {
  slot: "backend";
  apiVersion: 1;
  name: string;
  save(home: string, r: RunRecord): void;
  load(home: string, id: string): RunRecord | undefined;
  /** Newest first (by `created`, descending). */
  list(home: string): RunRecord[];
  beat(home: string, id: string, hb: Heartbeat): void;
  loadBeat(home: string, id: string): Heartbeat | undefined;
  /** Optional boot sweep: called once when plug-ins load; returns ids it changed. Must never signal processes. */
  sweep?(home: string, config: JillsConfig): string[];
  /** Optional `jills check` findings. */
  check?(config: JillsConfig): { errors: string[]; warnings: string[] };
}

export type AnyPlugin = MatcherPlugin | RunnerPlugin | IsolationPlugin | CheckPlugin | HookPlugin | SuggestPlugin | BackendPlugin;
