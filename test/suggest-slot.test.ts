import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { check, dryRun, lastSuggested, suggest } from "../src/api.js";
import { validatePlugin } from "../src/plugins/index.js";
import { loadRecord, markTerminal, saveRecord, type RunRecord } from "../src/runs.js";
import { MAX_TIMER_MS, parseLimit } from "../src/util.js";
import { tmp, tmpHome, tmpRepo, writeJill } from "./helpers.js";

test("a suggest plug-in from config replaces the default; core still drops undeclared inputs", async () => {
  const file = join(tmp(), "always.js");
  writeFileSync(
    file,
    `export default { slot: "suggest", apiVersion: 1, name: "always",
      async suggest(input, ctx) {
        const m = await ctx.match({ message: input.message, recent: input.recent, jills: ctx.jills, already: [], config: ctx.config });
        return { action: "suggest", reason: "always", jill: "hello", inputs: { who: "Bo", repo: "/etc" }, auto: false, matched: m };
      },
      chat: (session, change) => (change.kind === "last" ? { jill: "hello", inputs: { who: "saved" } } : undefined) };\n`,
  );
  const matcher = join(tmp(), "loud.js");
  writeFileSync(matcher, `export default { slot: "matcher", apiVersion: 1, name: "loud", async match() { return { label: "new", jill: "hello", inputs: { who: "M", repo: "/" }, confidence: 1, matcher: "loud" }; } };\n`);
  const home = tmpHome(`plugins: [${matcher}, ${file}]\n`);
  writeJill(home, "hello", "inputs: [who]\nworktree: false\nsteps:\n  a: {run: echo}");
  const s = (await suggest({ home, session: "s1", message: "anything", repo: tmpRepo() })) as unknown as { reason: string; inputs: unknown; matched: { inputs: unknown } };
  assert.equal(s.reason, "always");
  assert.deepEqual(s.inputs, { who: "Bo" }, "undeclared repo dropped from the plug-in's answer");
  assert.deepEqual(s.matched.inputs, { who: "M" }, "ctx.match drops undeclared inputs before the plug-in sees them");
  assert.deepEqual(await lastSuggested("s1", { home }), { jill: "hello", inputs: { who: "saved" } });
  assert.throws(() => validatePlugin({ slot: "suggest", apiVersion: 1, name: "x", suggest() {} }, "f.js"), /missing chat\(\)/);
});

test("markTerminal never overwrites a record its runner finished meanwhile", () => {
  const home = tmpHome();
  const base: RunRecord = { version: 1, id: "r1", jill: "j", jillPath: "p", inputs: {}, state: "running", created: new Date().toISOString(), repo: "/", logDir: "/l", steps: {}, events: [] };
  saveRecord(home, { ...base, state: "done", steps: {}, events: [] });
  const stale = (id: string): RunRecord => ({ ...base, id, steps: { a: { key: "a", step: "a", jill: "j", kind: "run", state: "running" } }, events: [] });
  assert.equal(markTerminal(home, stale("r1"), "failed", "stopped")?.state, "done");
  assert.equal(loadRecord(home, "r1")?.state, "done");
  saveRecord(home, { ...base, id: "r2", events: [] });
  const r = markTerminal(home, stale("r2"), "stuck", "why; hint", "why")!;
  assert.equal(loadRecord(home, "r2")?.state, "stuck");
  assert.equal(r.steps.a!.reason, "why");
  assert.equal(r.error, "why; hint");
});

test("parseLimit: unset or <= 0 is no limit; huge values clamp", () => {
  assert.equal(parseLimit(undefined), undefined);
  assert.equal(parseLimit("0s"), undefined);
  assert.equal(parseLimit("90s"), 90_000);
  assert.equal(parseLimit("9999999h"), MAX_TIMER_MS);
});

test("check and dry run share one step walk: nested Jills walk in dry run; a step a runner refuses is a check error", async () => {
  const home = tmpHome();
  writeJill(home, "inner", "worktree: false\nsteps:\n  x: {run: echo in}");
  writeJill(home, "odd", "worktree: false\nsteps:\n  a: {run: echo hi}\n  b: {jill: inner}");
  const r = await check({ home });
  assert.deepEqual(r.errors, []);
  const lines = await dryRun("odd", { home, cwd: tmp() });
  assert.ok(lines.some((l) => l.startsWith("- a: bash -c")), lines.join("\n"));
  assert.ok(lines.includes("- b: jill inner"), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith("  - x: bash -c")), lines.join("\n"));
  writeJill(home, "agentless", "worktree: false\nsteps:\n  a: {agent: nobody}");
  const bad = await check({ home });
  assert.ok(bad.errors.some((e) => /agentless.*step a: unknown agent "nobody"/.test(e)), bad.errors.join("\n"));
});
