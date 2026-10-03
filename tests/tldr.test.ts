import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { Saved } from '../types'
import { digestOf, parseTldr } from '../hooks/summary'

const REPLY = [
  'TITLE: TL;DR window mod',
  'GOAL: Remember what each Claude window is for.',
  'NOW: The pane draws and the tests pass.',
  'NEXT: Load it in a real session.',
].join('\n')

const USAGE = { input_tokens: 12, output_tokens: 48, cache_read_input_tokens: 84_000, cache_creation_input_tokens: 0 }

const SCROLL = { offset: 0, bodyRows: 30 }

const DOCK = {
  plugin: 'tldr-window',
  component: 'Pane',
  requestId: 'tldr',
  viewport: { columns: 180, rows: 40, isFullscreen: true },
  props: { title: 'TL;DR', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: SCROLL, view: {} },
} as const

const INLINE = { ...DOCK, props: { ...DOCK.props, placement: 'inline', bodyColumns: 100 } } as const

const BAND = {
  plugin: 'tldr-window',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 100, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: SCROLL, view: {} },
} as const

const ENGINE_DRAWS = { type: 'Text' as const, props: {}, children: ['drawn by Claude Code'] }

const TURN = { turnId: 't1', answer: 'Done.', durationMs: 1000, isAborted: false, reason: 'answer' } as const

/** The stubs every session-shaped test needs: a store, the session's id and cwd, panes, and the engine's answers. */
function stubSession(
  on: Parameters<TestBody>[1],
  store: Map<string, unknown>,
  opened: string[],
  surfaces: readonly ('terminal' | 'desktop')[] = ['terminal'],
) {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'win-a' }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('turn.complete', () => ({ text: '' }))
  on('session.start', () => ({ cwd: '/work/app' }))
  on('command.register', () => ({ value: { command: 'tldr' } }))
  on('ui.render', () => ENGINE_DRAWS)
  return clock
}

describe('parseTldr', () => {
  test('reads the four fields', () => {
    expect(parseTldr(REPLY)).toEqual({
      title: 'TL;DR window mod',
      goal: 'Remember what each Claude window is for.',
      now: 'The pane draws and the tests pass.',
      next: 'Load it in a real session.',
    })
  })

  test('tolerates markdown bold and stray quotes', () => {
    const fields = parseTldr('**TITLE:** "Fix login redirect"\n**NOW:** Reproduced it.')
    expect(fields?.title).toBe('Fix login redirect')
    expect(fields?.now).toBe('Reproduced it.')
    expect(fields?.goal).toBe('')
  })

  test('refuses a reply with no title', () => {
    expect(parseTldr('I cannot help with that.')).toBeUndefined()
  })
})

test('digestOf keeps the opening ask and names the tools used', () => {
  const digest = digestOf([
    { role: 'user', text: 'Add dark mode to the settings page', toolUses: [] },
    {
      role: 'assistant',
      text: 'Looking at the settings page.',
      toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: { file_path: 'src/settings.tsx' } }],
    },
  ])
  expect(digest).toContain('OPENING ASK: Add dark mode to the settings page')
  expect(digest).toContain('[tool] Read src/settings.tsx')
})

test('a finished turn forks once, saves the TL;DR and draws it in the dock, inline and band', async ($, on) => {
  const store = new Map<string, unknown>()
  const opened: string[] = []
  const prompts: string[] = []
  const clock = stubSession(on, store, opened)
  on('model.fork', ($, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: REPLY, usage: USAGE } }
  })

  await $.turn.complete(TURN)
  await clock.advance(1000)

  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Do not use tools')
  expect(opened).toEqual(['tldr'])
  const saved = store.get('tldr:win-a') as Saved
  expect(saved.cwd).toBe('/work/app')
  expect(saved.tldr.title).toBe('TL;DR window mod')
  expect(saved.tldr.cachedTokens).toBe(84_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const dock = await $.ui.mount({ ...DOCK, surface })
    expect(await dock.find({ type: 'Text', text: 'TL;DR window mod' })).toBeDefined()
    expect(await dock.find({ type: 'Text', text: 'Load it in a real session.' })).toBeDefined()
    expect(await dock.find({ type: 'Text', text: /84k cached/ })).toBeDefined()
    await dock.unmount()

    const inline = await $.ui.mount({ ...INLINE, surface })
    expect(await inline.find({ type: 'Text', text: 'TL;DR: TL;DR window mod' })).toBeDefined()
    await inline.unmount()

    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: /TL;DR: TL;DR window mod · The pane draws/ })).toBeDefined()
    await band.unmount()
  }
})

test("a subagent's turn and an errored turn do not refresh", async ($, on) => {
  const store = new Map<string, unknown>()
  let forks = 0
  const clock = stubSession(on, store, [])
  on('model.fork', () => {
    forks += 1
    return { value: { isAnswered: true, text: REPLY, usage: USAGE } }
  })

  await $.turn.complete({ ...TURN, agentId: 'agent-1' })
  await $.turn.complete({ ...TURN, reason: 'error' })
  await clock.advance(1000)

  expect(forks).toBe(0)
  expect(store.has('tldr:win-a')).toBe(false)
})

test('a headless run with no surface makes no model call', async ($, on) => {
  const store = new Map<string, unknown>()
  let forks = 0
  const clock = stubSession(on, store, [], [])
  on('model.fork', () => {
    forks += 1
    return { value: { isAnswered: true, text: REPLY, usage: USAGE } }
  })

  await $.turn.complete(TURN)
  await clock.advance(1000)

  expect(forks).toBe(0)
})

test('nothing to fork yet leaves the pane waiting without an error', async ($, on) => {
  const store = new Map<string, unknown>()
  const clock = stubSession(on, store, [])
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }))

  await $.turn.complete(TURN)
  await clock.advance(1000)

  const dock = await $.ui.mount({ ...DOCK, surface: 'terminal' })
  expect(await dock.find({ type: 'Text', text: /No TL;DR yet/ })).toBeDefined()
  expect(await dock.find({ type: 'Text', text: /Summary failed/ })).toBeUndefined()
})

test('an API error shows in the pane', async ($, on) => {
  const store = new Map<string, unknown>()
  const clock = stubSession(on, store, [])
  on('model.fork', () => ({
    value: { isAnswered: false, reason: 'api-error', status: 529, error: 'server_error', usage: USAGE },
  }))

  await $.turn.complete(TURN)
  await clock.advance(1000)

  const dock = await $.ui.mount({ ...DOCK, surface: 'terminal' })
  expect(await dock.find({ type: 'Text', text: 'Summary failed: API error 529' })).toBeDefined()
})

test('the Refresh button forks on demand', async ($, on) => {
  const store = new Map<string, unknown>()
  let forks = 0
  stubSession(on, store, [])
  on('model.fork', () => {
    forks += 1
    return { value: { isAnswered: true, text: REPLY, usage: USAGE } }
  })

  const dock = await $.ui.mount({ ...DOCK, surface: 'desktop' })
  await dock.press({ key: 'refresh' })

  expect(forks).toBe(1)
  expect(await dock.find({ type: 'Text', text: 'TL;DR window mod' })).toBeDefined()
})

test('the next prompt retitles the session after the TL;DR', async ($, on) => {
  const store = new Map<string, unknown>()
  const clock = stubSession(on, store, [])
  on('model.fork', () => ({ value: { isAnswered: true, text: REPLY, usage: USAGE } }))
  on('classic.UserPromptSubmit', () => ({}))

  const before = await $.classic.UserPromptSubmit({ prompt: 'first' })
  expect(before.sessionTitle).toBeUndefined()

  await $.turn.complete(TURN)
  await clock.advance(1000)

  const after = await $.classic.UserPromptSubmit({ prompt: 'second' })
  expect(after.sessionTitle).toBe('TL;DR window mod')
})

test('other open windows are listed; closed and stale ones are not', async ($, on) => {
  const now = 1_000_000
  const entry = (sessionId: string, title: string, updatedAt: number, closedAt?: number): Saved => ({
    sessionId,
    cwd: `/work/${sessionId}`,
    tldr: { title, goal: '', now: '', next: '', updatedAt, engine: 'fork', cachedTokens: 0, outputTokens: 0 },
    ...(closedAt === undefined ? {} : { closedAt }),
  })
  const store = new Map<string, unknown>([
    ['tldr:api', entry('api', 'Fix auth token refresh', now - 5 * 60_000)],
    ['tldr:old', entry('old', 'Yesterday thing', now - 30 * 60 * 60_000)],
    ['tldr:gone', entry('gone', 'Closed window', now - 60_000, now - 30_000)],
    ['tldr:ancient', entry('ancient', 'Prune me', now - 10 * 24 * 60 * 60_000)],
  ])
  stubSession(on, store, [])
  on('model.fork', () => ({ value: { isAnswered: true, text: REPLY, usage: USAGE } }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' })

  expect(store.has('tldr:ancient')).toBe(false)
  const dock = await $.ui.mount({ ...DOCK, surface: 'terminal' })
  expect(await dock.find({ type: 'Text', text: 'Other windows' })).toBeDefined()
  expect(await dock.find({ type: 'Text', text: 'Fix auth token refresh' })).toBeDefined()
  expect(await dock.find({ type: 'Text', text: /api · 5m ago/ })).toBeDefined()
  expect(await dock.find({ type: 'Text', text: 'Yesterday thing' })).toBeUndefined()
  expect(await dock.find({ type: 'Text', text: 'Closed window' })).toBeUndefined()
})

test('closing the session marks it closed for the other windows', async ($, on) => {
  const store = new Map<string, unknown>()
  const clock = stubSession(on, store, [])
  on('model.fork', () => ({ value: { isAnswered: true, text: REPLY, usage: USAGE } }))
  on('session.end', () => ({ sessionId: 'win-a' }))

  await $.turn.complete(TURN)
  await clock.advance(1000)
  await $.session.end({ sessionId: 'win-a', reason: 'prompt_input_exit', resume: { id: 'win-a' } })

  expect((store.get('tldr:win-a') as Saved).closedAt).toBeDefined()
})
