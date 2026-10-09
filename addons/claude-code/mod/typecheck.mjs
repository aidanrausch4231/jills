#!/usr/bin/env node
// Type-checks the Jills mod. The Claude Code API types come from the copy the engine lays
// beside a mod it loads with --plugin-dir (jills/.claude-plugin/types), else from
// CLAUDE_CODE_TYPES=<claude-code.d.ts>, else from the newest plugin-authoring skill copy
// Claude Code extracts under /tmp/claude-<uid>/bundled-skills.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const base = join(here, "tsconfig.json");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const laid = join(here, "jills", ".claude-plugin", "types", "claude-code", "index.d.ts");

function bundled() {
  const root = `/tmp/claude-${process.getuid?.() ?? 0}/bundled-skills`;
  if (!existsSync(root)) return undefined;
  const num = (v) => v.split(".").map((n) => n.padStart(6, "0")).join(".");
  for (const v of readdirSync(root).sort((a, b) => num(b).localeCompare(num(a)))) {
    for (const h of readdirSync(join(root, v))) {
      const f = join(root, v, h, "plugin-authoring", "types", "claude-code.d.ts");
      if (existsSync(f)) return f;
    }
  }
  return undefined;
}

let config = base;
let tmp;
if (!existsSync(laid)) {
  const dts = process.env.CLAUDE_CODE_TYPES || bundled();
  if (!dts) {
    console.error("typecheck: no Claude Code types; set CLAUDE_CODE_TYPES=<claude-code.d.ts> or load the mod once with --plugin-dir");
    process.exit(2);
  }
  console.error(`typecheck: types from ${dts}`);
  tmp = mkdtempSync(join(tmpdir(), "jills-mod-tsc-"));
  config = join(tmp, "tsconfig.json");
  writeFileSync(config, JSON.stringify({ extends: base, files: [dts] }));
}
const r = spawnSync(process.execPath, [tsc, "-p", config], { stdio: "inherit" });
if (tmp) rmSync(tmp, { recursive: true, force: true });
process.exit(r.status ?? 1);
