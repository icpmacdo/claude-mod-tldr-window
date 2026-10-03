export type Engine = 'fork' | 'haiku'

export type Tldr = {
  title: string
  goal: string
  now: string
  next: string
  updatedAt: number
  engine: Engine
  cachedTokens: number
  outputTokens: number
}

/** What one session keeps in $.store under `tldr:<sessionId>`, shared by every window. */
export type Saved = {
  sessionId: string
  cwd: string
  tldr: Tldr
  closedAt?: number
}

/** Another open window, as the "Other windows" list draws it. */
export type Peer = {
  sessionId: string
  title: string
  now: string
  cwd: string
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'tldr-window': {
      tldr: Tldr | null
      isBusy: boolean
      problem: string | null
      peers: Peer[]
      checkedAt: number
      isDismissed: boolean
    }
  }
}
