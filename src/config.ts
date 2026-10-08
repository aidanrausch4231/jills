import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { writeFileAtomic } from "./util.js";

export interface JevConfig {
  model: string;
  key_env: string;
  url: string;
  threshold: number;
  timeout_ms: number;
}

export interface JillsConfig {
  home: string;
  auto: boolean;
  agent_paths: string[];
  jill_paths: string[];
  jev: JevConfig;
  agent_cli: string;
  /** Optional binary override for agent_cli (path or name). */
  agent_bin?: string;
  /** Claude Code permission mode for headless agent steps. */
  claude_permission_mode?: string;
  tiers: Record<string, string>;
  default_model?: string;
  /** Extra single-file plug-ins to load (absolute paths or relative to home). */
  plugins: string[];
  /** Total-run time limit when a Jill sets none (config `default_timeout`, default 2h). */
  default_timeout: string | number;
  /** Raw parsed YAML, for plug-ins that read their own keys. */
  raw: Record<string, unknown>;
}

/** Total-run time limit when neither the Jill nor config.yml sets one. */
export const DEFAULT_TIMEOUT = "2h";

export const DEFAULT_AGENT_PATHS = ["/home/rausch/harness/v4/agents-src"];

/** The Jills home folder: $JILLS_HOME or ~/.jills. */
export function jillsHome(): string {
  const env = process.env.JILLS_HOME;
  return resolve(env && env.trim() ? env : join(homedir(), ".jills"));
}

export function configPath(home = jillsHome()): string {
  return join(home, "config.yml");
}

function expand(p: string, home: string): string {
  let out = p.replace(/\$JILLS_HOME|\$\{JILLS_HOME\}/g, home);
  if (out.startsWith("~/")) out = join(homedir(), out.slice(2));
  return resolve(home, out);
}

export function loadConfig(home = jillsHome()): JillsConfig {
  const file = configPath(home);
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    const parsed = YAML.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>;
  }
  const strList = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.map((x) => String(x)) : undefined;
  const jevRaw = (raw.jev && typeof raw.jev === "object" ? raw.jev : {}) as Record<string, unknown>;
  const tiersRaw = (raw.tiers && typeof raw.tiers === "object" ? raw.tiers : {}) as Record<string, unknown>;
  const tiers: Record<string, string> = {};
  for (const [k, v] of Object.entries(tiersRaw)) tiers[k] = String(v);
  return {
    home,
    auto: raw.auto === true,
    agent_paths: (strList(raw.agent_paths) ?? DEFAULT_AGENT_PATHS).map((p) => expand(p, home)),
    jill_paths: (strList(raw.jill_paths) ?? [join(home, "jills")]).map((p) => expand(p, home)),
    jev: {
      model: String(jevRaw.model ?? "typesafe/jev-router"),
      key_env: String(jevRaw.key_env ?? "OPENROUTER_API_KEY"),
      url: String(jevRaw.url ?? "https://openrouter.ai/api/v1/chat/completions"),
      threshold: typeof jevRaw.threshold === "number" ? jevRaw.threshold : 0.7,
      timeout_ms: typeof jevRaw.timeout_ms === "number" ? jevRaw.timeout_ms : 8000,
    },
    agent_cli: String(raw.agent_cli ?? "pi"),
    agent_bin: raw.agent_bin ? String(raw.agent_bin) : undefined,
    claude_permission_mode: raw.claude_permission_mode ? String(raw.claude_permission_mode) : undefined,
    tiers,
    default_model: raw.default_model ? String(raw.default_model) : undefined,
    plugins: (strList(raw.plugins) ?? []).map((p) => expand(p, home)),
    default_timeout: typeof raw.default_timeout === "string" || typeof raw.default_timeout === "number" ? raw.default_timeout : DEFAULT_TIMEOUT,
    raw,
  };
}

/** Set one top-level key in config.yml, keeping comments and other keys. */
export function setConfigValue(key: string, value: unknown, home = jillsHome()): void {
  const file = configPath(home);
  const doc = existsSync(file) ? YAML.parseDocument(readFileSync(file, "utf8")) : new YAML.Document({});
  if (!doc.contents) doc.contents = doc.createNode({}) as never;
  doc.set(key, value);
  writeFileAtomic(file, String(doc));
}
