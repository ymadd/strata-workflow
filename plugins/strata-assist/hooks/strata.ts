// Pure grammar of a Strata invocation, mirroring skills/general/SKILL.md "On activation" step 1.
// No engine imports: unit-tested with plain node.

export const SKILLS = ['general', 'code', 'finance'] as const

export const MODES: Record<string, string> = {
  focus: 'unknown surface → small find → verify (default, does the least)',
  review: 'code-review a known diff / PR → verdict',
  sweep: 'audit the WHOLE codebase → health grade',
  panel: 'N designs → judge → pick a winner',
  debate: 'one claim → adversarial rebuttal → verdict',
  research: 'hypotheses → web-grounded investigate → cited synthesis',
  scale: 'mass fan-out over a KNOWN work-list',
  grow: 'self-improving Plan→Build→Audit→Repair loop',
  ultra: 'the full task arc (understand→build→synth), capped',
  evolve: 'autonomous build; PM + Director grow the plan (opt-in, 500k)',
  delegate: 'ONE heavy task: cheap-first build → verify → fable apex on failure',
  conduct: 'fable conducts a fan-out of file-disjoint units',
  debug: 'unknown-cause bug: repro → hypotheses + experiments → fix on a confirmed cause',
}

export const DOMAINS = ['code', 'finance', 'security'] as const
export const TIERS = ['cheap', 'hard'] as const

// traced to each workflow's DEFAULT_CAP
const DEFAULT_CAP: Record<string, number> = {
  focus: 150_000, review: 150_000, panel: 150_000, debate: 150_000, research: 150_000, ultra: 150_000,
  sweep: 200_000, delegate: 200_000, conduct: 200_000, debug: 200_000, evolve: 500_000,
}
const ROOF: Record<string, number> = { sweep: 120, ultra: 120, evolve: 120 }

import type { Parsed } from '../types'
export type { Parsed }

const CMD = /^\/(?:strata-workflow:)?(general|code|finance)(?:\s|$)/

export function parse(draft: string): Parsed | null {
  const m = CMD.exec(draft)
  if (!m) return null
  const skill = m[1]
  const rest = draft.slice(m[0].length)
  const p: Parsed = { skill, task: '', partial: '', inTask: false }
  // code/finance skills are thin aliases that preset the domain
  if (skill !== 'general') p.domain = skill

  const re = /\S+/g
  let t: RegExpExecArray | null
  while ((t = re.exec(rest))) {
    const tok = t[0]
    const atEnd = t.index + tok.length === rest.length
    const low = tok.toLowerCase()
    const known = classify(low, p)
    if (!known) {
      if (atEnd && isPrefixOfAny(low)) { p.partial = tok; return p } // still typing a keyword
      p.inTask = true
      p.task = rest.slice(t.index).trim()
      return p
    }
    if (atEnd && !/\s$/.test(rest)) p.partial = tok
  }
  return p
}

function classify(low: string, p: Parsed): boolean {
  if (low in MODES && !p.mode) return (p.mode = low), true
  if ((DOMAINS as readonly string[]).includes(low) && (!p.domain || p.domain === p.skill)) return (p.domain = low), true
  const cap = /^(\d+(?:\.\d+)?)(k|m)$/.exec(low)
  if (cap) return (p.cap = Math.round(Number(cap[1]) * (cap[2] === 'k' ? 1e3 : 1e6))), true
  if (/^\d+$/.test(low)) return (p.maxAgents = Number(low)), true
  if ((TIERS as readonly string[]).includes(low)) return (p.tier = low), true
  if (low === 'unleashed' || low === 'nocap') return (p.unleashed = true), true
  return false
}

const KEYWORDS = [...Object.keys(MODES), ...DOMAINS, ...TIERS, 'unleashed']
function isPrefixOfAny(low: string) {
  return KEYWORDS.some(k => k.startsWith(low) && k !== low)
}

/** Next-token candidates for what has NOT been set yet, filtered by the partial token. */
export function candidates(p: Parsed): string[] {
  if (p.inTask) return []
  const pre = p.partial.toLowerCase()
  const out: string[] = []
  if (!p.mode) out.push(...Object.keys(MODES))
  if (!p.domain || p.domain === p.skill && p.skill === 'general') out.push(...DOMAINS)
  if (!p.cap && !p.maxAgents) out.push('300k', '100')
  if (!p.tier) out.push(...TIERS)
  return out.filter(c => c.startsWith(pre) && c !== pre)
}

/** SKILL.md cap math: MAX_AGENTS = clamp(floor(0.8*cap/12k), 4, 40|roof). Approximate, like the doc says. */
export function agentEstimate(p: Parsed): { cap: number; agents: number; capSet: boolean } | null {
  if (!p.mode) return null
  if (p.maxAgents) return { cap: p.cap ?? DEFAULT_CAP[p.mode] ?? 150_000, agents: Math.min(950, Math.max(4, p.maxAgents)), capSet: true }
  if (p.mode === 'scale' || p.mode === 'grow') return null // count-driven modes: no clamp formula
  const cap = p.cap ?? DEFAULT_CAP[p.mode] ?? 150_000
  const roof = ROOF[p.mode] ?? 40
  return { cap, agents: Math.min(roof, Math.max(4, Math.floor((0.8 * cap) / 12_000))), capSet: p.cap !== undefined }
}

export const fmtTokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}m` : `${Math.round(n / 1e3)}k`)
