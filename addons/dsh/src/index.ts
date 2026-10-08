/** Jills for dsh: a Host service under the `jills` Remote namespace. The browser card calls it. */
import { Context, Remote, TypertRemoteService } from './dsh.ts'
import { JillsBridge, loadCore } from './bridge.ts'
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

/** Host service exposed under the `jills` Remote namespace. */
export default class JillsDsh extends TypertRemoteService {
  private readonly bridge: JillsBridge

  /**
   * @param ctx - owning Host context.
   * @param config - Jills home and library location.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'jills')
    this.bridge = new JillsBridge(loadCore(config.lib ?? ''), { home: config.home ?? '', maxAgeMs: config.maxAgeMs ?? 5 * 60_000 })
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
