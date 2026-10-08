export interface TemplateVars {
  inputs: Record<string, string>;
  task?: string;
  copy?: number;
  run_id?: string;
  /** step name -> { output } */
  steps?: Record<string, { output: string }>;
  /** Back-arrow loops: this step's 1-based round and the failed step's output tail ("" in round 1). */
  round?: number;
  feedback?: string;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/y;
const up = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_]/g, "_");

/** One placeholder key: its plain value and the env var name it gets in run: commands. */
function resolveKey(vars: TemplateVars, key: string): { value?: string; env: string } {
  const [head, name, tail, more] = key.split(".");
  if (head === "inputs" && name && !tail) return { value: vars.inputs[name], env: `JILLS_INPUT_${up(name)}` };
  if (head === "steps" && name && tail === "output" && !more) return { value: vars.steps?.[name]?.output, env: `JILLS_STEP_OUT_${up(name)}` };
  if (key === "task") return { value: vars.task ?? vars.inputs.task, env: "JILLS_TASK" };
  if (key === "copy" || key === "run_id" || key === "round" || key === "feedback") return { value: vars[key]?.toString(), env: `JILLS_${up(key)}` };
  return { env: `JILLS_VAR_${up(key)}` };
}

/**
 * Replace {{inputs.x}}, {{task}}, {{copy}}, {{run_id}}, {{round}}, {{feedback}},
 * {{steps.<name>.output}} with their plain values. Use this for text that never reaches a shell
 * (agent tasks, nested Jill inputs). Unknown names expand to "".
 */
export function renderTemplate(tpl: string, vars: TemplateVars): string {
  return tpl.replace(new RegExp(PLACEHOLDER.source, "g"), (_m, key: string) => resolveKey(vars, key).value ?? "");
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
  const nameOfKey = new Map<string, string>();
  const varName = (key: string): string => {
    const hit = nameOfKey.get(key);
    if (hit) return hit;
    const { value, env: base } = resolveKey(vars, key);
    let name = base;
    for (let i = 2; name in env; i++) name = `${base}_${i}`;
    nameOfKey.set(key, name);
    env[name] = value ?? "";
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
    const two = ch + (tpl[i + 1] ?? "");
    const t = top();
    const code = t.kind === "plain" || t.kind === "subst";
    const push = (c: Ctx) => void stack.push(c);
    const escaped = two.length === 2 && ch === "\\" && t.kind !== "single"; // never opens or closes anything
    if (escaped || (code && two === "$'") || ((code || t.kind === "double") && two === "$(")) {
      if (!escaped) push(two === "$'" ? { kind: "ansi" } : { kind: "subst", depth: 0 });
      out += two;
      i += 2;
      continue;
    }
    if (code && ch === "'") push({ kind: "single" });
    else if (code && ch === '"') push({ kind: "double" });
    else if ((code || t.kind === "double") && ch === "`") push({ kind: "backtick" });
    else if (t.kind === "subst" && ch === "(") t.depth++;
    else if (t.kind === "subst" && ch === ")") t.depth === 0 ? stack.pop() : t.depth--;
    else if (((t.kind === "single" || t.kind === "ansi") && ch === "'") || (t.kind === "double" && ch === '"') || (t.kind === "backtick" && ch === "`")) stack.pop();
    out += ch;
    i++;
  }
  return { text: out, env };
}
