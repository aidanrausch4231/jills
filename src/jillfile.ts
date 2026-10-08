import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import YAML from "yaml";
import { renderShellTemplate } from "./template.js";
import { parseDuration } from "./util.js";

export type InputDef = { name: string; description?: string; default?: string; required?: boolean };

export interface StepDef {
  name: string;
  /** Exactly one of agent, run, jill; `task` is the agent's task text. */
  agent?: string; run?: string; jill?: string; task?: string;
  needs: string[];
  copies: number;
  writes: boolean;
  model?: string;
  timeout?: string | number;
  /** Inputs passed to a nested Jill (templated). Defaults to the parent's inputs. */
  inputs?: Record<string, string>;
  /** Back-arrow: on a real failure rerun `backTo` and every step after it, `maxRounds` rounds in all. */
  onFail?: { backTo: string; maxRounds: number };
  /** May squash-merge the run branch into the branch the run started from (needs worktree: true). */
  merges: boolean;
  /** Unknown step fields, passed through to plug-ins. */
  extra: Record<string, unknown>;
}

export interface JillDef {
  name: string; description: string; when?: string; keywords: string[];
  inputs: InputDef[];
  steps: StepDef[];
  worktree: boolean;
  /** Isolation box (`box: docker | openshell | <name>`): needs an isolation plug-in of that name. */
  box?: string;
  machine: string;
  timeout?: string | number;
  /** The markdown body and the JILL.md path. */
  body: string; path: string;
  /** Unknown top-level fields, passed through to plug-ins (e.g. goal, checks). */
  extra: Record<string, unknown>;
}

const JILL_KEYS = ["name", "description", "when", "keywords", "inputs", "steps", "worktree", "box", "machine", "timeout"];
const STEP_KEYS = ["agent", "run", "jill", "task", "needs", "copies", "writes", "model", "timeout", "inputs", "on_fail", "merges"];
export const MAX_COPIES = 16;
export const MAX_DEPTH = 4;
export const MAX_ROUNDS = 10;
/** Shown wherever a Jill with worktree: false is suggested or checked. */
export const NO_WORKTREE_NOTE = "no worktree: edits your checkout directly";

/** Split "---\nyaml\n---\nbody" into parsed YAML and the markdown body. */
export function parseFrontMatter(text: string, source = "file"): { data: Record<string, unknown>; body: string } {
  const t = text.replace(/^﻿/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(t);
  if (!m) throw new Error(`${source}: missing YAML front matter (--- ... ---)`);
  let data: unknown;
  try {
    data = YAML.parse(m[1]!) ?? {};
  } catch (e) {
    throw new Error(`${source}: bad YAML front matter: ${(e as Error).message}`);
  }
  if (typeof data !== "object" || Array.isArray(data)) throw new Error(`${source}: front matter must be a YAML map`);
  return { data: data as Record<string, unknown>, body: t.slice(m[0].length) };
}

const list = (v: unknown): string[] => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
const str = (v: unknown) => (v === undefined ? undefined : String(v));
const rest = (o: Record<string, unknown>, known: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !known.includes(k)));
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Run fn; a throw becomes one error line. */
const tryAll = (errs: string[], prefix: string, fn: () => unknown) => {
  try { fn(); } catch (e) { errs.push(prefix + (e as Error).message); }
};

function parseStep(name: string, s: Record<string, unknown>, errs: string[]): StepDef {
  const kinds = ["agent", "run", "jill"].filter((k) => s[k] !== undefined);
  if (kinds.length !== 1) errs.push(`step ${name}: needs exactly one of agent, run, jill (has ${kinds.join(", ") || "none"})`);
  const copies = s.copies === undefined ? 1 : Number(s.copies);
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) errs.push(`step ${name}: copies must be 1..${MAX_COPIES}`);
  tryAll(errs, `step ${name}: `, () => parseDuration(s.timeout));
  if (s.run !== undefined) tryAll(errs, `step ${name}: `, () => renderShellTemplate(String(s.run), { inputs: {} }));
  if (s.inputs !== undefined && !isMap(s.inputs)) errs.push(`step ${name}: inputs must be a map`);
  const of = s.on_fail, rounds = isMap(of) && of.max_rounds !== undefined ? Number(of.max_rounds) : 3;
  const onFail = isMap(of) && typeof of.back_to === "string" && Number.isInteger(rounds) && rounds >= 1 ? { backTo: of.back_to, maxRounds: Math.min(rounds, MAX_ROUNDS) } : undefined;
  if (s.merges === true && (s.jill !== undefined || s.writes === true)) errs.push(`step ${name}: merges: true needs an agent: or run: step without writes: true`);
  if (of !== undefined && !onFail) errs.push(`step ${name}: on_fail must be { back_to: <step>, max_rounds: 1..${MAX_ROUNDS} }`);
  return {
    name,
    agent: str(s.agent),
    run: str(s.run),
    jill: str(s.jill),
    task: str(s.task),
    needs: list(s.needs),
    copies: Number.isInteger(copies) ? copies : 1,
    writes: s.writes === true,
    model: str(s.model),
    timeout: s.timeout as string | number | undefined,
    inputs: isMap(s.inputs) ? Object.fromEntries(Object.entries(s.inputs).map(([k, v]) => [k, String(v)])) : undefined,
    onFail,
    merges: s.merges === true,
    extra: rest(s, STEP_KEYS),
  };
}

export function parseJill(text: string, path = "JILL.md"): JillDef {
  const { data, body } = parseFrontMatter(text, path);
  const errs: string[] = [];
  const name = data.name ? String(data.name) : path.endsWith("JILL.md") ? basename(dirname(path)) : "";
  if (!name) errs.push("missing name");
  else if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) errs.push(`bad name "${name}" (letters, digits, . _ - only)`);
  const inputs: InputDef[] = [];
  if (data.inputs !== undefined && !Array.isArray(data.inputs)) errs.push("inputs must be a list");
  for (const i of Array.isArray(data.inputs) ? data.inputs : []) {
    if (typeof i === "string") inputs.push({ name: i });
    else if (isMap(i) && "name" in i) inputs.push({ name: String(i.name), description: str(i.description), default: str(i.default), required: i.required === true });
    else errs.push(`bad input entry: ${JSON.stringify(i)}`);
  }
  const steps: StepDef[] = [];
  if (!isMap(data.steps)) errs.push("steps must be a map of step name -> step");
  else {
    for (const [sname, sv] of Object.entries(data.steps)) {
      if (isMap(sv)) steps.push(parseStep(sname, sv, errs));
      else errs.push(`step ${sname}: must be a map`);
    }
    if (steps.length === 0) errs.push("steps is empty");
  }
  const names = new Set(steps.map((s) => s.name));
  for (const s of steps) for (const n of s.needs) if (!names.has(n)) errs.push(`step ${s.name}: needs unknown step "${n}"`);
  const cyc = steps.filter((s) => ancestors(steps, s.name).has(s.name)).map((s) => s.name);
  if (cyc.length) errs.push(`steps form a cycle through: ${cyc.join(", ")}`);
  for (const s of steps) {
    if (s.onFail && !ancestors(steps, s.name).has(s.onFail.backTo)) errs.push(`step ${s.name}: on_fail back_to "${s.onFail.backTo}" must be an earlier step it needs (directly or not)`);
    if (s.merges && data.worktree === false) errs.push(`step ${s.name}: merges: true needs worktree: true`);
    if (s.merges && (s.copies !== 1 || steps.some((x) => x !== s && !ancestors(steps, s.name).has(x.name)))) errs.push(`step ${s.name}: merges: true must be the single final step (every other step comes before it) without copies`);
  }
  tryAll(errs, "", () => parseDuration(data.timeout));
  const box = data.box == null || data.box === false ? undefined : data.box;
  if (box !== undefined && (typeof box !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(box))) errs.push("box must be a plug-in name such as docker or openshell");
  if (data.docker !== undefined) errs.push("docker: is not a Jill field; use box: docker");
  if (errs.length) throw new Error(`${path}: ${errs.join("; ")}`);
  return {
    name,
    description: String(data.description ?? ""),
    when: str(data.when),
    keywords: list(data.keywords),
    inputs,
    steps,
    worktree: data.worktree === undefined || data.worktree === true,
    box: box as string | undefined,
    machine: data.machine === undefined ? "local" : String(data.machine),
    timeout: data.timeout as string | number | undefined,
    body: body.trim(),
    path,
    extra: rest(data, JILL_KEYS),
  };
}

/** Every step `name` needs, directly or not. */
export function ancestors(steps: StepDef[], name: string, seen = new Set<string>()): Set<string> {
  for (const d of steps.find((s) => s.name === name)?.needs ?? []) if (!seen.has(d)) ancestors(steps, d, seen.add(d));
  return seen;
}

/**
 * Settings whose plug-ins are not installed are refused: `box: <name>` needs an
 * isolation plug-in of that name (pass the loaded isolation names), and only
 * machine: local exists in v1. Returns a message or undefined.
 */
export function refusal(j: JillDef, isolation: ReadonlySet<string> | ReadonlyMap<string, unknown> = new Set()): string | undefined {
  if (j.box && !isolation.has(j.box))
    return `Jill "${j.name}" sets box: ${j.box}, but the "${j.box}" isolation extension is not installed. Add the ${j.box} isolation plug-in file to config plugins: (Jills core ships only worktree isolation), or remove box: to run in a worktree on this machine.`;
  if (j.machine !== "local") return `Jill "${j.name}" sets machine: ${j.machine} — only machine: local is supported in v1 (ssh places come later).`;
  return undefined;
}

/** `duplicates`: name -> every path found, when more than one (the first path wins). */
export type Scan<T> = { items: Map<string, T>; duplicates: Map<string, string[]>; errors: string[] };

/** Parse every file from each folder in order; the first item with a name wins. */
export function scanFirstWins<T extends { name: string }>(paths: string[], files: (dir: string) => string[], parse: (file: string) => T): Scan<T> {
  const items = new Map<string, T>();
  const all = new Map<string, string[]>();
  const errors: string[] = [];
  for (const dir of paths) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const f of files(dir)) {
      try {
        const it = parse(f);
        all.set(it.name, [...(all.get(it.name) ?? []), f]);
        if (!items.has(it.name)) items.set(it.name, it);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
  }
  return { items, duplicates: new Map([...all].filter(([, v]) => v.length > 1)), errors };
}

/** Scan jill_paths in order (folders of <name>/JILL.md); first name wins. */
export function scanJills(paths: string[]): Scan<JillDef> {
  const files = (dir: string) => readdirSync(dir).sort().map((e) => join(dir, e, "JILL.md")).filter((p) => existsSync(p));
  return scanFirstWins(paths, files, (f) => parseJill(readFileSync(f, "utf8"), f));
}

/**
 * Check nested jill: steps statically. Throws on self/indirect recursion,
 * unknown nested Jills, nesting deeper than MAX_DEPTH (outermost = depth 1), or
 * a nested Jill whose box differs from the outermost one (the outermost decides).
 */
export function checkNesting(root: JillDef, lookup: (name: string) => JillDef | undefined): void {
  const walk = (j: JillDef, stack: string[]) => {
    if (stack.length > MAX_DEPTH) throw new Error(`Jill nesting too deep: ${stack.join(" -> ")} (max depth ${MAX_DEPTH})`);
    for (const s of j.steps) {
      if (!s.jill) continue;
      if (stack.includes(s.jill))
        throw new Error(`Jill recursion refused: ${[...stack, s.jill].join(" -> ")} (a Jill may not call itself, directly or indirectly)`);
      const child = lookup(s.jill);
      if (!child) throw new Error(`step ${j.name}.${s.name}: unknown Jill "${s.jill}"`);
      if (child.steps.some((x) => x.merges)) throw new Error(`nested Jill "${child.name}" has a merges: true step; only the outermost Jill may merge`);
      if (child.box && child.box !== root.box)
        throw new Error(`nested Jill "${child.name}" sets box: ${child.box} but outermost Jill "${root.name}" uses box: ${root.box ?? "none"}`);
      walk(child, [...stack, child.name]);
    }
  };
  walk(root, [root.name]);
}
