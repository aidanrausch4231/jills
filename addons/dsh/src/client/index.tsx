/** Jills browser plugin: mount the `jills` Remote, then add one card after each typed user message. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import jillsRemote from '@jills/dsh/remote'
import { CSS, JillsCardNode } from './Card.tsx'
import { jillsFace, NODE_KIND, suggestionDefinition, type JillsFace } from './model.ts'

export { CardView, StatusLine, JillsCardNode, CSS, POLL_MS } from './Card.tsx'
export { suggestionDefinition, userMessage, textOf, dotState, inputsFrom, jillsFace, NODE_KIND } from './model.ts'

type NodeProps = PropsRuntime<'conversation.chat.node', 'jills-suggestion'> & InjectFace<{ face: JillsFace }>

/** Chat node renderer bound to the Remote face. */
function SuggestionNode(props: NodeProps) {
  return <JillsCardNode data={props.node.data} sessionId={String(props.sessionId)} cwd={props.cwd ?? ''} face={props.face} />
}

function injectCss(): () => void {
  if (typeof document === 'undefined' || document.querySelector('style[data-plugin-css="@jills/dsh"]')) return () => {}
  const tag = document.createElement('style')
  tag.dataset.pluginCss = '@jills/dsh'
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => { tag.remove() }
}

/** Card registration, once the Remote namespace is mounted. */
const presentation = {
  name: 'jills-presentation',
  inject: ['slots', 'remote', 'remote.jills'],
  apply(ctx: Context): void {
    const face = jillsFace(ctx.remote.jills)
    ctx.effect(injectCss, 'jills: styles')
    ctx.inject(['uiConversation'], (scope) => {
      scope.effect(() => scope.uiConversation.events.register(suggestionDefinition), 'jills: suggestion definition')
      scope.slots.inject('conversation.chat.node', () => scope.slots.register({
        name: 'conversation.chat.node', key: NODE_KIND, inject: () => ({ face }),
      }, SuggestionNode))
    })
  },
}

/** The Remote assembly needs only the transport service. */
export const inject = ['remote']

/**
 * Mount the generated `jills` namespace and the card presentation.
 * @param ctx - browser Cordis context.
 */
export async function apply(ctx: Context): Promise<void> {
  const dispose = await ctx.remote.$mount(jillsRemote)
  ctx.effect(() => dispose, 'jills: Remote contribution')
  ctx.plugin(presentation)
}
