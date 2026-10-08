import { createHash } from "node:crypto";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./util.js";

/** Per-chat anti-nag state, in $JILLS_HOME/sessions/<id>.json. */
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
  lastSuggestion?: { jill: string; at: number; resolved: boolean; inputs?: Record<string, string> };
  suggested: string[];
  runs: string[];
  updated?: string;
}

/** Rate limit: at most one suggestion per this many messages. */
export const SUGGEST_EVERY = 3;

export function sessionFile(home: string, id: string): string {
  const safe = /^[A-Za-z0-9._-]{1,80}$/.test(id) ? id : createHash("sha256").update(id).digest("hex").slice(0, 32);
  return join(home, "sessions", `${safe}.json`);
}

export function loadSession(home: string, id: string): SessionState {
  return readJson<SessionState>(sessionFile(home, id)) ?? { id, messages: 0, quiet: false, dismissed: false, waitingForNew: false, suggested: [], runs: [] };
}

export function saveSession(home: string, s: SessionState): void {
  s.updated = new Date().toISOString();
  writeJsonAtomic(sessionFile(home, s.id), s);
}

export function updateSession(home: string, id: string, fn: (s: SessionState) => void): SessionState {
  const s = loadSession(home, id);
  fn(s);
  saveSession(home, s);
  return s;
}

// ---- per-repo mutes ("never"), in $JILLS_HOME/muted.json: repo -> Jill names ("*" = all) ----
const mutes = (home: string) => readJson<Record<string, string[]>>(join(home, "muted.json")) ?? {};
const saveMutes = (home: string, m: Record<string, string[]>) => writeJsonAtomic(join(home, "muted.json"), m);

export function muteRepo(home: string, repo: string, jill = "*"): void {
  const m = mutes(home);
  m[repo] = [...new Set([...(m[repo] ?? []), jill])].sort();
  saveMutes(home, m);
}

export function unmuteRepo(home: string, repo: string): void {
  const m = mutes(home);
  delete m[repo];
  saveMutes(home, m);
}

export function isMuted(home: string, repo: string | undefined, jill: string): boolean {
  const list = repo ? (mutes(home)[repo] ?? []) : [];
  return list.includes("*") || list.includes(jill);
}
