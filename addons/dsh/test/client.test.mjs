/** The built browser bundle (lib/client.js) under a fake dsh module loader: Definition, card view, face. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

const requested = new Set()
const platform = {
  react: React,
  'react/jsx-runtime': require('react/jsx-runtime'),
  '@deepseek-ai/dsh-client-ui-primitives': {
    Button: ({ children, variant, size, icon, ...rest }) => React.createElement('button', { 'data-variant': variant, ...rest }, children),
    StateDot: ({ state }) => React.createElement('span', { 'data-dot': state }),
  },
}
let mod
globalThis.window = { __ModuleLoader__: { load({ id, factory }) { assert.equal(id, '@jills/dsh'); mod = factory(name => { requested.add(name); return platform[name] }) } } }
new Function(source)()
delete globalThis.window

const card = (over = {}) => ({ kind: 'suggest', messageId: 'm1', reason: '', jill: 'hello', description: 'Write a hello file', inputs: { who: 'Aidan' }, fields: ['who'], auto: false, confidence: 0.93, matcher: 'jev', note: '', run: null, ...over })
const view = (c, extra = {}) => renderToStaticMarkup(React.createElement(mod.CardView, {
  card: c, busy: false, editing: false, values: c.inputs, onEdit() {}, onValue() {}, handlers: { onStart() {}, onDismiss() {}, onNever() {} }, ...extra,
}))

test('the bundle loads through the module loader and asks only for platform modules', () => {
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['remote'])
  assert.deepEqual([...requested].sort(), ['@deepseek-ai/dsh-client-ui-primitives', 'react', 'react/jsx-runtime'])
})

test('the Definition matches typed user messages only', () => {
  const def = mod.suggestionDefinition
  const event = (data, extra = {}) => ({ type: 'user/message', seq: 7, time: '2026-10-07T10:00:00.000Z', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'say hello' }], ...data }, ...extra })
  assert.deepEqual(def.match(event({})), { id: 'jills:u1', role: 'start' })
  assert.equal(def.match(event({ source: { kind: 'compact-checkpoint' } })), null)
  assert.equal(def.match(event({ content: [{ type: 'text', text: '/jills go' }] })), null, 'slash commands get no card')
  assert.equal(def.match(event({ content: [] })), null)
  assert.equal(def.match({ type: 'tool/result', seq: 1, data: {} }), null)
  const state = def.start({}, { event: event({}), location: { kind: 'turn' } })
  assert.deepEqual(state, { messageId: 'u1', text: 'say hello', sentAt: Date.parse('2026-10-07T10:00:00.000Z') })
  const node = def.buildViewNode({ key: 'k', id: 'jills:u1', state, start: { event: event({}), location: { kind: 'turn' } } })
  assert.equal(node.kind, 'jills-suggestion')
  assert.equal(node.target, 'chat')
  assert.equal(node.anchorSeq, 7)
  assert.deepEqual(node.location, { kind: 'session' }, 'outside the Turn process fold')
  assert.equal(def.buildViewNode({ key: 'k', id: 'x' }), null)
  assert.equal(mod.textOf('plain'), 'plain')
})

test('a suggestion card shows the Jill, its inputs and four actions', () => {
  const html = view(card())
  assert.match(html, /aria-label="Jills suggestion: hello"/)
  assert.match(html, /Write a hello file/)
  assert.match(html, /<code>who<\/code> Aidan/)
  assert.match(html, /jev · 93%/)
  const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(m => m[1])
  assert.deepEqual(buttons, ['Start', 'Edit', 'Not this', 'Never'])
})

test('Edit shows one field per declared input', () => {
  const html = view(card({ fields: ['who', 'repo'] }), { editing: true })
  assert.match(html, /<input aria-label="who" value="Aidan"/)
  assert.match(html, /<input aria-label="repo" value=""/)
  assert.match(html, /aria-pressed="true"/)
  assert.deepEqual(mod.inputsFrom({ who: ' Aidan ', repo: '  ' }), { who: 'Aidan' })
})

test('started, closed, error and quiet cards', () => {
  const run = { runId: 'r1', jill: 'hello', state: 'done', terminal: true, stepsDone: 4, stepsTotal: 4, branch: 'jills/hello-r1', text: 'Jill hello · done · branch jills/hello-r1', detail: 'jills run r1 done: hello' }
  const started = view(card({ kind: 'started', run }))
  assert.match(started, /role="status"/)
  assert.match(started, /data-state="done"/)
  assert.match(started, /data-dot="done"/)
  assert.match(started, /Jill hello · done · branch jills\/hello-r1/)
  assert.ok(!started.includes('<button'), 'no buttons once started')
  assert.match(view(card({ kind: 'closed', note: 'Okay.' })), /role="note"[^>]*>Okay\./)
  assert.match(view(card({ kind: 'error', note: 'boom' })), /role="alert"[^>]*>Jills: boom/)
  assert.equal(view(card({ kind: 'quiet' })), '')
  assert.equal(mod.dotState({ ...run, state: 'needs-you' }), 'warning')
  assert.equal(mod.dotState({ ...run, state: 'stuck' }), 'error')
  assert.equal(mod.dotState({ ...run, state: 'running' }), 'ongoing')
})

test('the face unwraps Remote results and throws Remote failures', async () => {
  const face = mod.jillsFace({
    suggest: async () => ({ ok: true, value: card() }),
    start: async () => ({ ok: false, error: { message: 'gateway/internal: nope' } }),
    status: async () => ({ ok: true, value: { runId: 'r1' } }),
    dismiss: async () => ({ ok: true, value: card({ kind: 'closed' }) }),
    never: async () => ({ ok: true, value: card({ kind: 'closed' }) }),
  })
  assert.equal((await face.suggest({})).jill, 'hello')
  await assert.rejects(face.start({}), /nope/)
  assert.equal((await face.status('r1')).runId, 'r1')
})
