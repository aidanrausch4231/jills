/** Plain Node logic between dsh and the Jills library: one card per user message. No dsh imports. */
import { pathToFileURL } from 'node:url'
import type { CardAction, JillsCard, JillsRunState, RunLine, StartRequest, SuggestRequest } from './types.ts'

/** The part of a Jills run record the card reads. */
export interface CoreRunRecord {
  /** Run id. */
  id: string
  /** Jill name. */
  jill: string
  /** Run state. */
  state: JillsRunState
  /** Run branch. */
  branch?: string | undefined
  /** Step records by key. */
  steps: Record<string, { state: string }>
  /** Failure text. */
  error?: string | undefined
}

/** The part of a Jills suggestion the card reads. */
export interface CoreSuggestion {
  /** suggest or quiet. */
  action: 'suggest' | 'quiet'
  /** Why. */
  reason: string
  /** Suggested Jill. */
  jill?: string | undefined
  /** Its description. */
  description?: string | undefined
  /** Proposed inputs. */
  inputs?: Record<string, string> | undefined
  /** Matcher confidence. */
  confidence?: number | undefined
  /** Matcher name. */
  matcher?: string | undefined
  /** Global auto switch. */
  auto: boolean
  /** Whether the Jill runs in its own worktree. */
  worktree?: boolean | undefined
  /** Short warning to show on the card (e.g. worktree: false). */
  warning?: string | undefined
}

/** One chat turn Jev reads for context. */
export interface Turn {
  /** Who said it. */
  role: 'user' | 'assistant'
  /** Plain text. */
  text: string
}

/** The Jills library functions this add-on calls (src/index.ts of the core). */
export interface JillsCore {
  /** Ask Jev about one message (with up to the last 3 turns before it). */
  suggest(o: { session: string; message: string; recent?: Turn[]; cwd?: string; home?: string; jevKey?: BridgeOptions['jevKey'] }): Promise<CoreSuggestion>
  /** Start a detached run. */
  start(jill: string, o: { inputs?: Record<string, string>; cwd?: string; session?: string; home?: string }): Promise<CoreRunRecord>
  /** Read one run record. */
  status(id: string, o?: { home?: string }): CoreRunRecord | undefined
  /** Saved Jills. */
  listJills(o?: { home?: string }): Promise<{ name: string; inputs: string[] }[]>
  /** Apply a chat control; the bridge only sends dismiss (quiet this chat). */
  chat(session: string, change: { kind: 'dismiss' }, o?: { home?: string }): unknown
  /** Mute a Jill for a repo. */
  never(o: { session?: string; jill?: string; cwd?: string; home?: string }): Promise<string>
  /** Full one-line result. */
  resultLine(r: CoreRunRecord): string
}

/**
 * What the bridge needs from the dsh session runtime. `src/index.ts` wires the
 * real one (Session Controller); tests pass a fake. Both calls are best effort.
 */
export interface AgentPort {
  /** Up to the last 3 user/assistant turns before one user message. */
  recentTurns(sessionId: string, messageId: string): Promise<Turn[]>
  /** Give the session's main agent a model-facing notice (no new turn, no steering). */
  tell(sessionId: string, text: string, summary: string): Promise<void>
}

/** Bridge settings. */
export interface BridgeOptions {
  /** Jills home; empty uses $JILLS_HOME or ~/.jills (the core decides). */
  home?: string | undefined
  /** Messages older than this (ms) are never sent to Jev (history reloads). */
  maxAgeMs?: number | undefined
  /** Clock for tests. */
  now?: () => number
  /** Session runtime access (recent turns, telling the main agent). */
  agent?: AgentPort | undefined
  /** Jev's key from the harness's credentials (by jev.key_env's name); core falls back to the env var. Never logged or stored. */
  jevKey?: ((name: string) => Promise<string | undefined>) | undefined
}

/** Shown on a card whose Jill sets worktree: false. */
export const NO_WORKTREE = 'no worktree: edits your checkout directly'
/** Card note when the chat has no working folder. Jills never falls back to the dsh Host's own folder. */
export const NO_WORKSPACE = 'open a workspace folder first: this chat has no working folder, and Jills never runs in the dsh Host\'s own folder'

/** Number of turns before the new message that Jev reads. */
export const RECENT_TURNS = 3

/** Plain text of message content (string or text blocks). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')
    .filter(Boolean)
    .join('\n')
}

/**
 * The last `n` typed-user / assistant text turns before one user message, from
 * dsh Session events (`user/message` with source kind `user`, `assistant/message`).
 * Injected context, tool traffic and empty replies are skipped. When the message
 * is not in the events, the last `n` turns of the whole log are used.
 */
export function turnsBefore(events: readonly unknown[], messageId: string, n = RECENT_TURNS): Turn[] {
  const turns: Turn[] = []
  for (const raw of events) {
    const e = raw as { type?: unknown; data?: { id?: unknown; source?: { kind?: unknown }; content?: unknown; message?: { content?: unknown } } }
    if (!e || !e.data) continue
    if (e.type === 'user/message') {
      if (String(e.data.id) === messageId) break
      if (e.data.source?.kind !== 'user') continue
      const text = contentText(e.data.content).trim()
      if (text) turns.push({ role: 'user', text: text.slice(0, 2000) })
    } else if (e.type === 'assistant/message') {
      const text = contentText(e.data.message?.content).trim()
      if (text) turns.push({ role: 'assistant', text: text.slice(0, 2000) })
    }
  }
  return turns.slice(-n)
}

/** What the main agent is told when a Jill starts. */
export function startedNotice(r: Pick<CoreRunRecord, 'id' | 'jill'>): string {
  return `[Jills] Jill "${r.jill}" started as run ${r.id} in its own worktree (branch jills/${r.jill}-${r.id}). `
    + 'It runs on its own; the Jills card under the user\'s message follows it and reports the result (state, branch, logs) when it ends. '
    + 'Do not start it again and do not merge anything yourself.'
}

const TERMINAL: readonly JillsRunState[] = ['done', 'failed', 'stuck', 'needs-you']

/** Load the core from an explicit index.js path, $JILLS_LIB, or the repo's dist build. */
export function loadCore(lib = ''): () => Promise<JillsCore> {
  let loaded: Promise<JillsCore> | undefined
  return () => (loaded ??= import(lib || process.env.JILLS_LIB
    ? pathToFileURL(lib || process.env.JILLS_LIB!).href
    // lib/index.js -> addons/dsh -> addons -> repo root
    : new URL('../../../dist/src/index.js', import.meta.url).href) as Promise<JillsCore>)
}

/** Jev's key from dsh's own credentials service (`ctx.credentials`; ref = jev.key_env's name, e.g. TYPESAFE_API_KEY). Never logged. */
export function credentialsKey(get: () => { resolve(ref: string): Promise<{ value?: string } | undefined> } | undefined): BridgeOptions['jevKey'] {
  return async (name) => { const c = get(); return c && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? (await c.resolve(name))?.value : undefined }
}

/** Jills keeps per-chat state under this id. */
export function jillsSession(sessionId: string): string {
  return `dsh-${sessionId}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
}

/** Build the card's status line from a run record. */
export function runLine(core: Pick<JillsCore, 'resultLine'>, r: CoreRunRecord): RunLine {
  const steps = Object.values(r.steps)
  const stepsDone = steps.filter(s => ['done', 'failed', 'stuck', 'skipped'].includes(s.state)).length
  const terminal = TERMINAL.includes(r.state)
  const progress = steps.length ? ` · ${stepsDone}/${steps.length} steps` : ''
  const tail = r.state === 'done' && r.branch ? ` · branch ${r.branch}`
    : r.state === 'needs-you' ? ' · merge conflict, needs you'
      : (r.state === 'failed' || r.state === 'stuck') && r.error ? ` · ${r.error}` : ''
  return {
    runId: r.id, jill: r.jill, state: r.state, terminal, stepsDone, stepsTotal: steps.length,
    branch: r.branch ?? '', text: `Jill ${r.jill} · ${r.state}${terminal ? '' : progress}${tail}`, detail: core.resultLine(r),
  }
}

function emptyCard(messageId: string, kind: JillsCard['kind'], reason: string, note = ''): JillsCard {
  return { kind, messageId, reason, jill: '', description: '', inputs: {}, fields: [], auto: false, confidence: 0, matcher: '', warning: '', note, run: null }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One card per (session, message). Results are cached so a re-render or history
 * reload never asks Jev twice or advances the anti-nag counters twice.
 */
export class JillsBridge {
  private readonly cards = new Map<string, Promise<JillsCard>>()
  private readonly home: string | undefined
  private readonly maxAgeMs: number
  private readonly now: () => number
  private readonly agent: AgentPort | undefined
  private readonly jevKey: BridgeOptions['jevKey']

  constructor(private readonly core: () => Promise<JillsCore>, options: BridgeOptions = {}) {
    this.home = options.home || undefined
    this.maxAgeMs = options.maxAgeMs ?? 5 * 60_000
    this.now = options.now ?? Date.now
    this.agent = options.agent
    this.jevKey = options.jevKey
  }

  private async recent(sessionId: string, messageId: string): Promise<Turn[]> {
    if (!this.agent) return []
    try {
      return (await this.agent.recentTurns(sessionId, messageId)).slice(-RECENT_TURNS)
    } catch {
      return []
    }
  }

  private opts(): { home?: string } { return this.home ? { home: this.home } : {} }
  private key(sessionId: string, messageId: string): string { return `${sessionId}\u0000${messageId}` }

  /** Ask Jev about one user message (cached per message). */
  suggest(request: SuggestRequest): Promise<JillsCard> {
    const key = this.key(request.sessionId, request.messageId)
    if (!this.cards.has(key)) this.cards.set(key, this.ask(request))
    return this.cards.get(key)!
  }

  private async ask(request: SuggestRequest): Promise<JillsCard> {
    const { messageId } = request
    if (!request.text.trim()) return emptyCard(messageId, 'quiet', 'empty message')
    if (request.sentAt && this.now() - request.sentAt > this.maxAgeMs) return emptyCard(messageId, 'quiet', 'old message (history)')
    // No workspace folder: stay quiet before asking core, so the dsh Host's own
    // process.cwd() never reaches core.suggest (repo lookup, mutes, auto start).
    const cwd = (request.cwd ?? '').trim()
    if (!cwd) return emptyCard(messageId, 'quiet', 'no workspace folder', NO_WORKSPACE)
    try {
      const core = await this.core()
      const recent = await this.recent(request.sessionId, messageId)
      const s = await core.suggest({ session: jillsSession(request.sessionId), message: request.text, recent, cwd, ...this.opts(), ...(this.jevKey ? { jevKey: this.jevKey } : {}) })
      if (s.action !== 'suggest' || !s.jill) return { ...emptyCard(messageId, 'quiet', s.reason), matcher: s.matcher ?? '', confidence: s.confidence ?? 0 }
      const fields = (await core.listJills(this.opts())).find(j => j.name === s.jill)?.inputs ?? []
      const card: JillsCard = {
        kind: 'suggest', messageId, reason: s.reason, jill: s.jill, description: s.description ?? '', inputs: s.inputs ?? {}, fields,
        auto: s.auto, confidence: s.confidence ?? 0, matcher: s.matcher ?? '', warning: s.warning ?? (s.worktree === false ? NO_WORKTREE : ''), note: '', run: null,
      }
      return s.auto ? await this.launch(card, { sessionId: request.sessionId, messageId, jill: s.jill, inputs: card.inputs, cwd }) : card
    } catch (error) {
      return emptyCard(messageId, 'quiet', `jills unavailable: ${message(error)}`)
    }
  }

  private async launch(card: JillsCard, request: StartRequest): Promise<JillsCard> {
    // An empty cwd must never fall back to the dsh Host's process.cwd().
    const cwd = (request.cwd ?? '').trim()
    if (!cwd) return { ...card, kind: 'error', note: NO_WORKSPACE }
    let record: CoreRunRecord
    let core: JillsCore
    try {
      core = await this.core()
      record = await core.start(request.jill, { inputs: request.inputs, session: jillsSession(request.sessionId), cwd, ...this.opts() })
    } catch (error) {
      return { ...card, kind: 'error', note: message(error) }
    }
    let note = ''
    if (this.agent) {
      try {
        await this.agent.tell(request.sessionId, startedNotice(record), `Jill ${record.jill} started (run ${record.id})`)
        note = 'The agent was told.'
      } catch (error) {
        note = `The agent was not told: ${message(error)}`
      }
    }
    return { ...card, kind: 'started', inputs: request.inputs, note, run: runLine(core, record) }
  }

  private async update(sessionId: string, messageId: string, fn: (card: JillsCard) => Promise<JillsCard>): Promise<JillsCard> {
    const key = this.key(sessionId, messageId)
    const current = await (this.cards.get(key) ?? Promise.resolve(emptyCard(messageId, 'quiet', 'unknown card')))
    const next = fn(current)
    this.cards.set(key, next)
    return next
  }

  /** Start the Jill on a card (Start button, possibly after Edit). Starting twice returns the first run. */
  start(request: StartRequest): Promise<JillsCard> {
    return this.update(request.sessionId, request.messageId, async (card) => {
      if (card.kind === 'started') return card
      const base = card.kind === 'suggest' || card.kind === 'error' ? card : { ...emptyCard(request.messageId, 'suggest', 'started by hand'), jill: request.jill }
      return this.launch({ ...base, jill: request.jill }, request)
    })
  }

  /** Current status line of a run. */
  async status(runId: string): Promise<RunLine> {
    const core = await this.core()
    const record = core.status(runId, this.opts())
    if (!record) throw new Error(`no Jills run ${runId}`)
    return runLine(core, record)
  }

  /** "Not this": quiet for the rest of this chat. */
  dismiss(action: CardAction): Promise<JillsCard> {
    return this.update(action.sessionId, action.messageId, async (card) => {
      const core = await this.core()
      await core.chat(jillsSession(action.sessionId), { kind: 'dismiss' }, this.opts())
      return { ...card, kind: 'closed', note: 'Okay. Jev stays quiet in this chat.' }
    })
  }

  /** "Never": mute this Jill for the session's repo. */
  never(action: CardAction): Promise<JillsCard> {
    return this.update(action.sessionId, action.messageId, async (card) => {
      // The per-repo mute needs the chat's own folder, never the dsh Host's.
      const cwd = (action.cwd ?? '').trim()
      if (!cwd) return { ...card, kind: 'error', note: NO_WORKSPACE }
      try {
        const core = await this.core()
        const text = await core.never({ session: jillsSession(action.sessionId), ...(card.jill ? { jill: card.jill } : {}), cwd, ...this.opts() })
        return { ...card, kind: 'closed', note: `Jev will not suggest it here again (${text}).` }
      } catch (error) {
        return { ...card, kind: 'error', note: message(error) }
      }
    })
  }
}
