/**
 * `foreach:` steps: run a step once per item of a list that an earlier step printed.
 *
 *   repos:
 *     agent: repo-scout
 *     needs: [plan]
 *     foreach: steps.plan.repos   # or steps.plan (the JSON line itself is the list)
 *     as: repo                    # {{repo}} in task / run: (default {{item}})
 *     max_parallel: 4             # default 4
 *     max_items: 20               # default 20; a longer list fails the step, never truncated
 *
 * The list is the last line of the earlier step's output that is valid JSON (one line). Each
 * item runs as `<step>#<n>`; a failed item never cancels the others, and the step fails after
 * all items ran, naming the failed ones. An empty list skips the step (dependents still run).
 *
 * An `expand` plug-in, on by default. Config `foreach: { max_parallel, max_items }` sets the
 * defaults for steps that do not set their own; a config plug-in named "foreach" replaces this one.
 */
import type { JillsConfig } from "../config.js";
import type { StepDef } from "../jillfile.js";
import type { ExpandPlugin } from "./types.js";

export interface Foreach { step: string; field?: string; as: string; maxParallel: number; maxItems: number }
export const DEFAULT_PARALLEL = 4, DEFAULT_ITEMS = 20, MAX_PARALLEL = 16, MAX_ITEMS = 100;
const REF = /^steps\.([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_-]+))?$/;
const RESERVED = new Set(["inputs", "steps", "task", "copy", "run_id", "round", "feedback"]);
const int = (v: unknown, def: number) => (v === undefined ? def : Number(v));

/** The step's foreach settings (from its pass-through fields, else config `foreach:`), or undefined. */
export function foreachOf(s: Pick<StepDef, "extra">, config?: JillsConfig): Foreach | undefined {
  const x = s.extra, d = (config?.raw.foreach ?? {}) as Record<string, unknown>;
  if (x.foreach === undefined) return undefined;
  const m = REF.exec(String(x.foreach));
  return { step: m?.[1] ?? "", field: m?.[2], as: x.as === undefined ? "item" : String(x.as),
    maxParallel: int(x.max_parallel ?? d.max_parallel, DEFAULT_PARALLEL), maxItems: int(x.max_items ?? d.max_items, DEFAULT_ITEMS) };
}

/** Parse-time errors for one step; `before` = the steps it needs, directly or not. */
export function foreachErrors(s: StepDef, before: Set<string>): string[] {
  const f = foreachOf(s);
  const extraKeys = ["as", "max_parallel", "max_items"].filter((k) => s.extra[k] !== undefined);
  if (!f) return extraKeys.length ? [`step ${s.name}: ${extraKeys.join(", ")} needs foreach:`] : [];
  const errs: string[] = [];
  const say = (m: string) => errs.push(`step ${s.name}: ${m}`);
  if (!f.step) say(`foreach must be steps.<step> or steps.<step>.<field> (got ${JSON.stringify(s.extra.foreach)})`);
  else if (!before.has(f.step)) say(`foreach refers to steps.${f.step}, which is not an earlier step it needs (directly or not)`);
  if (s.copies !== 1 || s.jill !== undefined || s.merges) say("foreach cannot be combined with copies, jill: or merges");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.as) || RESERVED.has(f.as)) say(`as must be a plain name other than ${[...RESERVED].join(", ")}`);
  if (!Number.isInteger(f.maxParallel) || f.maxParallel < 1 || f.maxParallel > MAX_PARALLEL) say(`max_parallel must be 1..${MAX_PARALLEL}`);
  if (!Number.isInteger(f.maxItems) || f.maxItems < 1 || f.maxItems > MAX_ITEMS) say(`max_items must be 1..${MAX_ITEMS}`);
  return errs;
}

/** The items to run, as text. Throws a clear reason when the list is missing, not a list or over max_items. */
export function foreachItems(f: Foreach, outputs: Record<string, { output: string } | undefined>): string[] {
  const ref = `steps.${f.step}${f.field ? `.${f.field}` : ""}`;
  const lines = (outputs[f.step]?.output ?? "").split("\n").map((l) => l.trim()).reverse();
  let json: unknown, found = false;
  for (const l of lines) {
    if (!/^[[{]/.test(l)) continue;
    try { json = JSON.parse(l); found = true; break; } catch { /* not JSON: keep looking */ }
  }
  if (!found) throw new Error(`foreach ${ref}: step ${f.step} printed no JSON line to take the list from`);
  const list = f.field ? (json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>)[f.field] : undefined) : json;
  if (list === undefined) throw new Error(`foreach ${ref}: the JSON from step ${f.step} has no field "${f.field}"`);
  if (!Array.isArray(list)) throw new Error(`foreach ${ref} is not a list (got ${typeof list})`);
  if (list.length > f.maxItems) throw new Error(`foreach ${ref} has ${list.length} items, over max_items ${f.maxItems}; nothing ran (raise max_items or shorten the list)`);
  return list.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
}

/** The step output: every item's output in order, then which items failed. */
export function foreachOutput(name: string, items: string[], res: { ok: boolean; output: string }[]): string {
  const failed = res.flatMap((r, i) => (r.ok ? [] : [i + 1]));
  const parts = items.map((it, i) => `## ${name} item ${i + 1}/${items.length}${res[i]!.ok ? "" : " (failed)"}: ${it}\n${res[i]!.output}`);
  if (failed.length) parts.push(foreachFailed(items.length, failed));
  return parts.join("\n\n---\n\n");
}
export const foreachFailed = (n: number, failed: number[]) => `foreach: ${failed.length} of ${n} items failed (item ${failed.join(", ")})`;

const foreach: ExpandPlugin = {
  slot: "expand",
  apiVersion: 1,
  name: "foreach",
  validate: foreachErrors,
  expand(step, outputs, config) {
    const f = foreachOf(step, config);
    if (!f) return undefined;
    const items = foreachItems(f, outputs); // throws the reason the step fails
    return {
      items: items.map((it) => ({ [f.as]: it })),
      maxParallel: f.maxParallel,
      join: (res) => foreachOutput(step.name, items, res),
      failed: (res) => foreachFailed(items.length, res.flatMap((r, i) => (r.ok ? [] : [i + 1]))),
    };
  },
};
export default foreach;
