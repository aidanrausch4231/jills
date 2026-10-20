import { existsSync, readFileSync } from "node:fs";
import type { JillDef } from "../jillfile.js";
import type { RunRecord, StepRecord } from "../runs.js";
import type { Outputs } from "./engine-command.js";
import type { Workspace } from "./types.js";

export const readOutput = (path?: string) => (path && existsSync(path) ? readFileSync(path, "utf8").slice(-8000).trim() : "");

/** Reuse the recorded workspace, never silently replace a lost worktree. */
export function savedWorkspace(r: Pick<RunRecord, "workspace" | "branch" | "base" | "isolated" | "repo">): Workspace | undefined {
  if (!r.workspace) return undefined;
  if (!existsSync(r.workspace)) throw new Error(`recorded workspace ${r.workspace} is gone; cannot resume`);
  return { dir: r.workspace, branch: r.branch, base: r.base, isolated: r.isolated ?? false, repo: r.repo };
}

/** Last round wins: an earlier success must not hide a later failure. */
export function savedStep(r: RunRecord, key: string): StepRecord | undefined {
  return Object.values(r.steps).filter((s) => s.key === key || (s.key.startsWith(`${key}@`) && /^\d+$/.test(s.key.slice(key.length + 1))))
    .sort((a, b) => (b.started ?? "").localeCompare(a.started ?? "") ||
      (Number(b.key.slice(key.length + 1)) || 1) - (Number(a.key.slice(key.length + 1)) || 1))[0];
}

export function stepOutput(r: RunRecord, s: StepRecord): string {
  if (s.log || s.kind !== "jill") return readOutput(s.log);
  return Object.values(r.steps).filter((inner) => inner.key.startsWith(`${s.key}/`))
    .map((inner) => readOutput(inner.log)).filter(Boolean).slice(-1).join("");
}

/** Reuse successes only while all their dependencies are reusable, regardless of declaration order. */
export function resumeSteps(r: RunRecord, jill: JillDef, prefix: string,
  state: Map<string, "pending" | "running" | "done" | "failed">, outputs: Outputs, rounds: Map<string, number>): Set<string> {
  const reusable = new Set<string>();
  const pending = new Set(jill.steps);
  for (let progress = true; progress;) {
    progress = false;
    for (const s of pending) {
      if (!s.needs.every((n) => state.get(n) === "done")) continue;
      pending.delete(s);
      progress = true;
      const keys = Array.from({ length: s.copies }, (_, i) => `${prefix}${s.name}${s.copies > 1 ? `#${i + 1}` : ""}`);
      const copies = keys.map((key) => savedStep(r, key));
      copies.forEach((c, i) => { if (c?.state === "done") reusable.add(keys[i]!); });
      if (!copies.every((c) => c?.state === "done")) continue;
      state.set(s.name, "done");
      rounds.set(s.name, 1); // a later back-arrow must run again, not reuse this success
      outputs[s.name] = { output: copies.map((c) => stepOutput(r, c!)).filter(Boolean).join("\n\n---\n\n") };
    }
  }
  return reusable;
}
