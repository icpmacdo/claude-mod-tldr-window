import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Engine, Peer, Saved, Tldr } from '../types'
import { DIGEST_SYSTEM, FORK_ASK, ago, digestOf, parseTldr, shortPath, tokens } from './summary'

const PANE = 'tldr'
const PREFIX = 'tldr:'
const HOUR = 60 * 60 * 1000
const PEER_WINDOW = 24 * HOUR
const PRUNE_AFTER = 7 * 24 * HOUR

const tldr = atom({ plugin: 'tldr-window', key: 'tldr' } as const, null)
const isBusy = atom({ plugin: 'tldr-window', key: 'isBusy' } as const, false)
const problem = atom({ plugin: 'tldr-window', key: 'problem' } as const, null)
const peers = atom({ plugin: 'tldr-window', key: 'peers' } as const, [])
const checkedAt = atom({ plugin: 'tldr-window', key: 'checkedAt' } as const, 0)
const isDismissed = atom({ plugin: 'tldr-window', key: 'isDismissed' } as const, false)

type Outcome = { text: string; cachedTokens: number; outputTokens: number } | { problem: string } | undefined

function whyUnanswered(r: { reason: string; status?: number | null }): string {
  return r.reason === 'api-error' && typeof r.status === 'number' ? `API error ${r.status}` : r.reason
}

async function viaFork($: EngineInterface): Promise<Outcome> {
  const r = await $.model.fork({ prompt: FORK_ASK })
  if (!r.isAnswered) return r.reason === 'nothing-to-fork' ? undefined : { problem: whyUnanswered(r) }

  return {
    text: r.text,
    cachedTokens: r.usage.cache_read_input_tokens ?? 0,
    outputTokens: r.usage.output_tokens ?? 0,
  }
}

async function viaHaiku($: EngineInterface): Promise<Outcome> {
  const messages = await $.session.messages()
  if (!messages.some(m => m.role === 'assistant')) return undefined

  const r = await $.model.complete({
    model: 'haiku',
    system: DIGEST_SYSTEM,
    prompt: digestOf(messages),
    maxTokens: 300,
    timeoutMs: 30_000,
  })
  if (!r.isAnswered) return { problem: whyUnanswered(r) }

  return { text: r.text, cachedTokens: 0, outputTokens: r.usage.output_tokens ?? 0 }
}

async function storeKey($: EngineInterface): Promise<string> {
  return PREFIX + (await $.session.id())
}

async function refreshPeers($: EngineInterface): Promise<void> {
  const self = await storeKey($)
  const at = await $.clock.now()
  const list: Peer[] = []

  for (const key of await $.store.keys()) {
    if (!key.startsWith(PREFIX) || key === self) continue
    const saved = (await $.store.get(key)) as Saved | undefined
    if (saved?.tldr === undefined || saved.closedAt !== undefined) continue
    if (at - saved.tldr.updatedAt > PEER_WINDOW) continue
    list.push({
      sessionId: saved.sessionId,
      title: saved.tldr.title,
      now: saved.tldr.now,
      cwd: saved.cwd,
      updatedAt: saved.tldr.updatedAt,
    })
  }

  list.sort((a, b) => b.updatedAt - a.updatedAt)
  await update($, peers, () => list.slice(0, 8))
  await update($, checkedAt, () => at)
}

async function prune($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith(PREFIX)) continue
    const saved = (await $.store.get(key)) as Saved | undefined
    const last = saved?.closedAt ?? saved?.tldr?.updatedAt ?? 0
    if (at - last > PRUNE_AFTER) await $.store.delete(key)
  }
}

async function showPane($: EngineInterface): Promise<void> {
  if (await read($, isDismissed)) return
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (!isOpen) await $.ui.open({ id: PANE, title: 'TL;DR', columns: 40, rows: 3 })
}

let isRunning = false

async function refresh($: EngineInterface, engine: Engine): Promise<void> {
  if (isRunning) return
  isRunning = true
  await update($, isBusy, () => true)
  // Open before the model call so the pane says "Summarizing…" the moment a turn ends, not seconds later.
  await showPane($)

  try {
    const outcome = engine === 'haiku' ? await viaHaiku($) : await viaFork($)
    if (outcome === undefined) return
    if ('problem' in outcome) {
      await update($, problem, () => `Summary failed: ${outcome.problem}`)
      return
    }

    const fields = parseTldr(outcome.text)
    if (fields === undefined) {
      await update($, problem, () => 'The model answered in an unexpected format')
      return
    }

    const next: Tldr = {
      ...fields,
      updatedAt: await $.clock.now(),
      engine,
      cachedTokens: outcome.cachedTokens,
      outputTokens: outcome.outputTokens,
    }
    await update($, tldr, () => next)
    await update($, problem, () => null)

    const saved: Saved = { sessionId: await $.session.id(), cwd: await $.session.cwd(), tldr: next }
    await $.store.set(PREFIX + saved.sessionId, saved)
    await refreshPeers($)
  } finally {
    isRunning = false
    await update($, isBusy, () => false)
  }
}

// Marks this window closed for the others, then forgets its TL;DR (a /clear or /resume starts afresh).
async function retire($: EngineInterface): Promise<void> {
  const key = await storeKey($)
  const saved = (await $.store.get(key)) as Saved | undefined
  if (saved !== undefined) await $.store.set(key, { ...saved, closedAt: await $.clock.now() })
  await update($, tldr, () => null)
}

export const register: Register = (on, options) => {
  const engine: Engine = options.engine === 'haiku' ? 'haiku' : 'fork'
  const isEveryTurn = options.refresh !== 'manual'
  const shouldRetitle = options.retitle_session !== false

  on('session.start', async ($, e, next) => {
    await update($, isBusy, () => false)
    await prune($)

    // A resumed session shows its last TL;DR at once and counts as open again.
    const key = await storeKey($)
    const saved = (await $.store.get(key)) as Saved | undefined
    if (saved?.tldr !== undefined) {
      const { closedAt: _closed, ...open } = saved
      await $.store.set(key, open)
      await update($, tldr, () => saved.tldr)
      void showPane($)
    }

    await refreshPeers($)
    $.clock.every(30_000, () => refreshPeers($))

    try {
      await $.command.register({
        name: 'tldr',
        description: 'Show what this window is working on, and refresh the summary',
        immediate: true,
      })
    } catch (error) {
      $.ui.log(`/tldr not registered: ${String(error)}`)
    }

    return next(e)
  })

  on('command.run', { command: 'tldr' }, async $ => {
    await update($, isDismissed, () => false)
    await $.ui.open({ id: PANE, title: 'TL;DR', columns: 40, rows: 3 })
    $.clock.after(0, () => refresh($, engine))

    return {}
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const isMainAnswer = e.agentId === undefined && (e.reason === 'answer' || e.reason === 'aborted')
    if (!isEveryTurn || !isMainAnswer) return result

    // Nothing draws in a plain `claude -p` run, so no one would read the summary: skip the model call.
    if ((await $.session.surfaces()).length === 0) return result
    $.clock.after(250, () => refresh($, engine))

    return result
  })

  on('session.end', async ($, e, next) => {
    await retire($)
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await update($, isDismissed, () => true)
    return next(e)
  })

  // Names the session (and so the window) after the TL;DR, a turn behind: the title read is the last one made.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    const current = await read($, tldr)
    if (!shouldRetitle || current === null) return result

    return { ...result, sessionTitle: current.title }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, tldr)
    const busy = await read($, isBusy)
    const trouble = await read($, problem)
    const others = await read($, peers)
    const at = Math.max(await read($, checkedAt), current?.updatedAt ?? 0)

    if (e.props.placement === 'inline') {
      return (
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">
            {current === null ? (busy ? 'TL;DR: summarizing…' : 'TL;DR: nothing yet') : `TL;DR: ${current.title}`}
          </Text>
          {current !== null && current.now !== '' && (
            <Text dimColor wrap="truncate-end">
              {current.now}
            </Text>
          )}
        </Box>
      )
    }

    const section = (label: string, text: string) =>
      text === '' ? null : (
        <Box flexDirection="column">
          <Text dimColor>{label}</Text>
          <Text>{text}</Text>
        </Box>
      )

    const footer =
      current === null
        ? ''
        : [
            busy ? 'refreshing…' : ago(current.updatedAt, at),
            current.engine === 'fork' ? `${tokens(current.cachedTokens)} cached` : 'haiku',
            `${tokens(current.outputTokens)} out`,
          ].join(' · ')

    return (
      <Box flexDirection="column" gap={1}>
        {current === null ? (
          <Text dimColor>
            {busy ? 'Summarizing this session…' : 'No TL;DR yet. It appears after Claude finishes a turn, or press Refresh.'}
          </Text>
        ) : (
          <Box flexDirection="column" gap={1}>
            <Text bold>{current.title}</Text>
            {section('Goal', current.goal)}
            {section('Now', current.now)}
            {section('Next', current.next)}
          </Box>
        )}
        {trouble !== null && <Text color="red">{trouble}</Text>}
        <Box flexDirection="row" columnGap={1}>
          <Button key="refresh" label={busy ? 'Refreshing' : 'Refresh'} hotkey="r" onPress={() => refresh($, engine)} />
          <Text dimColor wrap="truncate-end">
            {footer}
          </Text>
        </Box>
        {others.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor bold>
              Other windows
            </Text>
            {others.map(peer => (
              <Box key={peer.sessionId} flexDirection="column" marginTop={1}>
                <Text wrap="truncate-end">{peer.title}</Text>
                <Text dimColor wrap="truncate-end">
                  {shortPath(peer.cwd)} · {ago(peer.updatedAt, at)}
                </Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })

  // Where no pane is seated (a narrow terminal, or the pane closed), a one-line band keeps the TL;DR in view.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, tldr)
    if (current === null || e.props.hasSurvey) return next(e)

    const isSeated = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
    if (isSeated) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const line = current.now === '' ? current.title : `${current.title} · ${current.now}`

    return (
      <Box>
        <Text dimColor wrap="truncate-end">
          TL;DR: {line}
        </Text>
      </Box>
    )
  })
}
