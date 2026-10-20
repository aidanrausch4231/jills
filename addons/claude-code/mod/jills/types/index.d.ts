// The Jills mod's session state ($.state), read by its band and pane.

/** A Jev suggestion shown as the card above the prompt. */
/** `needs`: required inputs the suggestion left empty; Start is hidden until /jills go gets them. */
export type JillsCard = { jill: string; description: string; inputs: [string, string][]; warnings: string[]; needs: string[] }

/** One step instance of a run, in start order. `label`: "build (round 2)"; `depth`: nesting. */
export type JillsStep = { key: string; label: string; depth: number; state: string; reason?: string }

/** What the pane and status row show of the latest run of this session. */
export type JillsRun = {
  id: string
  jill: string
  state: string
  startedMs?: number
  endedMs?: number
  polledMs: number
  steps: JillsStep[]
  branch?: string
  error?: string
  merge?: string
  conflicts: string[]
}

declare module 'claude-code' {
  interface PluginState {
    jills: { card: JillsCard | null; run: JillsRun | null }
  }
}
