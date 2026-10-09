#!/usr/bin/env node
// Jills add-on for Claude Code: UserPromptSubmit hook.
//
// Reads the hook input JSON on stdin ({session_id, prompt, cwd, transcript_path, ...}),
// asks Jev (the Jills core `suggest`) about the new message, and when Jev suggests
// a Jill prints the documented UserPromptSubmit JSON output:
//
//   { "systemMessage": "<shown to the user>",
//     "hookSpecificOutput": { "hookEventName": "UserPromptSubmit",
//                             "additionalContext": "<added to Claude's context>" } }
//
// Otherwise it prints nothing and exits 0, so the prompt goes through untouched.
// The hook never blocks a prompt: every error is swallowed (reason on stderr only
// when JILLS_HOOK_DEBUG=1).
//
// Env:
//   JILLS_HOME          Jills home (default ~/.jills), passed through to the core.
//   JILLS_LIB           path to the core library entry (default ../../dist/src/index.js).
//   JILLS_HOOK_TIMEOUT_MS  give up on Jev after this long. Never below the Jev
//                       request timeout (config jev.timeout_ms) + HOOK_MARGIN_MS,
//                       so the hook cannot quit before Jev's own request does.
//   JILLS_HOOK_DEBUG=1  write the quiet reason / errors to stderr.

import { closeSync, openSync, readSync, fstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEBUG = process.env.JILLS_HOOK_DEBUG === "1";
const TAIL_BYTES = 256 * 1024;

function debug(msg) {
  if (DEBUG) process.stderr.write(`jills hook: ${msg}\n`);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

/** Text of one transcript message content (string or content blocks); "" for tool traffic. */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Last `n` user/assistant text turns from a Claude Code transcript (JSONL).
 * Reads only the file's tail. Best effort: any problem gives [].
 */
export function recentTurns(transcriptPath, n = 3) {
  if (!transcriptPath) return [];
  let fd;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    let lines = buf.toString("utf8").split("\n");
    if (len < size) lines = lines.slice(1); // first line may be cut
    const turns = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!e || (e.type !== "user" && e.type !== "assistant") || e.isMeta || e.isSidechain) continue;
      const text = contentText(e.message?.content).trim();
      if (!text || text.startsWith("<command-") || text.startsWith("<local-command")) continue;
      turns.push({ role: e.type === "assistant" ? "assistant" : "user", text: text.slice(0, 4000) });
    }
    return turns.slice(-n);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Build the hook output for a core Suggestion, or undefined to stay silent. */
export function hookOutput(s, session, cwd) {
  if (!s || s.action !== "suggest" || !s.jill) return undefined;
  const hint = s.auto
    ? "Auto mode: Claude will start it. /jills quiet to pause, /jills dismiss for this chat."
    : "Type /jills go to start it, /jills dismiss to quiet this chat, /jills never to mute it here.";
  const extra = [
    // The id goes into a command only when it is plain (it comes from Claude Code, but never trust it into a shell).
    /^[A-Za-z0-9._-]{1,80}$/.test(session)
      ? `Chat session id for Jills: ${session} (pass it as \`session\` to start_jill or \`--session ${session}\` to the jills CLI).`
      : `Chat session id for Jills: ${JSON.stringify(session)} (pass it as \`session\` to start_jill).`,
  ];
  if (cwd) extra.push(`Repo for the run: ${cwd} (pass it as \`repo\` to start_jill or \`--repo\` to the jills CLI).`);
  return {
    systemMessage: `${s.text}\n${hint}`,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: `${s.agentContext}\n${extra.join("\n")}`,
    },
  };
}

async function loadLib() {
  const entry = process.env.JILLS_LIB ? resolve(process.env.JILLS_LIB) : resolve(HERE, "../../dist/src/index.js");
  return import(pathToFileURL(entry).href);
}

/** Extra time past the Jev request timeout for config, keywords fallback and session writes. */
export const HOOK_MARGIN_MS = 3000;

/**
 * How long the hook waits for the core before it gives up. It always exceeds the
 * Jev request timeout (config jev.timeout_ms, default 8000) by HOOK_MARGIN_MS, so a
 * slow Jev still ends in Jev's own timeout and the keywords fallback, not a silent
 * hook give-up. JILLS_HOOK_TIMEOUT_MS can only raise it.
 */
export function giveUpMs(jevTimeoutMs, envValue = process.env.JILLS_HOOK_TIMEOUT_MS) {
  const jev = Number(jevTimeoutMs) > 0 ? Number(jevTimeoutMs) : 8000;
  const floor = jev + HOOK_MARGIN_MS;
  const asked = Number(envValue);
  return asked > floor ? asked : floor;
}

/** The configured Jev request timeout: plug-in settings live under the raw config (`jev.timeout_ms`). */
export function jevTimeoutMs(lib) {
  try {
    return lib.loadConfig().raw?.jev?.timeout_ms;
  } catch (e) {
    debug(`config: ${e?.message ?? e}`);
    return undefined;
  }
}

function withTimeout(p, ms) {
  let t;
  const timer = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`Jev took longer than ${ms} ms`)), ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

export async function run(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    debug("hook input is not JSON");
    return undefined;
  }
  const session = typeof input?.session_id === "string" ? input.session_id : "";
  const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
  const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : undefined;
  if (!session || !prompt) return undefined;
  // Slash commands (including /jills itself), shell escapes and system events such as
  // <task-notification> are not tasks for Jev.
  if (/^[/!<]/.test(prompt)) return undefined;
  const lib = await loadLib();
  const recent = recentTurns(input.transcript_path);
  const ms = giveUpMs(jevTimeoutMs(lib));
  const s = await withTimeout(lib.suggest({ session, message: prompt, recent, cwd }), ms);
  if (s.action !== "suggest") debug(`quiet: ${s.reason}`);
  return hookOutput(s, session, cwd);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const out = await run(await readStdin());
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
  } catch (e) {
    debug(`error: ${e?.message ?? e}`);
  }
  // Never block the prompt, never leave a Jev request hanging.
  process.exit(0);
}
