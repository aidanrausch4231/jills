#!/usr/bin/env node
import {
  check,
  dismiss,
  dryRun,
  executeRun,
  lastSuggestion,
  listJills,
  never,
  newJill,
  on,
  quiet,
  runNow,
  setAuto,
  start,
  status,
  suggest,
  wait,
} from "./api.js";
import { loadConfig } from "./config.js";
import type { Turn } from "./plugins/types.js";
import { resultLine, type RunRecord, type RunState } from "./runs.js";
import { parseDuration } from "./util.js";

export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  noSuggestion: 3,
  failed: 4,
  stuck: 5,
  needsYou: 6,
  waitTimeout: 7,
} as const;

const USAGE = `jills — saved agent workflows that Jev suggests from chat

Usage:
  jills list                                   list saved Jills
  jills check                                  validate config, Jills, agents (warns on duplicates)
  jills suggest --session <id> [--repo <p>] [--json] "<message>"
                                               ask Jev about one chat message (recent turns: JSON on stdin)
  jills start <jill> [--input k=v]... [--repo <p>] [--session <id>] [--json] [--wait]
  jills go --session <id> [--input k=v]...     start the Jill last suggested in this chat
  jills wait <run> [--timeout 30m] [--json]    block until the run ends; print a one-line result
  jills status [run] [--json]
  jills try <jill> --dry-run [--input k=v]...  show what would run (without --dry-run: run in foreground)
  jills dismiss --session <id>                 quiet for the rest of this chat
  jills never [--session <id>] [--jill <name>] [--repo <p>]   mute (a Jill or all) for this repo
  jills quiet --session <id>                   quiet mode for this chat
  jills on --session <id> [--unmute]           resume suggestions (and clear repo mutes)
  jills auto on|off                            global auto/manual switch
  jills new <name>                             scaffold a JILL.md
  jills mcp                                    MCP server on stdio

Exit codes: 0 ok/done/suggestion, 1 error, 2 usage, 3 no suggestion,
            4 run failed, 5 run stuck (timeout), 6 run needs you (conflict), 7 wait timed out.
Env: JILLS_HOME (default ~/.jills).`;

interface Args {
  pos: string[];
  flags: Map<string, string[]>;
}

const BOOL_FLAGS = new Set(["json", "dry-run", "wait", "unmute", "help"]);

function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      let val: string;
      if (eq > 0) val = a.slice(eq + 1);
      else if (BOOL_FLAGS.has(name)) val = "true";
      else {
        const next = argv[i + 1];
        if (next === undefined) throw new UsageError(`--${name} needs a value`);
        val = next;
        i++;
      }
      flags.set(name, [...(flags.get(name) ?? []), val]);
    } else if (a === "-h") flags.set("help", ["true"]);
    else pos.push(a);
  }
  return { pos, flags };
}

class UsageError extends Error {}

const flag = (a: Args, n: string) => a.flags.get(n)?.at(-1);
const has = (a: Args, n: string) => a.flags.has(n);

function inputs(a: Args): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of a.flags.get("input") ?? []) {
    const eq = kv.indexOf("=");
    if (eq <= 0) throw new UsageError(`--input wants name=value, got "${kv}"`);
    out[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return out;
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new UsageError(`missing ${what}`);
  return v;
}

function stateExit(s: RunState): number {
  return s === "done" ? EXIT.ok : s === "stuck" ? EXIT.stuck : s === "needs-you" ? EXIT.needsYou : EXIT.failed;
}

async function readStdinTurns(): Promise<Turn[]> {
  if (process.stdin.isTTY) return [];
  const chunks: Buffer[] = [];
  const got = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(chunks.length > 0), 500);
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => {
      clearTimeout(t);
      resolve(true);
    });
    process.stdin.on("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
  process.stdin.destroy();
  if (!got) return [];
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    const list = Array.isArray(v) ? v : (v as { recent?: unknown }).recent;
    if (!Array.isArray(list)) return [];
    return list
      .filter((t): t is { role: string; text: string } => !!t && typeof t === "object" && typeof (t as { text?: unknown }).text === "string")
      .map((t) => ({ role: t.role === "assistant" ? "assistant" : "user", text: t.text }));
  } catch {
    return [];
  }
}

function printRecord(r: RunRecord): void {
  console.log(resultLine(r));
  for (const s of Object.values(r.steps)) {
    console.log(`  ${s.state.padEnd(9)} ${s.key}${s.reason ? ` — ${s.reason}` : ""}${s.log ? `  (${s.log})` : ""}`);
  }
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  const [cmd, ...rest] = a.pos;
  if (!cmd || has(a, "help") || cmd === "help") {
    console.log(USAGE);
    return cmd || has(a, "help") ? EXIT.ok : EXIT.usage;
  }
  const json = has(a, "json");
  switch (cmd) {
    case "list": {
      const js = await listJills();
      if (json) console.log(JSON.stringify(js, null, 2));
      else if (!js.length) console.log(`no Jills (jill_paths: ${loadConfig().jill_paths.join(", ")})`);
      else for (const j of js) console.log(`${j.name.padEnd(20)} ${j.description}`);
      return EXIT.ok;
    }
    case "check": {
      const r = await check();
      if (json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`${r.jills.length} Jill(s), ${r.agents} agent(s)`);
        for (const w of r.warnings) console.log(`warning: ${w}`);
        for (const e of r.errors) console.log(`error: ${e}`);
        if (!r.errors.length) console.log("ok");
      }
      return r.errors.length ? EXIT.error : EXIT.ok;
    }
    case "suggest": {
      const session = need(flag(a, "session"), "--session <id>");
      const message = rest.join(" ") || flag(a, "message");
      if (!message) throw new UsageError("missing message");
      const recent = await readStdinTurns();
      const s = await suggest({ session, message, recent, repo: flag(a, "repo") });
      if (json) console.log(JSON.stringify(s, null, 2));
      else if (s.action === "suggest") console.log(s.text);
      return s.action === "suggest" ? EXIT.ok : EXIT.noSuggestion;
    }
    case "go":
    case "start": {
      let jill: string;
      if (cmd === "go") {
        const session = need(flag(a, "session"), "--session <id>");
        const last = rest[0] ?? lastSuggestion(session);
        if (!last) throw new Error("nothing was suggested in this chat; use jills start <jill>");
        jill = last;
      } else jill = need(rest[0], "<jill>");
      const r = await start(jill, { inputs: inputs(a), cwd: flag(a, "repo"), session: flag(a, "session") });
      if (has(a, "wait")) {
        const w = await wait(r.id);
        if (json) console.log(JSON.stringify(w.record, null, 2));
        else console.log(w.line);
        return stateExit(w.record.state);
      }
      if (json) console.log(JSON.stringify({ run: r.id, jill: r.jill, state: r.state, record: r.logDir }, null, 2));
      else console.log(`started Jill ${r.jill} as run ${r.id}\nwatch it: jills wait ${r.id}`);
      return EXIT.ok;
    }
    case "wait": {
      const id = need(rest[0], "<run>");
      const t = flag(a, "timeout");
      const w = await wait(id, { timeoutMs: t ? parseDuration(t) : undefined });
      if (json) console.log(JSON.stringify({ ...w.record, line: w.line, timedOut: w.timedOut }, null, 2));
      else console.log(w.line);
      return w.timedOut ? EXIT.waitTimeout : stateExit(w.record.state);
    }
    case "status": {
      if (rest[0]) {
        const r = status(rest[0]);
        if (!r) {
          console.error(`no run ${rest[0]}`);
          return EXIT.error;
        }
        if (json) console.log(JSON.stringify(r, null, 2));
        else printRecord(r);
        return EXIT.ok;
      }
      const all = status();
      if (json) console.log(JSON.stringify(all, null, 2));
      else if (!all.length) console.log("no runs");
      else for (const r of all.slice(0, 20)) console.log(resultLine(r));
      return EXIT.ok;
    }
    case "try": {
      const jill = need(rest[0], "<jill>");
      if (has(a, "dry-run")) {
        for (const l of await dryRun(jill, { inputs: inputs(a), cwd: flag(a, "repo") })) console.log(l);
        return EXIT.ok;
      }
      const r = await runNow(jill, {
        inputs: inputs(a),
        cwd: flag(a, "repo"),
        onEvent: (e) => console.log(`[${e.at}] ${e.type}${e.step ? ` ${e.step}` : ""}${e.note ? ` — ${e.note}` : ""}`),
      });
      printRecord(r);
      return stateExit(r.state);
    }
    case "dismiss":
      dismiss(need(flag(a, "session"), "--session <id>"));
      console.log("ok: no more suggestions in this chat");
      return EXIT.ok;
    case "never":
      console.log(await never({ session: flag(a, "session"), jill: flag(a, "jill"), repo: flag(a, "repo") }));
      return EXIT.ok;
    case "quiet":
      quiet(need(flag(a, "session"), "--session <id>"));
      console.log("ok: quiet mode on for this chat");
      return EXIT.ok;
    case "on":
      await on(need(flag(a, "session"), "--session <id>"), { unmute: has(a, "unmute"), repo: flag(a, "repo") });
      console.log("ok: suggestions on for this chat");
      return EXIT.ok;
    case "auto": {
      const v = rest[0];
      if (v !== "on" && v !== "off") {
        console.log(`auto is ${loadConfig().auto ? "on" : "off"}`);
        return v === undefined ? EXIT.ok : EXIT.usage;
      }
      setAuto(v === "on");
      console.log(`auto ${v}`);
      return EXIT.ok;
    }
    case "new":
      console.log(newJill(need(rest[0], "<name>")));
      return EXIT.ok;
    case "mcp": {
      const { serveStdio } = await import("./mcp.js");
      await serveStdio();
      return -1; // keep running
    }
    case "__run": {
      const id = need(rest[0], "<run>");
      // The runner owns the step process groups: on a stop signal it aborts the
      // run, which kills every running group (SIGTERM, then SIGKILL), saves the
      // record as failed and only then exits. A runner that dies anyway is
      // swept by refreshRecord, which kills the recorded step groups.
      const ac = new AbortController();
      const onSignal = (sig: NodeJS.Signals) => {
        if (ac.signal.aborted) return;
        ac.abort(sig);
        // Last resort if the engine does not wind down.
        setTimeout(() => process.exit(EXIT.error), 15_000).unref();
      };
      const sigs: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
      for (const s of sigs) process.on(s, onSignal);
      try {
        const r = await executeRun(id, { signal: ac.signal });
        return stateExit(r.state);
      } finally {
        for (const s of sigs) process.off(s, onSignal);
      }
    }
    default:
      throw new UsageError(`unknown command "${cmd}"`);
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
const isMainReal = await (async () => {
  if (!process.argv[1]) return false;
  const { realpathSync } = await import("node:fs");
  const { pathToFileURL } = await import("node:url");
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain || isMainReal) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) process.exitCode = code;
    },
    (e: unknown) => {
      if (e instanceof UsageError) {
        console.error(`jills: ${e.message}\n\n${USAGE}`);
        process.exitCode = EXIT.usage;
      } else {
        console.error(`jills: ${(e as Error).message}`);
        process.exitCode = EXIT.error;
      }
    },
  );
}
