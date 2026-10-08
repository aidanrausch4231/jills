import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findAgent, resolveModel, type AgentDef } from "../agents.js";
import type { JillsConfig } from "../config.js";
import { spawnLogged } from "../proc.js";
import type { RunnerPlugin } from "./types.js";

const CLAUDE_TOOL_NAMES: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  find: "Glob",
  glob: "Glob",
  ls: "Glob",
  webfetch: "WebFetch",
  websearch: "WebSearch",
};

export interface AgentCommand {
  cmd: string;
  args: string[];
  model?: string;
}

/**
 * Build the headless agent command line.
 *  pi:     pi -p [--model M] --append-system-prompt <file> [--tools a,b] "<task>"
 *  claude: claude -p [--model M] --append-system-prompt "<instructions>" [--tools A B] [--permission-mode P] "<task>"
 */
export function buildAgentCommand(
  agent: AgentDef,
  task: string,
  stepModel: string | undefined,
  config: JillsConfig,
  promptFile: string,
): AgentCommand {
  const model = resolveModel(stepModel, agent, config.tiers, config.default_model);
  const kind = config.agent_cli;
  const cmd = config.agent_bin ?? kind;
  const args: string[] = ["-p"];
  if (kind === "claude") {
    if (model) args.push("--model", model);
    args.push("--append-system-prompt", agent.instructions);
    if (agent.tools?.length) {
      const names = [...new Set(agent.tools.map((t) => CLAUDE_TOOL_NAMES[t.toLowerCase()] ?? t))];
      args.push("--tools", names.join(","));
    }
    if (config.claude_permission_mode) args.push("--permission-mode", config.claude_permission_mode);
    args.push("--", task);
  } else if (kind === "pi") {
    if (model) args.push("--model", model);
    args.push("--append-system-prompt", promptFile);
    if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
    args.push("--", task);
  } else {
    throw new Error(`agent_cli "${kind}" is not supported (use pi or claude)`);
  }
  return { cmd, args, model };
}

/** Runs `agent:` steps: looks up the agent file and starts the agent CLI headless. */
const agentRunner: RunnerPlugin = {
  slot: "runner",
  apiVersion: 1,
  name: "agent",
  canRun: (step) => step.agent !== undefined,
  describe: (ctx) => {
    const agent = requireAgent(ctx.step.agent!, ctx.config);
    const c = buildAgentCommand(agent, ctx.text, ctx.step.model, ctx.config, `<instructions of ${agent.path}>`);
    return `${c.cmd} ${c.args.map((a) => (a.length > 60 ? JSON.stringify(a.slice(0, 57) + "...") : JSON.stringify(a))).join(" ")}  (cwd ${ctx.cwd})`;
  },
  run: async (ctx) => {
    const agent = requireAgent(ctx.step.agent!, ctx.config);
    const promptFile = join(dirname(ctx.logPath), `${ctx.stepKey.replace(/[^A-Za-z0-9_.-]/g, "_")}.prompt.md`);
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, agent.instructions + "\n");
    const c = buildAgentCommand(agent, ctx.text, ctx.step.model, ctx.config, promptFile);
    writeFileSync(ctx.logPath, `[jills] agent ${agent.name} (${agent.path}) via ${c.cmd} model=${c.model ?? "(cli default)"}\n`, { flag: "a" });
    return spawnLogged({ cmd: c.cmd, args: c.args, cwd: ctx.cwd, logPath: ctx.logPath, env: ctx.env, timeoutMs: ctx.timeoutMs, signal: ctx.signal });
  },
};

function requireAgent(name: string, config: JillsConfig): AgentDef {
  const a = findAgent(name, config.agent_paths);
  if (!a) throw new Error(`agent "${name}" not found in agent_paths: ${config.agent_paths.join(", ")}`);
  return a;
}

export default agentRunner;
