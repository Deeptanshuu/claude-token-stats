/** What one main-thread turn cost. */
export type Turn = {
  /** 1 for the session's first turn the mod saw, counting up. */
  n: number
  /** Output tokens per second, over the turn's steps. */
  tps: number
  /** Milliseconds from the turn's first request to its first streamed piece. */
  ttftMs: number | null
  /** Share of the turn's prompts the cache served, 0..1. */
  hit: number
  /** Output tokens over the turn. */
  output: number
}

/** Every main-thread request since the mod began counting. */
export type Session = {
  /** Prompt tokens the cache served. */
  cacheRead: number
  /** Prompt tokens written to the cache. */
  cacheWrite: number
  /** Prompt tokens neither read from nor written to the cache. */
  uncached: number
  output: number
}

/** The turn running now, as the working row and the panel show it. */
export type Live = {
  /** Waiting on the request's first piece, streaming it, or running the tools it asked for. */
  phase: 'waiting' | 'streaming' | 'tools'
  /** Eased output rate of the step streaming now; null until it has a span. */
  tps: number | null
  /** The current step's time to its first piece; null while it waits. */
  ttftMs: number | null
  /** Output tokens so far this turn: real for finished steps, estimated for the one streaming. */
  output: number
}

declare module 'claude-code' {
  interface PluginState {
    'token-stats': {
      turns: Shaped<Turn[]>
      session: Shaped<Session>
      live: Shaped<Live | null>
      isPaneOpen: boolean
      isStripHidden: boolean
    }
  }
}
