import { pathToFileURL } from "node:url";
import type { JillsConfig } from "../config.js";
import type { StepDef } from "../jillfile.js";
import agentRunner from "./runner-agent.js";
import claudeRunner from "./runner-claude.js";
import commandRunner from "./runner-command.js";
import exitCodeCheck from "./check-exit-code.js";
import verdictCheck from "./check-verdict.js";
import jevMatcher from "./matcher-jev.js";
import worktreeIsolation from "./isolation-worktree.js";
import defaultSuggest from "./suggest-default.js";
import foreachExpand from "./foreach.js";
import jsonBackend from "./backend-json.js";
import { PLUGIN_API_VERSION, type AnyPlugin, type BackendPlugin, type Expansion, type ExecutorPlugin, type CheckPlugin, type ExpandPlugin, type HookPlugin, type IsolationPlugin, type MatcherPlugin, type RunnerPlugin, type SuggestPlugin } from "./types.js";

export interface PluginSet {
  /** Tried in order; the first one that answers wins. */
  matchers: MatcherPlugin[];
  /** First runner whose canRun(step) is true runs the step. */
  runners: RunnerPlugin[];
  isolation: Map<string, IsolationPlugin>;
  checks: Map<string, CheckPlugin>;
  /** Every hook sees every run event. */
  hooks: HookPlugin[];
  /** Chat policy around the matchers (anti-nag, mutes); the last one loaded wins. */
  suggest: SuggestPlugin;
  backends: Map<string, BackendPlugin>;
  /** Selected by config `backend`, default json. */
  backend: BackendPlugin;
  executors: Map<string, ExecutorPlugin>;
  executor?: ExecutorPlugin;
  /** Step expanders by name (built-in: foreach); a config plug-in with the same name replaces one. */
  expanders: Map<string, ExpandPlugin>;
  warnings: string[];
}

export function builtinPlugins(): PluginSet {
  return {
    matchers: [jevMatcher],
    runners: [commandRunner, claudeRunner, agentRunner],
    isolation: new Map([[worktreeIsolation.name, worktreeIsolation]]),
    checks: new Map([exitCodeCheck, verdictCheck].map((c) => [c.name, c])),
    hooks: [],
    suggest: defaultSuggest,
    backends: new Map([[jsonBackend.name, jsonBackend]]),
    backend: jsonBackend,
    executors: new Map(),
    expanders: new Map([[foreachExpand.name, foreachExpand]]),
    warnings: [],
  };
}

export function validatePlugin(p: unknown, source: string): AnyPlugin {
  if (!p || typeof p !== "object") throw new Error(`${source}: default export is not a plug-in object`);
  const o = p as Record<string, unknown>;
  if (o.apiVersion !== PLUGIN_API_VERSION) throw new Error(`${source}: plug-in apiVersion ${String(o.apiVersion)} is not supported (core speaks ${PLUGIN_API_VERSION})`);
  if (typeof o.name !== "string" || !o.name) throw new Error(`${source}: plug-in has no name`);
  const need: Record<string, string[]> = {
    matcher: ["match"],
    runner: ["canRun", "run", "describe"],
    isolation: ["prepare", "child", "mergeBack", "commit"],
    check: ["check"],
    hook: ["on"],
    suggest: ["suggest", "chat"],
    backend: ["save", "load", "list", "beat", "loadBeat"],
    executor: ["execute"],
    expand: ["validate", "expand"],
  };
  const slot = String(o.slot);
  if (!need[slot]) throw new Error(`${source}: unknown plug-in slot "${slot}" (v1 slots: ${Object.keys(need).join(", ")})`);
  for (const fn of need[slot]!) if (typeof o[fn] !== "function") throw new Error(`${source}: ${slot} plug-in is missing ${fn}()`);
  for (const fn of slot === "backend" ? ["sweep", "check"] : slot === "executor" ? ["check"] : []) {
    if (o[fn] !== undefined && typeof o[fn] !== "function") throw new Error(`${source}: ${slot} plug-in ${fn} must be a function`);
  }
  return p as AnyPlugin;
}

export function addPlugin(set: PluginSet, p: AnyPlugin): void {
  switch (p.slot) {
    case "matcher":
      set.matchers.unshift(p);
      break;
    case "runner":
      set.runners.unshift(p);
      break;
    case "isolation":
      set.isolation.set(p.name, p);
      break;
    case "check":
      set.checks.set(p.name, p);
      break;
    case "hook":
      set.hooks.push(p);
      break;
    case "suggest":
      set.suggest = p;
      break;
    case "backend":
      set.backends.set(p.name, p);
      break;
    case "executor":
      set.executors.set(p.name, p);
      break;
    case "expand":
      set.expanders.set(p.name, p);
      break;
  }
}

/** Built-ins plus single-file plug-ins listed in config `plugins:` (those go first). */
export async function loadPlugins(config: JillsConfig, storageOnly = false): Promise<PluginSet> {
  const set = builtinPlugins();
  const name = config.raw.backend ?? "json";
  for (const file of config.plugins) {
    // Recovery needs only storage: JSON imports nothing; custom storage stops at its match.
    if (storageOnly && typeof name === "string" && set.backends.has(name)) break;
    try {
      const mod = (await import(pathToFileURL(file).href)) as { default?: { slot?: string } };
      if (!storageOnly || mod.default?.slot === "backend") addPlugin(set, validatePlugin(mod.default, file));
    } catch (e) {
      if (!storageOnly) throw e;
      console.warn(`jills: ignoring unrelated plug-in ${file}: ${(e as Error).message}`);
    }
  }
  const backend = typeof name === "string" ? set.backends.get(name) : undefined;
  if (!backend) throw new Error(`no backend plug-in "${String(name)}"`);
  set.backend = backend;
  try { backend.sweep?.(config.home, config); }
  catch (e) { set.warnings.push(`backend ${backend.name} sweep failed: ${(e as Error).message}`); }
  if (!storageOnly && config.raw.executor !== undefined) {
    const name = config.raw.executor;
    set.executor = typeof name === "string" ? set.executors.get(name) : undefined;
    if (!set.executor) throw new Error(`no executor plug-in "${String(name)}"`);
  }
  return set;
}

/** Parse-time step checks from every expander, for parseJill / scanJills. */
export const stepChecks = (set: PluginSet) => (s: StepDef, before: Set<string>): string[] => [...set.expanders.values()].flatMap((p) => p.validate(s, before));
/** The first expander that claims the step (throws its reason when the step must fail). */
export const expansionOf = (set: PluginSet, s: StepDef, outputs: Record<string, { output: string }>, config: JillsConfig): Expansion | undefined => {
  for (const p of set.expanders.values()) { const e = p.expand(s, outputs, config); if (e) return e; }
  return undefined;
};

export * from "./types.js";
