import type { SessionMessage } from 'claude-code'

import type { Tldr } from '../types'

export type Fields = Pick<Tldr, 'title' | 'goal' | 'now' | 'next'>

const FORMAT = [
  'Reply in exactly this format and nothing else:',
  'TITLE: <3 to 6 words naming what this window is working on>',
  'GOAL: <one sentence: what the user is ultimately trying to get done>',
  'NOW: <one sentence: where things stand right now>',
  'NEXT: <one short sentence: the next step, or "Waiting on you: <what>" if Claude asked the user something>',
].join('\n')

/** The question a fork asks over the session's own cached transcript. */
export const FORK_ASK = [
  'This is a side question from a status pane, not a step in the task. Do not use tools and do not continue the work.',
  'Summarize this session so someone glancing at the window instantly remembers what it is for.',
  FORMAT,
].join('\n')

/** The system prompt for the Haiku engine, which reads a digest instead of the transcript. */
export const DIGEST_SYSTEM = [
  'You read a condensed log of a Claude Code session (a user working with an AI coding agent) and summarize it',
  'so someone glancing at the terminal window instantly remembers what it is for. Weight the latest activity most.',
  FORMAT,
].join('\n')

export function parseTldr(text: string): Fields | undefined {
  const field = (name: string) =>
    text
      .match(new RegExp(`^[\\s*_#-]*${name}[\\s*_]*:[\\s*_]*(.+)$`, 'mi'))?.[1]
      ?.replace(/[*_]+$/, '')
      .trim()

  const title = field('TITLE')
  if (title === undefined || title === '') return undefined

  return {
    title: title.replace(/^["']|["'.]$/g, ''),
    goal: field('GOAL') ?? '',
    now: field('NOW') ?? '',
    next: field('NEXT') ?? '',
  }
}

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const ARG_KEYS = ['description', 'command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt']

function describeToolUse(tool: string, input: Record<string, unknown>): string {
  const key = ARG_KEYS.find(name => typeof input[name] === 'string')
  return key === undefined ? tool : `${tool} ${clip(String(input[key]), 80)}`
}

/** A condensed log for the Haiku engine: the opening ask, then the latest rows. */
export function digestOf(messages: readonly SessionMessage[], maxChars = 12_000): string {
  const firstAsk = messages.find(m => m.role === 'user' && m.text.trim() !== '')
  const lines: string[] = []

  for (const message of messages.slice(-60)) {
    if (message.text.trim() !== '') {
      lines.push(`${message.role === 'user' ? 'USER' : 'CLAUDE'}: ${clip(message.text, 400)}`)
    }
    for (const use of message.toolUses) {
      lines.push(`  [tool] ${describeToolUse(use.tool, use.input)}${use.isError ? ' (failed)' : ''}`)
    }
  }

  let recent = lines.join('\n')
  if (recent.length > maxChars) recent = `…${recent.slice(-maxChars)}`

  return [
    firstAsk === undefined ? '' : `OPENING ASK: ${clip(firstAsk.text, 600)}\n`,
    'RECENT ACTIVITY (oldest first):',
    recent,
  ].join('\n')
}

export function ago(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function shortPath(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? '/'
}

export function tokens(count: number): string {
  return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count)
}
