/**
 * Jills add-on for Pi 1.0.4 (one extension file).
 *
 * - On each user message, asks Jev (core `suggest`) whether a saved Jill fits.
 *   Manual mode: shows the suggestion (widget + notice) and tells the agent to ask the user.
 *   Auto mode: starts the Jill at once and tells the agent it started.
 * - `/jills go|dismiss|never|quiet|on|status|list|auto` commands.
 * - After a start, watches the run record and posts the one-line result in the chat.
 *
 * All Jills logic lives in the core library; this file only wires Pi events to it.
 * Install: see addons/pi/README.md. The core is loaded from ../../dist/src/index.js
 * (relative to this file) unless JILLS_LIB names another index.js.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type * as JillsLib from "../../src/index.js";
import type { RunRecord, Suggestion, Turn } from "../../src/index.js";
import { pathToFileURL } from "node:url";

/** The part of the Jills library this add-on uses (tests pass a fake). */
export type JillsCore = Pick<
  typeof JillsLib,
  "suggest" | "start" | "go" | "status" | "listJills" | "chat" | "never" | "setAuto" | "resultLine" | "TERMINAL"
>;

export interface JillsPiOptions {
  /** Core library; loaded lazily from JILLS_LIB or ../../dist/src/index.js when omitted. */
  core?: JillsCore | (() => Promise<JillsCore>);
  /** Jills home; defaults to $JILLS_HOME or ~/.jills (core decides). */
  home?: string;
  /** How long before_agent_start waits for Jev before the agent goes on without it. */
  contextWaitMs?: number;
  /** Poll interval for watching a started run. */
  pollMs?: number;
}

const WIDGET = "jills";
const STATUS = "jills";
const MSG_TYPE = "jills";
const SUBCOMMANDS = ["go", "dismiss", "never", "quiet", "on", "status", "list", "auto", "help"];
const HELP =
  "/jills go [jill] [key=value ...] | dismiss | never [jill] | quiet | on [--unmute] | status [run] | list | auto on|off";

async function defaultCore(): Promise<JillsCore> {
  const override = process.env.JILLS_LIB;
  const url = override ? pathToFileURL(override).href : new URL("../../dist/src/index.js", import.meta.url).href;
  return (await import(url)) as JillsCore;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** The last 3 user/assistant turns on the current branch (before the new message). */
export function recentTurns(ctx: Pick<ExtensionContext, "sessionManager">): Turn[] {
  const turns: Turn[] = [];
  let entries: unknown[] = [];
  try {
    entries = ctx.sessionManager.getBranch() as unknown[];
  } catch {
    return turns;
  }
  for (const e of entries) {
    const entry = e as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry.type !== "message" || !entry.message) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = textOf(entry.message.content).trim();
    if (text) turns.push({ role, text: text.slice(0, 2000) });
  }
  return turns.slice(-3);
}

/** Parse `key=value` words into inputs; other words are returned as rest. */
export function parseArgs(args: string): { words: string[]; inputs: Record<string, string> } {
  const words: string[] = [];
  const inputs: Record<string, string> = {};
  const re = /(\S+?)=("([^"]*)"|'([^']*)'|\S*)|"([^"]*)"|(\S+)/g;
  for (const m of args.matchAll(re)) {
    if (m[1] !== undefined) inputs[m[1]] = m[3] ?? m[4] ?? m[2] ?? "";
    else words.push(m[5] ?? m[6] ?? "");
  }
  return { words, inputs };
}

export function sessionKey(ctx: Pick<ExtensionContext, "sessionManager">): string {
  try {
    return `pi-${ctx.sessionManager.getSessionId()}`;
  } catch {
    return `pi-${process.pid}`;
  }
}

interface Pending {
  done: Promise<string | undefined>;
}

/** Build the extension. The default export uses the real core. */
export function createJillsExtension(pi: ExtensionAPI, opts: JillsPiOptions = {}): void {
  let corePromise: Promise<JillsCore> | undefined;
  const getCore = (): Promise<JillsCore> => {
    if (!corePromise) {
      const c = opts.core;
      corePromise = typeof c === "function" ? c() : c ? Promise.resolve(c) : defaultCore();
      corePromise.catch(() => (corePromise = undefined));
    }
    return corePromise;
  };
  const home = opts.home;
  const contextWaitMs = opts.contextWaitMs ?? 4000;
  const pollMs = opts.pollMs ?? 2000;

  let pending: Pending | undefined;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let alive = true;
  let uiCtx: ExtensionContext | undefined;

  const ui = () => (uiCtx?.hasUI ? uiCtx.ui : undefined);
  const safe = (f: () => void) => {
    try {
      f();
    } catch {
      /* stale context after a session switch */
    }
  };
  const notify = (msg: string, type: "info" | "warning" | "error" = "info") => safe(() => ui()?.notify(msg, type));
  const setStatus = (text: string | undefined) => safe(() => ui()?.setStatus(STATUS, text));
  const setWidget = (lines: string[] | undefined) => safe(() => ui()?.setWidget(WIDGET, lines));

  /**
   * Add a Jills message to the chat without steering or interrupting the agent.
   * Pi 1.0.4 `sendMessage` with `triggerTurn: false`: while the agent streams, the
   * message is held and appended when the current turn ends (never `agent.steer`);
   * when idle it is appended at once. It never starts a turn; the agent reads it
   * on its next turn.
   */
  function addToChat(text: string, display: boolean, details: Record<string, unknown>): void {
    safe(() => pi.sendMessage({ customType: MSG_TYPE, content: text, display, details }, { triggerTurn: false }));
  }

  function post(text: string, details: Record<string, unknown>): void {
    addToChat(text, true, details);
  }

  function watch(core: JillsCore, rec: RunRecord): void {
    if (timers.has(rec.id)) return;
    const tick = () => {
      timers.delete(rec.id);
      if (!alive) return;
      let r: RunRecord | undefined;
      try {
        r = core.status(rec.id, { home });
      } catch (e) {
        notify(`Jills: cannot read run ${rec.id}: ${(e as Error).message}`, "warning");
      }
      if (r && core.TERMINAL.has(r.state)) {
        const line = core.resultLine(r);
        setStatus(timers.size ? `Jills: ${timers.size} running` : undefined);
        notify(line, r.state === "done" ? "info" : "warning");
        post(`[Jills] ${line}`, { runId: r.id, jill: r.jill, state: r.state, branch: r.branch, logDir: r.logDir });
        return;
      }
      const t = setTimeout(tick, pollMs);
      t.unref?.();
      timers.set(rec.id, t);
    };
    const t = setTimeout(tick, pollMs);
    t.unref?.();
    timers.set(rec.id, t);
    setStatus(`Jills: ${rec.jill} running (${rec.id})`);
  }

  async function startRun(ctx: ExtensionContext, jill: string, inputs: Record<string, string>): Promise<RunRecord> {
    const core = await getCore();
    const rec = await core.start(jill, { inputs, cwd: ctx.cwd, session: sessionKey(ctx), home });
    setWidget(undefined);
    watch(core, rec);
    return rec;
  }

  /** Ask Jev about one message; show the result; return text for the agent's context. */
  async function check(ctx: ExtensionContext, message: string): Promise<string | undefined> {
    const core = await getCore();
    const s: Suggestion = await core.suggest({ session: sessionKey(ctx), message, recent: recentTurns(ctx), cwd: ctx.cwd, home });
    if (s.action !== "suggest" || !s.jill) return undefined;
    if (s.auto) {
      try {
        const rec = await startRun(ctx, s.jill, s.inputs ?? {});
        notify(`Jills: started ${s.jill} (run ${rec.id})${s.warning ? ` (${s.warning})` : ""}; I will post the result here.`);
        const where = s.worktree === false ? `It runs on its own with ${s.warning ?? "no worktree: edits your checkout directly"}` : "It runs on its own in a separate worktree";
        return `[Jills] Auto mode: Jills already started Jill "${s.jill}" as run ${rec.id}. ${where}; Pi will post the one-line result (branch + logs) in this chat when it finishes. Tell the user you started it; do not start it again and do not merge anything.`;
      } catch (e) {
        notify(`Jills: could not start ${s.jill}: ${(e as Error).message}`, "error");
        return undefined;
      }
    }
    // worktree: false → always say so next to the suggestion.
    let shown = s.text ?? `Jev suggests Jill "${s.jill}"`;
    if (s.warning && !shown.includes(s.warning)) shown += ` (${s.warning})`;
    setWidget([shown, "/jills go to run it · /jills dismiss · /jills never · /jills quiet"]);
    notify(shown);
    return s.agentContext;
  }

  pi.on("session_start", (_event, ctx) => {
    alive = true;
    uiCtx = ctx;
  });

  pi.on("session_shutdown", () => {
    alive = false;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    pending = undefined;
  });

  pi.on("input", (event, ctx) => {
    uiCtx = ctx;
    if (event.source === "extension") return { action: "continue" };
    const text = event.text.trim();
    if (!text || text.startsWith("/") || text.startsWith("!")) return { action: "continue" };
    const done = check(ctx, text).catch((e: unknown) => {
      notify(`Jills: suggestion check failed: ${(e as Error).message}`, "warning");
      return undefined;
    });
    pending = { done };
    return { action: "continue" };
  });

  pi.on("before_agent_start", async () => {
    const p = pending;
    pending = undefined;
    if (!p) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((r) => {
      timer = setTimeout(() => r(undefined), contextWaitMs);
    });
    const agentContext = await Promise.race([p.done, timeout]);
    if (timer) clearTimeout(timer);
    if (!agentContext) return;
    return { message: { customType: MSG_TYPE, content: agentContext, display: false } };
  });

  pi.registerCommand("jills", {
    description: "Jills: go | dismiss | never | quiet | on | status | list | auto on|off",
    getArgumentCompletions: (prefix) => {
      const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      uiCtx = ctx;
      const { words, inputs } = parseArgs(args);
      const sub = words.shift() ?? "help";
      const session = sessionKey(ctx);
      try {
        const core = await getCore();
        switch (sub) {
          case "go": {
            const jill = words[0] ?? (await core.chat(session, { kind: "last" }, { home }))?.jill;
            if (!jill) {
              notify("Jills: nothing suggested in this chat yet; use /jills go <jill> [key=value ...]", "warning");
              return;
            }
            // Core go: the inputs Jev proposed (saved with the suggestion in the
            // session state, so they survive a reload) overridden by key=value words.
            const g = await core.go({ session, jill, inputs, cwd: ctx.cwd, home });
            const rec = g.record;
            setWidget(undefined);
            watch(core, rec);
            if (g.dropped.length) notify(`Jills: ignored input(s) ${jill} does not declare: ${g.dropped.join(", ")}`, "warning");
            notify(`Jills: started ${jill} (run ${rec.id}); I will post the result here.`);
            addToChat(
              `[Jills] The user started Jill "${jill}" as run ${rec.id}. It runs on its own; the result will be posted in this chat. Do not start it again.`,
              false,
              { runId: rec.id, jill },
            );
            return;
          }
          case "dismiss":
            await core.chat(session, { kind: "dismiss" }, { home });
            setWidget(undefined);
            notify("Jills: quiet for this chat (/jills on to resume).");
            return;
          case "never": {
            const msg = await core.never({ session, jill: words[0], cwd: ctx.cwd, home });
            setWidget(undefined);
            notify(`Jills: ${msg}`);
            return;
          }
          case "quiet":
            await core.chat(session, { kind: "quiet" }, { home });
            setWidget(undefined);
            notify("Jills: quiet mode on for this chat (/jills on to resume).");
            return;
          case "on":
            await core.chat(session, { kind: "on", unmute: words.includes("--unmute") || undefined }, { cwd: ctx.cwd, home });
            notify("Jills: suggestions on for this chat.");
            return;
          case "status": {
            if (words[0]) {
              const r = core.status(words[0], { home });
              notify(r ? core.resultLine(r) : `Jills: no run ${words[0]}`, r ? "info" : "warning");
            } else {
              const rs = core.status(undefined, { home }).slice(0, 5);
              notify(rs.length ? rs.map((r) => core.resultLine(r)).join("\n") : "Jills: no runs yet");
            }
            return;
          }
          case "list": {
            const js = await core.listJills({ home });
            notify(js.length ? js.map((j) => `${j.name}: ${j.description}`).join("\n") : "Jills: no saved Jills");
            return;
          }
          case "auto": {
            const v = words[0];
            if (v !== "on" && v !== "off") {
              notify("Jills: use /jills auto on|off", "warning");
              return;
            }
            core.setAuto(v === "on", { home });
            notify(`Jills: auto mode ${v}`);
            return;
          }
          default:
            notify(HELP);
        }
      } catch (e) {
        notify(`Jills: ${(e as Error).message}`, "error");
      }
    },
  });
}

export default function jills(pi: ExtensionAPI): void {
  createJillsExtension(pi);
}
