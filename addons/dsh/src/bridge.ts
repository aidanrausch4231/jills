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
}

/** The Jills library functions this add-on calls (src/index.ts of the core). */
export interface JillsCore {
  /** Ask Jev about one message. */
  suggest(o: { session: string; message: string; cwd?: string; home?: string }): Promise<CoreSuggestion>
  /** Start a detached run. */
  start(jill: string, o: { inputs?: Record<string, string>; cwd?: string; session?: string; home?: string }): Promise<CoreRunRecord>
  /** Read one run record. */
  status(id: string, o?: { home?: string }): CoreRunRecord | undefined
  /** Saved Jills. */
  listJills(o?: { home?: string }): Promise<{ name: string; inputs: string[] }[]>
  /** Quiet this chat. */
  dismiss(session: string, o?: { home?: string }): unknown
  /** Mute a Jill for a repo. */
  never(o: { session?: string; jill?: string; cwd?: string; home?: string }): Promise<string>
  /** Full one-line result. */
  resultLine(r: CoreRunRecord): string
}

/** Bridge settings. */
export interface BridgeOptions {
  /** Jills home; empty uses $JILLS_HOME or ~/.jills (the core decides). */
  home?: string | undefined
  /** Messages older than this (ms) are never sent to Jev (history reloads). */
  maxAgeMs?: number | undefined
  /** Clock for tests. */
  now?: () => number
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

/** Jills keeps per-chat state under this id. */
export function jillsSession(sessionId: string): string {
  return `dsh-${sessionId}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
}

/** Build the card's status line from a run record. */
export function runLine(core: Pick<JillsCore, 'resultLine'>, r: CoreRunRecord): RunLine {
  const steps = Object.values(r.steps)
  const stepsDone = steps.filter(s => s.state === 'done' || s.state === 'failed' || s.state === 'stuck' || s.state === 'skipped').length
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
  return { kind, messageId, reason, jill: '', description: '', inputs: {}, fields: [], auto: false, confidence: 0, matcher: '', note, run: null }
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

  constructor(private readonly core: () => Promise<JillsCore>, options: BridgeOptions = {}) {
    this.home = options.home || undefined
    this.maxAgeMs = options.maxAgeMs ?? 5 * 60_000
    this.now = options.now ?? Date.now
  }

  private opts(): { home?: string } {
    return this.home ? { home: this.home } : {}
  }

  private key(sessionId: string, messageId: string): string {
    return `${sessionId}\u0000${messageId}`
  }

  /** Ask Jev about one user message (cached per message). */
  suggest(request: SuggestRequest): Promise<JillsCard> {
    const key = this.key(request.sessionId, request.messageId)
    let card = this.cards.get(key)
    if (!card) {
      card = this.ask(request)
      this.cards.set(key, card)
    }
    return card
  }

  private async ask(request: SuggestRequest): Promise<JillsCard> {
    const { messageId } = request
    if (!request.text.trim()) return emptyCard(messageId, 'quiet', 'empty message')
    if (request.sentAt && this.now() - request.sentAt > this.maxAgeMs) return emptyCard(messageId, 'quiet', 'old message (history)')
    try {
      const core = await this.core()
      const s = await core.suggest({ session: jillsSession(request.sessionId), message: request.text, ...(request.cwd ? { cwd: request.cwd } : {}), ...this.opts() })
      if (s.action !== 'suggest' || !s.jill) return { ...emptyCard(messageId, 'quiet', s.reason), matcher: s.matcher ?? '', confidence: s.confidence ?? 0 }
      const fields = (await core.listJills(this.opts())).find(j => j.name === s.jill)?.inputs ?? []
      const card: JillsCard = {
        kind: 'suggest', messageId, reason: s.reason, jill: s.jill, description: s.description ?? '', inputs: s.inputs ?? {}, fields,
        auto: s.auto, confidence: s.confidence ?? 0, matcher: s.matcher ?? '', note: '', run: null,
      }
      return s.auto ? await this.launch(card, { sessionId: request.sessionId, messageId, jill: s.jill, inputs: card.inputs, cwd: request.cwd }) : card
    } catch (error) {
      return emptyCard(messageId, 'quiet', `jills unavailable: ${message(error)}`)
    }
  }

  private async launch(card: JillsCard, request: StartRequest): Promise<JillsCard> {
    try {
      const core = await this.core()
      const record = await core.start(request.jill, {
        inputs: request.inputs, session: jillsSession(request.sessionId), ...(request.cwd ? { cwd: request.cwd } : {}), ...this.opts(),
      })
      return { ...card, kind: 'started', inputs: request.inputs, run: runLine(core, record) }
    } catch (error) {
      return { ...card, kind: 'error', note: message(error) }
    }
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
      await core.dismiss(jillsSession(action.sessionId), this.opts())
      return { ...card, kind: 'closed', note: 'Okay. Jev stays quiet in this chat.' }
    })
  }

  /** "Never": mute this Jill for the session's repo. */
  never(action: CardAction): Promise<JillsCard> {
    return this.update(action.sessionId, action.messageId, async (card) => {
      try {
        const core = await this.core()
        const text = await core.never({ session: jillsSession(action.sessionId), ...(card.jill ? { jill: card.jill } : {}), ...(action.cwd ? { cwd: action.cwd } : {}), ...this.opts() })
        return { ...card, kind: 'closed', note: `Jev will not suggest it here again (${text}).` }
      } catch (error) {
        return { ...card, kind: 'error', note: message(error) }
      }
    })
  }
}
