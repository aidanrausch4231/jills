/** The Jills suggestion card [Start][Edit][Not this][Never] and the run status line. */
import { useEffect, useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { JillsCard, RunLine } from '../types.ts'
import { dotState, inputsFrom, type JillsFace, type MessageData } from './model.ts'

/** Card actions bound by the stateful node. */
export interface CardHandlers {
  onStart(inputs: Record<string, string>): void
  onDismiss(): void
  onNever(): void
}

/** Status line for a started run. */
export function StatusLine({ run }: { run: RunLine }) {
  return <div className="jills-status" role="status" aria-label={`Jill ${run.jill} status`} title={run.detail} data-state={run.state}>
    <StateDot state={dotState(run)} />
    <span>{run.text}</span>
  </div>
}

/**
 * Stateless card view (server-renderable for tests).
 * @param props - card, edit state and handlers.
 */
export function CardView({ card, busy, editing, values, onEdit, onValue, handlers }: {
  card: JillsCard
  busy: boolean
  editing: boolean
  values: Record<string, string>
  onEdit(): void
  onValue(name: string, value: string): void
  handlers: CardHandlers
}) {
  if (card.kind === 'quiet') return null
  if (card.kind === 'started' && card.run) return <section className="jills-card jills-card-started" aria-label="Jills run">
    <StatusLine run={card.run} />
    {card.note && <div className="jills-note jills-run-note">{card.note}</div>}
  </section>
  if (card.kind === 'closed' || card.kind === 'error') return <div className="jills-note" role={card.kind === 'error' ? 'alert' : 'note'} data-kind={card.kind}>
    {card.kind === 'error' ? `Jills: ${card.note}` : card.note}
  </div>
  const names = [...new Set([...card.fields, ...Object.keys(card.inputs)])]
  const shown = Object.entries(values).filter(([, v]) => v.trim() !== '')
  return <section className="jills-card" role="group" aria-label={`Jills suggestion: ${card.jill}`}>
    <header>
      <span className="jills-eyebrow">Jev suggests a Jill</span>
      {card.confidence > 0 && <span className="jills-meta">{card.matcher} · {Math.round(card.confidence * 100)}%</span>}
    </header>
    <strong className="jills-name">{card.jill}</strong>
    {card.description && <p className="jills-desc">{card.description}</p>}
    {!editing && shown.length > 0 && <ul className="jills-inputs" aria-label="Inputs">
      {shown.map(([k, v]) => <li key={k}><code>{k}</code> {v}</li>)}
    </ul>}
    {editing && <div className="jills-edit" aria-label="Edit inputs">
      {names.length === 0 && <p className="jills-desc">This Jill takes no inputs.</p>}
      {names.map(name => <label key={name}>
        <span>{name}</span>
        <input aria-label={name} value={values[name] ?? ''} disabled={busy} onChange={e => onValue(name, e.currentTarget.value)} />
      </label>)}
    </div>}
    <div className="jills-actions">
      <Button size="sm" variant="primary" disabled={busy} onClick={() => handlers.onStart(inputsFrom(values))}>Start</Button>
      <Button size="sm" variant="outline" disabled={busy} aria-pressed={editing} onClick={onEdit}>Edit</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={handlers.onDismiss}>Not this</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={handlers.onNever}>Never</Button>
    </div>
  </section>
}

/** Poll interval for the status line. */
export const POLL_MS = 1500

/**
 * Stateful chat node: asks the Host once per message, then follows the run.
 * @param props - message, session identity and the bound Jills face.
 */
export function JillsCardNode({ data, sessionId, cwd, face }: { data: MessageData; sessionId: string; cwd: string; face: JillsFace }) {
  const [card, setCard] = useState<JillsCard | undefined>()
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const action = { sessionId, messageId: data.messageId, cwd }

  useEffect(() => {
    let live = true
    void face.suggest({ ...action, text: data.text, sentAt: data.sentAt })
      .then(next => { if (live) { setCard(next); setValues(next.inputs) } })
      .catch(() => { /* Host unavailable: show nothing */ })
    return () => { live = false }
  }, [sessionId, data.messageId])

  const runId = card?.run && !card.run.terminal ? card.run.runId : undefined
  useEffect(() => {
    if (!runId) return
    let live = true
    const tick = (): void => {
      void face.status(runId).then(run => { if (live) setCard(c => c ? { ...c, run } : c) }).catch(() => {})
    }
    tick()
    const timer = setInterval(tick, POLL_MS)
    return () => { live = false; clearInterval(timer) }
  }, [runId])

  if (!card) return null
  const act = (request: Promise<JillsCard>): void => {
    setBusy(true)
    void request.then(setCard, (error: unknown) => setCard({ ...card, kind: 'error', note: String(error) })).finally(() => setBusy(false))
  }
  return <CardView card={card} busy={busy} editing={editing} values={values}
    onEdit={() => setEditing(e => !e)}
    onValue={(name, value) => setValues(v => ({ ...v, [name]: value }))}
    handlers={{
      onStart: inputs => act(face.start({ ...action, jill: card.jill, inputs })),
      onDismiss: () => act(face.dismiss(action)),
      onNever: () => act(face.never(action)),
    }} />
}

/** Card styles, injected once; dsh design tokens with plain fallbacks. */
export const CSS = `
.jills-card { margin: 6px 0 10px; padding: 12px 14px; display: grid; gap: 6px; max-width: 560px; border: 0.5px solid var(--dsw-alias-border-l3, #8884); border-radius: var(--dsw-radius-md, 10px); background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary, inherit); font-size: 13px; line-height: 1.5; }
.jills-card header { display: flex; justify-content: space-between; gap: 12px; }
.jills-eyebrow { color: var(--dsw-alias-label-tertiary, #888); font-size: 12px; }
.jills-meta { color: var(--dsw-alias-label-tertiary, #888); font-size: 11px; }
.jills-name { font-size: 14px; font-weight: 600; }
.jills-desc { margin: 0; color: var(--dsw-alias-label-secondary, #999); }
.jills-inputs { margin: 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 6px; }
.jills-inputs li { padding: 2px 8px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, #8882); }
.jills-inputs code { color: var(--dsw-alias-label-secondary, #999); margin-right: 4px; }
.jills-edit { display: grid; gap: 6px; }
.jills-edit label { display: grid; grid-template-columns: 110px 1fr; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary, #999); }
.jills-edit input { padding: 5px 8px; border: 0.5px solid var(--dsw-alias-border-l3, #8886); border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-module-platform, transparent); color: var(--dsw-alias-label-primary, inherit); font: inherit; }
.jills-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.jills-card-started { padding: 8px 12px; gap: 2px; }
.jills-run-note { margin: 0; font-size: 11px; }
.jills-status[data-state='done'] { color: var(--dsw-alias-state-success-primary, #3a3); }
.jills-status[data-state='failed'], .jills-status[data-state='stuck'] { color: var(--dsw-alias-state-error-primary, #d33); }
.jills-status[data-state='needs-you'] { color: var(--dsw-alias-state-warn-primary, #d90); }
.jills-status { display: flex; align-items: center; gap: 8px; overflow-wrap: anywhere; }
.jills-note { margin: 4px 0 10px; color: var(--dsw-alias-label-tertiary, #888); font-size: 12px; }
.jills-note[data-kind='error'] { color: var(--dsw-alias-state-error-primary, #d33); }
`
