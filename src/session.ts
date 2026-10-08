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
  lastSuggestion?: { jill: string; at: number; resolved: boolean };
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
  const s = readJson<SessionState>(sessionFile(home, id));
  return s ?? { id, messages: 0, quiet: false, dismissed: false, waitingForNew: false, suggested: [], runs: [] };
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

// ---- per-repo mutes ("never") ----
type MuteFile = Record<string, string[]>;

function muteFile(home: string): string {
  return join(home, "muted.json");
}

/** Mute a Jill (or every Jill with "*") for a repo. */
export function muteRepo(home: string, repo: string, jill = "*"): void {
  const m = readJson<MuteFile>(muteFile(home)) ?? {};
  const list = new Set(m[repo] ?? []);
  list.add(jill);
  m[repo] = [...list].sort();
  writeJsonAtomic(muteFile(home), m);
}

export function unmuteRepo(home: string, repo: string): void {
  const m = readJson<MuteFile>(muteFile(home)) ?? {};
  delete m[repo];
  writeJsonAtomic(muteFile(home), m);
}

export function isMuted(home: string, repo: string | undefined, jill: string): boolean {
  if (!repo) return false;
  const list = (readJson<MuteFile>(muteFile(home)) ?? {})[repo] ?? [];
  return list.includes("*") || list.includes(jill);
}
