import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { NO_WORKTREE_NOTE } from "../jillfile.js";
import { refreshRecord, TERMINAL } from "../runs.js";
import { readJson, writeJsonAtomic } from "../util.js";
import type { MatchResult, SuggestPlugin, Suggestion } from "./types.js";

/**
 * The default chat policy around the matchers ("anti-nag"): at most one
 * suggestion per SUGGEST_EVERY messages, quiet / dismissed / running chats stay
 * quiet, an ignored suggestion waits for a new task, and per-repo "never" mutes.
 * State: $JILLS_HOME/sessions/<id>.json per chat, $JILLS_HOME/muted.json per repo.
 */
export interface SessionState {
  id: string;
  /** Messages seen by suggest() in this chat. */
  messages: number;
  /** /jills quiet: no suggestions in this chat until /jills on. */
  quiet: boolean;
  /** "Not this": quiet for the rest of this chat. */
  dismissed: boolean;
  /** A suggestion was ignored: wait until Jev sees a new task. */
  waitingForNew: boolean;
  lastSuggestion?: { jill: string; at: number; resolved: boolean; inputs?: Record<string, string>; task?: string };
  suggested: string[];
  runs: string[];
  updated?: string;
}

/** Rate limit: at most one suggestion per this many messages. */
export const SUGGEST_EVERY = 3;

function sessionFile(home: string, id: string): string {
  const safe = /^[A-Za-z0-9._-]{1,80}$/.test(id) ? id : createHash("sha256").update(id).digest("hex").slice(0, 32);
  return join(home, "sessions", `${safe}.json`);
}

export function loadSession(home: string, id: string): SessionState {
  return readJson<SessionState>(sessionFile(home, id)) ?? { id, messages: 0, quiet: false, dismissed: false, waitingForNew: false, suggested: [], runs: [] };
}

function saveSession(home: string, s: SessionState): void {
  s.updated = new Date().toISOString();
  writeJsonAtomic(sessionFile(home, s.id), s);
}

// Per-repo mutes: repo -> Jill names ("*" = all).
const mutes = (home: string) => readJson<Record<string, string[]>>(join(home, "muted.json")) ?? {};
function setMutes(home: string, repo: string, names: string[] | undefined): void {
  const m = mutes(home);
  if (names) m[repo] = [...new Set([...(m[repo] ?? []), ...names])].sort();
  else delete m[repo];
  writeJsonAtomic(join(home, "muted.json"), m);
}
const isMuted = (list: string[], jill: string) => list.includes("*") || list.includes(jill);

/** Jev named another Jill, or the same Jill for a new task (p(same) < 0.2) rather than a rewording. */
function isNewTarget(m: MatchResult, last: SessionState["lastSuggestion"]): boolean {
  if (!last || last.jill !== m.jill) return true;
  if (m.sameProb !== undefined) return m.sameProb < 0.2; // Jev's own judgment: a new task, not a rewording
  return Object.entries(m.inputs ?? {}).some(([k, v]) => String(v).trim() !== "" && (last.inputs ?? {})[k] !== v);
}

/** The main agent's instructions for a suggestion (manual: ask the user; auto: start it). */
function agentText(auto: boolean, what: string, startCmd: string | undefined): string {
  return auto
    ? `[Jills] Jev matched ${what}. Auto mode is on: start it with the start_jill MCP tool${startCmd ? ` (or \`${startCmd}\`)` : ""}, tell the user you started it, then run \`jills wait <run-id>\` in the background and report the one-line result (branch + logs). Nothing merges itself unless the Jill says it merges.`
    : `[Jills] Jev suggests ${what}. Manual mode: do NOT start it yourself. Ask the user whether to run it; they can type /jills go to start it, /jills dismiss to quiet this chat, or /jills never to mute it for this repo.`;
}

/** The chat repo's current branch, for "merges into <branch> when done". */
const branchOf = (repo?: string) => {
  try { return execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "your branch"; }
};

const shown = (v: string) => { const one = String(v).replace(/\s+/g, " ").replace(/`/g, "'").trim(); return one.length > 200 ? `${one.slice(0, 199)}…` : one; }; // an input as text, never a command
const settle = (s: SessionState) => void (s.lastSuggestion && (s.lastSuggestion.resolved = true));

const defaultSuggest: SuggestPlugin = {
  slot: "suggest",
  apiVersion: 1,
  name: "default",
  async suggest(o, c) {
    const { home, auto } = c.config;
    const t = (c.config.raw.jev as { threshold?: unknown } | undefined)?.threshold; // config `jev.threshold`
    const threshold = typeof t === "number" ? t : 0.5;
    const s = loadSession(home, o.session);
    s.messages += 1;
    const quiet = (reason: string, extra: Partial<Suggestion> = {}): Suggestion => {
      saveSession(home, s);
      return { action: "quiet", reason, auto, ...extra };
    };
    const last = s.lastSuggestion;
    // A suggestion nobody acted on before this message counts as ignored.
    if (last && !last.resolved && last.at < s.messages) last.resolved = s.waitingForNew = true;
    if (s.quiet) return quiet("quiet mode is on for this chat (/jills on to resume)");
    if (s.dismissed) return quiet("dismissed in this chat");
    s.runs = s.runs.filter((id) => {
      const r = refreshRecord(home, id, undefined, c.backend);
      return !!r && !TERMINAL.has(r.state);
    });
    if (s.runs.length) return quiet(`a Jill is running in this chat (${s.runs.join(", ")})`);
    if (last && s.messages - last.at < SUGGEST_EVERY) return quiet(`at most one suggestion per ${SUGGEST_EVERY} messages`);
    const muted = o.repo ? (mutes(home)[o.repo] ?? []) : [];
    const jills = c.jills.filter((j) => !isMuted(muted, j.name));
    if (!jills.length) return quiet("no Jills to suggest");
    const m = await c.match({ message: o.message, recent: o.recent, jills, already: [...new Set(s.suggested)], config: c.config, ...(last?.task ? { suggestedTask: { jill: last.jill, task: last.task.slice(0, 500) } } : {}) });
    if (!m) return quiet("no matcher answered");
    const base = { label: m.label, matcher: m.matcher, confidence: m.confidence };
    if (m.label !== "new" || !m.jill) return quiet(m.label === "same" ? "same task as before" : m.note?.startsWith("Jev unavailable") ? m.note : "just talk", base);
    if (s.waitingForNew) {
      // Ignored: the ignored Jill (or one already suggested) stays quiet for the same task; a new task or another Jill comes back.
      const ignored = new Set([...(last ? [last.jill] : []), ...s.suggested]);
      if (ignored.has(m.jill) && !isNewTarget(m, last)) return quiet("ignored; waiting for a new task", { ...base, jill: m.jill });
      s.waitingForNew = false;
    }
    if (m.confidence < threshold) return quiet(`not confident enough (${m.confidence} < ${threshold})`, { ...base, jill: m.jill });
    const j = c.jills.find((x) => x.name === m.jill);
    if (!j) return quiet(`matcher named unknown Jill ${m.jill}`, base);
    const inputs = m.inputs ?? {};
    s.lastSuggestion = { jill: j.name, at: s.messages, resolved: false, inputs, task: o.message.trim().slice(0, 500) };
    s.suggested.push(j.name);
    saveSession(home, s);
    const inputText = Object.keys(inputs).length ? ` with ${Object.entries(inputs).map(([k, v]) => `${k}=${shown(v)}`).join(", ")}` : "";
    const warning = [j.worktree ? "" : NO_WORKTREE_NOTE, j.merges ? `merges into ${branchOf(o.repo)} when done` : ""].filter(Boolean).join("; ") || undefined;
    const warnText = warning ? ` (${warning})` : "";
    const text = `Jev: this looks like a job for Jill "${j.name}"${inputText}: ${j.description}${warnText}`;
    const startCmd = /^[A-Za-z0-9._-]{1,80}$/.test(o.session) ? `jills go --session ${o.session}` : undefined; // never input values (chat text): go reuses the saved ones
    const agentContext = agentText(auto, `Jill "${j.name}"${inputText} (confidence ${m.confidence})${warnText}`, startCmd);
    return { action: "suggest", reason: "new task fits a saved Jill", jill: j.name, description: j.description, inputs, ...base, auto, text, agentContext, worktree: j.worktree, ...(warning ? { warning } : {}) };
  },
  chat(session, change, config) {
    const home = config.home;
    const s = session ? loadSession(home, session) : undefined;
    if (change.kind === "never") setMutes(home, change.repo, [change.jill ?? s?.lastSuggestion?.jill ?? "*"]);
    if (change.kind === "on" && change.unmute) setMutes(home, change.unmute, undefined);
    if (!s) return undefined;
    if (change.kind === "dismiss") s.dismissed = true;
    if (change.kind === "quiet") s.quiet = true;
    if (change.kind === "on") [s.quiet, s.dismissed, s.waitingForNew] = [false, false, false];
    if (change.kind === "started") [s.runs, s.waitingForNew] = [[...s.runs, change.run], false];
    if (change.kind === "dismiss" || change.kind === "never" || change.kind === "started") settle(s);
    if (change.kind !== "last") saveSession(home, s);
    return s.lastSuggestion ? { jill: s.lastSuggestion.jill, inputs: { ...s.lastSuggestion.inputs } } : undefined;
  },
};
export default defaultSuggest;
