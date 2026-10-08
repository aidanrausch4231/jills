import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontMatter } from "./frontmatter.js";

export interface AgentDef {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  tier?: string;
  instructions: string;
  path: string;
}

export interface AgentScan {
  agents: Map<string, AgentDef>;
  /** name -> every path found, when more than one. First path wins. */
  duplicates: Map<string, string[]>;
  errors: string[];
}

function agentFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isFile() && entry.endsWith(".md") && entry.toLowerCase() !== "readme.md") out.push(p);
    else if (st.isDirectory() && existsSync(join(p, "AGENT.md"))) out.push(join(p, "AGENT.md"));
  }
  return out;
}

export function parseAgentFile(path: string): AgentDef {
  const { data, body } = parseFrontMatter(readFileSync(path, "utf8"), path);
  const name = data.name ? String(data.name) : "";
  if (!name) throw new Error(`${path}: agent file has no name`);
  let tools: string[] | undefined;
  if (Array.isArray(data.tools)) tools = data.tools.map(String);
  else if (typeof data.tools === "string") tools = data.tools.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    name,
    description: String(data.description ?? ""),
    tools,
    model: data.model ? String(data.model) : undefined,
    tier: data.tier ? String(data.tier) : undefined,
    instructions: body.trim(),
    path,
  };
}

/** Scan agent_paths in order; the first file with a given name wins. */
export function scanAgents(paths: string[]): AgentScan {
  const agents = new Map<string, AgentDef>();
  const all = new Map<string, string[]>();
  const errors: string[] = [];
  for (const dir of paths) {
    for (const f of agentFiles(dir)) {
      let a: AgentDef;
      try {
        a = parseAgentFile(f);
      } catch (e) {
        errors.push((e as Error).message);
        continue;
      }
      const list = all.get(a.name) ?? [];
      list.push(f);
      all.set(a.name, list);
      if (!agents.has(a.name)) agents.set(a.name, a);
    }
  }
  const duplicates = new Map<string, string[]>();
  for (const [k, v] of all) if (v.length > 1) duplicates.set(k, v);
  return { agents, duplicates, errors };
}

export function findAgent(name: string, paths: string[]): AgentDef | undefined {
  return scanAgents(paths).agents.get(name);
}

/** step.model ?? agent.model ?? tiers[agent.tier] ?? default_model */
export function resolveModel(
  stepModel: string | undefined,
  agent: AgentDef,
  tiers: Record<string, string>,
  defaultModel: string | undefined,
): string | undefined {
  return stepModel ?? agent.model ?? (agent.tier ? tiers[agent.tier] : undefined) ?? defaultModel;
}
