import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathList, type JillsConfig } from "../config.js";
import { parseFrontMatter, scanFirstWins, type Scan, type StepDef } from "../jillfile.js";
import { spawnLogged } from "./runner-command.js";
import type { RunnerPlugin } from "./types.js";

/**
 * Runs `agent:` steps: finds the agent file and starts the agent CLI headless.
 * Config keys (all optional): agent_paths (default [$JILLS_HOME/agents]),
 * agent_cli (pi), agent_bin (binary override), tiers {tier: model}, default_model.
 * Steps whose CLI is `claude` belong to the Claude Code runner (runner-claude.ts).
 */
export interface AgentDef {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  tier?: string;
  /** Agent CLI (`cli:`), and `claude_tools:` (Claude Code allowedTools, verbatim). */
  cli?: string;
  claudeTools?: string[];
  instructions: string;
  path: string;
}

export function agentPaths(config: JillsConfig): string[] {
  return pathList(config.raw.agent_paths, config.home, [join(config.home, "agents")]);
}

export function parseAgentFile(path: string): AgentDef {
  const { data, body } = parseFrontMatter(readFileSync(path, "utf8"), path);
  if (!data.name) throw new Error(`${path}: agent file has no name`);
  const list = (t: unknown) => (Array.isArray(t) ? t.map(String) : typeof t === "string" ? t.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  const tools = list(data.tools);
  return {
    name: String(data.name),
    description: String(data.description ?? ""),
    tools,
    model: data.model ? String(data.model) : undefined,
    tier: data.tier ? String(data.tier) : undefined,
    cli: data.cli ? String(data.cli) : undefined,
    claudeTools: list(data.claude_tools),
    instructions: body.trim(),
    path,
  };
}

/** Files `<name>.md` (not README.md) and folders `<name>/AGENT.md`, in each path in order; first name wins. */
export function scanAgents(paths: string[]): Scan<AgentDef> {
  const files = (dir: string) =>
    readdirSync(dir)
      .sort()
      .flatMap((e) => {
        const p = join(dir, e);
        if (statSync(p).isFile()) return e.endsWith(".md") && e.toLowerCase() !== "readme.md" ? [p] : [];
        return existsSync(join(p, "AGENT.md")) ? [join(p, "AGENT.md")] : [];
      });
  return scanFirstWins(paths, files, parseAgentFile);
}

/** step.model ?? agent.model ?? tiers[agent.tier] ?? default_model */
export function resolveModel(stepModel: string | undefined, agent: AgentDef, tiers: Record<string, unknown>, defaultModel: unknown): string | undefined {
  const m = stepModel ?? agent.model ?? (agent.tier ? tiers[agent.tier] : undefined) ?? defaultModel;
  return m === undefined ? undefined : String(m);
}

/** pi -p [--model M] --append-system-prompt <file> [--tools a,b] -- "<task>" (an agent file `cli:` other than pi/claude is refused) */
export function buildAgentCommand(agent: AgentDef, task: string, stepModel: string | undefined, config: JillsConfig, promptFile: string, kind = String(agent.cli ?? config.raw.agent_cli ?? "pi")) {
  const raw = config.raw;
  if (kind !== "pi") throw new Error(`agent_cli "${kind}" is not supported (use pi or claude; other agent CLIs are add-ons)`);
  const model = resolveModel(stepModel, agent, (raw.tiers ?? {}) as Record<string, unknown>, raw.default_model);
  const args = ["-p", ...(model ? ["--model", model] : []), "--append-system-prompt", promptFile];
  if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
  return { cmd: raw.agent_bin ? String(raw.agent_bin) : kind, args: [...args, "--", task], model };
}

/** The step's agent CLI: step `cli:` ?? the agent file's `cli:` ?? config agent_cli ?? pi. */
export function agentCli(step: StepDef, config?: JillsConfig): string {
  if (step.extra.cli !== undefined) return String(step.extra.cli);
  if (!config) return "pi";
  const agent = step.agent === undefined ? undefined : scanAgents(agentPaths(config)).items.get(step.agent);
  return String(agent?.cli ?? config.raw.agent_cli ?? "pi");
}

export function requireAgent(name: string, config: JillsConfig): AgentDef {
  const a = scanAgents(agentPaths(config)).items.get(name);
  if (!a) throw new Error(`unknown agent "${name}" (agent_paths: ${agentPaths(config).join(", ")})`);
  return a;
}

const agentRunner: RunnerPlugin = {
  slot: "runner",
  apiVersion: 1,
  name: "agent",
  canRun: (step, config) => step.agent !== undefined && agentCli(step, config) !== "claude",
  describe: (ctx) => {
    const agent = requireAgent(ctx.step.agent!, ctx.config);
    const c = buildAgentCommand(agent, ctx.text, ctx.step.model, ctx.config, `<instructions of ${agent.path}>`, agentCli(ctx.step, ctx.config));
    return `${c.cmd} ${c.args.map((a) => JSON.stringify(a.length > 60 ? a.slice(0, 57) + "..." : a)).join(" ")}  (cwd ${ctx.cwd})`;
  },
  run: async (ctx) => {
    const agent = requireAgent(ctx.step.agent!, ctx.config);
    const promptFile = join(dirname(ctx.logPath), `${ctx.stepKey.replace(/[^A-Za-z0-9_.-]/g, "_")}.prompt.md`);
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, agent.instructions + "\n");
    const c = buildAgentCommand(agent, ctx.text, ctx.step.model, ctx.config, promptFile, agentCli(ctx.step, ctx.config));
    writeFileSync(ctx.logPath, `[jills] agent ${agent.name} (${agent.path}) via ${c.cmd} model=${c.model ?? "(cli default)"}\n`, { flag: "a" });
    return spawnLogged({ cmd: c.cmd, args: c.args, cwd: ctx.cwd, logPath: ctx.logPath, env: ctx.env, timeoutMs: ctx.timeoutMs, signal: ctx.signal });
  },
  check: (config) => {
    const scan = scanAgents(agentPaths(config));
    const warnings = agentPaths(config).filter((p) => !existsSync(p)).map((p) => `agent path ${p} does not exist`);
    for (const [n, paths] of scan.duplicates) warnings.push(`agent "${n}" found more than once; using ${paths[0]} (also: ${paths.slice(1).join(", ")})`);
    return { errors: scan.errors, warnings };
  },
};

export default agentRunner;
