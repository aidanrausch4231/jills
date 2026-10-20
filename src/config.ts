import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { writeFileAtomic } from "./util.js";

/** Core settings only; plug-ins read their own keys (agent_paths, jev, ...) from `raw`. */
export interface JillsConfig {
  home: string;
  auto: boolean;
  jill_paths: string[];
  /** Extra single-file plug-ins to load (absolute paths or relative to home). */
  plugins: string[];
  /** Total-run time limit when a Jill sets none (config `default_timeout`, default 2h). */
  default_timeout: string | number;
  /** Raw parsed YAML, for plug-ins that read their own keys. */
  raw: Record<string, unknown>;
}

/** Total-run time limit when neither the Jill nor config.yml sets one. */
export const DEFAULT_TIMEOUT = "2h";

/** The Jills home folder: $JILLS_HOME or ~/.jills. */
export function jillsHome(): string {
  const env = process.env.JILLS_HOME;
  return resolve(env && env.trim() ? env : join(homedir(), ".jills"));
}

export const configPath = (home = jillsHome()) => join(home, "config.yml");

/** Paths from config key `v` ($JILLS_HOME and ~/ expanded, relative to home); `fallback` when unset. */
export function pathList(v: unknown, home: string, fallback: string[]): string[] {
  return (Array.isArray(v) ? v.map(String) : fallback).map((p) => {
    const out = p.replace(/\$JILLS_HOME|\$\{JILLS_HOME\}/g, home);
    return resolve(home, out.startsWith("~/") ? join(homedir(), out.slice(2)) : out);
  });
}

export function loadConfig(home = jillsHome()): JillsConfig {
  const file = configPath(home);
  const parsed: unknown = existsSync(file) ? YAML.parse(readFileSync(file, "utf8")) : undefined;
  const raw = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const dt = raw.default_timeout;
  return {
    home,
    auto: raw.auto === true,
    jill_paths: pathList(raw.jill_paths, home, [join(home, "jills")]),
    plugins: pathList(raw.plugins, home, []),
    default_timeout: typeof dt === "string" || typeof dt === "number" ? dt : DEFAULT_TIMEOUT,
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
