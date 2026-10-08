import { shellQuote } from "./util.js";

export interface TemplateVars {
  inputs: Record<string, string>;
  task?: string;
  copy?: number;
  run_id?: string;
  /** step name -> { output } */
  steps?: Record<string, { output: string }>;
}

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
 * Replace {{inputs.x}}, {{task}}, {{copy}}, {{run_id}}, {{steps.<name>.output}}.
 * With shell=true every value is shell-quoted, so inputs cannot inject commands.
 * Unknown names expand to an empty string (shell-quoted as '').
 */
export function renderTemplate(tpl: string, vars: TemplateVars, opts: { shell?: boolean } = {}): string {
  return tpl.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_m, key: string) => {
    const v = lookup(vars, key) ?? "";
    return opts.shell ? shellQuote(v) : v;
  });
}
