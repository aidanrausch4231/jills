/** Isolated dsh smoke: real dsh Host + Remote + browser, a mocked Jev endpoint, a temp git repo.
 * All state lives in a new temp folder (DSH_HOME, JILLS_HOME, repo). Never touches ~/.dsh or ~/.jills,
 * and listens on a random port (never 3080).
 *
 *   node test/smoke/dsh-smoke.mjs [screenshot-dir]
 *
 * Needs a built add-on (pnpm build), a built Jills core (repo pnpm build), the prepared runtime at
 * ../switchboard/dsh-runtime (override with DSH_RUNTIME) and Playwright Chromium. */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { chromium } from 'playwright'

const addon = fileURLToPath(new URL('../../', import.meta.url))
const repoRoot = resolve(addon, '../..')
const runtime = resolve(process.env.DSH_RUNTIME ?? join(repoRoot, '../switchboard/dsh-runtime'))
const output = resolve(process.argv[2] ?? join(repoRoot, '.work/shots'))
await mkdir(output, { recursive: true })
// Start clean: a stale jills-dsh-failure.png (or an old card shot) from an earlier run must never
// be mistaken for this run's result.
for (const f of readdirSync(output)) if (/^jills-dsh-.*\.png$/.test(f)) rmSync(join(output, f), { force: true })
const temp = realpathSync(await mkdtemp(join(tmpdir(), 'jills-dsh-smoke-')))
const dshHome = join(temp, 'dsh-home')
const jillsHome = join(temp, 'jills-home')
const repo = join(temp, 'repo')
const title = `Jills smoke ${temp.slice(-6)}`
const message = 'Please say hello to Aidan from the team.'
const earlier = 'What does this repo do?'

// A small git repo the hello Jill can branch from.
await mkdir(repo, { recursive: true })
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
git('init', '-q', '-b', 'main')
git('-c', 'user.email=smoke@jills.local', '-c', 'user.name=jills smoke', 'commit', '-q', '--allow-empty', '-m', 'init')

// Mocked Jev: records each request; names the hello Jill for the hello message, "talk" otherwise.
const jevRequests = []
const jev = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    jevRequests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) })
    const hello = /New message: "Please say hello/.test(JSON.parse(body).messages[1].content)
    const content = JSON.stringify(hello ? { label: 'new', jill: 'hello', inputs: { who: 'Aidan' }, confidence: 0.93 } : { label: 'talk', confidence: 0.9 })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content } }] }))
  })
})
jev.listen(0, '127.0.0.1')
await once(jev, 'listening')
const jevUrl = `http://127.0.0.1:${jev.address().port}/v1/chat/completions`
await mkdir(jillsHome, { recursive: true })
await writeFile(join(jillsHome, 'config.yml'), [
  'auto: false',
  `jill_paths: [${JSON.stringify(join(repoRoot, 'examples'))}]`,
  'agent_paths: []',
  `jev: { url: ${JSON.stringify(jevUrl)}, key_env: JILLS_SMOKE_JEV_KEY, model: typesafe/jev-router }`,
  '',
].join('\n'))

const env = { ...process.env }
for (const name of Object.keys(env)) if (/KEY|SECRET|TOKEN|PASSWORD/.test(name)) delete env[name]
Object.assign(env, {
  DSH_HOME: dshHome, JILLS_HOME: jillsHome, JILLS_LIB: join(repoRoot, 'dist/src/index.js'), JILLS_SMOKE_JEV_KEY: 'smoke-fake-key',
  JILLS_SMOKE_REPO: repo, JILLS_SMOKE_TITLE: title, JILLS_SMOKE_MESSAGE: message, JILLS_SMOKE_EARLIER: earlier,
})
/** File text; dsh session logs (*.zstd) are a series of zstd frames, decoded one by one. */
function readText(file) {
  const buf = readFileSync(file)
  if (!file.endsWith('.zstd')) return buf.toString('utf8')
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  for (let i = buf.indexOf(magic); i >= 0; i = buf.indexOf(magic, i + 1)) starts.push(i)
  let text = ''
  for (let k = 0; k < starts.length; k++) {
    try { text += zstdDecompressSync(buf.subarray(starts[k], starts[k + 1] ?? buf.length)).toString('utf8') } catch { /* magic bytes inside a frame */ }
  }
  return text
}
function dsh(args) {
  const result = spawnSync('pnpm', ['dsh', ...args], { cwd: runtime, env, encoding: 'utf8', timeout: 180000 })
  assert.equal(result.status, 0, `dsh ${args.join(' ')} failed: ${result.stderr}\n${result.stdout}`)
  return result.stdout
}
dsh(['--profile', 'jills', '--from-default-profile', 'web', '--dump-config'])
dsh(['plugin', '--profile', 'jills', 'add', addon])
const patch = join(temp, 'smoke.json')
await writeFile(patch, JSON.stringify([
  { id: 'llm-deepseek', disabled: true },
  { id: 'session-title-llm', disabled: true },
  { id: 'agent-default-model', config: { provider: 'jills-scripted', model: 'scripted' } },
  { id: 'hmr', disabled: true }, { id: 'open-in-app', disabled: true }, { id: 'ui-open-in-app', disabled: true },
  { insert: [{ id: 'jills-smoke-fixture', name: fileURLToPath(new URL('./fixture.mjs', import.meta.url)) }] },
]))
const child = spawn('pnpm', ['dsh', '--profile', 'jills', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  cwd: runtime, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
const exited = once(child, 'exit')
let logs = ''
child.stdout.on('data', chunk => { logs += chunk }); child.stderr.on('data', chunk => { logs += chunk })
let browser
let page
const errors = []
const warnings = []
try {
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => { clean(); reject(new Error('dsh did not announce its URL')) }, 120000)
    const clean = () => { clearTimeout(timer); child.stdout.off('data', inspect); child.stderr.off('data', inspect); child.off('exit', failed) }
    const failed = code => { clean(); reject(new Error(`dsh exited before readiness: ${code}`)) }
    const inspect = () => { const match = logs.match(/http:\/\/127\.0\.0\.1:\d+\S*/); if (match) { clean(); resolveUrl(match[0].replace(/\x1b\[[\d;]*m/g, '')) } }
    child.on('exit', failed); child.stdout.on('data', inspect); child.stderr.on('data', inspect); inspect()
  })
  assert.ok(!/:3080\b/.test(url), 'smoke must not use port 3080')
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: 'en-US', colorScheme: 'dark' })
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); else if (m.type() === 'warning') warnings.push(m.text()) })
  await page.addLocatorHandler(page.getByRole('button', { name: /^(Continue|继续)$/ }), button => button.click())
  await page.addLocatorHandler(page.getByRole('button', { name: 'Configure later', exact: true }), button => button.click())
  await page.goto(url, { waitUntil: 'load' })
  // The fixture writes its two-turn chat while the Host starts; reload until the session is listed.
  for (let attempt = 1; ; attempt++) {
    try {
      await page.getByRole('textbox', { name: 'Search session names' }).fill(title, { timeout: 90000 })
      await page.getByRole('treeitem', { name: new RegExp(title) }).first().click({ timeout: 30000 })
      break
    } catch (error) {
      if (attempt >= 4) throw error
      await page.reload({ waitUntil: 'load' })
    }
  }
  const card = page.getByRole('group', { name: 'Jills suggestion: hello' })
  await card.waitFor({ timeout: 60000 })
  for (const name of ['Start', 'Edit', 'Not this', 'Never']) await card.getByRole('button', { name, exact: true }).waitFor()
  await card.getByText('Aidan').waitFor()
  await card.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(output, 'jills-dsh-card.png') })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: join(output, 'jills-dsh-card-light.png') })
  await page.emulateMedia({ colorScheme: 'dark' })

  // Edit shows the declared input with Jev's value; Start runs the Jill; the status line follows it.
  await card.getByRole('button', { name: 'Edit', exact: true }).click()
  assert.equal(await card.getByRole('textbox', { name: 'who' }).inputValue(), 'Aidan')
  await card.getByRole('textbox', { name: 'who' }).fill('Aidan and team')
  await page.screenshot({ path: join(output, 'jills-dsh-edit.png') })
  await card.getByRole('button', { name: 'Start', exact: true }).click()
  const status = page.getByRole('status', { name: 'Jill hello status' })
  await status.waitFor({ timeout: 30000 })
  await status.and(page.locator('[data-state="done"]')).waitFor({ timeout: 90000 })
  const line = (await status.innerText()).split('\n')[0]
  assert.match(line, /Jill hello · done · branch jills\/hello-/)
  await page.getByText('The agent was told.').waitFor({ timeout: 10000 })
  await page.screenshot({ path: join(output, 'jills-dsh-status.png') })

  const branches = git('branch', '--list', 'jills/hello-*').trim()
  assert.ok(branches, 'the run branch exists in the repo')
  const branch = branches.replace(/^[*+ ]+/, '').split('\n')[0].trim()
  assert.match(git('show', `${branch}:hello.txt`), /hello Aidan and team/)
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main', 'the user branch is untouched')

  assert.equal(jevRequests.length, 2, 'one Jev call per user message')
  const helloRequest = jevRequests.find(r => /New message: "Please say hello/.test(r.body.messages[1].content))
  assert.ok(helloRequest, 'Jev was asked about the hello message')
  assert.equal(helloRequest.body.model, 'typesafe/jev-router')
  // Jev reads the turns before the message, from the dsh Session log.
  const lastTurns = /Last turns: (\[.*\])/.exec(helloRequest.body.messages[1].content)?.[1]
  assert.deepEqual(JSON.parse(lastTurns), [
    { role: 'user', text: earlier },
    { role: 'assistant', text: 'Sure. (scripted reply from the Jills smoke fixture)' },
  ])
  // The main agent was told: the started notice is in the persisted Session log.
  const runId = /jills\/hello-(\S+)/.exec(branch)[1]
  const notice = `started as run ${runId} in its own worktree`
  const files = []
  const walk = dir => { for (const name of readdirSync(dir)) { if (name === 'node_modules') continue; const p = join(dir, name); const st = lstatSync(p); if (st.isDirectory()) walk(p); else if (st.isFile() && st.size < 20_000_000) files.push(p) } }
  walk(dshHome)
  const logged = files.filter(f => readText(f).includes(notice))
  assert.ok(logged.length > 0, `the agent notice for run ${runId} is in the dsh session log`)
  assert.ok(!logs.includes('smoke-fake-key'), 'the Jev key never appears in dsh logs')
  assert.deepEqual(errors, [])
  assert.ok(!readdirSync(output).includes('jills-dsh-failure.png'), 'no failure screenshot from this run')
  console.log(`PASS dsh smoke: card shown, Jev got the last turns, Edit + Start ran Jill hello -> ${line}; agent told (${logged.map(f => f.slice(temp.length)).join(', ')})`)
  console.log(`screenshots: ${output}/jills-dsh-card.png, jills-dsh-status.png (temp: ${temp})`)
} catch (error) {
  await page?.screenshot({ path: join(output, 'jills-dsh-failure.png') }).catch(() => {})
  console.error('jills DOM:', await page?.evaluate(() => [...document.querySelectorAll('.jills-card, .jills-note, [class*=jills]')].map(e => e.outerHTML.slice(0, 600)).join('\n')).catch(String))
  console.error(`page errors: ${JSON.stringify(errors, null, 1)}\nwarnings: ${JSON.stringify(warnings.slice(-20), null, 1)}\njev requests: ${jevRequests.length}\ntemp: ${temp}`)
  console.error(logs.replace(/http:\/\/127\.0\.0\.1:\d+\S*/g, '<LOCAL_URL>').slice(-6000))
  throw error
} finally {
  await browser?.close()
  if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM')
  await exited
  jev.close()
}
