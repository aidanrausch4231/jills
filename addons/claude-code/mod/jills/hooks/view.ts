// Pure helpers: what the card, pane and status row show. No `$`, no I/O.
import type { JillsCard, JillsRun, JillsStep } from '../types'

export const TERMINAL = new Set(['done', 'failed', 'stuck', 'needs-you'])

/** The person's own prompt, and one Jev should read: not a slash command, shell escape or system event. */
export function isPersonPrompt(text: string, originKind: string): boolean {
  if (originKind !== 'composer' && originKind !== 'bridge') return false
  const t = text.trim()
  return t !== '' && !/^[/!<]/.test(t)
}

/** `jills suggest --json` output, as far as the mod reads it. */
export type Suggestion = {
  action?: string
  jill?: string
  description?: string
  inputs?: Record<string, unknown>
  auto?: boolean
  worktree?: boolean
  warning?: string
}

export function cardFrom(s: Suggestion): JillsCard | null {
  if (s.action !== 'suggest' || !s.jill) return null
  const warnings = (s.warning ?? '').split(';').map(w => w.trim()).filter(Boolean)
  if (s.worktree === false && !warnings.some(w => /worktree/.test(w))) warnings.unshift('no worktree')
  const inputs = Object.entries(s.inputs ?? {}).map(([k, v]): [string, string] => [k, String(v)])
  return { jill: s.jill, description: s.description ?? '', inputs, warnings }
}

/** One line, at most `n` characters. */
export function clip(text: string, n: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= n ? one : `${one.slice(0, Math.max(1, n - 1))}…`
}

/** `research/explore#1` → depth 1, "explore#1"; `build@2` → "build (round 2)". */
export function stepLabel(key: string): { label: string; depth: number } {
  const parts = key.split('/')
  const last = parts[parts.length - 1] ?? key
  const round = /^(.*)@(\d+)$/.exec(last)
  return { label: round ? `${round[1]} (round ${round[2]})` : last, depth: parts.length - 1 }
}

type RawStep = { key?: string; state?: string; reason?: string; started?: string }
type RawRecord = {
  id?: string
  jill?: string
  state?: string
  created?: string
  started?: string
  finished?: string
  branch?: string
  error?: string
  conflicts?: string[]
  steps?: Record<string, RawStep>
  events?: { type?: string; note?: string }[]
}

const time = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? undefined : t
}

/** The pane's view of a `jills status <run> --json` record. */
export function runView(r: RawRecord, polledMs: number): JillsRun {
  const raw = Object.values(r.steps ?? {}).map((s, i) => ({ s, i, at: time(s.started) ?? Infinity }))
  raw.sort((a, b) => a.at - b.at || a.i - b.i)
  const steps: JillsStep[] = raw.map(({ s }) => {
    const key = s.key ?? '?'
    const stale = s.state === 'skipped' && /^stale/.test(s.reason ?? '')
    return { key, ...stepLabel(key), state: stale ? 'stale' : (s.state ?? 'pending'), ...(s.reason ? { reason: s.reason } : {}) }
  })
  // Only a finished merge step's note ("done: merged into main"); a child-worktree conflict
  // ("needs-you: merge of X into Y conflicts") is the needs-you reason, not a merge result.
  const merge = [...(r.events ?? [])].reverse().find(e => e.type === 'step-done' && /^done: .*merge/.test(e.note ?? ''))?.note
  return {
    id: r.id ?? '?',
    jill: r.jill ?? '?',
    state: r.state ?? 'queued',
    startedMs: time(r.started ?? r.created),
    endedMs: time(r.finished),
    polledMs,
    steps,
    branch: r.branch,
    error: r.error,
    merge: merge?.replace(/^done: /, ''),
    conflicts: r.conflicts ?? [],
  }
}

/** done / failed / stuck / needs you */
export const endWord = (state: string) => (state === 'needs-you' ? 'needs you' : state)

export const GLYPH: Record<string, string> = {
  running: '▸', done: '✓', failed: '✗', stuck: '!', 'needs-you': '?', skipped: '-', stale: '~', pending: '·',
}

/** The status row: running, or the final word once ended. */
export function statusText(run: JillsRun): string {
  if (TERMINAL.has(run.state)) return `Jills: ${run.jill} ${endWord(run.state)}`
  const now = run.steps.filter(s => s.state === 'running').map(s => s.label)
  const seen = run.steps.filter(s => s.state !== 'skipped' && s.state !== 'stale')
  const done = seen.filter(s => s.state === 'done').length
  return `Jills: ${run.jill} · ${now.length ? now.join(', ') : run.state} · ${done}/${seen.length} steps`
}

/** "1m 05s" */
export function elapsed(run: JillsRun): string {
  if (run.startedMs === undefined) return ''
  const s = Math.max(0, Math.round(((run.endedMs ?? run.polledMs) - run.startedMs) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}
