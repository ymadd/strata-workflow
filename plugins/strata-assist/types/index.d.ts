export type Parsed = {
  skill: string
  mode?: string
  variant?: string
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

export type Arm = 'haiku/low' | 'sonnet/low' | 'sonnet/medium' | 'opus/medium' | 'opus/high'

export type RouteUnit = {
  id: string
  role: 'scout' | 'build' | 'verify' | 'review'
  title?: string
  spec: string
  acceptance?: string
  own?: string[]
  plannerTier?: 'sonnet' | 'opus'
}

export type JevAnswers = {
  choice: string
  confidence: number
  probabilities: Record<string, number>
  complexity: number | null
  ambiguity: number | null
  blast: number | null
}

export type RouteDecision = { id: string; role: string; model?: string; effort?: string; reason: string }

declare module 'claude-code' {
  interface PluginState {
    'strata-assist': { draft: Parsed | null; route: Route | null }
  }
}
