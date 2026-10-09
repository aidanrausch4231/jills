import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * replaces default_model for these steps), claude_tools (allowedTools default for
 * writer steps only). Agent file `claude_tools:` replaces allowedTools verbatim.
 *
 * Permissions: a `writes: true` step gets --permission-mode acceptEdits; any other
 * step gets no Write/Edit tools at all, the ask-first mode (in print mode an
 * unapproved action is denied), and claude_tools without any write or Bash entry.
 * Never bypassPermissions. Outside settings, hooks and MCP servers are not loaded
 * (--setting-sources "" --strict-mcp-config). The task goes on stdin.
 */
export const CLAUDE_DEFAULT_MODEL = "claude-opus-5-5";
/** Claude Code 2.1.x calls the ask-first mode "manual" (its --permission-mode choices have no "default"). */
export const ASK_MODE = "manual";
export const WRITER_MODE = "acceptEdits";

/** Pi tool names → Claude Code tool names. */
export const CLAUDE_TOOLS: Record<string, string> = { read: "Read", grep: "Grep", find: "Glob", ls: "Glob", write: "Write", edit: "Edit", bash: "Bash" };
/** Never pre-approved for a step without `writes: true`. */
const NON_WRITER_DENY = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]);

/** Claude Code tools for an agent: its `tools:` mapped (default read-only set, plus write/edit for writers); non-writers never get Write/Edit. */
export function claudeTools(agent: AgentDef, writes: boolean): string[] {
  const names = agent.tools ?? ["read", "grep", "find", "ls", ...(writes ? ["write", "edit"] : [])];
  const out = names.map((n) => {
    const t = CLAUDE_TOOLS[n.toLowerCase()];
    if (!t) throw new Error(`agent ${agent.name}: tool "${n}" has no Claude Code name (known: ${Object.keys(CLAUDE_TOOLS).join(", ")})`);
    return t;
  });
  return [...new Set(out)].filter((t) => writes || !["Write", "Edit"].includes(t));
}

/** step.model ?? agent.model ?? tiers[tier] ?? claude_default_model, without a leading `anthropic/`. */
export function claudeModel(stepModel: string | undefined, agent: AgentDef, config: JillsConfig): string {
  const raw = config.raw;
  const m = String(resolveModel(stepModel, agent, (raw.tiers ?? {}) as Record<string, unknown>, raw.claude_default_model ?? CLAUDE_DEFAULT_MODEL));
  if (m.startsWith("-")) throw new Error(`agent ${agent.name}: model "${m}" must not start with "-"`);
  return m.replace(/^anthropic\//, "");
}

/** allowedTools: agent claude_tools ?? (writers only) config claude_tools ?? the tools without Bash. Throws on an unsafe entry. */
export function claudeAllowed(agent: AgentDef, writes: boolean, tools: string[], config: JillsConfig): string[] {
  const cfg = config.raw.claude_tools;
  if (cfg !== undefined && !(Array.isArray(cfg) && cfg.every((t) => typeof t === "string"))) throw new Error("config claude_tools must be a list of tool names");
  const allowed = agent.claudeTools ?? (writes ? (cfg as string[] | undefined) : undefined) ?? tools.filter((t) => t !== "Bash");
  for (const t of allowed) {
    const bad = (why: string) => new Error(`agent ${agent.name}: claude_tools entry "${t}" ${why}`);
    if (t.startsWith("-")) throw bad(`must not start with "-"`);
    const base = t.replace(/\(.*$/s, "").trim();
    if (!writes && NON_WRITER_DENY.has(base)) throw bad("is not allowed in a step without writes: true (no write or Bash approvals)");
    if (!writes && !tools.includes(base)) throw bad(`names a tool the step does not have (tools: ${tools.join(", ") || "none"})`);
  }
  return allowed;
}

/** claude -p --model M --append-system-prompt-file F --permission-mode P --tools T [--allowedTools A] --strict-mcp-config --setting-sources "" ...; the task is `input` (stdin). */
export function buildClaudeCommand(agent: AgentDef, step: Pick<StepDef, "model" | "writes">, task: string, config: JillsConfig, promptFile: string) {
  const model = claudeModel(step.model, agent, config);
  const tools = claudeTools(agent, step.writes);
  const allowed = claudeAllowed(agent, step.writes, tools, config);
  const mode = step.writes ? WRITER_MODE : ASK_MODE;
  const args = ["-p", "--model", model, "--append-system-prompt-file", promptFile, "--permission-mode", mode, "--tools", tools.join(",")];
  if (allowed.length) args.push("--allowedTools", allowed.join(","));
  args.push("--strict-mcp-config", "--setting-sources", "", "--input-format", "text", "--output-format", "text");
  return { cmd: config.raw.claude_bin ? String(config.raw.claude_bin) : "claude", args, model, input: task };
}

const claudeRunner: RunnerPlugin = {
  slot: "runner",
  apiVersion: 1,
  name: "claude",
  canRun: (step, config) => step.agent !== undefined && agentCli(step, config) === "claude",
  describe: (ctx) => {
    const agent = requireAgent(ctx.step.agent!, ctx.config);
    const c = buildClaudeCommand(agent, ctx.step, ctx.text, ctx.config, `<instructions of ${agent.path}>`);
    const task = c.input.length > 60 ? c.input.slice(0, 57) + "..." : c.input;
    return `${c.cmd} ${c.args.map((a) => JSON.stringify(a)).join(" ")} < ${JSON.stringify(task)}  (cwd ${ctx.cwd})`;
  },
  run: async (ctx) => {
    const agent = requireAgent(ctx.step.agent!, ctx.config);
    const promptFile = join(dirname(ctx.logPath), `${ctx.stepKey.replace(/[^A-Za-z0-9_.-]/g, "_")}.prompt.md`);
    const c = buildClaudeCommand(agent, ctx.step, ctx.text, ctx.config, promptFile); // throws (step refused) before anything is written
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, agent.instructions + "\n");
    writeFileSync(ctx.logPath, `[jills] agent ${agent.name} (${agent.path}) via ${c.cmd} (Claude Code) model=${c.model}\n`, { flag: "a" });
    return spawnLogged({ cmd: c.cmd, args: c.args, cwd: ctx.cwd, logPath: ctx.logPath, env: ctx.env, timeoutMs: ctx.timeoutMs, signal: ctx.signal, input: c.input });
  },
};

export default claudeRunner;
