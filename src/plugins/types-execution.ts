import type { JillsConfig } from "../config.js";
import type { Heartbeat, RunRecord } from "../runs.js";

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
  check?(config: JillsConfig): { errors: string[]; warnings: string[] };
}

// ---- executor (who drives a run) ----
export interface ExecutorContext {
  config: JillsConfig;
  /** Absolute path of the Jills CLI entry (dist/src/cli.js), to spawn `node <cli> engine <id>`. */
  cli: string;
  /** Aborted when the detached runner gets SIGTERM / `jills stop`. */
  signal: AbortSignal;
}
export interface ExecutorPlugin {
  slot: "executor";
  apiVersion: 1;
  name: string;
  /** Drive run `run.id` until it is terminal. Core reloads the record afterwards. Must not write the record itself. */
  execute(run: RunRecord, ctx: ExecutorContext): Promise<void>;
  check?(config: JillsConfig): { errors: string[]; warnings: string[] };
}
