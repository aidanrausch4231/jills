import { pathToFileURL } from "node:url";
import type { JillsConfig } from "../config.js";
import agentRunner from "./runner-agent.js";
import claudeRunner from "./runner-claude.js";
import commandRunner from "./runner-command.js";
import exitCodeCheck from "./check-exit-code.js";
import verdictCheck from "./check-verdict.js";
import jevMatcher from "./matcher-jev.js";
import keywordsMatcher from "./matcher-keywords.js";
import worktreeIsolation from "./isolation-worktree.js";
import defaultSuggest from "./suggest-default.js";
import { PLUGIN_API_VERSION, type AnyPlugin, type CheckPlugin, type HookPlugin, type IsolationPlugin, type MatcherPlugin, type RunnerPlugin, type SuggestPlugin } from "./types.js";

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
}

export function builtinPlugins(): PluginSet {
  return {
    matchers: [jevMatcher, keywordsMatcher],
    runners: [commandRunner, claudeRunner, agentRunner],
    isolation: new Map([[worktreeIsolation.name, worktreeIsolation]]),
    checks: new Map([exitCodeCheck, verdictCheck].map((c) => [c.name, c])),
    hooks: [],
    suggest: defaultSuggest,
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
  };
  const slot = String(o.slot);
  if (!need[slot]) throw new Error(`${source}: unknown plug-in slot "${slot}" (v1 slots: ${Object.keys(need).join(", ")})`);
  for (const fn of need[slot]!) if (typeof o[fn] !== "function") throw new Error(`${source}: ${slot} plug-in is missing ${fn}()`);
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
  }
}

/** Built-ins plus single-file plug-ins listed in config `plugins:` (those go first). */
export async function loadPlugins(config: JillsConfig): Promise<PluginSet> {
  const set = builtinPlugins();
  for (const file of config.plugins) {
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    addPlugin(set, validatePlugin(mod.default, file));
  }
  return set;
}

export * from "./types.js";
