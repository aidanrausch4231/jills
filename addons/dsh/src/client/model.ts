/** Pure browser-side pieces: the chat node Definition and card helpers. Type-only dsh imports. */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CardAction, JillsCard, RunLine, StartRequest, SuggestRequest } from '../types.ts'

/** Chat node kind owned by this add-on. */
export const NODE_KIND = 'jills-suggestion'

/** One user message, as the card needs it. */
export interface MessageData {
  /** Durable user message id. */
  messageId: string
  /** Plain message text. */
  text: string
  /** Message time in epoch ms (0 when unknown). */
  sentAt: number
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'jills-suggestion': MessageData }
}

/** Operations the card calls; transport failures arrive as thrown Errors. */
export interface JillsFace {
  suggest(request: SuggestRequest): Promise<JillsCard>
  start(request: StartRequest): Promise<JillsCard>
  status(runId: string): Promise<RunLine>
  dismiss(action: CardAction): Promise<JillsCard>
  never(action: CardAction): Promise<JillsCard>
}

/** Narrow the generated Remote namespace to plain promises. */
export interface JillsRemote {
  suggest(request: SuggestRequest): Promise<RemoteResult<JillsCard>>
  start(request: StartRequest): Promise<RemoteResult<JillsCard>>
  status(runId: string): Promise<RemoteResult<RunLine>>
  dismiss(action: CardAction): Promise<RemoteResult<JillsCard>>
  never(action: CardAction): Promise<RemoteResult<JillsCard>>
}

async function valueOf<T>(request: Promise<RemoteResult<T>>): Promise<T> {
  const result = await request
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Bind the Remote namespace into the card's face. */
export function jillsFace(remote: JillsRemote): JillsFace {
  return {
    suggest: request => valueOf(remote.suggest(request)),
    start: request => valueOf(remote.start(request)),
    status: runId => valueOf(remote.status(runId)),
    dismiss: action => valueOf(remote.dismiss(action)),
    never: action => valueOf(remote.never(action)),
  }
}

/** Plain text of a message content value (string or text blocks). */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : '')
    .filter(Boolean)
    .join('\n')
}

function timeOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') { const t = Date.parse(value); return Number.isFinite(t) ? t : 0 }
  return 0
}

/** Read a typed user message from a loosely typed history event; undefined for anything else. */
export function userMessage(event: unknown): MessageData | undefined {
  if (!event || typeof event !== 'object') return undefined
  const e = event as { type?: unknown; time?: unknown; data?: { id?: unknown; content?: unknown; source?: { kind?: unknown } } }
  if (e.type !== 'user/message' || !e.data || e.data.source?.kind !== 'user' || e.data.id === undefined) return undefined
  const text = textOf(e.data.content)
  if (!text.trim() || text.trimStart().startsWith('/')) return undefined
  return { messageId: String(e.data.id), text, sentAt: timeOf(e.time) }
}

/**
 * One Jills card after each typed user message (commands and injected context are skipped).
 * The node sits at Session level: a Turn/Step location would fold it into the Turn's collapsed
 * "Completed in ..." process group, because the Chat keeps only built-in kinds independent.
 */
export const suggestionDefinition: ConversationNodeDefinition<MessageData> = {
  kind: NODE_KIND, target: 'chat',
  match(event) {
    const data = userMessage(event)
    return data ? { id: `jills:${data.messageId}`, role: 'start' } : null
  },
  start(_context, match) {
    const data = userMessage(match.event)
    if (!data) throw new Error('Jills card requires a user message')
    return data
  },
  update(context) { return context.state },
  buildViewNode(context) {
    if (!context.start || !context.state) return null
    return {
      key: context.key, kind: NODE_KIND, target: 'chat', id: context.id, anchorSeq: context.start.event.seq,
      location: { kind: 'session' }, visibility: 'visible', data: context.state,
    }
  },
}

/** Map a run state to the dsh StateDot vocabulary. */
export function dotState(run: RunLine): 'done' | 'warning' | 'ongoing' | 'error' | 'idle' {
  switch (run.state) {
    case 'done': return 'done'
    case 'needs-you': return 'warning'
    case 'failed': case 'stuck': return 'error'
    case 'queued': return 'idle'
    default: return 'ongoing'
  }
}

/** Edit form values to start inputs: trimmed, empty ones dropped (the Jill's defaults apply). */
export function inputsFrom(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()] as const).filter(([, v]) => v !== ''))
}
