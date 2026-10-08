/** Jills for dsh: a Host service under the `jills` Remote namespace. The browser card calls it. */
import { randomUUID } from 'node:crypto'
import { Context, Remote, TypertRemoteService } from './dsh.ts'
import { JillsBridge, loadCore, turnsBefore, type AgentPort } from './bridge.ts'
import type { CardAction, JillsCard, RunLine, StartRequest, SuggestRequest } from './types.ts'

export type * from './types.ts'

/** Host settings (cordis plugin config). */
export interface Config {
  /** Jills home; empty uses $JILLS_HOME or ~/.jills. */
  home?: string
  /** Path to the Jills library index.js; empty uses $JILLS_LIB or this repo's dist build. */
  lib?: string
  /** Messages older than this many milliseconds are never sent to Jev (history reloads). */
  maxAgeMs?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { jills: JillsDsh }
}

/** The parts of dsh's Session Controller and Agent this add-on uses (structural; no extra package). */
interface SessionControllerLike {
  /** Read one Session's events without activating its Agent. */
  inspect(sessionId: string): Promise<{ events: readonly unknown[] }>
  /** Resolve (resuming when cold) the Session's main Agent. */
  resolveAgent(sessionId: string): Promise<{ agent: AgentLike } | { error: unknown }>
}
interface AgentLike {
  /** Queue model-facing context for the next step without waking the agent. */
  inject(message: unknown): void
  /** The live session (for flushing). */
  session: unknown
}
interface SessionsLike {
  /** Persist pending Session events. */
  flush(session: unknown): Promise<boolean>
}

/**
 * A user-role context message as dsh's `createUserMessage` builds it (fresh id,
 * frozen), with a `jills` notice source so the chat shows it as a one-line notice
 * and the card never mistakes it for a typed message.
 */
function jillsNotice(text: string, summary: string): unknown {
  const message = {
    role: 'user',
    content: [Object.freeze({ type: 'text', text })],
    source: Object.freeze({ kind: 'jills', form: 'notice', summary: summary.slice(0, 120) }),
    id: randomUUID(),
  }
  Object.freeze(message.content)
  return Object.freeze(message)
}

/**
 * Session access through dsh's Session Controller:
 * - recent turns: `sessionController.inspect()` (reads the log; never activates the Agent);
 * - telling the agent: `agent.inject()` = dsh's "queue model-facing context for the next
 *   pre-step without waking the driver". It never starts or steers a turn; the agent reads
 *   it at its next step (now if running, else with the user's next message). The Session is
 *   flushed so the notice is durable.
 */
function agentPort(ctx: Context): AgentPort {
  let controller: SessionControllerLike | undefined
  let sessions: SessionsLike | undefined
  ctx.inject(['sessionController', 'sessions'], (scope: Context) => {
    const found = scope as unknown as { sessionController: SessionControllerLike; sessions: SessionsLike }
    controller = found.sessionController
    sessions = found.sessions
    scope.effect(() => () => { controller = undefined; sessions = undefined }, 'jills: session access')
  })
  return {
    async recentTurns(sessionId, messageId) {
      if (!controller) return []
      return turnsBefore((await controller.inspect(sessionId)).events, messageId)
    },
    async tell(sessionId, text, summary) {
      if (!controller) throw new Error('dsh session controller is not available')
      const resolved = await controller.resolveAgent(sessionId)
      if ('error' in resolved) throw resolved.error instanceof Error ? resolved.error : new Error(String(resolved.error))
      resolved.agent.inject(jillsNotice(text, summary))
      await sessions?.flush(resolved.agent.session)
    },
  }
}

/** Host service exposed under the `jills` Remote namespace. */
export default class JillsDsh extends TypertRemoteService {
  private readonly bridge: JillsBridge

  /**
   * @param ctx - owning Host context.
   * @param config - Jills home and library location.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'jills')
    this.bridge = new JillsBridge(loadCore(config.lib ?? ''), { home: config.home ?? '', maxAgeMs: config.maxAgeMs ?? 5 * 60_000, agent: agentPort(ctx) })
  }

  /**
   * Ask Jev whether a saved Jill fits one user message. Cached per message.
   * @param request - session, message and working folder.
   * @returns the card to show.
   */
  @Remote('suggest')
  suggest(request: SuggestRequest): Promise<JillsCard> { return this.bridge.suggest(request) }

  /**
   * Start the suggested Jill as a detached run.
   * @param request - card identity, Jill and edited inputs.
   * @returns the card with its run status line.
   */
  @Remote('start')
  start(request: StartRequest): Promise<JillsCard> { return this.bridge.start(request) }

  /**
   * Read the current status line of a run.
   * @param runId - Jills run id.
   * @returns the status line.
   */
  @Remote('status')
  status(runId: string): Promise<RunLine> { return this.bridge.status(runId) }

  /**
   * "Not this": quiet Jev for the rest of this chat.
   * @param action - card identity.
   * @returns the closed card.
   */
  @Remote('dismiss')
  dismiss(action: CardAction): Promise<JillsCard> { return this.bridge.dismiss(action) }

  /**
   * "Never": mute this Jill for the session's repo.
   * @param action - card identity and working folder.
   * @returns the closed card.
   */
  @Remote('never')
  never(action: CardAction): Promise<JillsCard> { return this.bridge.never(action) }
}
