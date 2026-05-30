export const meta = {
  name: 'strata-ultra',
  description:
    "ultracode's full task arc — understand -> design -> build -> review (loop-until-dry) -> synthesize — but on Strata's leash: a hard agent-count cap plus model tiering keep opus to a thin judge+synth layer and stop the session from exhausting. Use to take ONE substantial task end-to-end, exhaustively but within a budget. The opposite of `focus` (do the least): this does the most the cap allows.",
  phases: [
    { title: 'Understand', detail: 'cheap haiku scouts map the task from several angles in parallel' },
    { title: 'Design', detail: 'sonnet proposes approaches from distinct lenses; one opus judge picks a winner' },
    { title: 'Build', detail: 'sonnet fans out the winning design into work units' },
    { title: 'Review', detail: 'dimension finders + severity-gated adversarial verify + repair, looped until dry' },
    { title: 'Synthesize', detail: 'one opus agent assembles the final deliverable and flags what is missing' },
  ],
}

// ---- args: { task, taskClass?, cap?, maxAgents?, designLenses?, reviewDimensions?, dryStreakLimit?, maxReviewRounds?, tierHint? } ----
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
    error: "No task provided. Invoke as Workflow({ scriptPath: '.../strata-ultra.js', args: { task, taskClass, cap } }).",
  }
}

// ---- tunable constants ----
const DEFAULT_CAP = 150_000
// ultra is the most token-heavy mode: it re-passes the full artifact set to every review/verify/repair
// agent, so per-agent spend runs well above the other modes. A higher estimate keeps MAX_AGENTS (and thus
// the token overshoot) conservative. The agent-count counter is still the hard guarantee; tokens are approximate.
const TOKENS_PER_AGENT = 16_000
const AGENT_FLOOR = 8 // ultra is multi-phase; it needs more headroom than focus's floor of 4
const AGENT_ROOF = 120 // hard backstop unless an explicit maxAgents is given
const HARD_LIMIT = 950 // lifetime-agent guard

// ---- model tiers: opus stays a THIN layer (judge + synth only); everything else is haiku/sonnet ----
const TIER = { scout: 'haiku', design: 'sonnet', judge: 'opus', build: 'sonnet', review: 'sonnet', verify: 'sonnet', repair: 'sonnet', synth: 'opus' }
if (A.tierHint === 'cheap') TIER.design = 'sonnet'
if (A.tierHint === 'hard') TIER.verify = 'sonnet' // keep verify on sonnet even when hard; opus is reserved

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

// ---- derive the ceiling and the agent cap ----
const candidates = [A.cap, hardTotal()].filter((n) => typeof n === 'number' && n > 0)
const CEIL = candidates.length ? Math.min(...candidates) : DEFAULT_CAP
const SOFT = Math.floor(CEIL * 0.8)
const DERIVED = Math.max(AGENT_FLOOR, Math.min(AGENT_ROOF, Math.floor(SOFT / TOKENS_PER_AGENT)))
const MAX_AGENTS = Math.min(
  HARD_LIMIT,
  typeof A.maxAgents === 'number' && A.maxAgents > 0 ? Math.max(4, A.maxAgents) : DERIVED
)

// ---- the PRIMARY guard is a literal counter ----
let spawned = 0
const startSpent = spentNow()
const overBudget = () => spentNow() - startSpent >= SOFT
// per-phase ceilings so no single phase starves the rest (the grow-mode lesson)
const SYNTH_RESERVE = 1
const U_END = Math.max(2, Math.round(MAX_AGENTS * 0.18)) // Understand
const D_END = U_END + Math.max(3, Math.round(MAX_AGENTS * 0.15)) // + Design (approaches + judge)
const B_END = D_END + Math.max(2, Math.round(MAX_AGENTS * 0.27)) // + Build
const R_END = Math.max(B_END + 1, MAX_AGENTS - SYNTH_RESERVE) // + Review/Repair (rest, minus the synth reserve)
// gate: may spawn while under this phase ceiling AND the global cap AND not over budget
const gate = (ceil) => spawned < Math.min(ceil, MAX_AGENTS) && !overBudget()

const dryStreakLimit = typeof A.dryStreakLimit === 'number' ? A.dryStreakLimit : 2
const maxReviewRounds = typeof A.maxReviewRounds === 'number' ? A.maxReviewRounds : 4

log(
  `Strata/strata-ultra: cap=${CEIL} (${candidates.length ? 'set' : 'default'}), MAX_AGENTS=${MAX_AGENTS} ` +
    `(phase ceilings U=${U_END} D=${D_END} B=${B_END} R=${R_END}), ` +
    `tiers scout=${TIER.scout} design=${TIER.design} judge=${TIER.judge} build=${TIER.build} review=${TIER.review} synth=${TIER.synth}`
)

// ============================ schemas ============================
const MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['facts'],
  properties: {
    facts: { type: 'array', items: { type: 'string' }, description: 'concrete, evidence-backed observations for this angle' },
    constraints: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
}
const APPROACH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['approach', 'workUnits'],
  properties: {
    approach: { type: 'string', description: 'the proposed approach, concrete and self-contained' },
    keyIdeas: { type: 'array', items: { type: 'string' } },
    tradeoffs: { type: 'array', items: { type: 'string' } },
    workUnits: {
      type: 'array',
      description: 'the independent pieces this approach decomposes into',
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
    graft: { type: 'array', items: { type: 'string' }, description: 'ideas from the losing approaches to fold into the build' },
    rationale: { type: 'string' },
  },
}
const BUILD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['unitId', 'output'],
  properties: {
    unitId: { type: 'string' },
    output: { type: 'string', description: 'the produced artifact for this unit — ready to use' },
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
          unitId: { type: 'string', description: 'the work unit this issue is in (or "global")' },
          evidence: { type: 'string' },
          fix: { type: 'string', description: 'the suggested fix' },
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
  required: ['deliverable'],
  properties: {
    deliverable: { type: 'string', description: 'the final, assembled answer/artifact for the task' },
    completeness: { type: 'string', description: 'what is fully done vs still missing' },
    residualRisks: { type: 'array', items: { type: 'string' } },
    coverageNote: { type: 'string', description: 'any gaps caused by the agent budget' },
  },
}

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
).slice(0, Math.max(2, D_END - U_END - 1)) // leave room for the judge

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

let winner, graft = []
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
  const widx = approaches.some((a) => a.index === verdict.winnerIndex) ? verdict.winnerIndex : approaches[0].index
  winner = approaches.find((a) => a.index === widx)
  graft = verdict.graft || []
} else {
  winner = approaches[0]
}

// ============================ Phase 3: BUILD ============================
phase('Build')
let workUnits = Array.isArray(winner.workUnits) && winner.workUnits.length ? winner.workUnits : [{ id: 'main', instruction: A.task }]
// don't plan more units than the build budget can build
const buildBudget = Math.max(1, Math.min(B_END, MAX_AGENTS) - spawned)
if (workUnits.length > buildBudget) {
  log(`build: ${workUnits.length} units planned but budget allows ${buildBudget}; building the first ${buildBudget}`)
  workUnits = workUnits.slice(0, buildBudget)
}
const graftBlock = graft.length ? `\nFold in these ideas where they help:\n- ${graft.join('\n- ')}\n` : ''
const built = (
  await parallel(
    workUnits.map((u) => () => {
      if (!gate(B_END)) return null
      spawned++
      return agent(
        `Task:\n${A.task}\n\nChosen approach: ${winner.approach}\n${graftBlock}\nBuild THIS work unit only (id "${u.id}"):\n${u.instruction}\n\nProduce the finished artifact for this unit, ready to use. Return the artifact CONTENT itself in the \`output\` field — do NOT write files to disk or return a file path.`,
        { label: `build:${u.id}`, phase: 'Build', model: TIER.build, schema: BUILD_SCHEMA }
      )
    })
  )
).filter(Boolean)
// artifacts: unitId -> output (mutated immutably each repair)
let artifacts = {}
for (const b of built) artifacts = { ...artifacts, [b.unitId || 'main']: b.output }

// ============================ Phase 4: REVIEW (loop-until-dry) ============================
phase('Review')
const RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
const reviewDims = (
  Array.isArray(A.reviewDimensions) && A.reviewDimensions.length
    ? A.reviewDimensions
    : SCOUT_PROFILES[A.taskClass]?.slice(0, 3) || ['correctness', 'robustness & edge cases', 'meets the task requirements']
)
const reviewLog = []
let dry = 0
let round = 0
while (round < maxReviewRounds && dry < dryStreakLimit && gate(R_END)) {
  round++
  const artifactsJson = JSON.stringify(artifacts, null, 2)
  // -- find issues across dimensions (sonnet) --
  const found = (
    await parallel(
      reviewDims.map((dim) => () => {
        if (!gate(R_END)) return null
        spawned++
        return agent(
          `Task being delivered:\n${A.task}\n\nCURRENT ARTIFACTS (unitId -> output):\n${artifactsJson}\n\n` +
            `Review STRICTLY for: "${dim}". Report only concrete, evidence-backed issues, each tied to the unitId it lives in, with a suggested fix. If there are none, return an empty list.`,
          { label: `review:${dim.slice(0, 18)}#${round}`, phase: 'Review', model: TIER.review, schema: ISSUES_SCHEMA }
        )
      })
    )
  )
    .filter(Boolean)
    .flatMap((r) => r.issues || [])
    .filter((it) => it && it.title)
    .sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9))

  // -- severity-gated adversarial verify (2 votes for CRITICAL/HIGH, else 1) --
  const confirmed = []
  for (const it of found) {
    if (!gate(R_END)) break
    const votes = it.severity === 'CRITICAL' || it.severity === 'HIGH' ? 2 : 1
    const ballots = (
      await parallel(
        Array.from({ length: votes }, () => () => {
          if (!gate(R_END)) return null
          spawned++
          return agent(
            `Adversarially verify this review issue against the artifact. Default to isReal=false unless the evidence clearly supports it.\n\nISSUE:\n${JSON.stringify(it)}\n\nARTIFACT unit "${it.unitId}":\n${artifacts[it.unitId] ?? '(not found)'}`,
            { label: `verify:${it.title.slice(0, 18)}`, phase: 'Review', model: TIER.verify, schema: VERDICT_SCHEMA }
          )
        })
      )
    ).filter(Boolean)
    if (ballots.length && ballots.filter((v) => v.isReal).length >= Math.ceil(ballots.length / 2)) confirmed.push(it)
  }

  reviewLog.push({ round, found: found.length, confirmed: confirmed.length })
  if (!confirmed.length) {
    dry++
    continue
  }
  dry = 0

  // -- repair: re-build each affected unit with the confirmed issue(s) as guidance (sonnet) --
  const byUnit = {}
  for (const it of confirmed) (byUnit[it.unitId] = byUnit[it.unitId] || []).push(it)
  for (const [unitId, issues] of Object.entries(byUnit)) {
    if (!gate(R_END)) break
    if (artifacts[unitId] === undefined) continue
    spawned++
    const fixed = await agent(
      `Task:\n${A.task}\n\nFix the confirmed issues in this unit, preserving what works. Return the full corrected artifact CONTENT in the \`output\` field — do NOT write files to disk or return a file path.\n\n` +
        `UNIT "${unitId}" CURRENT:\n${artifacts[unitId]}\n\nCONFIRMED ISSUES:\n${JSON.stringify(issues, null, 2)}`,
      { label: `repair:${unitId}#${round}`, phase: 'Review', model: TIER.repair, schema: BUILD_SCHEMA }
    )
    if (fixed && fixed.output) artifacts = { ...artifacts, [unitId]: fixed.output }
  }
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
      `Assemble the final deliverable for the task. Be a completeness critic: explicitly state what is fully done vs still missing, and note any gaps the agent budget forced.`,
    { label: 'synthesize', phase: 'Synthesize', model: TIER.synth, schema: SYNTH_SCHEMA }
  )
} catch (e) {
  synthesis = {
    deliverable: 'Budget ceiling reached before synthesis. Returning built artifacts as the partial result.',
    completeness: 'partial — synthesis truncated by budget',
    residualRisks: ['synthesis truncated by budget'],
    coverageNote: String(e && e.message ? e.message : e),
  }
}

log(`done: ${spawned} agents, ${approaches.length} approaches, ${Object.keys(artifacts).length} units, ${round} review rounds, ~${Math.max(0, spentNow() - startSpent)} output tokens this run`)
return {
  task: A.task,
  cap: CEIL,
  capWasSet: candidates.length > 0,
  agentsSpawned: spawned,
  maxAgents: MAX_AGENTS,
  approaches: approaches.length,
  winnerLens: winner.lens || null,
  unitCount: Object.keys(artifacts).length,
  reviewRounds: round,
  reviewLog,
  artifacts,
  synthesis,
}
