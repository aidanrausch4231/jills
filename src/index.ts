/**
 * Jills library API (stable for add-ons, v1).
 *
 *   suggest({ session, message, recent?, repo?, cwd?, home? }) -> Suggestion
 *   start(jill, { inputs?, cwd?, session?, home? })            -> RunRecord (queued, detached runner)
 *   wait(runId, { timeoutMs?, pollMs?, onUpdate?, home? })      -> { record, timedOut, line }
 *   status(runId?, { home? })                                   -> RunRecord | RunRecord[] (never signals)
 *   stop(runId, { home? })                                      -> stop the run's processes (env-tagged only)
 *   listJills({ home? })                                        -> JillSummary[]
 *   go({ session, jill?, inputs?, cwd? })                       -> start the last suggestion with its saved inputs
 *   chat / dismiss / quiet / on / never / lastSuggested / setAuto -> anti-nag + switch controls
 */
export * from "./api.js";
export { loadConfig, jillsHome, type JillsConfig } from "./config.js";
export { parseJill, scanJills, checkNesting, refusal, NO_WORKTREE_NOTE, MAX_DEPTH, type JillDef, type StepDef } from "./jillfile.js";
export { resultLine, TERMINAL, type RunRecord, type RunState, type StepRecord, type RunEvent } from "./runs.js";
export { loadSession, type SessionState } from "./session.js";
export { loadPlugins, builtinPlugins, validatePlugin, PLUGIN_API_VERSION } from "./plugins/index.js";
export type * from "./plugins/types.js";
