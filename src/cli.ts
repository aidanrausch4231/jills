#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chat, check, dryRun, executeRun, go, listJills, never, newJill, runNow, setAuto, start, status, stop, suggest, wait } from "./api.js";
import { loadConfig } from "./config.js";
import type { Turn } from "./plugins/types.js";
import { resultLine, type RunEvent, type RunRecord, type RunState } from "./runs.js";
import { parseDuration } from "./util.js";

export const EXIT = { ok: 0, error: 1, usage: 2, noSuggestion: 3, failed: 4, stuck: 5, needsYou: 6, waitTimeout: 7 } as const;

class UsageError extends Error {}

const flag = { type: "boolean" } as const;
const str = { type: "string" } as const;
const OPTIONS = { json: flag, "dry-run": flag, wait: flag, unmute: flag, help: { ...flag, short: "h" }, input: { ...str, multiple: true }, session: str, repo: str, jill: str, timeout: str, message: str } as const;
const parse = (args: string[]) => parseArgs({ args, options: OPTIONS, allowPositionals: true });
type Flags = ReturnType<typeof parse>["values"];

function need(v: string | undefined, what: string): string {
  if (!v) throw new UsageError(`missing ${what}`);
  return v;
}

const stateExit = (s: RunState) => (s === "done" ? EXIT.ok : s === "stuck" ? EXIT.stuck : s === "needs-you" ? EXIT.needsYou : EXIT.failed);

/** Recent turns for `suggest`: a JSON array of {role, text} on stdin (optional). */
async function readStdinTurns(): Promise<Turn[]> {
  if (process.stdin.isTTY) return [];
  const chunks: Buffer[] = [];
  const read = (async () => {
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return true;
  })().catch(() => false);
  // Wait at most 500 ms; the unref'd timer never holds the process open.
  const got = await Promise.race([read, delay(500, undefined, { ref: false }).then(() => chunks.length > 0)]);
  process.stdin.destroy();
  try {
    const v: unknown = got ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : [];
    return (Array.isArray(v) ? v : []).filter((t) => typeof t?.text === "string").map((t) => ({ role: t.role === "assistant" ? "assistant" : "user", text: t.text }));
  } catch {
    return [];
  }
}

function printRecord(r: RunRecord): void {
  console.log(resultLine(r));
  for (const s of Object.values(r.steps)) console.log(`  ${s.state.padEnd(9)} ${s.key}${s.reason ? ` — ${s.reason}` : ""}${s.log ? `  (${s.log})` : ""}`);
}

const inputs = (f: Flags) =>
  Object.fromEntries((f.input ?? []).map((kv) => {
    const [k, ...v] = kv.split("=");
    if (!k || !v.length) throw new UsageError(`--input wants name=value, got "${kv}"`);
    return [k, v.join("=")];
  }));
const session = (f: Flags) => need(f.session, "--session <id>");

/** Start a run (start/go); with --wait block until it ends. */
async function started(r: RunRecord, f: Flags, out: Out): Promise<number> {
  if (f.wait) {
    const w = await wait(r.id);
    out(w.record, () => w.line);
    return stateExit(w.record.state);
  }
  out({ run: r.id, jill: r.jill, state: r.state, record: r.logDir }, () => `started Jill ${r.jill} as run ${r.id}\nwatch it: jills wait ${r.id}`);
  return EXIT.ok;
}

type Out = (v: unknown, text: () => string) => void;
type Command = [usage: string, run: (rest: string[], f: Flags, out: Out) => Promise<number>];
const print = (text: string) => (console.log(text), EXIT.ok);
/** dismiss / quiet / on: one chat control, then a short confirmation. */
const chatCommand = (kind: "dismiss" | "quiet" | "on", done: string): Command[1] => async (_r, f) =>
  (await chat(session(f), kind === "on" ? { kind, unmute: f.unmute ? (f.repo ?? true) : undefined } : { kind }), print(done));

/** Every command: its usage line(s) for --help, and its handler (returns the exit code). */
const COMMANDS: Record<string, Command> = {
  list: ["list                                   list saved Jills", async (_r, _f, out) => {
    const js = await listJills();
    out(js, () => (js.length ? js.map((j) => `${j.name.padEnd(20)} ${j.description}`).join("\n") : `no Jills (jill_paths: ${loadConfig().jill_paths.join(", ")})`));
    return EXIT.ok;
  }],
  check: ["check                                  validate config, Jills, steps (warns on duplicates)", async (_r, _f, out) => {
    const r = await check();
    out(r, () => [`${r.jills.length} Jill(s)`, ...r.warnings.map((w) => `warning: ${w}`), ...r.errors.map((e) => `error: ${e}`), ...(r.errors.length ? [] : ["ok"])].join("\n"));
    return r.errors.length ? EXIT.error : EXIT.ok;
  }],
  suggest: [`suggest --session <id> [--repo <p>] [--json] "<message>"
                                               ask Jev about one chat message (recent turns: JSON array on stdin)`, async (rest, f, out) => {
    const s = await suggest({ session: session(f), message: need(rest.join(" ") || f.message, "message"), recent: await readStdinTurns(), repo: f.repo });
    if (f.json || s.action === "suggest") out(s, () => s.text ?? "");
    return s.action === "suggest" ? EXIT.ok : EXIT.noSuggestion;
  }],
  start: ["start <jill> [--input k=v]... [--repo <p>] [--session <id>] [--json] [--wait]", async (rest, f, out) =>
    started(await start(need(rest[0], "<jill>"), { inputs: inputs(f), cwd: f.repo, session: f.session }), f, out)],
  go: [`go --session <id> [<jill>] [--input k=v]... [--repo <p>] [--json] [--wait]
                                               start the Jill last suggested in this chat with the
                                               inputs Jev proposed (--input overrides; undeclared keys dropped)`, async (rest, f, out) => {
    const g = await go({ session: session(f), jill: rest[0], inputs: inputs(f), cwd: f.repo });
    if (g.dropped.length) console.error(`jills: ignored input(s) the Jill does not declare: ${g.dropped.join(", ")}`);
    return started(g.record, f, out);
  }],
  wait: ["wait <run> [--timeout 30m] [--json]    block until the run ends; print a one-line result", async (rest, f, out) => {
    const w = await wait(need(rest[0], "<run>"), { timeoutMs: f.timeout ? parseDuration(f.timeout) : undefined });
    out({ ...w.record, line: w.line, timedOut: w.timedOut }, () => w.line);
    return w.timedOut ? EXIT.waitTimeout : stateExit(w.record.state);
  }],
  status: ["status [run] [--json]                  never signals anything; a hung or dead runner shows as stuck", async (rest, f, out) => {
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
  }],
  stop: ["stop <run>                             stop every process of the run (env JILLS_RUN_ID=<run>), nothing else", async (rest, _f, out) => {
    const s = await stop(need(rest[0], "<run>"));
    out(s, () => `stopped ${s.pids.length} process(es)\n${resultLine(s.record)}`);
    return EXIT.ok;
  }],
  try: ["try <jill> --dry-run [--input k=v]...  show what would run (without --dry-run: run in foreground)", async (rest, f) => {
    const jill = need(rest[0], "<jill>");
    if (f["dry-run"]) return print((await dryRun(jill, { inputs: inputs(f), cwd: f.repo })).join("\n"));
    const onEvent = (e: RunEvent) => console.log(`[${e.at}] ${e.type}${e.step ? ` ${e.step}` : ""}${e.note ? ` — ${e.note}` : ""}`);
    const r = await runNow(jill, { inputs: inputs(f), cwd: f.repo, onEvent });
    printRecord(r);
    return stateExit(r.state);
  }],
  dismiss: ["dismiss --session <id>                 quiet for the rest of this chat", chatCommand("dismiss", "ok: no more suggestions in this chat")],
  never: ["never [--session <id>] [--jill <name>] [--repo <p>]   mute (a Jill or all) for this repo", async (_r, f) => print(await never({ session: f.session, jill: f.jill, repo: f.repo }))],
  quiet: ["quiet --session <id>                   quiet mode for this chat", chatCommand("quiet", "ok: quiet mode on for this chat")],
  on: ["on --session <id> [--unmute]           resume suggestions (and clear repo mutes)", chatCommand("on", "ok: suggestions on for this chat")],
  auto: ["auto on|off                            global auto/manual switch", async ([v]) => {
    if (v === "on" || v === "off") setAuto(v === "on");
    console.log(v === "on" || v === "off" ? `auto ${v}` : `auto is ${loadConfig().auto ? "on" : "off"}`);
    return v === undefined || v === "on" || v === "off" ? EXIT.ok : EXIT.usage;
  }],
  new: ["new <name>                             scaffold a JILL.md", async (rest) => print(newJill(need(rest[0], "<name>")))],
  mcp: ["mcp                                    MCP server on stdio", async () => (await (await import("../addons/mcp/mcp.js")).serveStdio(), -1)], // -1: keep running
};

const USAGE = `jills — saved agent workflows that Jev suggests from chat

Usage:
${Object.values(COMMANDS).map(([u]) => `  jills ${u}`).join("\n")}

Exit codes: 0 ok/done/suggestion, 1 error, 2 usage, 3 no suggestion,
            4 run failed, 5 run stuck (timeout), 6 run needs you (conflict), 7 wait timed out.
Env: JILLS_HOME (default ~/.jills).`;

/**
 * `__run <id>` is the detached runner. It owns its step process groups: on a
 * stop signal it aborts the run, which stops every running group (SIGTERM, then
 * SIGKILL), saves the record as failed and only then exits.
 */
async function runner(id: string): Promise<number> {
  const ac = new AbortController();
  const onSignal = (sig: NodeJS.Signals) => {
    if (ac.signal.aborted) return;
    ac.abort(sig);
    setTimeout(() => process.exit(EXIT.error), 15_000).unref(); // last resort
  };
  const sigs = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  for (const s of sigs) process.on(s, onSignal);
  try {
    return stateExit((await executeRun(id, { signal: ac.signal })).state);
  } finally {
    for (const s of sigs) process.off(s, onSignal);
  }
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parse(argv);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const f = parsed.values;
  const [cmd, ...rest] = parsed.positionals;
  if (!cmd || f.help || cmd === "help") {
    console.log(USAGE);
    return cmd || f.help ? EXIT.ok : EXIT.usage;
  }
  if (cmd === "__run") return runner(need(rest[0], "<run>"));
  const c = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (!c) throw new UsageError(`unknown command "${cmd}"`);
  return c[1](rest, f, (v, text) => console.log(f.json ? JSON.stringify(v, null, 2) : text()));
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return false; // not started as a script
  }
})();

if (isMain)
  main(process.argv.slice(2))
    .then((code) => void (code >= 0 && (process.exitCode = code)))
    .catch((e: Error) => {
      const usage = e instanceof UsageError;
      console.error(`jills: ${e.message}${usage ? `\n\n${USAGE}` : ""}`);
      process.exitCode = usage ? EXIT.usage : EXIT.error;
    });
