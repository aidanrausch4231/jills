import type { JillsConfig } from "../config.js";
import type { JillDef, StepDef } from "../jillfile.js";
import { renderShellTemplate, renderTemplate, type TemplateVars } from "../template.js";
import { parseLimit } from "../util.js";
import type { PluginSet } from "./index.js";
import type { RunnerPlugin } from "./types.js";

export type Outputs = Record<string, { output: string }>;
/** A step's round (1-based) and the failing step's feedback from round 2. */
export type Loop = { round: number; feedback: string };
type StepCtx = { config: JillsConfig; plugins: PluginSet; runId: string; key: string; cwd: string; box?: string; copy?: number; steps: Outputs; loop?: Loop; named?: Record<string, string>; status?: string };

/** Shared command preparation for real and dry runs; shell values always travel via env. */
export function stepCommand(step: StepDef, jill: JillDef, inputs: Record<string, string>, c: StepCtx) {
  const runner: RunnerPlugin | undefined = c.plugins.runners.find((p) => p.canRun(step, c.config, { jill, box: c.box }));
  const vars = { inputs, task: inputs.task, copy: c.copy, run_id: c.runId, steps: c.steps, ...c.loop, named: c.named };
  const shell = step.run !== undefined ? renderShellTemplate(step.run, vars) : undefined;
  const text = shell ? shell.text : renderTemplate(step.task ?? "{{task}}", vars);
  const env: Record<string, string> = { JILLS_HOME: c.config.home, JILLS_RUN_ID: c.runId, JILLS_STEP: c.key, JILLS_JILL: jill.name, JILLS_WORKSPACE: c.cwd };
  if (c.copy !== undefined) env.JILLS_COPY = String(c.copy);
  if (c.status) env.JILLS_RUN_STATUS = c.status; // always steps: pass | fail so far
  for (const [k, v] of Object.entries(inputs)) env[`JILLS_INPUT_${k.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`] = v;
  return { runner, text, env: { ...env, ...shell?.env }, shellEnv: shell?.env ?? {}, timeoutMs: parseLimit(step.timeout) };
}

/** A nested Jill's rendered inputs (else the parent's inputs), then the child's defaults. */
export function nestedInputs(step: StepDef, child: JillDef, vars: TemplateVars): Record<string, string> {
  const out = step.inputs ? Object.fromEntries(Object.entries(step.inputs).map(([k, v]) => [k, renderTemplate(v, vars)])) : { ...vars.inputs };
  for (const i of child.inputs) if (out[i.name] === undefined && i.default !== undefined) out[i.name] = i.default;
  return out;
}
