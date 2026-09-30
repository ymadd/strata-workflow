export type Parsed = {
  skill: string
  mode?: string
  domain?: string
  cap?: number // token cap (k/m token)
  maxAgents?: number // bare integer
  tier?: string
  unleashed?: boolean
  task: string
  partial: string // the token under construction (no trailing space yet), '' otherwise
  inTask: boolean // true once free text has begun
}

export type Route =
  | { task: string; status: 'ok'; choice: string; confidence: number; second?: string; secondP?: number; sensitive: number }
  | { task: string; status: 'pending' | 'nokey' | 'off' | 'error'; message?: string }

declare module 'claude-code' {
  interface PluginState {
    'strata-assist': { draft: Parsed | null; route: Route | null }
  }
}
