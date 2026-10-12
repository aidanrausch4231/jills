// Jills mod for Claude Code: Jev's suggestion as a card above the prompt, the run's
// progress in a pane, a status row, and a toast + a line for Claude when a run ends.
// It drives Jills only through the `jills` CLI (argv, never a shell).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { JillsCard, JillsRun } from '../types'
import { GLYPH, TERMINAL, cardFrom, clip, elapsed, endWord, isPersonPrompt, jevOffText, runView, statusText } from './view'
import type { Suggestion } from './view'

type $ = EngineInterface

const PANE = 'jills-run'
const POLL_MS = 1500 // while the pane is open
const POLL_CLOSED_MS = 5000 // pane closed: the status row and the end notice still need the result
const FINAL_STATUS_MS = 60_000
const MAX_FAILURES = 5 // `jills status` failing this many times in a row ends the polling

const card = atom({ plugin: 'jills', key: 'card' } as const, null)
const run = atom({ plugin: 'jills', key: 'run' } as const, null)

/** `jills <args>`; never throws (a missing CLI reads as exit 127). */
async function jills($: $, args: string[], init: { stdin?: string; timeoutMs?: number } = {}) {
  try {
    return await $.process.run(['jills', ...args], { timeoutMs: 30_000, ...init })
  } catch (err) {
    return { exitCode: 127, stdout: '', stderr: String(err) }
  }
}

function json<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

const firstLine = (text: string) => clip(text.split('\n').find(l => l.trim()) ?? 'no output', 160)

/** A user-role row Claude reads and the person does not see as typed. */
async function tellClaude($: $, text: string) {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } catch (err) {
    $.ui.log(`jills: could not tell Claude: ${String(err)}`, { to: 'debug' })
  }
}

type Poll = { id: string; timer?: Timer; failures: number }

/** Per-session module state; a hot reload starts it fresh (`/jills-panel` resumes polling). */
const live = {
  asked: 0, // the latest person prompt; an older suggest answer is dropped
  poll: undefined as Poll | undefined,
  paneOpen: false,
  statusRun: undefined as string | undefined, // the run whose final word the status row shows
  jevOffShown: false, // the "Jev off" reason shows once per session
}

async function suggest($: $, text: string, seq: number) {
  const session = await $.session.id()
  const repo = await $.session.cwd()
  const history = await $.session.messages()
  const turns = history
    .filter(m => m.text.trim() && !m.text.trim().startsWith('<'))
    .map(m => ({ role: m.role, text: m.text.slice(0, 4000) }))
  if (turns.at(-1)?.text.trim() === text.trim()) turns.pop() // the prompt itself, already entered
  const out = await jills($, ['suggest', '--session', session, '--repo', repo, '--json', '--', text], {
    stdin: JSON.stringify(turns.slice(-3)),
    timeoutMs: 20_000,
  })
  const s = json<Suggestion>(out.stdout)
  if (seq !== live.asked || !s) return
  const off = jevOffText(s)
  if (off && !live.jevOffShown && !live.poll) {
    live.jevOffShown = true
    const token = `jev-off:${await $.clock.now()}`
    live.statusRun = token
    $.ui.status(off)
    $.clock.after(FINAL_STATUS_MS, () => {
      if (live.statusRun === token) $.ui.status(undefined)
    })
    return
  }
  const found = cardFrom(s)
  if (!found) return
  const shown = { ...found, needs: await missingInputs($, found) }
  if (seq !== live.asked) return
  if (s.auto && !shown.needs.length) await start($, true, shown.jill)
  else await update($, card, () => shown)
}

/** Required inputs (no default) of the Jill that the suggestion leaves empty: `jills list --json`. */
async function missingInputs($: $, c: JillsCard): Promise<string[]> {
  const out = await jills($, ['list', '--json'])
  const listed = json<{ name?: string; required?: string[] }[]>(out.stdout)
  const required = (Array.isArray(listed) ? listed : []).find(j => j.name === c.jill)?.required ?? []
  const given = new Set(c.inputs.filter(([, v]) => v.trim()).map(([k]) => k))
  return required.filter(n => !given.has(n))
}

/** `auto`: started by auto mode, not a press; the pane stays shut (`/jills-panel` opens it). */
async function start($: $, auto: boolean, name: string) {
  const session = await $.session.id()
  const repo = await $.session.cwd()
  const out = await jills($, ['go', '--session', session, '--repo', repo, '--json'])
  const g = json<{ run?: string; jill?: string; state?: string }>(out.stdout)
  if (out.exitCode !== 0 || !g?.run) {
    // Stays visible: the card keeps its text, and the status row says why for a minute.
    const why = firstLine(out.stderr || out.stdout)
    $.ui.toast(`Jills: could not start (${why})`)
    const token = `start-failed:${await $.clock.now()}`
    live.statusRun = token
    $.ui.status(`couldn't start ${name}: ${why}`)
    $.clock.after(FINAL_STATUS_MS, () => {
      if (live.statusRun === token) $.ui.status(undefined)
    })
    return
  }
  await update($, card, () => null)
  const id = g.run
  const jill = g.jill ?? '?'
  const first = runView({ id, jill, state: g.state ?? 'queued' }, await $.clock.now())
  await update($, run, () => first)
  if (auto) $.ui.toast(`Jill ${jill} started (auto mode); /jills-panel shows it`)
  else {
    live.paneOpen = true
    void $.ui.open({ id: PANE, title: `Jill ${jill}` })
  }
  live.statusRun = undefined
  $.ui.status(`${jill} · starting · 0/0 steps`)
  await tellClaude($, `Jills run ${id} started (Jill ${jill}). The Jills mod shows its progress and will add the result to this chat when it ends; do not start it again or wait on it.`)
  follow($, id)
}

/** Our own close: the plugin's own `ui.close` hook does not run for its own call. */
async function closePane($: $) {
  live.paneOpen = false
  await $.ui.close({ id: PANE })
}

function follow($: $, id: string) {
  live.poll?.timer?.cancel()
  const p: Poll = { id, failures: 0 }
  live.poll = p
  void tick($, p)
}

async function tick($: $, p: Poll) {
  if (live.poll !== p) return
  const out = await jills($, ['status', p.id, '--json'])
  const r = json<Parameters<typeof runView>[0]>(out.stdout)
  if (live.poll !== p) return
  if (out.exitCode === 0 && r) {
    const view = runView(r, await $.clock.now())
    await update($, run, () => view)
    p.failures = 0
    if (TERMINAL.has(view.state)) return finish($, view)
    $.ui.status(statusText(view))
  } else if (++p.failures >= MAX_FAILURES) {
    live.poll = undefined
    $.ui.status(undefined)
    $.ui.toast(`Jills: lost track of run ${p.id}`)
    return
  }
  p.timer = $.clock.after(live.paneOpen ? POLL_MS : POLL_CLOSED_MS, () => void tick($, p))
}

async function finish($: $, view: JillsRun) {
  live.poll = undefined
  const w = await jills($, ['wait', view.id, '--json', '--timeout', '5s'])
  const line = json<{ line?: string }>(w.stdout)?.line ?? `jills run ${view.id} ${view.state}: ${view.jill}`
  const word = endWord(view.state)
  $.ui.toast(`Jill ${view.jill} ${word}`)
  live.statusRun = view.id
  $.ui.status(statusText(view))
  $.clock.after(FINAL_STATUS_MS, () => {
    if (live.statusRun === view.id) $.ui.status(undefined)
  })
  await tellClaude($, `[Jills] ${line}${view.merge ? ` | merge: ${view.merge}` : ''}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'jills-panel', description: 'Show the latest Jills run of this session in a pane' })
    return next(e)
  })

  on('command.run', { command: 'jills-panel' }, async $ => {
    const latest = await read($, run)
    if (!latest) return { text: 'Jills: no run in this session yet.' }
    live.paneOpen = true
    await $.ui.open({ id: PANE, title: `Jill ${latest.jill}`, focus: true })
    if (!TERMINAL.has(latest.state) && live.poll?.id !== latest.id) follow($, latest.id)
    return { text: `Jills: showing run ${latest.id}.` }
  })

  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if (!isPersonPrompt(e.text, e.origin.kind)) return entered
    const seq = ++live.asked
    await update($, card, () => null)
    void suggest($, e.text, seq).catch(err => $.ui.log(`jills: suggest failed: ${String(err)}`, { to: 'debug' }))
    return entered
  }).catch(($, e, next) => next(e)) // never holds a prompt back

  on('ui.close', { id: PANE }, ($, e, next) => { // the person's close (ctrl+x x, the close mark)
    live.paneOpen = false
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown: JillsCard | null = await read($, card)
    if (!shown || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns - 4)
    const close = async (args: string[]) => {
      await update($, card, () => null)
      await jills($, args)
    }
    const pressNot = async () => close(['dismiss', '--session', await $.session.id()])
    const pressNever = async () =>
      close(['never', '--session', await $.session.id(), '--jill', shown.jill, '--repo', await $.session.cwd()])
    return (
      <Box flexDirection="column" key="jills-card">
        <Text wrap="truncate-end">
          <Text bold>Jill {shown.jill}</Text>
          {shown.description ? <Text dimColor> · {shown.description}</Text> : null}
        </Text>
        {shown.inputs.map(([k, v]) => (
          <Text dimColor wrap="truncate-end">
            {'  '}
            {clip(`${k}: ${v}`, width)}
          </Text>
        ))}
        {shown.needs.length ? (
          <Text color="warning" wrap="truncate-end" key="needs">
            {'  '}
            {clip(`needs: ${shown.needs.join(', ')} — use /jills go ${shown.needs.map(n => `${n}=value`).join(' ')}`, width)}
          </Text>
        ) : null}
        {shown.warnings.map(w => (
          <Text color="warning" wrap="truncate-end">
            {'  '}
            {clip(w, width)}
          </Text>
        ))}
        <Box flexDirection="row" gap={1}>
          {/* Letter hotkeys only: they press while the band holds the focus (ctrl+x tab or a click).
              A digit would also fire from an empty prompt, so "1. fix ..." could press Start. */}
          {shown.needs.length ? null : (
            <Button key="start" label="Start" hotkey="s" variant="primary" onPress={() => start($, false, shown.jill)} />
          )}
          <Button key="dismiss" label="Not this" hotkey="n" onPress={pressNot} />
          <Button key="never" label="Never here" hotkey="v" onPress={pressNever} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const r = await read($, run)
    if (!r) return <Text dimColor>No Jills run in this session yet.</Text>
    const width = Math.max(20, e.props.bodyColumns - 2)
    const isRunning = !TERMINAL.has(r.state)
    const stateColor = r.state === 'done' ? 'success' : isRunning ? 'suggestion' : 'error'
    const needs = r.steps.find(s => s.state === 'needs-you')?.reason
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>Jill {r.jill}</Text> · <Text color={stateColor}>{endWord(r.state)}</Text>
          <Text dimColor> · {elapsed(r)} · {r.id}</Text>
        </Text>
        {r.steps.length === 0 && <Text dimColor>No step has started yet.</Text>}
        {r.steps.map(s => (
          <Text key={s.key} wrap="truncate-end" dimColor={s.state === 'stale' || s.state === 'skipped'}>
            {'  '.repeat(s.depth + 1)}
            {GLYPH[s.state] ?? '·'} {s.label}
            {s.reason && s.state !== 'done' ? <Text dimColor> — {clip(s.reason, width)}</Text> : null}
          </Text>
        ))}
        {r.merge ? <Text color="merged" wrap="truncate-end">merge: {clip(r.merge, width)}</Text> : null}
        {r.state === 'needs-you' ? (
          <Text color="warning" wrap="truncate-end">needs you: {clip(needs ?? r.error ?? 'see the run log', width)}</Text>
        ) : null}
        {r.conflicts.length ? <Text color="warning" wrap="truncate-end">conflicts: {clip(r.conflicts.join(', '), width)}</Text> : null}
        {r.error && r.state !== 'needs-you' && r.state !== 'done' ? (
          <Text color="error" wrap="truncate-end">error: {clip(r.error, width)}</Text>
        ) : null}
        {r.branch ? <Text dimColor wrap="truncate-end">branch {r.branch}</Text> : null}
        <Box flexDirection="row" gap={1}>
          {isRunning ? (
            <Button key="stop" label="Stop" hotkey="s" onPress={async () => {
              await jills($, ['stop', r.id])
              if (live.poll?.id === r.id) follow($, r.id)
            }} />
          ) : null}
          <Button key="close" label="Close" hotkey="c" role="dismiss" onPress={() => closePane($)} />
        </Box>
      </Box>
    )
  })
}
