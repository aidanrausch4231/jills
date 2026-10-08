/** Wire types shared by the Jills dsh Host service and its browser card. No dsh or Jills imports. */

/** Run states as the Jills core records them. */
export type JillsRunState = 'queued' | 'running' | 'done' | 'failed' | 'stuck' | 'needs-you'

/** One user chat message the card asks about. */
export interface SuggestRequest {
  /** dsh Session id; Jills keeps its anti-nag state per id. */
  sessionId: string
  /** Durable id of the user message; one card per message. */
  messageId: string
  /** Plain text of the user message. */
  text: string
  /** Session working folder; the Jill runs in its git repo. Empty when unknown. */
  cwd: string
  /** Message time in epoch milliseconds; old messages are never sent to Jev. */
  sentAt: number
}

/** Start the suggested Jill (after an optional edit of its inputs). */
export interface StartRequest {
  /** dsh Session id. */
  sessionId: string
  /** Message whose card started the run. */
  messageId: string
  /** Jill name. */
  jill: string
  /** Input values, as edited on the card. */
  inputs: Record<string, string>
  /** Session working folder. Empty when unknown. */
  cwd: string
}

/** "Not this" or "Never" on one card. */
export interface CardAction {
  /** dsh Session id. */
  sessionId: string
  /** Message whose card the user answered. */
  messageId: string
  /** Session working folder (for the per-repo "never" mute). Empty when unknown. */
  cwd: string
}

/** Compact run status for the card's status line. */
export interface RunLine {
  /** Jills run id. */
  runId: string
  /** Jill name. */
  jill: string
  /** Current run state. */
  state: JillsRunState
  /** True once the run will not change any more. */
  terminal: boolean
  /** Finished steps (including copies). */
  stepsDone: number
  /** All known steps (including copies). */
  stepsTotal: number
  /** Run branch once the worktree exists; empty before. */
  branch: string
  /** One-line status for the card. */
  text: string
  /** Full `jills wait` result line (branch, worktree, logs). */
  detail: string
}

/** What the card shows for one user message. */
export interface JillsCard {
  /** quiet: nothing to show; suggest: buttons; started: status line; closed: short note; error: failure note. */
  kind: 'quiet' | 'suggest' | 'started' | 'closed' | 'error'
  /** Message the card belongs to. */
  messageId: string
  /** Why Jev chose this outcome (for logs and tests). */
  reason: string
  /** Suggested Jill name; empty when quiet. */
  jill: string
  /** Suggested Jill description. */
  description: string
  /** Proposed input values from Jev. */
  inputs: Record<string, string>
  /** Inputs the Jill declares, in order; the Edit form shows these. */
  fields: string[]
  /** Global auto switch: the card starts the Jill itself. */
  auto: boolean
  /** Confidence Jev reported (0..1); 0 when unknown. */
  confidence: number
  /** Matcher that answered (jev or keywords). */
  matcher: string
  /** Warning shown on the card, e.g. "no worktree: edits your checkout directly"; empty when none. */
  warning: string
  /** Short note for closed and error cards. */
  note: string
  /** Live run status once started. */
  run: RunLine | null
}
