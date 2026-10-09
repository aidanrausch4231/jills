// `claude plugin test addons/claude-code/mod/jills`. Every `jills` call is mocked; nothing
// runs, no file is touched.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SESSION = 'cc-sess-1'
const REPO = '/tmp/jills-mod-repo'
const BAND = {
  plugin: 'jills',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 80, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const
const PANE = {
  plugin: 'jills',
  component: 'Pane',
  requestId: 'jills-run',
  props: { title: 'Jill fix-bug', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const SUGGESTION = {
  action: 'suggest',
  reason: 'new task fits a saved Jill',
  jill: 'fix-bug',
  description: 'Find and fix a bug',
  inputs: { issue: 'the login page crashes on submit' },
  auto: false,
  worktree: true,
  warning: 'merges into main when done',
}

const T0 = Date.parse('2026-10-09T10:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

const RUNNING = {
  id: 'r1',
  jill: 'fix-bug',
  state: 'running',
  created: at(0),
  started: at(0),
  branch: 'jills/fix-bug-r1',
  steps: {
    research: { key: 'research', state: 'done', started: at(1) },
    'research/explore#1': { key: 'research/explore#1', state: 'done', started: at(2) },
    build: { key: 'build', state: 'skipped', reason: 'stale: a back-arrow reran an earlier step', started: at(3) },
    review: { key: 'review', state: 'failed', reason: 'tests fail', started: at(4) },
    'build@2': { key: 'build@2', state: 'running', started: at(5) },
  },
  events: [],
}

const DONE = {
  ...RUNNING,
  state: 'done',
  finished: at(90),
  steps: { ...RUNNING.steps, 'build@2': { key: 'build@2', state: 'done', started: at(5) }, merge: { key: 'merge', state: 'done', started: at(80) } },
  events: [{ at: at(85), type: 'step-done', step: 'merge', note: 'done: merged into main' }],
}

type World = {
  argv: string[][]
  statuses: (string | undefined)[]
  toasts: string[]
  opened: string[]
  record: object
  suggestion: object
  clock: ReturnType<typeof mock.clock>
  appended: () => string[]
}

/** The engine beneath the mod: session facts, the jills CLI, the display calls. */
function world(on: On, now = T0 + 10_000): World {
  const w: World = {
    argv: [],
    statuses: [],
    toasts: [],
    opened: [],
    record: RUNNING,
    suggestion: SUGGESTION,
    clock: mock.clock(on, { now }),
    appended: () => [],
  }
  const session = mock.session(on)
  w.appended = () => session.appended().flatMap(r => r.message.content.flatMap(b => ('text' in b && typeof b.text === 'string' ? [b.text] : [])))
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: REPO }))
  on('session.messages', () => ({ value: [] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => (w.statuses.push(e.text), { value: undefined }))
  on('ui.toast', ($, e) => (w.toasts.push(e.text), { value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', ($, e) => (w.opened.push(e.id), { value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine-band" /> // the band as the engine draws it with no mod
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    w.argv.push(argv)
    const ok = (out: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    switch (argv[1]) {
      case 'suggest': return ok(w.suggestion)
      case 'go': return ok({ run: 'r1', jill: 'fix-bug', state: 'queued', record: '/tmp/x' })
      case 'status': return ok(w.record)
      case 'wait': return ok({ ...w.record, line: `jills run r1 ${(w.record as { state: string }).state}: fix-bug | branch jills/fix-bug-r1` })
      default: return ok({})
    }
  })
  return w
}

const person = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } as const })
const calls = (w: World, cmd: string) => w.argv.filter(a => a[1] === cmd)

test('a suggestion shows as a card with the Jill, inputs and warnings', async ($, on) => {
  const w = world(on)
  await $.prompt.submit(person('the login page crashes, please fix it'))
  await w.clock.settle()
  expect(calls(w, 'suggest')).toEqual([['jills', 'suggest', '--session', SESSION, '--repo', REPO, '--json', '--', 'the login page crashes, please fix it']])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'Jill fix-bug' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Find and fix a bug' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'issue: the login page crashes on submit' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'merges into main when done' })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(3)
    await ui.unmount()
  }
})

test('Start runs jills go, opens the pane and tells Claude', async ($, on) => {
  const w = world(on)
  await $.prompt.submit(person('fix the crash'))
  await w.clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'start' })
  expect(calls(w, 'go')).toEqual([['jills', 'go', '--session', SESSION, '--repo', REPO, '--json']])
  expect(w.opened).toEqual(['jills-run'])
  expect(w.appended()).toContainEqual(expect.stringContaining('Jills run r1 started (Jill fix-bug)'))
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
})

test('Not this runs jills dismiss and hides the card', async ($, on) => {
  const w = world(on)
  await $.prompt.submit(person('fix the crash'))
  await w.clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'dismiss' })
  expect(calls(w, 'dismiss')).toEqual([['jills', 'dismiss', '--session', SESSION]])
  expect(await ui.find({ type: 'Text', text: 'Jill fix-bug' })).toBeUndefined()
  expect(calls(w, 'go')).toHaveLength(0)
})

test('Never here runs jills never for this Jill and repo', async ($, on) => {
  const w = world(on)
  await $.prompt.submit(person('fix the crash'))
  await w.clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'never' })
  expect(calls(w, 'never')).toEqual([['jills', 'never', '--session', SESSION, '--jill', 'fix-bug', '--repo', REPO]])
  expect(await ui.find({ type: 'Text', text: 'Jill fix-bug' })).toBeUndefined()
})

test('the next person prompt removes the card', async ($, on) => {
  const w = world(on)
  await $.prompt.submit(person('fix the crash'))
  await w.clock.settle()
  w.suggestion = { action: 'quiet', reason: 'same task', auto: false }
  await $.prompt.submit(person('and also check the logs'))
  await w.clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Jill fix-bug' })).toBeUndefined()
})

test('slash commands, shell escapes, system events and non-person prompts never call suggest', async ($, on) => {
  const w = world(on)
  for (const text of ['/jills go', '!ls', '<task-notification>done</task-notification>', '   ']) await $.prompt.submit(person(text))
  await $.prompt.submit({ text: 'a background task finished', wait: false, origin: { kind: 'task-notification' } })
  await w.clock.settle()
  expect(calls(w, 'suggest')).toHaveLength(0)
})

test('auto mode starts the run without a card', async ($, on) => {
  const w = world(on)
  w.suggestion = { ...SUGGESTION, auto: true }
  await $.prompt.submit(person('fix the crash'))
  await w.clock.settle()
  expect(calls(w, 'go')).toHaveLength(1)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
})

/** Suggest, press Start, let the first status poll land. */
async function started($: Engine, w: World) {
  await $.prompt.submit(person('fix the crash'))
  await w.clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'start' })
  await w.clock.settle()
  await band.unmount()
}

test('the pane shows steps in start order, a round-2 step and a nested step', async ($, on) => {
  const w = world(on)
  await started($, w)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const rows = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(rows[0]).toContain('Jill fix-bug')
    expect(rows[0]).toContain('running')
    expect(rows[0]).toContain('10s')
    const steps = rows.filter(r => /[▸✓✗~]/.test(r))
    expect(steps[0]).toMatch(/^ {2}✓ research$/)
    expect(steps[1]).toMatch(/^ {4}✓ explore#1$/)
    expect(steps[2]).toMatch(/~ build/)
    expect(steps[3]).toMatch(/✗ review — tests fail/)
    expect(steps[4]).toMatch(/▸ build \(round 2\)/)
    expect(rows).toContainEqual(expect.stringContaining('branch jills/fix-bug-r1'))
    expect(await ui.find({ type: 'Button', key: 'stop' })).toBeDefined()
    await ui.unmount()
  }
})

test('Stop runs jills stop <run>', async ($, on) => {
  const w = world(on)
  await started($, w)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'stop' })
  expect(calls(w, 'stop')).toEqual([['jills', 'stop', 'r1']])
})

test('the status row shows the Jill, current step and done/seen steps', async ($, on) => {
  const w = world(on)
  await started($, w)
  expect(w.statuses.at(-1)).toBe('Jills: fix-bug · build (round 2) · 2/4 steps')
})

test('a run that ends: toast, final status row, result line for Claude, status cleared after 60 s', async ($, on) => {
  const w = world(on)
  await started($, w)
  w.record = DONE
  await w.clock.advance(1500)
  expect(w.toasts).toContainEqual('Jill fix-bug done')
  expect(w.statuses.at(-1)).toBe('Jills: fix-bug done')
  expect(w.appended()).toContainEqual('[Jills] jills run r1 done: fix-bug | branch jills/fix-bug-r1 | merge: merged into main')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'merge: merged into main' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeUndefined()
  await w.clock.advance(60_000)
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('polling stops once the run ended', async ($, on) => {
  const w = world(on)
  await started($, w)
  await w.clock.advance(1500)
  expect(calls(w, 'status')).toHaveLength(2)
  w.record = { ...DONE, state: 'failed', error: 'review failed twice' }
  await w.clock.advance(1500)
  const polls = calls(w, 'status').length
  expect(w.toasts).toContainEqual('Jill fix-bug failed')
  await w.clock.advance(30_000)
  expect(calls(w, 'status')).toHaveLength(polls)
})
