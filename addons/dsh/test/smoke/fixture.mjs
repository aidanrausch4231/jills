/** Test-only dsh plugin for the smoke: a scripted model (never contacts a provider) and one chat
 * whose user message Jev should match to the `hello` Jill. Pattern from switchboard's scripted.mjs. */
import { randomUUID } from 'node:crypto'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'

class ScriptedAdapter extends LlmAdapter {
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
  listModels() { return Promise.resolve([{ id: 'scripted', name: 'Jills smoke fixture' }]) }
  async *stream() {
    const text = 'Sure. (scripted reply from the Jills smoke fixture)'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const inject = ['llm', 'agents', 'agentPresets', 'sessionTitle']
export async function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['jills-scripted'], new ScriptedAdapter()))
  const cwd = process.env.JILLS_SMOKE_REPO
  const title = process.env.JILLS_SMOKE_TITLE
  const message = process.env.JILLS_SMOKE_MESSAGE
  const earlier = process.env.JILLS_SMOKE_EARLIER
  if (!cwd || !title || !message) throw new Error('JILLS_SMOKE_REPO, JILLS_SMOKE_TITLE and JILLS_SMOKE_MESSAGE are required by the test-only fixture')
  // Preset plugins register after this fixture can start; wait for the default one.
  let preset
  for (let i = 0; ; i++) {
    try { preset = await ctx.agentPresets.resolve(); break } catch (error) {
      if (i > 240) throw error
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  const lease = await ctx.agentPresets.acquireScope(preset.id)
  try {
    const handle = await ctx.agents.create({
      sessionId: `jills-smoke-${randomUUID()}`, meta: { cwd, agentPreset: preset.id },
      agentOptions: { provider: 'jills-scripted', model: 'scripted' },
      setup: async (scope) => { await ctx.agentPresets.mount(scope, preset.id) },
    })
    try {
      // An earlier turn first, so Jev's "last turns" for the hello message are not empty.
      for (const text of earlier ? [earlier, message] : [message]) {
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        await handle.agent.whenIdle()
      }
      ctx.sessionTitle.rename(handle.agent.session, title)
    } finally { await handle.dispose() }
  } finally { await lease[Symbol.asyncDispose]() }
}
