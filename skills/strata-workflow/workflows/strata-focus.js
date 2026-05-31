export const meta = {
  name: 'strata-focus',
  description:
    "Budget-bounded, model-tiered find->verify->synthesize. Caps agent count via a literal counter and routes cheap work to haiku, reserving opus for synthesis, so a session is not exhausted early. Reusable for review/research/implement/migrate.",
  phases: [
    { title: 'Find', detail: 'capped pool of cheap (haiku) scouts, one per dimension' },
    { title: 'Verify', detail: 'severity-gated adversarial verification on sonnet' },
    { title: 'Synthesize', detail: 'one opus agent merges confirmed findings into the answer' },
  ],
}

// ---- args: { task, taskClass, cap, tierHint, dimensions? } ----
// The workflow runtime threads `args` to the script as a JSON STRING, so normalize it here.
const A = (() => {
  if (typeof args === 'string') {
    try {
      return JSON.parse(args)
    } catch (e) {
      return {}
    }
  }
  return args && typeof args === 'object' ? args : {}
})()
if (!A.task) {
  return {
    error:
      "No task provided. Invoke as Workflow({ scriptPath: '.../tiered-orchestrate.js', args: { task, taskClass, cap } }).",
  }
}

// ---- tunable constants (the enforcement surface) ----
const DEFAULT_CAP = 150_000 // used when neither args.cap nor a +N budget directive is set
const TOKENS_PER_AGENT = 12_000 // blended planning estimate for deriving the agent ceiling
const AGENT_FLOOR = 4
const AGENT_ROOF = 40

// ---- model tiers: applied to EVERY agent() call; implicit inherit is forbidden ----
const TIER = { find: 'haiku', extract: 'haiku', verify: 'sonnet', synth: 'opus', implement: 'sonnet' }
if (A.tierHint === 'cheap') TIER.verify = 'haiku'
if (A.tierHint === 'hard') {
  TIER.verify = 'sonnet'
  TIER.implement = 'opus'
}

// ---- budget reads are BEST-EFFORT (the budget API is documented but unexercised; never let it throw) ----
const spentNow = () => {
  try {
    return budget.spent()
  } catch (e) {
    return 0
  }
}
const remainingNow = () => {
  try {
    return budget.remaining()
  } catch (e) {
    return Infinity
  }
}
const hardTotal = () => {
  try {
    return budget.total
  } catch (e) {
    return null
  }
}

// ---- derive the ceiling from the cap arg / the +N directive / the default; min() if both ----
const candidates = [A.cap, hardTotal()].filter((n) => typeof n === 'number' && n > 0)
const CEIL = candidates.length ? Math.min(...candidates) : DEFAULT_CAP
const SOFT = Math.floor(CEIL * 0.8)
const RESERVE = Math.min(40_000, Math.floor(CEIL * 0.2))
const MAX_AGENTS = Math.max(AGENT_FLOOR, Math.min(AGENT_ROOF, Math.floor(SOFT / TOKENS_PER_AGENT)))
const FINDERS = Math.min(8, Math.max(2, Math.ceil(MAX_AGENTS * 0.4)))

// ---- the PRIMARY guard is a literal counter (needs no API, cannot fail) ----
let spawned = 0
// budget.spent() is the SHARED, cumulative turn pool (main loop + every workflow), NOT this run's spend.
// So measure THIS invocation's spend relative to a baseline captured now; SOFT is a per-task budget.
const startSpent = spentNow()
const overBudget = () => spentNow() - startSpent >= SOFT
const mustReserve = () => remainingNow() < RESERVE // remaining() is the global hard ceiling — keep absolute
const canSpawn = () => spawned < MAX_AGENTS && !overBudget()

log(
  `Strata/tiered-orchestrate: cap=${CEIL} (${candidates.length ? 'set' : 'default'}), ` +
    `MAX_AGENTS=${MAX_AGENTS}, finders=${FINDERS}, tiers find=${TIER.find} verify=${TIER.verify} synth=${TIER.synth}`
)

// ---- task profiles: default investigation dimensions per class ----
const PROFILES = {
  review: ['correctness', 'security', 'performance', 'tests'],
  research: ['primary-sources', 'counter-evidence', 'recency', 'consensus'],
  implement: ['design', 'edge-cases', 'tests'],
  migrate: ['schema-drift', 'data-loss', 'rollback', 'cutover'],
}
const baseDims =
  A.dimensions && A.dimensions.length
    ? A.dimensions
    : PROFILES[A.taskClass] || ['scope', 'evidence', 'risks']
const DIMS = baseDims.slice(0, FINDERS)

// ---- schemas: schema-bounded cheap workers keep output small AND parseable ----
const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'evidence'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] },
          location: { type: 'string', description: 'file:line or source reference' },
          evidence: { type: 'string', description: 'quoted evidence supporting the finding' },
        },
      },
    },
  },
}
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isReal', 'reason'],
  properties: { isReal: { type: 'boolean' }, reason: { type: 'string' } },
}
const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer'],
  properties: {
    answer: { type: 'string' },
    residualRisks: { type: 'array', items: { type: 'string' } },
    coverageNote: { type: 'string' },
  },
}

// ---- Phase 1: FIND — one cheap haiku scout per dimension, count-capped ----
phase('Find')
const found = await pipeline(DIMS, (dim) => {
  if (!canSpawn()) {
    log(`find: gate hit at ${spawned}/${MAX_AGENTS}, skipping "${dim}"`)
    return { findings: [] }
  }
  spawned++
  return agent(
    `Task: ${A.task}\n\nInvestigate STRICTLY the dimension: "${dim}". Read the real files/sources and quote evidence as path:line (or a source reference). Report only concrete, evidence-backed findings for this dimension.`,
    { label: `find:${dim}`, phase: 'Find', model: TIER.find, schema: FINDINGS_SCHEMA }
  )
})

const RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 }
const items = found
  .filter(Boolean)
  .flatMap((f) => (f && f.findings ? f.findings : []))
  .filter((it) => it && it.title) // D1: drop malformed findings before they consume a verify agent
  .sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9))

// ---- Phase 2: VERIFY — severity-gated adversarial check on sonnet (2 votes for CRITICAL/HIGH, else 1) ----
phase('Verify')
const verified = []
for (const it of items) {
  if (!canSpawn() || mustReserve()) {
    verified.push({ ...it, confirmed: true, note: 'budget-skip-verify' })
    continue
  }
  const votes = it.severity === 'CRITICAL' || it.severity === 'HIGH' ? 2 : 1
  const thunks = []
  for (let v = 0; v < votes; v++) {
    if (!canSpawn() || mustReserve()) break // recheck the reserve per vote, not just at the block start
    spawned++
    thunks.push(() =>
      agent(
        `Adversarially verify this finding. Re-read the cited evidence and judge whether it is REAL (not a false positive). Be skeptical; default to isReal=false if the evidence does not clearly support it.\n\n${JSON.stringify(it)}`,
        { label: `verify:${it.title}`, phase: 'Verify', model: TIER.verify, schema: VERDICT_SCHEMA }
      )
    )
  }
  const ballots = (await parallel(thunks)).filter(Boolean)
  // Fail OPEN on a missing OR partial ballot: a budget-truncated vote must not let a lone adversarial
  // ballot reject a finding the 2-vote rule exists to protect. Quorum is against the INTENDED vote count.
  if (ballots.length < votes) {
    verified.push({ ...it, confirmed: true, note: ballots.length === 0 ? 'budget-skip-verify' : 'budget-partial-verify' })
    continue
  }
  const real = ballots.filter((r) => r.isReal).length
  verified.push({ ...it, confirmed: real >= Math.ceil(votes / 2) })
}

// ---- Phase 3: SYNTHESIZE — the ONE opus stage, on the fenced reserve, guarded against a budget throw ----
phase('Synthesize')
const confirmed = verified.filter((f) => f.confirmed)
spawned++ // the synthesis agent always runs; count it for honest reporting
let synthesis
try {
  synthesis = await agent(
    `Task: ${A.task}\n\nConfirmed findings (after adversarial verification):\n${JSON.stringify(confirmed, null, 2)}\n\nProduce the final, correct answer/roadmap. You MAY read 2-3 key files to ground the synthesis. Explicitly note any coverage gaps caused by the agent budget.`,
    { label: 'synthesize', phase: 'Synthesize', model: TIER.synth, schema: SYNTH_SCHEMA }
  )
  // agent() can resolve to null without throwing — route that into the fail-open below
  // (consistent with review/panel/sweep/ultra which all guard against synthesis null)
  if (!synthesis) throw new Error('synthesis agent returned null')
} catch (e) {
  synthesis = {
    answer:
      'Budget ceiling reached before full synthesis. Returning verified findings as the partial result; re-run with a larger cap for full depth.',
    residualRisks: ['synthesis truncated by budget'],
    coverageNote: String(e && e.message ? e.message : e),
  }
}

log(`done: ${spawned} agents spawned, ~${Math.max(0, spentNow() - startSpent)} output tokens this run, ${confirmed.length} confirmed findings`)
return {
  task: A.task,
  cap: CEIL,
  capWasSet: candidates.length > 0,
  agentsSpawned: spawned,
  maxAgents: MAX_AGENTS,
  confirmedCount: confirmed.length,
  findings: confirmed,
  synthesis,
}
