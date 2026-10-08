export interface TemplateVars {
  inputs: Record<string, string>;
  task?: string;
  copy?: number;
  run_id?: string;
  /** step name -> { output } */
  steps?: Record<string, { output: string }>;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/y;
const PLACEHOLDER_G = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

function lookup(vars: TemplateVars, path: string): string | undefined {
  const parts = path.split(".");
  if (parts[0] === "inputs" && parts.length === 2) return vars.inputs[parts[1]!];
  if (parts[0] === "task" && parts.length === 1) return vars.task ?? vars.inputs.task;
  if (parts[0] === "copy" && parts.length === 1) return vars.copy !== undefined ? String(vars.copy) : undefined;
  if (parts[0] === "run_id" && parts.length === 1) return vars.run_id;
  if (parts[0] === "steps" && parts.length === 3 && parts[2] === "output") return vars.steps?.[parts[1]!]?.output;
  return undefined;
}

/**
 * Replace {{inputs.x}}, {{task}}, {{copy}}, {{run_id}}, {{steps.<name>.output}}
 * with their plain values. Use this for text that never reaches a shell
 * (agent tasks, nested Jill inputs). Unknown names expand to "".
 */
export function renderTemplate(tpl: string, vars: TemplateVars): string {
  return tpl.replace(PLACEHOLDER_G, (_m, key: string) => lookup(vars, key) ?? "");
}

/** Env var name for one placeholder key. */
function envBase(key: string): string {
  const up = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const parts = key.split(".");
  if (parts[0] === "inputs" && parts.length === 2) return `JILLS_INPUT_${up(parts[1]!)}`;
  if (key === "task") return "JILLS_TASK";
  if (key === "copy") return "JILLS_COPY";
  if (key === "run_id") return "JILLS_RUN_ID";
  if (parts[0] === "steps" && parts.length === 3 && parts[2] === "output") return `JILLS_STEP_OUT_${up(parts[1]!)}`;
  return `JILLS_VAR_${up(key)}`;
}

type Ctx = { kind: "plain" } | { kind: "subst"; depth: number } | { kind: "single" } | { kind: "ansi" } | { kind: "double" } | { kind: "backtick" };

export interface ShellTemplate {
  /** The command text: every placeholder is a reference to an env var, never the value. */
  text: string;
  /** Env vars the command needs (name -> value). */
  env: Record<string, string>;
}

/**
 * Render a `run:` command for bash without putting any value into the shell
 * text. Each placeholder becomes a reference to an env var ("${JILLS_INPUT_X}",
 * "${JILLS_TASK}", "${JILLS_COPY}", "${JILLS_STEP_OUT_<name>}", ...), quoted to
 * fit where it sits: outside quotes, inside "double quotes", inside 'single
 * quotes' or $'...', or inside $( ). Bash never parses an expanded value as
 * code, so inputs, chat text and agent output cannot inject commands.
 * Placeholders inside backticks are refused (use $( ) instead).
 */
export function renderShellTemplate(tpl: string, vars: TemplateVars): ShellTemplate {
  const env: Record<string, string> = {};
  const keyOfName = new Map<string, string>();
  const nameOfKey = new Map<string, string>();
  const varName = (key: string): string => {
    const hit = nameOfKey.get(key);
    if (hit) return hit;
    let name = envBase(key);
    for (let i = 2; keyOfName.has(name); i++) name = `${envBase(key)}_${i}`;
    keyOfName.set(name, key);
    nameOfKey.set(key, name);
    env[name] = lookup(vars, key) ?? "";
    return name;
  };
  const stack: Ctx[] = [{ kind: "plain" }];
  const top = () => stack[stack.length - 1]!;
  let out = "";
  let i = 0;
  while (i < tpl.length) {
    PLACEHOLDER.lastIndex = i;
    const m = PLACEHOLDER.exec(tpl);
    if (m) {
      const key = m[1]!;
      if (stack.some((c) => c.kind === "backtick"))
        throw new Error(`template {{${key}}} sits inside backticks in a run: command; use $( ) instead of backticks`);
      const ref = "${" + varName(key) + "}";
      const k = top().kind;
      if (k === "double") out += ref;
      else if (k === "single") out += `'"${ref}"'`;
      else if (k === "ansi") out += `'"${ref}"$'`;
      else out += `"${ref}"`;
      i += m[0].length;
      continue;
    }
    const ch = tpl[i]!;
    const next = tpl[i + 1];
    const t = top();
    switch (t.kind) {
      case "plain":
      case "subst":
        if (ch === "\\" && next !== undefined) {
          out += ch + next;
          i += 2;
          continue;
        }
        if (ch === "$" && next === "'") {
          stack.push({ kind: "ansi" });
          out += "$'";
          i += 2;
          continue;
        }
        if (ch === "$" && next === "(") {
          stack.push({ kind: "subst", depth: 0 });
          out += "$(";
          i += 2;
          continue;
        }
        if (ch === "'") stack.push({ kind: "single" });
        else if (ch === '"') stack.push({ kind: "double" });
        else if (ch === "`") stack.push({ kind: "backtick" });
        else if (t.kind === "subst" && ch === "(") t.depth++;
        else if (t.kind === "subst" && ch === ")") {
          if (t.depth === 0) stack.pop();
          else t.depth--;
        }
        break;
      case "single":
        if (ch === "'") stack.pop();
        break;
      case "ansi":
        if (ch === "\\" && next !== undefined) {
          out += ch + next;
          i += 2;
          continue;
        }
        if (ch === "'") stack.pop();
        break;
      case "double":
        if (ch === "\\" && next !== undefined) {
          out += ch + next;
          i += 2;
          continue;
        }
        if (ch === "$" && next === "(") {
          stack.push({ kind: "subst", depth: 0 });
          out += "$(";
          i += 2;
          continue;
        }
        if (ch === '"') stack.pop();
        else if (ch === "`") stack.push({ kind: "backtick" });
        break;
      case "backtick":
        if (ch === "\\" && next !== undefined) {
          out += ch + next;
          i += 2;
          continue;
        }
        if (ch === "`") stack.pop();
        break;
    }
    out += ch;
    i++;
  }
  return { text: out, env };
}
