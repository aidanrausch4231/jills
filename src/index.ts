/**
 * Jills library API (stable for add-ons, v1).
 *
 *   suggest({ session, message, recent?, repo?, cwd?, home? }) -> Suggestion
 *   start(jill, { inputs?, cwd?, session?, home? })            -> RunRecord (queued, detached runner)
 *   wait(runId, { timeoutMs?, pollMs?, onUpdate?, home? })      -> { record, timedOut, line }
 *   status(runId?, { home? })                                   -> RunRecord | RunRecord[]
 *   listJills({ home? })                                        -> JillSummary[]
 *   dismiss / never / quiet / on / lastSuggestion / setAuto     -> anti-nag + switch controls
 */
export {
  context,
  listJills,
  suggest,
  start,
  runNow,
  executeRun,
  wait,
  status,
  dismiss,
  never,
  quiet,
  on,
  lastSuggestion,
  setAuto,
  check,
  dryRun,
  newJill,
  type BaseOpts,
  type SuggestOpts,
  type Suggestion,
  type StartOpts,
  type WaitResult,
  type CheckReport,
} from "./api.js";
export { loadConfig, jillsHome, type JillsConfig } from "./config.js";
export { parseJill, scanJills, checkNesting, v1Refusal, MAX_DEPTH, type JillDef, type StepDef } from "./jillfile.js";
export { scanAgents, findAgent, parseAgentFile, resolveModel, type AgentDef } from "./agents.js";
export { resultLine, TERMINAL, type RunRecord, type RunState, type StepRecord, type RunEvent } from "./runs.js";
export { loadSession, type SessionState } from "./session.js";
export { loadPlugins, builtinPlugins, validatePlugin, PLUGIN_API_VERSION } from "./plugins/index.js";
export type * from "./plugins/types.js";
