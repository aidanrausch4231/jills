/** Host bridge against the real Jills core: temp JILLS_HOME and git repo, mocked Jev over local HTTP. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { JillsBridge, jillsSession, loadCore, NO_WORKSPACE, runLine, startedNotice, turnsBefore } from '../lib/types/bridge.js'

const repoRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const lib = join(repoRoot, 'dist/src/index.js')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'jills-dsh-test-')))
process.env.JILLS_HOME = join(root, 'default-home') // never the real ~/.jills
delete process.env.OPENROUTER_API_KEY

const jevRequests = []
let jevReply = { label: 'new', jill: 'hello', inputs: { who: 'Aidan' }, confidence: 0.91 }
const jev = createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    jevRequests.push({ auth: req.headers.authorization, body: JSON.parse(body) })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(jevReply) } }] }))
  })
})
let jevUrl = ''
before(async () => { jev.listen(0, '127.0.0.1'); await once(jev, 'listening'); jevUrl = `http://127.0.0.1:${jev.address().port}/v1/chat/completions` })
after(() => { jev.close() })

let n = 0
/** A fresh Jills home + git repo; `jev` points the matcher at the mock server. */
function fixture({ auto = false, jev: useJev = false, agent = undefined } = {}) {
  const dir = join(root, `case-${++n}`)
  const home = join(dir, 'home'), repo = join(dir, 'repo')
  mkdirSync(home, { recursive: true }); mkdirSync(repo, { recursive: true })
  const jevLine = useJev ? `jev: { url: ${JSON.stringify(jevUrl)}, key_env: JILLS_TEST_JEV_KEY }` : 'jev: { key_env: JILLS_TEST_NO_SUCH_KEY }'
  writeFileSync(join(home, 'config.yml'), `auto: ${auto}\njill_paths: [${JSON.stringify(join(repoRoot, 'examples'))}]\nagent_paths: []\n${jevLine}\n`)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
  const bridge = new JillsBridge(loadCore(lib), { home, ...(agent ? { agent } : {}) })
  return { home, repo, bridge }
}
const msg = (over = {}) => ({ sessionId: 'sess-1', messageId: 'm1', text: 'please say hello to the team', cwd: '', sentAt: Date.now(), ...over })

async function untilTerminal(bridge, runId) {
  for (let i = 0; i < 200; i++) {
    const line = await bridge.status(runId)
    if (line.terminal) return line
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('run did not finish')
}

test('keyword fallback suggests hello with its declared inputs; cached per message', async () => {
  const { home, repo, bridge } = fixture()
  const card = await bridge.suggest(msg({ cwd: repo }))
  assert.equal(card.kind, 'suggest')
  assert.equal(card.jill, 'hello')
  assert.equal(card.matcher, 'keywords')
  assert.deepEqual(card.fields, ['who'])
  assert.equal(card.run, null)
  const again = await bridge.suggest(msg({ cwd: repo }))
  assert.deepEqual(again, card)
  const session = JSON.parse(readFileSync(join(home, 'sessions', `${jillsSession('sess-1')}.json`), 'utf8'))
  assert.equal(session.messages, 1, 'a re-render never advances the anti-nag counter')
})

test('Jev request shape and inputs come through the card', async () => {
  process.env.JILLS_TEST_JEV_KEY = 'test-key'
  try {
    jevRequests.length = 0
    jevReply = { label: 'new', jill: 'hello', inputs: { who: 'Aidan' }, confidence: 0.91 }
    const { bridge } = fixture({ jev: true })
    const card = await bridge.suggest(msg({ text: 'greet Aidan for me' }))
    assert.equal(card.kind, 'suggest')
    assert.equal(card.matcher, 'jev')
    assert.deepEqual(card.inputs, { who: 'Aidan' })
    assert.equal(card.confidence, 0.91)
    assert.equal(jevRequests.length, 1)
    assert.equal(jevRequests[0].body.model, 'typesafe/jev-router')
    assert.equal(jevRequests[0].auth, 'Bearer test-key')
    assert.match(jevRequests[0].body.messages[1].content, /New message: "greet Aidan for me"/)
  } finally { delete process.env.JILLS_TEST_JEV_KEY }
})

test('talk and history messages stay quiet; history never reaches Jev', async () => {
  process.env.JILLS_TEST_JEV_KEY = 'test-key'
  try {
    jevRequests.length = 0
    jevReply = { label: 'talk', confidence: 0.9 }
    const { bridge } = fixture({ jev: true })
    assert.equal((await bridge.suggest(msg({ text: 'how are you?' }))).kind, 'quiet')
    const old = await bridge.suggest(msg({ messageId: 'old', sentAt: Date.now() - 60 * 60_000 }))
    assert.equal(old.kind, 'quiet')
    assert.match(old.reason, /old message/)
    assert.equal((await bridge.suggest(msg({ messageId: 'blank', text: '   ' }))).kind, 'quiet')
    assert.equal(jevRequests.length, 1)
  } finally { delete process.env.JILLS_TEST_JEV_KEY }
})

test('Not this closes the card and quiets the chat', async () => {
  const { bridge } = fixture()
  await bridge.suggest(msg())
  const closed = await bridge.dismiss({ sessionId: 'sess-1', messageId: 'm1', cwd: '' })
  assert.equal(closed.kind, 'closed')
  assert.match(closed.note, /quiet in this chat/)
  const later = await bridge.suggest(msg({ messageId: 'm9', text: 'say hello again' }))
  assert.equal(later.kind, 'quiet')
  assert.match(later.reason, /dismissed/)
})

test('Never mutes the Jill for the session repo', async () => {
  const { home, repo, bridge } = fixture()
  await bridge.suggest(msg({ cwd: repo }))
  const closed = await bridge.never({ sessionId: 'sess-1', messageId: 'm1', cwd: repo })
  assert.equal(closed.kind, 'closed')
  const muted = JSON.parse(readFileSync(join(home, 'muted.json'), 'utf8'))
  assert.deepEqual(Object.values(muted), [['hello']])
  const other = new JillsBridge(loadCore(lib), { home })
  const card = await other.suggest(msg({ sessionId: 'sess-2', cwd: repo }))
  assert.equal(card.kind, 'quiet', 'muted in this repo for every chat')
})

test('Never outside a git repo returns an error card, not a crash', async () => {
  const { bridge } = fixture()
  await bridge.suggest(msg({ cwd: root }))
  const card = await bridge.never({ sessionId: 'sess-1', messageId: 'm1', cwd: root })
  assert.equal(card.kind, 'error')
  assert.match(card.note, /not in a git repo/)
})

test('Start runs the Jill once; the status line follows it to done with a branch', async () => {
  const { repo, bridge } = fixture()
  await bridge.suggest(msg({ cwd: repo }))
  const started = await bridge.start({ sessionId: 'sess-1', messageId: 'm1', jill: 'hello', inputs: { who: 'Aidan' }, cwd: repo })
  assert.equal(started.kind, 'started')
  assert.ok(started.run)
  assert.match(started.run.text, /^Jill hello · (queued|running)/)
  const twice = await bridge.start({ sessionId: 'sess-1', messageId: 'm1', jill: 'hello', inputs: {}, cwd: repo })
  assert.equal(twice.run.runId, started.run.runId, 'a double click starts one run')
  const done = await untilTerminal(bridge, started.run.runId)
  assert.equal(done.state, 'done')
  assert.equal(done.stepsDone, done.stepsTotal)
  assert.match(done.text, /^Jill hello · done · branch jills\/hello-/)
  assert.match(done.detail, /^jills run \S+ done: hello/)
  assert.match(execFileSync('git', ['show', `${done.branch}:hello.txt`], { cwd: repo, encoding: 'utf8' }), /hello Aidan/)
  assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), 'main')
  const reloaded = await bridge.suggest(msg({ cwd: repo }))
  assert.equal(reloaded.kind, 'started', 'a reload shows the status line, not the buttons')
})

test('Start with a bad repo returns an error card', async () => {
  const { bridge } = fixture()
  await bridge.suggest(msg())
  const card = await bridge.start({ sessionId: 'sess-1', messageId: 'm1', jill: 'hello', inputs: {}, cwd: join(root, 'missing') })
  assert.equal(card.kind, 'error')
  assert.match(card.note, /does not exist/)
})

test('auto mode starts the Jill from the suggestion itself', async () => {
  const { repo, bridge } = fixture({ auto: true })
  const card = await bridge.suggest(msg({ cwd: repo }))
  assert.equal(card.kind, 'started')
  assert.equal(card.auto, true)
  const done = await untilTerminal(bridge, card.run.runId)
  assert.equal(done.state, 'done')
})

test('a missing library gives quiet cards', async () => {
  const bridge = new JillsBridge(loadCore(join(root, 'nope/index.js')), { home: join(root, 'nohome') })
  const card = await bridge.suggest(msg())
  assert.equal(card.kind, 'quiet')
  assert.match(card.reason, /jills unavailable/)
  assert.ok(!existsSync(join(root, 'nohome')))
})

test('runLine text for each terminal state', () => {
  const core = { resultLine: r => `line ${r.id}` }
  const base = { id: 'r1', jill: 'hello', steps: { a: { state: 'done' }, b: { state: 'running' } } }
  assert.equal(runLine(core, { ...base, state: 'running' }).text, 'Jill hello · running · 1/2 steps')
  assert.equal(runLine(core, { ...base, state: 'done', branch: 'jills/hello-x' }).text, 'Jill hello · done · branch jills/hello-x')
  assert.equal(runLine(core, { ...base, state: 'needs-you' }).text, 'Jill hello · needs-you · merge conflict, needs you')
  assert.equal(runLine(core, { ...base, state: 'stuck', error: 'timeout' }).text, 'Jill hello · stuck · timeout')
  assert.equal(runLine(core, { ...base, state: 'failed' }).terminal, true)
  assert.equal(runLine(core, { ...base, state: 'queued' }).terminal, false)
  assert.equal(jillsSession('a/b c'), 'dsh-a_b_c')
})

// ---------------------------------------------------------------- fix round 2

/** A fake dsh session runtime: fixed turns, records what the agent is told. */
function fakeAgent({ turns = [], tellError } = {}) {
  const told = []
  const asked = []
  return {
    told, asked,
    async recentTurns(sessionId, messageId) { asked.push([sessionId, messageId]); return turns },
    async tell(sessionId, text, summary) { if (tellError) throw new Error(tellError); told.push({ sessionId, text, summary }) },
  }
}

const noRuns = home => !existsSync(join(home, 'runs')) || readdirSync(join(home, 'runs')).length === 0

test('empty or missing cwd never falls back to the Host folder: Start refuses with a clear note', async () => {
  const agent = fakeAgent()
  const { home, bridge } = fixture({ agent })
  await bridge.suggest(msg({ cwd: '' }))
  for (const cwd of ['', '   ', undefined]) {
    const card = await bridge.start({ sessionId: 'sess-1', messageId: 'm1', jill: 'hello', inputs: {}, cwd })
    assert.equal(card.kind, 'error')
    assert.equal(card.note, NO_WORKSPACE)
    assert.match(card.note, /open a workspace folder first/)
  }
  assert.ok(noRuns(home), 'no run was started (in the Host folder or anywhere)')
  assert.equal(agent.told.length, 0)
  const never = await bridge.never({ sessionId: 'sess-1', messageId: 'm1', cwd: '' })
  assert.equal(never.kind, 'error')
  assert.equal(never.note, NO_WORKSPACE)
  assert.ok(!existsSync(join(home, 'muted.json')), 'no mute for the Host folder repo')
})

test('auto mode with no cwd refuses instead of running in the Host folder', async () => {
  const { home, bridge } = fixture({ auto: true })
  const card = await bridge.suggest(msg({ cwd: '' }))
  assert.equal(card.kind, 'error')
  assert.equal(card.note, NO_WORKSPACE)
  assert.ok(noRuns(home))
})

test('Jev gets the last 3 turns before the message, not just the new message', async () => {
  process.env.JILLS_TEST_JEV_KEY = 'test-key'
  try {
    jevRequests.length = 0
    jevReply = { label: 'new', jill: 'hello', inputs: { who: 'Aidan' }, confidence: 0.91 }
    const turns = [
      { role: 'user', text: 'u1' }, { role: 'assistant', text: 'a1' }, { role: 'user', text: 'u2' }, { role: 'assistant', text: 'a2' },
    ]
    const agent = fakeAgent({ turns })
    const { bridge } = fixture({ jev: true, agent })
    await bridge.suggest(msg({ text: 'greet Aidan for me' }))
    assert.deepEqual(agent.asked, [['sess-1', 'm1']])
    const user = jevRequests[0].body.messages[1].content
    assert.match(user, /Last turns: \[\{"role":"assistant","text":"a1"\},\{"role":"user","text":"u2"\},\{"role":"assistant","text":"a2"\}\]/)
    assert.match(user, /New message: "greet Aidan for me"/)
  } finally { delete process.env.JILLS_TEST_JEV_KEY }
})

test('turnsBefore reads typed user and assistant turns before the message from dsh events', () => {
  const user = (id, text, kind = 'user') => ({ type: 'user/message', data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind } } })
  const assistant = text => ({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text }] } } })
  const events = [
    { type: 'session/start', data: {} },
    user('u0', 'zero'), assistant('r0'),
    user('u1', 'one'), user('x', 'injected context', 'schedule'), { type: 'tool/call', data: { name: 'read' } }, assistant(''), assistant('r1'),
    user('m1', 'the new message'), assistant('after'),
  ]
  assert.deepEqual(turnsBefore(events, 'm1'), [{ role: 'assistant', text: 'r0' }, { role: 'user', text: 'one' }, { role: 'assistant', text: 'r1' }])
  assert.deepEqual(turnsBefore(events, 'm1', 5).map(t => t.text), ['zero', 'r0', 'one', 'r1'])
  assert.deepEqual(turnsBefore([], 'm1'), [])
})

test('Start tells the main agent the run id and that the result will be reported back', async () => {
  const agent = fakeAgent()
  const { repo, bridge } = fixture({ agent })
  await bridge.suggest(msg({ cwd: repo }))
  const card = await bridge.start({ sessionId: 'sess-1', messageId: 'm1', jill: 'hello', inputs: { who: 'x' }, cwd: repo })
  assert.equal(card.kind, 'started')
  assert.equal(card.note, 'The agent was told.')
  assert.equal(agent.told.length, 1)
  const { sessionId, text, summary } = agent.told[0]
  assert.equal(sessionId, 'sess-1')
  assert.ok(text.includes(`run ${card.run.runId}`), text)
  assert.match(text, /reports the result/)
  assert.match(text, /Do not start it again/)
  assert.equal(text, startedNotice({ id: card.run.runId, jill: 'hello' }))
  assert.match(summary, /Jill hello started/)
  await untilTerminal(bridge, card.run.runId)
})

test('a failing agent notice never breaks the started card', async () => {
  const { repo, bridge } = fixture({ agent: fakeAgent({ tellError: 'agent busy' }) })
  await bridge.suggest(msg({ cwd: repo }))
  const card = await bridge.start({ sessionId: 'sess-1', messageId: 'm1', jill: 'hello', inputs: {}, cwd: repo })
  assert.equal(card.kind, 'started')
  assert.match(card.note, /not told: agent busy/)
  await untilTerminal(bridge, card.run.runId)
})
