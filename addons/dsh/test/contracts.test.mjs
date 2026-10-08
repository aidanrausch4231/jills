/** Generated Typert contracts and the Host service registration. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import TYPERT_REMOTE from '../lib/typert.remote-client.js'
import { TYPERT } from '../lib/typert.host.js'
import JillsDsh from '../lib/index.js'

const METHODS = ['dismiss', 'never', 'start', 'status', 'suggest']

test('the Remote contribution names five jills methods', () => {
  const ids = TYPERT_REMOTE.descriptors.map(m => m.id).sort()
  assert.deepEqual(ids, METHODS.map(m => `@jills/dsh#jills/${m}`))
  for (const method of TYPERT_REMOTE.descriptors) assert.equal(method.namespace, 'jills')
  assert.ok(TYPERT, 'host reflection exists')
})

test('the Remote codecs validate the card shape', () => {
  const suggest = TYPERT_REMOTE.descriptors.find(m => m.method === 'suggest')
  const request = suggest.parameters[0].codec.create()
  assert.ok(request.safeParse({ sessionId: 's', messageId: 'm', text: 't', cwd: '', sentAt: 1 }).success)
  assert.ok(!request.safeParse({ sessionId: 's' }).success)
})

test('the Host service binds the jills namespace and marks five Remote methods', () => {
  const ctx = new Context()
  const service = new JillsDsh(ctx, { home: '/nonexistent-jills-home' })
  assert.deepEqual(remoteMethods(service).map(m => m.name ?? m.exportName ?? m.method).sort(), METHODS)
})

test('the bundle patch inserts the plugin and the manifest declares both halves', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'].default, './lib/client.js')
  assert.match(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), /name: '@jills\/dsh'/)
})
