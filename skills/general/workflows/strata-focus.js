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

// ---- grounding context (NEW): the conversation/intent behind the task + the project's conventions ----
// focus is the GENERAL, restraint mode (used for research/migrate as well as code), so unlike code-locked
// review/sweep, convention grounding is OPT-IN — it never auto-reads CLAUDE.md on a non-code task:
//  • conversation: caller-supplied (subagents can't see the parent session) — injected into every scout.
//  • conventions: a non-empty string = used verbatim; `true` = scouts consult the repo's CLAUDE.md/AGENTS.md
//    themselves (no extra agent — focus has no scope phase); omitted/false = off (legacy behavior).
const CONVERSATION = typeof A.conversation === 'string' && A.conversation.trim() ? A.conversation.trim() : ''
const CONV_BLOCK = CONVERSATION
  ? `\nCONVERSATION / INTENT (what was actually requested — judge the work against THIS, not just the surface; flag missed requirements and unrequested scope creep):\n${CONVERSATION}\n`
  : ''
const CONVENTIONS_LITERAL = typeof A.conventions === 'string' && A.conventions.trim() ? A.conventions.trim() : ''
const CONVENTIONS_AUTO = A.conventions === true // opt-in only (review/sweep auto-read; focus does not)
const CONVENTIONS_BLOCK = CONVENTIONS_LITERAL ? `\nPROJECT CONVENTIONS (hold the work to these; flag deviations):\n${CONVENTIONS_LITERAL}\n` : ''
// focus has no scope/map agent, so AUTO conventions are sourced by the scouts themselves, on demand.
const CONV_SELF_READ = CONVENTIONS_AUTO
  ? "\nIf relevant to your dimension, consult the repo's CLAUDE.md / AGENTS.md for project conventions and flag deviations."
  : ''
const GROUND_BLOCK = CONV_BLOCK + CONVENTIONS_BLOCK
const groundOn = !!(CONVERSATION || CONVENTIONS_LITERAL || CONVENTIONS_AUTO)
const ADHERENCE_DIM =
  'convention & intent adherence (does the work follow the project conventions, and does it satisfy what the conversation/intent asked — flag missed requirements, scope creep, and convention deviations)'

// ---- tunable constants (the enforcement surface) ----
const DEFAULT_CAP = 150_000 // used when neither args.cap nor a +N budget directive is set
const TOKENS_PER_AGENT = 12_000 // blended planning estimate for deriving the agent ceiling
const AGENT_FLOOR = 4
const AGENT_ROOF = 40

// ---- model tiers: applied to EVERY agent() call; implicit inherit is forbidden ----
const TIER = { find: 'haiku', verify: 'sonnet', synth: 'opus' }
// run every sonnet-tier agent on the 1M-context variant (the cheap bulk carries the long inputs); haiku/opus untouched
for (const k in TIER) if (TIER[k] === 'sonnet') TIER[k] = 'sonnet[1m]'
if (A.tierHint === 'cheap') TIER.verify = 'haiku'
if (A.tierHint === 'hard') TIER.verify = 'opus' // spend opus on the adversarial verify when correctness is critical

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
// An explicit agent-count cap (a leading bare number like `100`) overrides the token-derived clamp and
// may exceed the soft AGENT_ROOF — bounded only by [AGENT_FLOOR, HARD_LIMIT] so the literal counter stays honest.
const HARD_LIMIT = 950
const explicitMax = typeof A.maxAgents === 'number' && isFinite(A.maxAgents) && A.maxAgents > 0 ? Math.floor(A.maxAgents) : null
const MAX_AGENTS = explicitMax != null
  ? Math.max(AGENT_FLOOR, Math.min(HARD_LIMIT, explicitMax))
  : Math.max(AGENT_FLOOR, Math.min(AGENT_ROOF, Math.floor(SOFT / TOKENS_PER_AGENT)))
const FINDERS = Math.min(8, Math.max(2, Math.ceil(MAX_AGENTS * 0.4)))

// ---- the PRIMARY guard is a literal counter (needs no API, cannot fail) ----
let spawned = 0
// budget.spent() is the SHARED, cumulative turn pool (main loop + every workflow), NOT this run's spend.
// So measure THIS invocation's spend relative to a baseline captured now; SOFT is a per-task budget.
const startSpent = spentNow()
// An explicit agent cap with NO explicit token cap makes the agent count the SOLE binding limit:
// lift the soft token budget so it can't silently undercut the cap. A hard budget.total (the +N
// directive, enforced by the runtime) still applies; passing a k/m token cap too re-imposes SOFT.
const UNCAP_TOKENS = explicitMax != null && !(typeof A.cap === 'number' && A.cap > 0)
const overBudget = () => (UNCAP_TOKENS ? false : spentNow() - startSpent >= SOFT)
const mustReserve = () => remainingNow() < RESERVE // remaining() is the global hard ceiling — keep absolute
const canSpawn = () => spawned < MAX_AGENTS && !overBudget()

log(
  `Strata/tiered-orchestrate: cap=${CEIL} (${candidates.length ? 'set' : 'default'}), ` +
    `MAX_AGENTS=${MAX_AGENTS}${explicitMax != null ? ` (explicit agent cap${UNCAP_TOKENS ? '; token budget lifted' : ''})` : ''}, finders=${FINDERS}, tiers find=${TIER.find} verify=${TIER.verify} synth=${TIER.synth}`
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
// When grounding context is supplied, slot the adherence lens right after the first two dims so it survives
// the FINDERS slice; otherwise leave the profile untouched (preserves default focus behavior).
const dimSource = groundOn ? [...baseDims.slice(0, 2), ADHERENCE_DIM, ...baseDims.slice(2)] : baseDims
const DIMS = dimSource.slice(0, FINDERS)

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
    answer: { type: 'string', maxLength: 8000 },
    residualRisks: { type: 'array', items: { type: 'string' } },
    coverageNote: { type: 'string', maxLength: 2000 },
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
    `Task: ${A.task}\n${GROUND_BLOCK}\nInvestigate STRICTLY the dimension: "${dim}". Read the real files/sources and quote evidence as path:line (or a source reference).${CONV_SELF_READ} Report only concrete, evidence-backed findings for this dimension.`,
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
        `Adversarially verify this finding. Re-read the cited evidence and judge whether it is REAL (not a false positive). Be skeptical; default to isReal=false if the evidence does not clearly support it.\n${GROUND_BLOCK}\n${JSON.stringify(it)}`,
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
    `Task: ${A.task}\n${GROUND_BLOCK}\nConfirmed findings (after adversarial verification):\n${JSON.stringify(confirmed, null, 2)}\n\nProduce the final, correct answer/roadmap. You MAY read 2-3 key files to ground the synthesis. Explicitly note any coverage gaps caused by the agent budget.`,
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
