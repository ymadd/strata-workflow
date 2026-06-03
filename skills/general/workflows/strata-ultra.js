export const meta = {
  name: 'strata-ultra',
  description:
    "ultracode's full task arc — understand -> design -> build -> review -> synthesize — that DYNAMICALLY spawns more agents where the work needs them: opus advice for low-confidence builds, an opus tie-breaker when verifiers split, and an opus completeness critic that grows new work units until the deliverable is actually done. Still on Strata's leash by default (a hard agent-count cap; opus kept thin), or fully `unleashed`. The deliberate opposite of `focus`: this does the most the budget allows.",
  phases: [
    { title: 'Understand', detail: 'cheap haiku scouts map the task from several angles in parallel' },
    { title: 'Design', detail: 'sonnet proposes approaches from distinct lenses; one opus judge picks a winner' },
    { title: 'Build', detail: 'sonnet fans out work units; low-confidence units get an opus advice + revise pass' },
    { title: 'Review', detail: 'dimension finders + adversarial verify (opus tie-breaks splits) + repair, looped until dry; an opus completeness critic then grows gap units until done' },
    { title: 'Synthesize', detail: 'one opus agent assembles the final deliverable and flags what is missing' },
  ],
}

// ---- args: { task, taskClass?, cap?, maxAgents?, unleashed?, designLenses?, reviewDimensions?, adviceThreshold?, dryStreakLimit?, maxReviewRounds?, maxImprovementRounds?, tierHint? } ----
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
  return { error: "No task provided. Invoke as Workflow({ scriptPath: '.../strata-ultra.js', args: { task, taskClass, cap } })." }
}

// ---- tunable constants ----
const DEFAULT_CAP = 150_000
// ultra is the most token-heavy mode: it re-passes the full artifact set to many agents and spawns
// escalation agents dynamically, so per-agent spend runs above the other modes. A higher estimate keeps
// MAX_AGENTS conservative. The agent-count counter is the hard guarantee; tokens are approximate.
const TOKENS_PER_AGENT = 16_000
const AGENT_FLOOR = 8
const AGENT_ROOF = 120
const HARD_LIMIT = 950 // runtime lifetime-agent backstop
// guard: typeof NaN === 'number' is true; NaN would silence the escalation (b.selfScore < NaN = false)
const ADVICE_THRESHOLD = typeof A.adviceThreshold === 'number' && isFinite(A.adviceThreshold) ? A.adviceThreshold : 78

// ---- model tiers: opus is spawned ONLY where judgment is needed (judge, advice, tie-break, critic, synth) ----
const TIER = { scout: 'haiku', design: 'sonnet', judge: 'opus', build: 'sonnet', advise: 'opus', review: 'sonnet', verify: 'sonnet', tiebreak: 'opus', repair: 'sonnet', critic: 'opus', synth: 'opus' }
if (A.tierHint === 'cheap') TIER.design = 'sonnet'

// ---- budget reads are BEST-EFFORT (never let the API throw) ----
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

// ---- UNLEASHED: deliberately drop Strata's leash (true ultracode — "token cost is no constraint").
// Ignores the cap-derived agent ceiling AND the soft token budget. The ONLY remaining guards are the
// runtime's hard 950-agent lifetime backstop and any `+Ntokens` hard budget.total (agent() throws there).
// Off by default. Pass an explicit `maxAgents` to bound it safely even while unleashed. ----
const UNLEASHED = A.unleashed === true || A.noCap === true

// ---- derive the ceiling and the agent cap ----
const candidates = [A.cap, hardTotal()].filter((n) => typeof n === 'number' && n > 0)
const CEIL = candidates.length ? Math.min(...candidates) : DEFAULT_CAP
const SOFT = Math.floor(CEIL * 0.8)
const DERIVED = Math.max(AGENT_FLOOR, Math.min(AGENT_ROOF, Math.floor(SOFT / TOKENS_PER_AGENT)))
const explicitMax = typeof A.maxAgents === 'number' && A.maxAgents > 0 ? A.maxAgents : null
const MAX_AGENTS = UNLEASHED
  ? Math.min(HARD_LIMIT, explicitMax || HARD_LIMIT)
  : Math.min(HARD_LIMIT, explicitMax ? Math.max(4, explicitMax) : DERIVED)

// ---- guards ----
let spawned = 0
const startSpent = spentNow()
// unleashed bypasses the soft token budget; MAX_AGENTS and any hard budget.total still bound the run.
// An explicit agent cap with NO explicit token cap has the same effect — the agent count is then the
// sole binding limit; passing a k/m token cap alongside it re-imposes SOFT.
const TOKEN_FREE = UNLEASHED || (explicitMax != null && !(typeof A.cap === 'number' && A.cap > 0))
const overBudget = () => (TOKEN_FREE ? false : spentNow() - startSpent >= SOFT)
const SYNTH_RESERVE = 1
// the FRONT arc (understand/design/initial build) gets a small GUARANTEED slice via phase ceilings,
// kept lean (~35%) so the DYNAMIC back half — where opus escalations and gap-growth live — has room.
const U_END = Math.max(2, Math.round(MAX_AGENTS * 0.12))
const D_END = U_END + Math.max(3, Math.round(MAX_AGENTS * 0.1))
const B_END = D_END + Math.max(2, Math.round(MAX_AGENTS * 0.13))
const gate = (ceil) => spawned < Math.min(ceil, MAX_AGENTS) && !overBudget()
// ...the DYNAMIC back half (escalation, review loop, tie-breaks, completeness, gap build) draws from the
// rest of the global budget up to MAX_AGENTS, minus the synth reserve. This is where agents grow on demand.
const canSpawnDyn = () => spawned < MAX_AGENTS - SYNTH_RESERVE && !overBudget()

// guard: typeof NaN === 'number' is true; without isFinite(), NaN propagates into loop bounds causing
// `round < NaN` or `dry < NaN` → always false → loop body never runs (or dry streak never terminates).
// Add isFinite() + positive-integer clamp to match the guard pattern used by strata-grow.js.
const dryStreakLimit = typeof A.dryStreakLimit === 'number' && isFinite(A.dryStreakLimit) && A.dryStreakLimit > 0 ? Math.floor(A.dryStreakLimit) : 2
const maxReviewRounds = typeof A.maxReviewRounds === 'number' && isFinite(A.maxReviewRounds) && A.maxReviewRounds > 0 ? Math.floor(A.maxReviewRounds) : UNLEASHED ? 8 : 4
const maxImprovementRounds = typeof A.maxImprovementRounds === 'number' && isFinite(A.maxImprovementRounds) && A.maxImprovementRounds > 0 ? Math.floor(A.maxImprovementRounds) : UNLEASHED ? 6 : 2

if (UNLEASHED)
  log(
    `Strata/strata-ultra: ⚠️ UNLEASHED — soft cap & token budget IGNORED. ` +
      `Bounded only by MAX_AGENTS=${MAX_AGENTS}${explicitMax ? ' (your maxAgents)' : ' (950 lifetime backstop)'} and any hard budget.total.`
  )
log(
  `Strata/strata-ultra: cap=${CEIL} (${candidates.length ? 'set' : 'default'})${UNLEASHED ? ' [UNLEASHED]' : ''}, MAX_AGENTS=${MAX_AGENTS} ` +
    `(front ceilings U=${U_END} D=${D_END} B=${B_END}; dynamic back half draws the rest), ` +
    `tiers scout=${TIER.scout} design=${TIER.design} build=${TIER.build} review=${TIER.review} opus-for=judge/advice/tiebreak/critic/synth`
)

// ============================ schemas ============================
const MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['facts'],
  properties: {
    facts: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
}
const APPROACH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['approach', 'workUnits'],
  properties: {
    approach: { type: 'string' },
    keyIdeas: { type: 'array', items: { type: 'string' } },
    tradeoffs: { type: 'array', items: { type: 'string' } },
    workUnits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'instruction'],
        properties: { id: { type: 'string' }, instruction: { type: 'string' } },
      },
    },
  },
}
const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['winnerIndex', 'rationale'],
  properties: {
    winnerIndex: { type: 'integer' },
    graft: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
  },
}
const BUILD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['unitId', 'output', 'selfScore'],
  properties: {
    unitId: { type: 'string' },
    output: { type: 'string', description: 'the produced artifact CONTENT for this unit — not a file path' },
    selfScore: { type: 'integer', description: 'your honest confidence 0-100 that this unit fully meets its spec' },
    notes: { type: 'string' },
  },
}
const ISSUES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issues'],
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'unitId', 'evidence'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          unitId: { type: 'string' },
          evidence: { type: 'string' },
          fix: { type: 'string' },
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
const CRITIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['complete'],
  properties: {
    complete: { type: 'boolean', description: 'true only if the deliverable fully satisfies the task' },
    gaps: {
      type: 'array',
      description: 'missing pieces, each as a new work unit to build',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'instruction'],
        properties: { id: { type: 'string' }, instruction: { type: 'string' } },
      },
    },
    note: { type: 'string' },
  },
}
const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['deliverable'],
  properties: {
    deliverable: { type: 'string' },
    completeness: { type: 'string' },
    residualRisks: { type: 'array', items: { type: 'string' } },
    coverageNote: { type: 'string' },
  },
}

// counters for the dynamic escalations (reported at the end)
let adviceEscalations = 0
let tiebreakers = 0
let gapUnitsAdded = 0
let improvementRounds = 0

// ============================ Phase 1: UNDERSTAND ============================
phase('Understand')
const SCOUT_PROFILES = {
  review: ['behavior & control flow', 'edge cases & failure modes', 'dependencies & contracts', 'tests & coverage'],
  research: ['primary sources', 'counter-evidence', 'state of the art', 'open questions'],
  implement: ['current behavior', 'constraints & invariants', 'integration points', 'edge cases'],
  migrate: ['source shape', 'target shape', 'data-loss risks', 'cutover & rollback'],
}
const scoutAngles = (
  Array.isArray(A.scoutAngles) && A.scoutAngles.length
    ? A.scoutAngles
    : SCOUT_PROFILES[A.taskClass] || ['scope & goal', 'context & constraints', 'unknowns & risks', 'prior art / what exists']
).slice(0, Math.max(2, U_END))

const maps = (
  await parallel(
    scoutAngles.map((angle) => () => {
      if (!gate(U_END)) return null
      spawned++
      return agent(
        `Task to accomplish:\n${A.task}\n\nYou are a scout. Map STRICTLY this angle: "${angle}". Read the real files/sources and report concrete, evidence-backed observations, the hard constraints, and the risks for this angle only.`,
        { label: `understand:${angle.slice(0, 22)}`, phase: 'Understand', model: TIER.scout, schema: MAP_SCHEMA }
      )
    })
  )
).filter(Boolean)
const mapDigest = {
  facts: maps.flatMap((m) => m.facts || []),
  constraints: Array.from(new Set(maps.flatMap((m) => m.constraints || []))),
  risks: Array.from(new Set(maps.flatMap((m) => m.risks || []))),
}

// ============================ Phase 2: DESIGN (mini-panel) ============================
phase('Design')
const DESIGN_LENSES = (
  Array.isArray(A.designLenses) && A.designLenses.length
    ? A.designLenses
    : ['simplicity-first', 'robustness-first (failure modes & scale)', 'pragmatic / reuse-existing', 'novel / challenge the obvious framing']
).slice(0, Math.max(2, D_END - U_END - 1))

const approaches = (
  await parallel(
    DESIGN_LENSES.map((lens, i) => () => {
      if (!gate(D_END)) return null
      spawned++
      return agent(
        `Task to accomplish:\n${A.task}\n\nUNDERSTANDING (from scouts):\n${JSON.stringify(mapDigest, null, 2)}\n\n` +
          `Propose ONE approach from this lens: "${lens}". Commit to the lens so it is genuinely distinct. Decompose it into concrete, independent work units (each with an id and a clear instruction) that can be built in parallel.`,
        { label: `design:${lens.slice(0, 20)}`, phase: 'Design', model: TIER.design, schema: APPROACH_SCHEMA }
      ).then((r) => (r && r.approach ? { index: i, lens, ...r } : null))
    })
  )
).filter(Boolean)

if (!approaches.length) {
  return { task: A.task, cap: CEIL, agentsSpawned: spawned, maxAgents: MAX_AGENTS, error: 'no viable design approach produced — raise the cap' }
}

let winner,
  graft = []
if (approaches.length === 1) {
  winner = approaches[0]
} else if (gate(D_END)) {
  spawned++
  const verdict = await agent(
    `You are judging design approaches for this task:\n${A.task}\n\n` +
      `APPROACHES:\n${JSON.stringify(
        approaches.map((a) => ({ index: a.index, lens: a.lens, approach: a.approach, keyIdeas: a.keyIdeas, tradeoffs: a.tradeoffs })),
        null,
        2
      )}\n\nPick the winner that best fits the task and constraints. Name ideas from the losers worth grafting into the build.`,
    { label: 'design:judge', phase: 'Design', model: TIER.judge, schema: JUDGE_SCHEMA }
  )
  // agent() can resolve to null without throwing — fall back to the first approach instead of dereferencing null
  const widx = verdict && approaches.some((a) => a.index === verdict.winnerIndex) ? verdict.winnerIndex : approaches[0].index
  winner = approaches.find((a) => a.index === widx)
  graft = (verdict && verdict.graft) || []
} else {
  winner = approaches[0]
}
const graftBlock = graft.length ? `\nFold in these ideas where they help:\n- ${graft.join('\n- ')}\n` : ''

// shared builder so initial build, gap build, and revise all behave the same
const buildOne = (unit, gateFn, lbl) => {
  if (!gateFn()) return Promise.resolve(null)
  spawned++
  return agent(
    `Task:\n${A.task}\n\nChosen approach: ${winner.approach}\n${graftBlock}\nBuild THIS work unit only (id "${unit.id}"):\n${unit.instruction}\n\n` +
      `Produce the finished artifact CONTENT in the \`output\` field — do NOT write files to disk or return a path. Set selfScore to your honest 0-100 confidence it fully meets the spec.`,
    { label: lbl, phase: 'Build', model: TIER.build, schema: BUILD_SCHEMA }
  )
}

// ============================ Phase 3: BUILD (+ dynamic opus advice for low-confidence units) ============================
phase('Build')
let workUnits = Array.isArray(winner.workUnits) && winner.workUnits.length ? winner.workUnits : [{ id: 'main', instruction: A.task }]
const buildBudget = Math.max(1, Math.min(B_END, MAX_AGENTS) - spawned)
if (workUnits.length > buildBudget) {
  log(`build: ${workUnits.length} units planned but front budget allows ${buildBudget}; building ${buildBudget} now (the completeness critic can grow the rest)`)
  workUnits = workUnits.slice(0, buildBudget)
}
const built = (await parallel(workUnits.map((u) => () => buildOne(u, () => gate(B_END), `build:${u.id}`)))).filter(Boolean)
let artifacts = {}
for (const b of built) artifacts = { ...artifacts, [b.unitId || 'main']: b.output }

// DYNAMIC ESCALATION #1 — rescue low-confidence units with an opus advice pass, then a sonnet revise.
for (const b of built) {
  const uid = b.unitId || 'main'
  if (typeof b.selfScore === 'number' && b.selfScore < ADVICE_THRESHOLD && canSpawnDyn()) {
    spawned++
    const advice = await agent(
      `A builder rated its own work ${b.selfScore}/100 for this task:\n${A.task}\n\nUNIT "${uid}" instruction: ${(workUnits.find((u) => u.id === uid) || {}).instruction || '(gap unit)'}\n\nCURRENT OUTPUT:\n${b.output}\n\nGive expert, specific guidance to lift this unit to top quality — the concrete fixes and the bar it is missing. Do not rewrite it yourself.`,
      { label: `advise:${uid}`, phase: 'Build', model: TIER.advise }
    )
    if (canSpawnDyn()) {
      spawned++
      adviceEscalations++
      const revised = await agent(
        `Task:\n${A.task}\n\nRevise UNIT "${uid}" using this expert advice. Return the full improved artifact CONTENT in \`output\`; do not write files.\n\nADVICE:\n${typeof advice === 'string' ? advice : ''}\n\nCURRENT:\n${artifacts[uid]}`,
        { label: `revise:${uid}`, phase: 'Build', model: TIER.build, schema: BUILD_SCHEMA }
      )
      if (revised && revised.output) artifacts = { ...artifacts, [uid]: revised.output }
    }
  }
}

// ============================ Phase 4: REVIEW — dynamic loop (verify tie-breaks + completeness-grown gaps) ============================
phase('Review')
const RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
const reviewDims = Array.isArray(A.reviewDimensions) && A.reviewDimensions.length
  ? A.reviewDimensions
  : SCOUT_PROFILES[A.taskClass]?.slice(0, 3) || ['correctness', 'robustness & edge cases', 'meets the task requirements']
const reviewLog = []

// one review-until-dry pass over the current artifacts
const reviewUntilDry = async () => {
  let dry = 0
  let round = 0
  while (round < maxReviewRounds && dry < dryStreakLimit && canSpawnDyn()) {
    round++
    const artifactsJson = JSON.stringify(artifacts, null, 2)
    const found = (
      await parallel(
        reviewDims.map((dim) => () => {
          if (!canSpawnDyn()) return null
          spawned++
          return agent(
            `Task being delivered:\n${A.task}\n\nCURRENT ARTIFACTS (unitId -> output):\n${artifactsJson}\n\n` +
              `Review STRICTLY for: "${dim}". Report only concrete, evidence-backed issues, each tied to its unitId, with a suggested fix. Empty list if none.`,
            { label: `review:${dim.slice(0, 16)}#${improvementRounds}.${round}`, phase: 'Review', model: TIER.review, schema: ISSUES_SCHEMA }
          )
        })
      )
    )
      .filter(Boolean)
      .flatMap((r) => r.issues || [])
      .filter((it) => it && it.title)
      .sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9))

    const confirmed = []
    for (const it of found) {
      if (!canSpawnDyn()) break
      const high = it.severity === 'CRITICAL' || it.severity === 'HIGH'
      const votes = high ? 2 : 1
      const ballots = (
        await parallel(
          Array.from({ length: votes }, () => () => {
            if (!canSpawnDyn()) return null
            spawned++
            return agent(
              `Adversarially verify this review issue against the artifact. Default to isReal=false unless the evidence clearly supports it.\n\nISSUE:\n${JSON.stringify(it)}\n\nARTIFACT unit "${it.unitId}":\n${artifacts[it.unitId] ?? '(not found)'}`,
              { label: `verify:${it.title.slice(0, 16)}`, phase: 'Review', model: TIER.verify, schema: VERDICT_SCHEMA }
            )
          })
        )
      ).filter(Boolean)
      // Fail OPEN on a missing OR partial ballot: a budget-truncated verify must not silently DROP a
      // possibly-real issue. Confirm it for repair (the repair loop's own gate skips work if budget is out).
      if (ballots.length < votes) {
        confirmed.push(it)
        continue
      }
      const real = ballots.filter((v) => v.isReal).length
      let isReal
      // DYNAMIC ESCALATION #2 — verifiers split on a high-severity issue → spawn an opus tie-breaker.
      if (ballots.length === 2 && real === 1 && high && canSpawnDyn()) {
        spawned++
        tiebreakers++
        const tb = await agent(
          `Two reviewers disagree on whether this issue is real. You are the deciding opus vote. Judge strictly.\n\nISSUE:\n${JSON.stringify(it)}\n\nARTIFACT unit "${it.unitId}":\n${artifacts[it.unitId] ?? '(not found)'}`,
          { label: `tiebreak:${it.title.slice(0, 14)}`, phase: 'Review', model: TIER.tiebreak, schema: VERDICT_SCHEMA }
        )
        isReal = !!(tb && tb.isReal)
      } else {
        isReal = real >= Math.ceil(ballots.length / 2)
      }
      if (isReal) confirmed.push(it)
    }

    reviewLog.push({ pass: improvementRounds, round, found: found.length, confirmed: confirmed.length })
    if (!confirmed.length) {
      dry++
      continue
    }
    dry = 0

    const byUnit = {}
    for (const it of confirmed) (byUnit[it.unitId] = byUnit[it.unitId] || []).push(it)
    for (const [unitId, issues] of Object.entries(byUnit)) {
      if (!canSpawnDyn()) break
      if (artifacts[unitId] === undefined) continue
      spawned++
      const fixed = await agent(
        `Task:\n${A.task}\n\nFix the confirmed issues in this unit, preserving what works. Return the full corrected artifact CONTENT in \`output\`; do NOT write files.\n\n` +
          `UNIT "${unitId}" CURRENT:\n${artifacts[unitId]}\n\nCONFIRMED ISSUES:\n${JSON.stringify(issues, null, 2)}`,
        { label: `repair:${unitId}#${improvementRounds}`, phase: 'Review', model: TIER.repair, schema: BUILD_SCHEMA }
      )
      if (fixed && fixed.output) artifacts = { ...artifacts, [unitId]: fixed.output }
    }
  }
}

// DYNAMIC OUTER LOOP — review-until-dry, then an opus completeness critic GROWS new units for any gaps,
// builds them, and re-enters review. Repeats until the critic says complete, or the budget/cap is reached.
while (true) {
  await reviewUntilDry()
  if (!canSpawnDyn() || improvementRounds >= maxImprovementRounds) break
  improvementRounds++
  spawned++
  const critic = await agent(
    `Task:\n${A.task}\n\nCURRENT DELIVERABLE (unitId -> output):\n${JSON.stringify(artifacts, null, 2)}\n\n` +
      `You are a completeness critic. Does this FULLY satisfy the task? If not, return complete=false and list the missing pieces as concrete new work units (id + instruction). Be exacting — only call it complete when it truly is.`,
    { label: `completeness#${improvementRounds}`, phase: 'Review', model: TIER.critic, schema: CRITIC_SCHEMA }
  )
  // agent() can resolve to null without throwing — stop the loop instead of dereferencing critic.complete
  if (!critic || critic.complete || !(critic.gaps && critic.gaps.length)) break
  // DYNAMIC ESCALATION #3 — build the gap units the critic identified
  let added = 0
  for (const g of critic.gaps) {
    if (!canSpawnDyn()) break
    const b = await buildOne(g, canSpawnDyn, `build-gap:${g.id}`)
    if (b && b.output) {
      artifacts = { ...artifacts, [b.unitId || g.id]: b.output }
      added++
      gapUnitsAdded++
    }
  }
  if (!added) break
}

// ============================ Phase 5: SYNTHESIZE (the thin opus cap, always runs) ============================
phase('Synthesize')
spawned++
let synthesis
try {
  synthesis = await agent(
    `Task:\n${A.task}\n\nUNDERSTANDING:\n${JSON.stringify(mapDigest, null, 2)}\n\n` +
      `CHOSEN APPROACH: ${winner.approach}\n\nBUILT & REPAIRED ARTIFACTS (unitId -> output):\n${JSON.stringify(artifacts, null, 2)}\n\n` +
      `REVIEW HISTORY: ${JSON.stringify(reviewLog)}\n\n` +
      `Assemble the final deliverable for the task. Be a completeness critic: state what is fully done vs still missing, and note any gaps the agent budget forced.`,
    { label: 'synthesize', phase: 'Synthesize', model: TIER.synth, schema: SYNTH_SCHEMA }
  )
  if (!synthesis) throw new Error('synthesis agent returned null') // route a non-throwing null into the fail-open
} catch (e) {
  synthesis = {
    deliverable: 'Budget ceiling reached before synthesis. Returning built artifacts as the partial result.',
    completeness: 'partial — synthesis truncated by budget',
    residualRisks: ['synthesis truncated by budget'],
    coverageNote: String(e && e.message ? e.message : e),
  }
}

log(
  `done: ${spawned} agents (${adviceEscalations} advice-escalations, ${tiebreakers} tie-breakers, ${gapUnitsAdded} gap-units over ${improvementRounds} improvement rounds), ` +
    `${Object.keys(artifacts).length} units, ~${Math.max(0, spentNow() - startSpent)} output tokens this run`
)
return {
  task: A.task,
  cap: CEIL,
  capWasSet: candidates.length > 0,
  unleashed: UNLEASHED,
  agentsSpawned: spawned,
  maxAgents: MAX_AGENTS,
  approaches: approaches.length,
  winnerLens: winner.lens || null,
  unitCount: Object.keys(artifacts).length,
  dynamic: { adviceEscalations, tiebreakers, gapUnitsAdded, improvementRounds },
  reviewLog,
  artifacts,
  synthesis,
}
