import YAML from "yaml";

export interface FrontMatterDoc {
  data: Record<string, unknown>;
  body: string;
}

/** Split "---\nyaml\n---\nbody" into parsed YAML and the markdown body. */
export function parseFrontMatter(text: string, source = "file"): FrontMatterDoc {
  const t = text.replace(/^﻿/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(t);
  if (!m) throw new Error(`${source}: missing YAML front matter (--- ... ---)`);
  let data: unknown;
  try {
    data = YAML.parse(m[1]!);
  } catch (e) {
    throw new Error(`${source}: bad YAML front matter: ${(e as Error).message}`);
  }
  if (data === null || data === undefined) data = {};
  if (typeof data !== "object" || Array.isArray(data)) throw new Error(`${source}: front matter must be a YAML map`);
  return { data: data as Record<string, unknown>, body: t.slice(m[0].length) };
}
