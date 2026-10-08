#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chat, check, dryRun, executeRun, go, listJills, never, newJill, on, runNow, setAuto, start, status, stop, suggest, wait } from "./api.js";
import { loadConfig } from "./config.js";
import type { Turn } from "./plugins/types.js";
import { resultLine, type RunRecord, type RunState } from "./runs.js";
import { parseDuration } from "./util.js";

export const EXIT = { ok: 0, error: 1, usage: 2, noSuggestion: 3, failed: 4, stuck: 5, needsYou: 6, waitTimeout: 7 } as const;

const USAGE = `jills — saved agent workflows that Jev suggests from chat

Usage:
  jills list                                   list saved Jills
  jills check                                  validate config, Jills, steps (warns on duplicates)
  jills suggest --session <id> [--repo <p>] [--json] "<message>"
                                               ask Jev about one chat message (recent turns: JSON on stdin)
  jills start <jill> [--input k=v]... [--repo <p>] [--session <id>] [--json] [--wait]
  jills go --session <id> [<jill>] [--input k=v]... [--repo <p>] [--json] [--wait]
                                               start the Jill last suggested in this chat with the
                                               inputs Jev proposed (--input overrides; undeclared keys dropped)
  jills wait <run> [--timeout 30m] [--json]    block until the run ends; print a one-line result
  jills status [run] [--json]                  never signals anything; a hung or dead runner shows as stuck
  jills stop <run>                             stop every process of the run (env JILLS_RUN_ID=<run>), nothing else
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

class UsageError extends Error {}

const OPTIONS = {
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  wait: { type: "boolean" },
  unmute: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  input: { type: "string", multiple: true },
  session: { type: "string" },
  repo: { type: "string" },
  jill: { type: "string" },
  timeout: { type: "string" },
  message: { type: "string" },
} as const;

function need(v: string | undefined, what: string): string {
  if (!v) throw new UsageError(`missing ${what}`);
  return v;
}

const stateExit = (s: RunState) => (s === "done" ? EXIT.ok : s === "stuck" ? EXIT.stuck : s === "needs-you" ? EXIT.needsYou : EXIT.failed);

async function readStdinTurns(): Promise<Turn[]> {
  if (process.stdin.isTTY) return [];
  const chunks: Buffer[] = [];
  const got = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(chunks.length > 0), 500);
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(true));
    process.stdin.on("error", () => resolve(false));
    process.stdin.on("close", () => clearTimeout(t));
  });
  process.stdin.destroy();
  try {
    const v = got ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown) : [];
    const list = Array.isArray(v) ? v : (v as { recent?: unknown }).recent;
    return (Array.isArray(list) ? list : [])
      .filter((t): t is { role: string; text: string } => typeof t?.text === "string")
      .map((t) => ({ role: t.role === "assistant" ? "assistant" : "user", text: t.text }));
  } catch {
    return [];
  }
}

function printRecord(r: RunRecord): void {
  console.log(resultLine(r));
  for (const s of Object.values(r.steps)) console.log(`  ${s.state.padEnd(9)} ${s.key}${s.reason ? ` — ${s.reason}` : ""}${s.log ? `  (${s.log})` : ""}`);
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const f = parsed.values;
  const [cmd, ...rest] = parsed.positionals;
  if (!cmd || f.help || cmd === "help") {
    console.log(USAGE);
    return cmd || f.help ? EXIT.ok : EXIT.usage;
  }
  const out = (v: unknown, text: () => string) => console.log(f.json ? JSON.stringify(v, null, 2) : text());
  const inputs = () =>
    Object.fromEntries(
      (f.input ?? []).map((kv) => {
        const eq = kv.indexOf("=");
        if (eq <= 0) throw new UsageError(`--input wants name=value, got "${kv}"`);
        return [kv.slice(0, eq), kv.slice(eq + 1)];
      }),
    );
  const session = () => need(f.session, "--session <id>");
  switch (cmd) {
    case "list": {
      const js = await listJills();
      out(js, () => (js.length ? js.map((j) => `${j.name.padEnd(20)} ${j.description}`).join("\n") : `no Jills (jill_paths: ${loadConfig().jill_paths.join(", ")})`));
      return EXIT.ok;
    }
    case "check": {
      const r = await check();
      out(r, () => [`${r.jills.length} Jill(s)`, ...r.warnings.map((w) => `warning: ${w}`), ...r.errors.map((e) => `error: ${e}`), ...(r.errors.length ? [] : ["ok"])].join("\n"));
      return r.errors.length ? EXIT.error : EXIT.ok;
    }
    case "suggest": {
      const message = rest.join(" ") || f.message;
      const s = await suggest({ session: session(), message: need(message, "message"), recent: await readStdinTurns(), repo: f.repo });
      if (f.json || s.action === "suggest") out(s, () => s.text ?? "");
      return s.action === "suggest" ? EXIT.ok : EXIT.noSuggestion;
    }
    case "go":
    case "start": {
      let r: RunRecord;
      if (cmd === "go") {
        const g = await go({ session: session(), jill: rest[0], inputs: inputs(), cwd: f.repo });
        if (g.dropped.length) console.error(`jills: ignored input(s) the Jill does not declare: ${g.dropped.join(", ")}`);
        r = g.record;
      } else r = await start(need(rest[0], "<jill>"), { inputs: inputs(), cwd: f.repo, session: f.session });
      if (f.wait) {
        const w = await wait(r.id);
        out(w.record, () => w.line);
        return stateExit(w.record.state);
      }
      out({ run: r.id, jill: r.jill, state: r.state, record: r.logDir }, () => `started Jill ${r.jill} as run ${r.id}\nwatch it: jills wait ${r.id}`);
      return EXIT.ok;
    }
    case "wait": {
      const w = await wait(need(rest[0], "<run>"), { timeoutMs: f.timeout ? parseDuration(f.timeout) : undefined });
      out({ ...w.record, line: w.line, timedOut: w.timedOut }, () => w.line);
      return w.timedOut ? EXIT.waitTimeout : stateExit(w.record.state);
    }
    case "status": {
      if (!rest[0]) {
        const all = status();
        out(all, () => (all.length ? all.slice(0, 20).map(resultLine).join("\n") : "no runs"));
        return EXIT.ok;
      }
      const r = status(rest[0]);
      if (!r) console.error(`no run ${rest[0]}`);
      else if (f.json) out(r, () => "");
      else printRecord(r);
      return r ? EXIT.ok : EXIT.error;
    }
    case "stop": {
      const s = await stop(need(rest[0], "<run>"));
      out(s, () => `stopped ${s.pids.length} process(es)\n${resultLine(s.record)}`);
      return EXIT.ok;
    }
    case "try": {
      const jill = need(rest[0], "<jill>");
      if (f["dry-run"]) {
        for (const l of await dryRun(jill, { inputs: inputs(), cwd: f.repo })) console.log(l);
        return EXIT.ok;
      }
      const onEvent = (e: { at: string; type: string; step?: string; note?: string }) => console.log(`[${e.at}] ${e.type}${e.step ? ` ${e.step}` : ""}${e.note ? ` — ${e.note}` : ""}`);
      const r = await runNow(jill, { inputs: inputs(), cwd: f.repo, onEvent });
      printRecord(r);
      return stateExit(r.state);
    }
    case "dismiss":
    case "quiet":
      chat(session(), cmd as "dismiss" | "quiet");
      console.log(cmd === "quiet" ? "ok: quiet mode on for this chat" : "ok: no more suggestions in this chat");
      return EXIT.ok;
    case "on":
      await on(session(), { unmute: f.unmute, repo: f.repo });
      console.log("ok: suggestions on for this chat");
      return EXIT.ok;
    case "never":
      console.log(await never({ session: f.session, jill: f.jill, repo: f.repo }));
      return EXIT.ok;
    case "auto": {
      const v = rest[0];
      if (v === "on" || v === "off") setAuto(v === "on");
      console.log(v === "on" || v === "off" ? `auto ${v}` : `auto is ${loadConfig().auto ? "on" : "off"}`);
      return v === undefined || v === "on" || v === "off" ? EXIT.ok : EXIT.usage;
    }
    case "new":
      console.log(newJill(need(rest[0], "<name>")));
      return EXIT.ok;
    case "mcp":
      await (await import("./mcp.js")).serveStdio();
      return -1; // keep running
    case "__run": {
      // The runner owns its step process groups: on a stop signal it aborts the
      // run, which stops every running group (SIGTERM, then SIGKILL), saves the
      // record as failed and only then exits.
      const ac = new AbortController();
      const onSignal = (sig: NodeJS.Signals) => {
        if (ac.signal.aborted) return;
        ac.abort(sig);
        setTimeout(() => process.exit(EXIT.error), 15_000).unref(); // last resort
      };
      const sigs = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
      for (const s of sigs) process.on(s, onSignal);
      try {
        return stateExit((await executeRun(need(rest[0], "<run>"), { signal: ac.signal })).state);
      } finally {
        for (const s of sigs) process.off(s, onSignal);
      }
    }
    default:
      throw new UsageError(`unknown command "${cmd}"`);
  }
}

const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain)
  main(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) process.exitCode = code;
    },
    (e: unknown) => {
      const usage = e instanceof UsageError;
      console.error(`jills: ${(e as Error).message}${usage ? `\n\n${USAGE}` : ""}`);
      process.exitCode = usage ? EXIT.usage : EXIT.error;
    },
  );
