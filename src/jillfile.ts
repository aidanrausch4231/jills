import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseFrontMatter } from "./frontmatter.js";
import { parseDuration } from "./util.js";
import { renderShellTemplate } from "./template.js";

export interface InputDef {
  name: string;
  description?: string;
  default?: string;
  required?: boolean;
}

export interface StepDef {
  name: string;
  agent?: string;
  run?: string;
  jill?: string;
  task?: string;
  needs: string[];
  copies: number;
  writes: boolean;
  model?: string;
  timeout?: string | number;
  /** Inputs passed to a nested Jill (templated). Defaults to the parent's inputs. */
  inputs?: Record<string, string>;
  /** Unknown step fields, passed through to plug-ins. */
  extra: Record<string, unknown>;
}

export interface JillDef {
  name: string;
  description: string;
  when?: string;
  keywords: string[];
  inputs: InputDef[];
  steps: StepDef[];
  worktree: boolean;
  /**
   * Isolation box this Jill opts into (`box: docker | openshell | <name>`);
   * `docker: true` is an alias of `box: docker`. Needs a matching isolation
   * plug-in in config `plugins:`; core ships none.
   */
  box?: string;
  /** True when box is "docker" (kept for the docker: true alias). */
  docker: boolean;
  machine: string;
  timeout?: string | number;
  body: string;
  path: string;
  /** Unknown top-level fields, passed through to plug-ins (e.g. goal, checks). */
  extra: Record<string, unknown>;
}

const JILL_KEYS = new Set(["name", "description", "when", "keywords", "inputs", "steps", "worktree", "box", "docker", "machine", "timeout"]);
const STEP_KEYS = new Set(["agent", "run", "jill", "task", "needs", "copies", "writes", "model", "timeout", "inputs"]);
export const MAX_COPIES = 16;

function toList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}

export function parseJill(text: string, path = "JILL.md"): JillDef {
  const { data, body } = parseFrontMatter(text, path);
  const errs: string[] = [];
  const name = data.name ? String(data.name) : path.endsWith("JILL.md") ? basename(dirname(path)) : "";
  if (!name) errs.push("missing name");
  else if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) errs.push(`bad name "${name}" (letters, digits, . _ - only)`);
  const inputs: InputDef[] = [];
  if (data.inputs !== undefined) {
    if (!Array.isArray(data.inputs)) errs.push("inputs must be a list");
    else
      for (const i of data.inputs) {
        if (typeof i === "string") inputs.push({ name: i });
        else if (i && typeof i === "object" && "name" in i) {
          const o = i as Record<string, unknown>;
          inputs.push({
            name: String(o.name),
            description: o.description ? String(o.description) : undefined,
            default: o.default !== undefined ? String(o.default) : undefined,
            required: o.required === true,
          });
        } else errs.push(`bad input entry: ${JSON.stringify(i)}`);
      }
  }
  const steps: StepDef[] = [];
  const rawSteps = data.steps;
  if (!rawSteps || typeof rawSteps !== "object" || Array.isArray(rawSteps)) errs.push("steps must be a map of step name -> step");
  else {
    for (const [sname, sv] of Object.entries(rawSteps as Record<string, unknown>)) {
      if (!sv || typeof sv !== "object" || Array.isArray(sv)) {
        errs.push(`step ${sname}: must be a map`);
        continue;
      }
      const s = sv as Record<string, unknown>;
      const kinds = ["agent", "run", "jill"].filter((k) => s[k] !== undefined);
      if (kinds.length !== 1) errs.push(`step ${sname}: needs exactly one of agent, run, jill (has ${kinds.join(", ") || "none"})`);
      const copies = s.copies === undefined ? 1 : Number(s.copies);
      if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) errs.push(`step ${sname}: copies must be 1..${MAX_COPIES}`);
      if (s.timeout !== undefined) {
        try {
          parseDuration(s.timeout);
        } catch (e) {
          errs.push(`step ${sname}: ${(e as Error).message}`);
        }
      }
      let stepInputs: Record<string, string> | undefined;
      if (s.inputs !== undefined) {
        if (typeof s.inputs !== "object" || Array.isArray(s.inputs) || s.inputs === null) errs.push(`step ${sname}: inputs must be a map`);
        else stepInputs = Object.fromEntries(Object.entries(s.inputs as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
      }
      if (s.run !== undefined) {
        try {
          renderShellTemplate(String(s.run), { inputs: {} });
        } catch (e) {
          errs.push(`step ${sname}: ${(e as Error).message}`);
        }
      }
      const extra: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s)) if (!STEP_KEYS.has(k)) extra[k] = v;
      steps.push({
        name: sname,
        agent: s.agent !== undefined ? String(s.agent) : undefined,
        run: s.run !== undefined ? String(s.run) : undefined,
        jill: s.jill !== undefined ? String(s.jill) : undefined,
        task: s.task !== undefined ? String(s.task) : undefined,
        needs: toList(s.needs),
        copies: Number.isInteger(copies) ? copies : 1,
        writes: s.writes === true,
        model: s.model !== undefined ? String(s.model) : undefined,
        timeout: s.timeout as string | number | undefined,
        inputs: stepInputs,
        extra,
      });
    }
    if (steps.length === 0) errs.push("steps is empty");
  }
  // needs refer to known steps, no cycles
  const names = new Set(steps.map((s) => s.name));
  for (const s of steps) for (const n of s.needs) if (!names.has(n)) errs.push(`step ${s.name}: needs unknown step "${n}"`);
  const cyc = findCycle(steps);
  if (cyc) errs.push(`steps form a cycle: ${cyc.join(" -> ")}`);
  if (data.timeout !== undefined) {
    try {
      parseDuration(data.timeout);
    } catch (e) {
      errs.push((e as Error).message);
    }
  }
  let box: string | undefined;
  if (data.box !== undefined && data.box !== null && data.box !== false) {
    if (typeof data.box !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(data.box)) errs.push(`box must be a plug-in name such as docker or openshell`);
    else box = data.box;
  }
  if (data.docker === true) {
    if (box && box !== "docker") errs.push(`docker: true conflicts with box: ${box} (docker: true means box: docker)`);
    box = "docker";
  }
  if (errs.length) throw new Error(`${path}: ${errs.join("; ")}`);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!JILL_KEYS.has(k)) extra[k] = v;
  return {
    name,
    description: String(data.description ?? ""),
    when: data.when !== undefined ? String(data.when) : undefined,
    keywords: toList(data.keywords),
    inputs,
    steps,
    worktree: data.worktree === undefined ? true : data.worktree === true,
    box,
    docker: box === "docker",
    machine: data.machine === undefined ? "local" : String(data.machine),
    timeout: data.timeout as string | number | undefined,
    body: body.trim(),
    path,
    extra,
  };
}

function findCycle(steps: StepDef[]): string[] | undefined {
  const by = new Map(steps.map((s) => [s.name, s]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | undefined => {
    if (state.get(n) === 2) return undefined;
    if (state.get(n) === 1) return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, 1);
    stack.push(n);
    for (const d of by.get(n)?.needs ?? []) {
      if (!by.has(d)) continue;
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(n, 2);
    return undefined;
  };
  for (const s of steps) {
    const c = visit(s.name);
    if (c) return c;
  }
  return undefined;
}

/** Shown wherever a Jill with worktree: false is suggested or checked. */
export const NO_WORKTREE_NOTE = "no worktree: edits your checkout directly";

/**
 * Refusals for settings whose plug-ins are not installed. `box:` (and its
 * alias docker: true) needs an isolation plug-in of that name loaded from
 * config `plugins:`; pass the loaded isolation names. Returns a message or undefined.
 */
export function v1Refusal(j: JillDef, isolation: ReadonlySet<string> | ReadonlyMap<string, unknown> = new Set()): string | undefined {
  const r = boxRefusal(j, isolation);
  if (r) return r;
  if (j.machine !== "local") return `Jill "${j.name}" sets machine: ${j.machine} — only machine: local is supported in v1 (ssh places come later).`;
  return undefined;
}

/** box: <name> without an installed isolation plug-in of that name → message naming the missing extension. */
export function boxRefusal(j: JillDef, isolation: ReadonlySet<string> | ReadonlyMap<string, unknown> = new Set()): string | undefined {
  if (!j.box || isolation.has(j.box)) return undefined;
  const how = j.box === "docker" ? "box: docker (or docker: true)" : `box: ${j.box}`;
  return `Jill "${j.name}" sets ${how}, but the "${j.box}" isolation extension is not installed. Add the ${j.box} isolation plug-in file to config plugins: (Jills core ships only worktree isolation), or remove box: to run in a worktree on this machine.`;
}

export interface JillScan {
  jills: Map<string, JillDef>;
  duplicates: Map<string, string[]>;
  errors: string[];
}

function jillFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry, "JILL.md");
    if (existsSync(p)) out.push(p);
  }
  return out;
}

/** Scan jill_paths in order (folders of <name>/JILL.md); first name wins. */
export function scanJills(paths: string[]): JillScan {
  const jills = new Map<string, JillDef>();
  const all = new Map<string, string[]>();
  const errors: string[] = [];
  for (const dir of paths) {
    for (const f of jillFiles(dir)) {
      let j: JillDef;
      try {
        j = parseJill(readFileSync(f, "utf8"), f);
      } catch (e) {
        errors.push((e as Error).message);
        continue;
      }
      const l = all.get(j.name) ?? [];
      l.push(f);
      all.set(j.name, l);
      if (!jills.has(j.name)) jills.set(j.name, j);
    }
  }
  const duplicates = new Map<string, string[]>();
  for (const [k, v] of all) if (v.length > 1) duplicates.set(k, v);
  return { jills, duplicates, errors };
}

export const MAX_DEPTH = 4;

/**
 * Check nested jill: steps statically. Throws on self/indirect recursion,
 * unknown nested Jills, or nesting deeper than MAX_DEPTH (outermost = depth 1).
 */
export function checkNesting(root: JillDef, lookup: (name: string) => JillDef | undefined): void {
  const walk = (j: JillDef, stack: string[]) => {
    if (stack.length > MAX_DEPTH)
      throw new Error(`Jill nesting too deep: ${stack.join(" -> ")} (max depth ${MAX_DEPTH})`);
    for (const s of j.steps) {
      if (!s.jill) continue;
      if (stack.includes(s.jill))
        throw new Error(`Jill recursion refused: ${[...stack, s.jill].join(" -> ")} (a Jill may not call itself, directly or indirectly)`);
      const child = lookup(s.jill);
      if (!child) throw new Error(`step ${j.name}.${s.name}: unknown Jill "${s.jill}"`);
      if (child.box && !root.box)
        throw new Error(`nested Jill "${child.name}" requires box: ${child.box} but outer Jill "${root.name}" runs without it`);
      walk(child, [...stack, child.name]);
    }
  };
  walk(root, [root.name]);
}
