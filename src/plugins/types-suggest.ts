import type { JillsConfig } from "../config.js";
import type { BackendPlugin, JillSummary, MatchInput, MatchLabel, MatchResult, Turn } from "./types.js";

// ---- suggest ----
/** What Jev tells the chat about one message. */
export interface Suggestion {
  action: "suggest" | "quiet";
  reason: string;
  jill?: string;
  description?: string;
  inputs?: Record<string, string>;
  confidence?: number;
  label?: MatchLabel;
  matcher?: string;
  /** Global auto switch: when true the main agent should start the Jill itself. */
  auto: boolean;
  /** `text` for the user, `agentContext` for the main agent. */
  text?: string;
  agentContext?: string;
  /** Whether the suggested Jill runs in its own worktree; a short warning (no worktree, merges into a branch). */
  worktree?: boolean;
  warning?: string;
}
/** `recent`: up to the last 3 turns before the message; `repo`: the chat's git root, when known. */
export type SuggestInput = { session: string; message: string; recent: Turn[]; repo?: string };
export interface SuggestCtx {
  jills: (JillSummary & { worktree: boolean; merges?: boolean })[];
  config: JillsConfig;
  /** Selected run storage, used to keep chats with active runs quiet. */
  backend: BackendPlugin;
  /** Asks the matcher plug-ins in order; core keeps only inputs the named Jill declares. */
  match(input: MatchInput): Promise<MatchResult | undefined>;
}
/** A chat control: dismiss / quiet / on (unmute: clear repo mutes) / never (mute) / started (a run began) / last (read only). */
export type ChatChange = { kind: "dismiss" | "quiet" | "last" } | { kind: "on"; unmute?: string } | { kind: "never"; repo: string; jill?: string } | { kind: "started"; run: string };
export type LastSuggestion = { jill: string; inputs: Record<string, string> };
/** The chat policy around matchers (anti-nag, mutes); the last one loaded wins. */
export interface SuggestPlugin {
  slot: "suggest";
  apiVersion: 1;
  name: string;
  suggest(input: SuggestInput, ctx: SuggestCtx): Promise<Suggestion>;
  /** Apply a chat control; returns the chat's last suggestion afterwards. `session` is absent for a repo-wide never. */
  chat(session: string | undefined, change: ChatChange, config: JillsConfig): LastSuggestion | undefined;
}
