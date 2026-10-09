import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JillsConfig } from "../config.js";
import type { StepDef } from "../jillfile.js";
import { agentCli, requireAgent, resolveModel, type AgentDef } from "./runner-agent.js";
import { spawnLogged } from "./runner-command.js";
import type { RunnerPlugin } from "./types.js";

/**
 * Runs `agent:` steps on Claude Code (`claude -p`), so Claude models use the user's
 * Claude plan through claude's own login. Claims a step when its CLI is `claude`:
 * step `cli:` ?? agent file `cli:` ?? config agent_cli. Config keys (optional):
 * claude_bin (binary override), claude_default_model (default claude-opus-5-5,
 * replaces default_model for these steps). Agent file `claude_tools:` replaces the
 * allowedTools list verbatim (e.g. `Bash(pnpm test:*)`).
 *
 * Permissions: a `writes: true` step gets --permission-mode acceptEdits; any other
 * step gets no Write/Edit tools at all and the ask-first mode (in print mode an
 * unapproved action is denied). Never bypassPermissions. Bash is available only when
 * the agent file lists `bash`, and is never pre-approved unless `claude_tools` names it.
 */
export const CLAUDE_DEFAULT_MODEL = "claude-opus-5-5";
/** Claude Code 2.1.x calls the ask-first mode "manual" (its --permission-mode choices have no "default"). */
export const ASK_MODE = "manual";
export const WRITER_MODE = "acceptEdits";

/** Pi tool names → Claude Code tool names. */
export const CLAUDE_TOOLS: Record<string, string> = { read: "Read", grep: "Grep", find: "Glob", ls: "Glob", write: "Write", edit: "Edit", bash: "Bash" };
const WRITE_TOOLS = new Set(["Write", "Edit"]);

/** Claude Code tools for an agent: its `tools:` mapped (default read-only set, plus write/edit for writers); non-writers never get Write/Edit. */
export function claudeTools(agent: AgentDef, writes: boolean): string[] {
  const names = agent.tools ?? ["read", "grep", "find", "ls", ...(writes ? ["write", "edit"] : [])];
  const out = names.map((n) => {
    const t = CLAUDE_TOOLS[n.toLowerCase()];
    if (!t) throw new Error(`agent ${agent.name}: tool "${n}" has no Claude Code name (known: ${Object.keys(CLAUDE_TOOLS).join(", ")})`);
    return t;
  });
  return [...new Set(out)].filter((t) => writes || !WRITE_TOOLS.has(t));
}

/** step.model ?? agent.model ?? tiers[tier] ?? claude_default_model, without a leading `anthropic/`. */
export function claudeModel(stepModel: string | undefined, agent: AgentDef, config: JillsConfig): string {
  const raw = config.raw;
  const m = resolveModel(stepModel, agent, (raw.tiers ?? {}) as Record<string, unknown>, raw.claude_default_model ?? CLAUDE_DEFAULT_MODEL);
  return String(m).replace(/^anthropic\//, "");
}

/** claude -p --model M --append-system-prompt <instructions> --permission-mode P --tools T --allowedTools A --output-format text -- "<task>" */
export function buildClaudeCommand(agent: AgentDef, step: Pick<StepDef, "model" | "writes">, task: string, config: JillsConfig, instructions = agent.instructions) {
  const model = claudeModel(step.model, agent, config);
  const tools = claudeTools(agent, step.writes);
  const allowed = agent.claudeTools ?? tools.filter((t) => t !== "Bash");
  const mode = step.writes ? WRITER_MODE : ASK_MODE;
  const args = ["-p", "--model", model, "--append-system-prompt", instructions, "--permission-mode", mode, "--tools", tools.join(",")];
  if (allowed.length) args.push("--allowedTools", allowed.join(","));
  args.push("--output-format", "text", "--", task);
  return { cmd: config.raw.claude_bin ? String(config.raw.claude_bin) : "claude", args, model };
}

const claudeRunner: RunnerPlugin = {
  slot: "runner",
  apiVersion: 1,
  name: "claude",
  canRun: (step, config) => step.agent !== undefined && agentCli(step, config) === "claude",
  describe: (ctx) => {
    const agent = requireAgent(ctx.step.agent!, ctx.config);
    const c = buildClaudeCommand(agent, ctx.step, ctx.text, ctx.config, `<instructions of ${agent.path}>`);
    return `${c.cmd} ${c.args.map((a) => JSON.stringify(a.length > 60 ? a.slice(0, 57) + "..." : a)).join(" ")}  (cwd ${ctx.cwd})`;
  },
  run: async (ctx) => {
    const agent = requireAgent(ctx.step.agent!, ctx.config);
    const c = buildClaudeCommand(agent, ctx.step, ctx.text, ctx.config);
    mkdirSync(dirname(ctx.logPath), { recursive: true });
    writeFileSync(ctx.logPath, `[jills] agent ${agent.name} (${agent.path}) via ${c.cmd} (Claude Code) model=${c.model}\n`, { flag: "a" });
    return spawnLogged({ cmd: c.cmd, args: c.args, cwd: ctx.cwd, logPath: ctx.logPath, env: ctx.env, timeoutMs: ctx.timeoutMs, signal: ctx.signal });
  },
};

export default claudeRunner;
