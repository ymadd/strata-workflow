// Jev per-unit (model, effort) routing for Strata — pure: question shapes + the policy.
// Decisions (2026-09-30): 5 arms, no sonnet/high, fable never an arm; role bands enforced here AND
// re-checked by the workflow script; planner tier may be overridden both ways under conditions.
import type { Arm, RouteUnit, RouteDecision, JevAnswers } from '../types'
export type { Arm, RouteUnit, RouteDecision, JevAnswers }

export const ARMS: Arm[] = ['haiku/low', 'sonnet/low', 'sonnet/medium', 'opus/medium', 'opus/high']

export const ARM_CRITERIA: Record<Arm, unknown> = {
  'haiku/low': { what: 'Mechanical, fully specified work', signals: 'Rename, move, format, extract fields, apply an obvious one-line change, list files', not_for: 'Anything needing judgement or reading several files together' },
  'sonnet/low': { what: 'Clear, bounded implementation', signals: 'Spec and acceptance are explicit; one or two files; a known pattern to follow', not_for: 'Unclear cause, cross-module contracts, security-sensitive logic' },
  'sonnet/medium': { what: 'Bounded work with some reasoning', signals: 'Several files, tests to write, edge cases to think through, but the approach is known', not_for: 'Architecture choices or high blast radius' },
  'opus/medium': { what: 'Hard reasoning or high blast radius', signals: 'Unknown-cause debugging, cross-module design, auth, concurrency, migrations, data integrity', not_for: 'Routine work with a clear implementation' },
  'opus/high': { what: 'Open-ended and high-stakes at once', signals: 'No spec for HOW, several interacting systems, and an irreversible or security-critical outcome: e.g. zero-downtime auth or data migrations across services, designing a consistency model, root-causing a production incident with no reproduction', not_for: 'Hard but well-scoped fixes where the failing behaviour is known and reproducible' },
}

// role bands (cheapest → strongest); the script enforces the same bands independently
export const BAND: Record<string, Arm[]> = {
  scout: ['haiku/low', 'sonnet/low'],
  build: ['haiku/low', 'sonnet/low', 'sonnet/medium', 'opus/medium', 'opus/high'],
  verify: ['sonnet/low', 'sonnet/medium', 'opus/medium'],
  review: ['sonnet/low', 'sonnet/medium', 'opus/medium'],
}

export const LOW_CONFIDENCE = 0.4 // below: step one arm up inside the band
export const DOWNGRADE_MIN_CONFIDENCE = 0.8 // planner tier may be lowered only at/above this…
export const DOWNGRADE_MAX_BLAST = 2 // …and only when blast_radius is below this

export function buildQuestions() {
  return {
    arm: { type: 'choice', instructions: ['Pick the cheapest model/effort that completes this `unit` correctly in one pass, without a retry on a stronger model.', 'Judge the reasoning required, not the length of the text.'], criteria: ARM_CRITERIA },
    complexity: { type: 'score', instructions: 'How complex is this unit, including scope and how many parts must fit together?', criteria: ['Trivial single mechanical change', 'Small change in one place following a known pattern', 'Several coordinated changes with edge cases', 'Cross-module change where contracts must stay consistent', 'System-wide change with many interacting parts'] },
    ambiguity: { type: 'score', instructions: 'How much does the `unit` leave open that the worker must decide?', criteria: ['Fully specified: exact change and acceptance given', 'Minor details left open', 'Approach must be chosen among known options', 'Goal is clear but the cause or design is unknown'] },
    blast_radius: { type: 'score', instructions: 'If this unit is done wrong, how much breaks?', criteria: ['Nothing user-facing: docs, comments, local scripts', 'One feature degrades', 'Several features or a public API break', 'Security, data loss or corruption, or a production outage'] },
  }
}

export function buildState(u: RouteUnit, mode: string) {
  return { mode, role: u.role, unit: { title: u.title, spec: u.spec, acceptance: u.acceptance, files: u.own ?? [] } }
}

export function readAnswers(body: any): JevAnswers | null {
  const a = body?.answers
  if (!a?.arm?.choice || !a.arm.probabilities) return null
  return {
    choice: a.arm.choice,
    confidence: a.arm.confidence ?? 0,
    probabilities: a.arm.probabilities,
    complexity: a.complexity?.score ?? null,
    ambiguity: a.ambiguity?.score ?? null,
    blast: a.blast_radius?.score ?? null,
  }
}

const modelOf = (arm: Arm) => arm.split('/')[0]
const effortOf = (arm: Arm) => arm.split('/')[1]
const RANK: Record<string, number> = { haiku: 0, sonnet: 1, opus: 2 }

export type Policy = { version: number; LOW_CONFIDENCE: number; DOWNGRADE_MIN_CONFIDENCE: number; DOWNGRADE_MAX_BLAST: number }
export const DEFAULT_POLICY: Policy = { version: 0, LOW_CONFIDENCE, DOWNGRADE_MIN_CONFIDENCE, DOWNGRADE_MAX_BLAST }

export function decide(u: RouteUnit, j: JevAnswers | null, policy: Policy = DEFAULT_POLICY): RouteDecision {
  const band = BAND[u.role]
  if (!band) return { id: u.id, role: u.role, reason: 'no-band' }
  if (!j) return { id: u.id, role: u.role, reason: 'jev-unavailable' }

  // 1. Jev's pick; out of band → project onto the nearest band arm (a clamp, not a re-vote:
  //    the in-band leftovers of a distribution centred elsewhere are noise — e2e 2026-09-30 showed
  //    a verify clamped from haiku/low landing on sonnet/medium, then stepping up to opus)
  const inBand = band.includes(j.choice as Arm)
  let arm: Arm
  const reasons: string[] = []
  if (inBand) {
    arm = j.choice as Arm
    reasons.push('jev')
    // 2. low confidence → one step up inside the band (only when Jev's own pick stands)
    if (j.confidence < policy.LOW_CONFIDENCE) {
      arm = band[Math.min(band.length - 1, band.indexOf(arm) + 1)]
      reasons.push('low-conf-step-up')
    }
  } else {
    const at = ARMS.indexOf(j.choice as Arm)
    arm = at < 0 ? band[0] : at < ARMS.indexOf(band[0]) ? band[0] : band[band.length - 1]
    reasons.push(`clamped:${j.choice}`)
  }
  // 3. planner tier (conduct/delegate build units): bidirectional under conditions
  if (u.role === 'build' && u.plannerTier) {
    const p = RANK[u.plannerTier], m = RANK[modelOf(arm)]
    if (m < p) {
      const blastOk = j.blast !== null && j.blast < policy.DOWNGRADE_MAX_BLAST
      if (j.confidence >= policy.DOWNGRADE_MIN_CONFIDENCE && blastOk) reasons.push(`downgrade:${u.plannerTier}→${modelOf(arm)}`)
      else {
        // keep the planner's model; effort from Jev when compatible, else the planner model's base effort
        const keep = u.plannerTier === 'opus' ? 'opus/medium' : effortOf(arm) === 'medium' ? 'sonnet/medium' : 'sonnet/low'
        reasons.push(`keep-planner:${u.plannerTier}`)
        arm = keep as Arm
      }
    } else if (m > p) {
      reasons.push(`upgrade:${u.plannerTier}→${modelOf(arm)}`) // the script enforces OPUS_UNIT_CAP on upgrades
    }
  }
  return { id: u.id, role: u.role, model: modelOf(arm), effort: effortOf(arm), reason: reasons.join(',') }
}
