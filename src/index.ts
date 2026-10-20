// Jills library API for add-ons (v1); each function's contract is in its JSDoc in api.ts.
export * from "./api.js";
export { loadConfig, jillsHome, type JillsConfig } from "./config.js";
export { parseJill, scanJills, checkNesting, refusal, NO_WORKTREE_NOTE, MAX_DEPTH, type JillDef, type StepDef } from "./jillfile.js";
export { resultLine, TERMINAL, type RunRecord, type RunState, type StepRecord, type RunEvent } from "./runs.js";
export { loadPlugins, builtinPlugins, validatePlugin, PLUGIN_API_VERSION } from "./plugins/index.js";
export type * from "./plugins/types.js";
