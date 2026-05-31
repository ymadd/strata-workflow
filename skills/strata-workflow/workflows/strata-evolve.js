export const meta = {
  name: 'strata-evolve',
  description:
    "Autonomous, self-propagating development. A PM (opus) owns the vision — turns the user's goal into a charter, selects which bold ideas to fold in, and is the goal-critic. A DIRECTOR (opus) owns execution — drafts an EMERGENT phase plan (not a fixed arc), and at each phase audit PROPOSES PASS / SUBDIVIDE (split an important-or-risky phase into finer sub-phases and spawn MORE agents) / REPAIR. After the Director, the PM SELECTS every cycle — adopts, trims, or overrides the Director's call and judges whether the vision is met (Ideate-style propose → select). Sonnet workers build the real artifacts each phase, and each emergent phase runs in its own live progress group. The phase plan grows itself until the PM judges the vision met, or the agent cap / budget is hit. Distinct from ultra (fixed understand→design→build→review→synth arc) and grow (fixed Plan→Build→Audit→Repair rounds): in evolve the PHASES THEMSELVES are created and mutated by the overseers. Count-bounded (≤950), depth-bounded, and model-tiered like every Strata mode.",
  phases: [
    { title: 'Charter', detail: 'PM (opus) turns the vision into objective + acceptance criteria + priorities' },
    { title: 'Ideate', detail: 'opus proposes bold vision-aligned ideas; PM selects the value-high / risk-low ones to fold in' },
    { title: 'Plan', detail: 'Director (opus) drafts the initial emergent phase plan' },
    { title: 'Evolve', detail: 'each emergent phase gets its own live group: sonnet workers build → grade → Director PROPOSES (subdivide/repair/pass) → PM SELECTS/arbitrates + goal-critic → plan mutates' },
    { title: 'Synthesize', detail: 'opus assembles the deliverable + an evolution log of how the plan grew' },
  ],
}

// ---- args: { task|vision|goal, root?, ideation?, maxDepth?, maxPhases?, unleashed?, maxAgents?, adviceThreshold?, cap?, tierHint? } ----
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
const VISION = A.vision || A.task || (A.goal && (A.goal.objective || A.goal.vision)) || ''
if (!VISION) {
  return { error: "No vision provided. Invoke as Workflow({ scriptPath: '.../strata-evolve.js', args: { vision, root, goal } }). Agree a Goal Contract first (Strata stays idle until the human confirms)." }
}

// ---- tunable constants (the enforcement surface) ----
const DEFAULT_CAP = 500_000 // autonomous development is a big, hot mode
const TOKENS_PER_AGENT = 16_000 // evolve runs hot (re-passes context to workers/auditors), like ultra
const AGENT_FLOOR = 8
const AGENT_ROOF = 120
const HARD_LIMIT = 950 // runtime lifetime-agent backstop; never exceed

// ---- model tiers: applied to EVERY agent() call; implicit inherit is forbidden ----
// pm/director/ideate/synth = opus (the brains). build/revise = sonnet. grade = sonnet (cheap mechanical check).
const TIER = { pm: 'opus', director: 'opus', ideate: 'opus', build: 'sonnet', grade: 'sonnet', revise: 'sonnet', synth: 'opus' }
if (A.tierHint === 'cheap') TIER.ideate = 'sonnet' // never cheap the pm/director judgment; ideation can be cheaper

// ---- budget reads are BEST-EFFORT (never let the API throw) ----
const spentNow = () => {
  try {
    return budget.spent()
  } catch (e) {
    return 0
  }
}
const hardTotal = () => {
  try {
    return budget.total
  } catch (e) {
    return null
  }
}

// ---- derive the ceiling from the cap arg / the +N directive / the default ----
const candidates = [A.cap, hardTotal()].filter((n) => typeof n === 'number' && n > 0)
const CEIL = candidates.length ? Math.min(...candidates) : DEFAULT_CAP
const SOFT = Math.floor(CEIL * 0.8)
const DERIVED = Math.max(AGENT_FLOOR, Math.min(AGENT_ROOF, Math.floor(SOFT / TOKENS_PER_AGENT)))
const UNLEASHED = A.unleashed === true || A.noCap === true
const explicitMax = typeof A.maxAgents === 'number' && A.maxAgents > 0 ? Math.min(A.maxAgents, HARD_LIMIT) : null
const MAX_AGENTS = UNLEASHED
  ? Math.min(HARD_LIMIT, explicitMax || HARD_LIMIT)
  : Math.min(HARD_LIMIT, explicitMax ? Math.max(AGENT_FLOOR, explicitMax) : DERIVED)
// self-propagation backstops: bound the phase queue and the subdivision recursion so it can't run away
const MAX_DEPTH = typeof A.maxDepth === 'number' && A.maxDepth >= 0 ? A.maxDepth : 3
const MAX_PHASES = typeof A.maxPhases === 'number' && A.maxPhases > 0 ? A.maxPhases : Math.min(40, Math.max(6, MAX_AGENTS))
const SYNTH_RESERVE = 1 // keep room for the final synthesis (the only guaranteed post-loop opus call)
const MAX_REPAIRS = typeof A.maxRepairs === 'number' && A.maxRepairs >= 0 ? A.maxRepairs : 2 // per-phase repair cap (subdivide is depth-bounded; repair needs its own so one failing phase can't starve the queue)
const IDEATION = A.ideation === 'conservative' ? 'conservative' : 'bold'
const ROOT = A.root ? String(A.root) : '.'

// ---- the PRIMARY guard is a literal counter (needs no API, cannot fail) ----
let spawned = 0
const startSpent = spentNow()
const overBudget = () => (UNLEASHED ? false : spentNow() - startSpent >= SOFT)
const canSpawn = () => spawned < MAX_AGENTS && !overBudget()
const canSpawnWork = () => spawned < MAX_AGENTS - SYNTH_RESERVE && !overBudget()

log(
  `Strata/strata-evolve: cap=${CEIL} (${candidates.length ? 'set' : 'default'})${UNLEASHED ? ' [UNLEASHED]' : ''}, ` +
    `MAX_AGENTS=${MAX_AGENTS}, maxPhases=${MAX_PHASES}, maxDepth=${MAX_DEPTH}, ideation=${IDEATION}, ` +
    `tiers pm=${TIER.pm} director=${TIER.director} build=${TIER.build} synth=${TIER.synth}`
)

// ---- schemas ----
const CHARTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['objective', 'acceptanceCriteria', 'priorities'],
  properties: {
    objective: { type: 'string', description: 'the product vision restated crisply — what success looks like for the user' },
    acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'concrete, checkable conditions the deliverable must meet' },
    priorities: { type: 'array', items: { type: 'string' }, description: 'what matters most, ordered (the PM uses this to arbitrate trade-offs)' },
    scope: { type: 'string', description: 'what is in scope' },
    nonGoals: { type: 'array', items: { type: 'string' }, description: 'explicitly out of scope (keeps the self-propagation from drifting)' },
  },
}
const IDEATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ideas'],
  properties: {
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'value', 'risk', 'rationale'],
        properties: {
          title: { type: 'string' },
          value: { type: 'number', description: 'value to the user 0-10' },
          risk: { type: 'number', description: 'risk / cost 0-10 (lower is safer)' },
          rationale: { type: 'string' },
        },
      },
    },
  },
}
const IDEA_SELECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['adopt'],
  properties: {
    adopt: { type: 'array', items: { type: 'string' }, description: 'titles of the ideas to fold into the vision (value-high, risk-low, on-vision)' },
    rationale: { type: 'string' },
  },
}
const PHASE_LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['phases'],
  properties: {
    phases: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['goal', 'kind', 'agents'],
        properties: {
          goal: { type: 'string', description: 'what this phase must accomplish' },
          kind: { type: 'string', enum: ['research', 'design', 'build', 'integrate', 'test', 'refine', 'docs'], description: 'the nature of the work' },
          agents: { type: 'integer', description: 'suggested number of parallel sonnet workers for this phase (1-6)' },
          rationale: { type: 'string' },
        },
      },
    },
  },
}
const WORKER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'selfScore'],
  properties: {
    summary: { type: 'string', description: 'what you did this slice of the phase' },
    filesWritten: { type: 'array', items: { type: 'string' }, description: 'paths you created or modified on disk' },
    notes: { type: 'string', description: 'decisions, assumptions, anything the next phase needs' },
    selfScore: { type: 'integer', description: 'your honest 0-100 confidence this slice meets the phase goal' },
  },
}
const GRADE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['meetsPhaseGoal', 'score', 'issues'],
  properties: {
    meetsPhaseGoal: { type: 'boolean' },
    score: { type: 'integer', description: '0-100 quality of the phase output' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'detail'],
        properties: {
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          location: { type: 'string' },
          detail: { type: 'string' },
        },
      },
    },
  },
}
const DIRECTOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'reason', 'productImpact'],
  properties: {
    decision: { type: 'string', enum: ['pass', 'subdivide', 'repair'], description: 'pass = phase done, advance; subdivide = important/risky/underdone, split into finer phases + more agents; repair = re-run the failed parts' },
    subPhases: {
      type: 'array',
      description: 'when subdividing: the finer phases to insert NEXT (each gets more focused agents)',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['goal', 'kind', 'agents'],
        properties: {
          goal: { type: 'string' },
          kind: { type: 'string', enum: ['research', 'design', 'build', 'integrate', 'test', 'refine', 'docs'] },
          agents: { type: 'integer', description: '1-6 parallel sonnet workers' },
          rationale: { type: 'string' },
        },
      },
    },
    repairFocus: { type: 'string', description: 'when repairing: exactly what to fix' },
    productImpact: { type: 'boolean', description: 'true if this phase changed the product enough that the PM should re-check vision alignment now' },
    reason: { type: 'string' },
  },
}
// PM SELECT: the PM runs AFTER the Director every cycle. It is the goal-critic AND the arbiter —
// it reviews the Director's proposed plan-mutation and decides whether to adopt it, trim it, or override it.
// (Mirrors the Ideate phase: the team proposes, the PM selects what to adopt.)
const PM_SELECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['adopt', 'onVision', 'goalMet', 'reason'],
  properties: {
    adopt: { type: 'boolean', description: "adopt the Director's proposed decision as-is? false = you are overriding or trimming it" },
    override: { type: 'string', enum: ['pass', 'repair', 'subdivide', 'none'], description: "if adopt=false, the decision to take INSTEAD of the Director's (none = keep the Director's decision but apply your trims)" },
    subPhasesKeep: { type: 'integer', description: "when the effective decision is subdivide: how many of the Director's proposed sub-phases to keep (trim gold-plating); omit to keep all" },
    repairFocus: { type: 'string', description: 'when you override to repair: exactly what to fix' },
    onVision: { type: 'boolean', description: 'is the work still serving the user vision and acceptance criteria?' },
    goalMet: { type: 'boolean', description: 'are ALL acceptance criteria satisfied — is the deliverable done? Set true ONLY when every criterion is met.' },
    residual: { type: 'array', items: { type: 'string' }, description: 'acceptance criteria not yet met' },
    revisePhases: {
      type: 'array',
      description: 'NEW downstream phases to append because the product needs them (drift correction or newly-clear requirements)',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['goal', 'kind', 'agents'],
        properties: {
          goal: { type: 'string' },
          kind: { type: 'string', enum: ['research', 'design', 'build', 'integrate', 'test', 'refine', 'docs'] },
          agents: { type: 'integer' },
          rationale: { type: 'string' },
        },
      },
    },
    reason: { type: 'string' },
  },
}
const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['deliverableSummary', 'healthGrade', 'evolutionLog', 'coverageNote'],
  properties: {
    deliverableSummary: { type: 'string', description: 'what was built, and how to run/use it' },
    healthGrade: { type: 'string', enum: ['A', 'B', 'C', 'D', 'F'] },
    evolutionLog: { type: 'string', description: 'the story of how the plan grew — phases added, subdivisions, ideas adopted, drifts corrected' },
    openItems: { type: 'array', items: { type: 'string' }, description: 'acceptance criteria not met / known gaps' },
    coverageNote: { type: 'string', description: 'honest: what the agent/budget cap left unfinished' },
  },
}

// ---- helpers ----
const clampAgents = (n) => Math.max(1, Math.min(6, typeof n === 'number' ? n : 2))
const evolution = [] // the running narrative of how the plan mutated
const artifacts = [] // every worker's manifest

// ---- Phase 1: CHARTER — PM turns the vision into objective + acceptance criteria ----
phase('Charter')
let charter = { objective: VISION, acceptanceCriteria: [], priorities: [], scope: '', nonGoals: [] }
if (canSpawn()) {
  spawned++
  try {
    charter =
      (await agent(
        `You are the PRODUCT MANAGER. Turn this user vision into a crisp charter the team will build against. Own the "what" and "why".\n\n` +
          `USER VISION:\n${VISION}\n` +
          (A.goal ? `\nUSER-PROVIDED GOAL CONTRACT (honor it):\n${JSON.stringify(A.goal, null, 2)}\n` : '') +
          `\nProduce objective, concrete checkable acceptanceCriteria, ordered priorities, scope, and nonGoals. The acceptanceCriteria are the definition of done — be specific enough that another agent can verify each one.`,
        { label: 'pm:charter', phase: 'Charter', model: TIER.pm, schema: CHARTER_SCHEMA }
      )) || charter
  } catch (e) {
    /* keep the fallback charter */
  }
}
const charterBlock = `PRODUCT CHARTER:\nobjective: ${charter.objective}\nacceptance: ${(charter.acceptanceCriteria || []).join(' | ')}\npriorities: ${(charter.priorities || []).join(' > ')}` + (charter.nonGoals && charter.nonGoals.length ? `\nnon-goals: ${charter.nonGoals.join(', ')}` : '')

// ---- Phase 2: IDEATE — bold vision-aligned ideas; PM selects which to fold in ----
phase('Ideate')
let adoptedIdeas = []
if (IDEATION === 'bold' && canSpawn()) {
  spawned++
  let ideas = { ideas: [] }
  try {
    ideas =
      (await agent(
        `You are an inventive product/eng lead. Propose BOLD ideas that would make this product meaningfully better than the literal spec — features, architecture choices, UX wins, robustness. Score each by value (to the user) and risk/cost.\n\n${charterBlock}\n\nPropose 4-8 ideas; do not implement anything.`,
        { label: 'ideate', phase: 'Ideate', model: TIER.ideate, schema: IDEATION_SCHEMA }
      )) || ideas
  } catch (e) {
    ideas = { ideas: [] }
  }
  const candidates2 = (ideas.ideas || []).filter((i) => i && i.title)
  if (candidates2.length && canSpawn()) {
    spawned++
    try {
      const sel = await agent(
        `You are the PRODUCT MANAGER deciding which proposed ideas to fold into the build. Adopt only ideas that are ON-VISION and value-high / risk-low — protect the charter, don't gold-plate.\n\n${charterBlock}\n\nIDEAS:\n${JSON.stringify(candidates2, null, 2)}\n\nReturn the titles to adopt.`,
        { label: 'pm:select-ideas', phase: 'Ideate', model: TIER.pm, schema: IDEA_SELECT_SCHEMA }
      )
      const adopt = new Set((sel && sel.adopt) || [])
      adoptedIdeas = candidates2.filter((i) => adopt.has(i.title))
    } catch (e) {
      adoptedIdeas = []
    }
  }
}
if (adoptedIdeas.length) {
  evolution.push(`Ideation: adopted ${adoptedIdeas.length} idea(s): ${adoptedIdeas.map((i) => i.title).join('; ')}`)
  log(`ideate: adopted ${adoptedIdeas.length} idea(s)`)
}
const visionBlock = charterBlock + (adoptedIdeas.length ? `\nADOPTED IDEAS (build these in too): ${adoptedIdeas.map((i) => i.title).join('; ')}` : '')

// ---- Phase 3: PLAN — Director drafts the initial emergent phase plan ----
phase('Plan')
let queue = []
if (canSpawn()) {
  spawned++
  try {
    const plan = await agent(
      `You are the ENGINEERING DIRECTOR. Draft an EMERGENT phase plan to build this — phases tailored to THIS product, not a fixed template. Order them so each builds on the last. Keep it lean; you can subdivide later when a phase proves important or risky.\n\n${visionBlock}\n\nWORKING DIRECTORY: ${ROOT} (workers write real files here).\n\nReturn 3-7 phases, each with a goal, kind, and a suggested worker count (1-6).`,
      { label: 'director:plan', phase: 'Plan', model: TIER.director, schema: PHASE_LIST_SCHEMA }
    )
    queue = ((plan && plan.phases) || []).map((p, i) => ({ ...p, agents: clampAgents(p.agents), depth: 0, id: `P${i + 1}` }))
  } catch (e) {
    queue = []
  }
}
if (queue.length === 0) {
  // fail open: a minimal generic plan so the run still produces something
  queue = [
    { goal: 'Design the solution and its structure', kind: 'design', agents: 1, depth: 0, id: 'P1' },
    { goal: 'Build the core of the deliverable', kind: 'build', agents: 2, depth: 0, id: 'P2' },
    { goal: 'Integrate, test, and refine to meet the acceptance criteria', kind: 'test', agents: 1, depth: 0, id: 'P3' },
  ]
}
evolution.push(`Initial plan (${queue.length} phases): ${queue.map((p) => `${p.id}:${p.kind}`).join(' → ')}`)

// ---- Phase 4: EVOLVE — the self-propagating engine ----
phase('Evolve')
const RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
let phasesRun = 0
let pmFinal = { goalMet: false, residual: charter.acceptanceCriteria || [], onVision: true, reason: 'not yet evaluated' }
let seq = queue.length

while (queue.length && phasesRun < MAX_PHASES && canSpawnWork()) {
  const ph = queue.shift()
  phasesRun++

  // VARIABLE LABEL: each emergent phase gets its OWN live progress group (P1, P1r, P2, P2.1 …) instead of
  // collapsing into one static "Evolve" box — so the left panel reflects the plan as it self-propagates.
  // The same string is passed as opts.phase to every agent() below so it survives parallel()'s race on the
  // global phase() state.
  const evolveLabel = `Evolve ${ph.id}·${ph.kind}`
  phase(evolveLabel)

  // EXECUTE: fan out sonnet workers (barrier — the audit needs the whole phase output)
  const want = Math.min(ph.agents, Math.max(0, MAX_AGENTS - SYNTH_RESERVE - spawned))
  if (want <= 0) {
    // no worker budget left — restore the phase as unrun and stop (don't feed an empty build to grade/director as a ghost phase)
    queue.unshift(ph)
    phasesRun--
    evolution.push(`HALT before ${ph.id} (${ph.kind}): no agent budget for workers`)
    break
  }
  const thunks = []
  for (let w = 0; w < want; w++) {
    if (!canSpawnWork()) break
    spawned++
    const slice = want > 1 ? `\nYou are worker ${w + 1} of ${want} on this phase — take a distinct, non-overlapping slice and coordinate via the files already on disk.` : ''
    thunks.push(() =>
      agent(
        `You are a senior engineer EXECUTING one phase of an evolving build. Do the actual work and WRITE REAL FILES under ${ROOT} (create/modify on disk; do not just describe).\n\n${visionBlock}\n\n` +
          `CURRENT PHASE [${ph.id}/${ph.kind}]: ${ph.goal}${ph.repairFocus ? `\nREPAIR FOCUS: ${ph.repairFocus}` : ''}${slice}\n\n` +
          `Build to the charter's quality bar. Report the files you wrote, key decisions, and an honest selfScore.`,
        { label: `build:${ph.id}${want > 1 ? `#${w + 1}` : ''}`, phase: evolveLabel, model: TIER.build, schema: WORKER_SCHEMA }
      )
    )
  }
  const built = (await parallel(thunks)).filter(Boolean)
  built.forEach((b) => artifacts.push({ phase: ph.id, kind: ph.kind, ...b }))
  const phaseFiles = built.flatMap((b) => b.filesWritten || [])
  const minScore = built.length ? Math.min(...built.map((b) => (typeof b.selfScore === 'number' && !Number.isNaN(b.selfScore) ? b.selfScore : 50))) : 0

  // GRADE: one cheap sonnet auditor checks the phase output against the phase goal
  let grade = { meetsPhaseGoal: true, score: minScore, issues: [] }
  if (canSpawnWork()) {
    spawned++
    try {
      grade =
        (await agent(
          `Audit the output of this build phase against its goal. Read the files that were written and check for real defects (correctness, completeness, integration). Be concrete.\n\n` +
            `PHASE [${ph.id}/${ph.kind}]: ${ph.goal}\nFILES WRITTEN: ${phaseFiles.join(', ') || '(none reported)'}\nWORKER NOTES: ${built.map((b) => b.notes).filter(Boolean).join(' | ').slice(0, 800)}\n\nReturn meetsPhaseGoal, a 0-100 score, and any issues.`,
          { label: `grade:${ph.id}`, phase: evolveLabel, model: TIER.grade, schema: GRADE_SCHEMA }
        )) || grade
    } catch (e) {
      /* keep optimistic fallback */
    }
  }
  const blocking = (grade.issues || []).filter((i) => i.severity === 'CRITICAL' || i.severity === 'HIGH')
  // sort by severity so the slice(0,12) fed to the director keeps the most severe issues (RANK: lower = more severe)
  const sortedIssues = (grade.issues || []).slice().sort((a, b) => (RANK[a.severity] ?? 4) - (RANK[b.severity] ?? 4))

  // DIRECTOR audit (opus): PROPOSE pass / subdivide / repair (the PM arbitrates it next).
  let dir = { decision: 'pass', productImpact: false, reason: 'no director (budget)' }
  if (canSpawnWork()) {
    spawned++
    try {
      dir =
        (await agent(
          `You are the ENGINEERING DIRECTOR auditing a just-finished phase of an evolving build. PROPOSE how the plan should react — the Product Manager will review your call.\n\n${charterBlock}\n\n` +
            `PHASE [${ph.id}/${ph.kind}] (depth ${ph.depth}): ${ph.goal}\n` +
            `GRADE: meetsGoal=${grade.meetsPhaseGoal}, score=${grade.score}, blockingIssues=${blocking.length}, workerMinSelfScore=${minScore}\n` +
            `ISSUES:\n${JSON.stringify(sortedIssues.slice(0, 12), null, 2)}\n\n` +
            `Choose:\n- pass: the phase met its goal; advance.\n- subdivide: this phase is IMPORTANT, RISKY, or UNDERDONE — split it into finer sub-phases (each with focused agents) that will be inserted next. Use this to pour MORE effort exactly where it matters.\n- repair: re-run the failed parts (give repairFocus).\n` +
            (ph.depth >= MAX_DEPTH ? `\nNOTE: max subdivision depth reached for this branch — do NOT subdivide; choose pass or repair.\n` : '') +
            `Set productImpact=true if the product changed enough that the PM should re-check vision now.`,
          { label: `director:${ph.id}`, phase: evolveLabel, model: TIER.director, schema: DIRECTOR_SCHEMA }
        )) || dir
    } catch (e) {
      /* keep pass fallback */
    }
  }

  // PM SELECT (opus, EVERY cycle): the PM is the goal-critic AND the arbiter. It reviews the Director's
  // proposal and either adopts it, trims it, or overrides it — then owns the goalMet/vision call. This
  // guarantees the PM fires after the Director on every phase (Ideate-style propose → select), instead of
  // the Director unilaterally driving the plan with the PM only firing on productImpact/queue-drain.
  let pm = { adopt: true, override: 'none', onVision: true, goalMet: false, residual: pmFinal.residual || [], reason: 'no PM (budget) — Director proposal stands' }
  if (canSpawnWork()) {
    spawned++
    try {
      const dirSummary =
        `decision=${dir.decision}` +
        (dir.decision === 'subdivide' ? ` (${(dir.subPhases || []).length} proposed sub-phases)` : '') +
        (dir.decision === 'repair' ? ` (focus: ${dir.repairFocus || '—'})` : '') +
        ` — ${dir.reason}`
      pm =
        (await agent(
          `You are the PRODUCT MANAGER — the goal-critic AND the arbiter of the Director's call. The Director (engineering) just PROPOSED how the plan should react to the finished phase. YOU decide whether to adopt, trim, or override it, and whether the vision is met. Protect the charter: don't let the build over-repair or gold-plate, and don't under-invest where an acceptance criterion is still unmet.\n\n${charterBlock}\n\n` +
            `PHASE [${ph.id}/${ph.kind}] (depth ${ph.depth}): ${ph.goal}\n` +
            `GRADE: meetsGoal=${grade.meetsPhaseGoal}, score=${grade.score}, blockingIssues=${blocking.length}, workerMinSelfScore=${minScore}\n` +
            `DIRECTOR PROPOSAL: ${dirSummary}\n` +
            `WORK SO FAR (phase summaries):\n${artifacts.map((a) => `[${a.phase}/${a.kind}] ${a.summary}`).join('\n').slice(0, 2200)}\n` +
            `FILES: ${[...new Set(artifacts.flatMap((a) => a.filesWritten || []))].slice(0, 50).join(', ')}\n` +
            `REMAINING PLANNED PHASES: ${queue.map((q) => `${q.id}:${q.kind}`).join(', ') || '(none)'}\n\n` +
            `Set adopt=true to take the Director's decision as-is. Set adopt=false and an override (pass/repair/subdivide) to change it, or keep the decision but use subPhasesKeep to trim the sub-phases. Set goalMet=true ONLY when every acceptanceCriterion is satisfied. Append revisePhases only for genuinely missing work.`,
          { label: `pm:select:${ph.id}`, phase: evolveLabel, model: TIER.pm, schema: PM_SELECT_SCHEMA }
        )) || pm
      pmFinal = { onVision: pm.onVision, goalMet: pm.goalMet, residual: pm.residual || pmFinal.residual || [], reason: pm.reason }
    } catch (e) {
      /* keep the adopt=true fallback so the Director's proposal still applies */
    }
  }

  // EFFECTIVE decision = the Director's proposal AS ARBITRATED by the PM.
  const effective = pm.adopt === false && pm.override && pm.override !== 'none' ? pm.override : dir.decision
  if (pm.adopt === false) evolution.push(`PM ${effective === dir.decision ? 'kept (trimmed)' : `overrode → ${effective}`} the Director on ${ph.id}: ${pm.reason}`)

  // APPLY the arbitrated decision (bounded by depth + the literal counter)
  if (effective === 'subdivide' && ph.depth < MAX_DEPTH && Array.isArray(dir.subPhases) && dir.subPhases.length) {
    const keep = typeof pm.subPhasesKeep === 'number' && pm.subPhasesKeep >= 0 ? Math.min(pm.subPhasesKeep, dir.subPhases.length) : dir.subPhases.length
    const subs = dir.subPhases.slice(0, Math.min(5, keep)).map((s, i) => ({ ...s, agents: clampAgents(s.agents), depth: ph.depth + 1, id: `${ph.id}.${i + 1}` }))
    if (subs.length) {
      queue.unshift(...subs) // insert NEXT — this is the self-propagation
      evolution.push(`SUBDIVIDE ${ph.id} (score ${grade.score}) → ${subs.length} sub-phases [${subs.map((s) => s.id).join(', ')}]${pm.adopt === false ? ' (PM-trimmed)' : ''}: ${dir.reason}`)
      log(`evolve: subdivided ${ph.id} into ${subs.length} sub-phases (depth ${ph.depth + 1})`)
    } else {
      evolution.push(`PASS ${ph.id} (${ph.kind}, score ${grade.score}) — PM trimmed all proposed sub-phases`)
    }
  } else if (effective === 'repair') {
    // repair is NOT depth-bounded like subdivide — give it its own per-phase cap so one failing phase can't repair-loop the whole MAX_PHASES budget
    const attempts = (ph.repairCount || 0) + 1
    if (attempts > MAX_REPAIRS) {
      evolution.push(`REPAIR-CAP ${ph.id}: max repairs (${MAX_REPAIRS}) reached — advancing with score ${grade.score}`)
      log(`evolve: ${ph.id} hit repair cap (${MAX_REPAIRS}), advancing`)
    } else if (canSpawnWork()) {
      const repairFocus = (pm.adopt === false && pm.repairFocus) || dir.repairFocus || 'fix the blocking issues'
      queue.unshift({ goal: ph.goal, kind: ph.kind, agents: ph.agents, depth: ph.depth, id: `${ph.id}r`, repairFocus, repairCount: attempts })
      evolution.push(`REPAIR ${ph.id} (attempt ${attempts}, score ${grade.score}): ${repairFocus}`)
    } else {
      // a repair the overseers WANTED but the budget blocked — record it honestly, don't mislabel as PASS
      evolution.push(`REPAIR-SKIPPED ${ph.id} (score ${grade.score}): cap reached`)
    }
  } else {
    evolution.push(`PASS ${ph.id} (${ph.kind}, score ${grade.score})`)
  }

  // PM goal-critic verdict (the PM already ran this cycle; honor its call).
  // goal-critic wins: if every criterion is met, stop — even if phases remain queued (they become
  // phasesUnrun / gold-plating). Checked BEFORE appending revisePhases so a goalMet+revise response
  // can't swallow the stop signal.
  if (pm.goalMet) {
    evolution.push(`PM: goal MET — vision satisfied, stopping.`)
    log(`evolve: PM declared goal met after ${phasesRun} phases`)
    break
  }
  if (Array.isArray(pm.revisePhases) && pm.revisePhases.length && canSpawnWork()) {
    // clamp the append to remaining phase headroom so the queue can't balloon past MAX_PHASES
    const headroom = Math.max(0, MAX_PHASES - phasesRun - queue.length)
    const adds = pm.revisePhases.slice(0, Math.min(5, headroom)).map((p, i) => ({ ...p, agents: clampAgents(p.agents), depth: 0, id: `R${seq + i + 1}` }))
    seq += adds.length
    if (adds.length) {
      queue.push(...adds) // append downstream
      evolution.push(`PM REVISE: appended ${adds.length} phase(s) [${adds.map((a) => a.id).join(', ')}]: ${pm.reason}`)
      log(`evolve: PM appended ${adds.length} phase(s)`)
    }
  }
  if (!pm.onVision) evolution.push(`PM: drift flagged — ${pm.reason}`)
}
if (phasesRun >= MAX_PHASES) evolution.push(`Stopped: hit maxPhases=${MAX_PHASES} backstop.`)
if (!canSpawnWork() && queue.length) evolution.push(`Stopped: agent/budget cap with ${queue.length} planned phase(s) unrun.`)

// ---- Phase 5: SYNTHESIZE — assemble the deliverable + the evolution log ----
phase('Synthesize')
// synthesis always runs (it consumes the SYNTH_RESERVE slot the loop held back); never let the always-on increment push the counter past the hard backstop
if (spawned < HARD_LIMIT) spawned++
else log(`evolve: WARNING synthesis running at HARD_LIMIT (${spawned}) — not incrementing the counter`)
let synthesis
try {
  synthesis = await agent(
    `You are the lead wrapping up an autonomous build. Summarize what was delivered, grade its health against the charter, and tell the story of how the plan EVOLVED.\n\n${charterBlock}\n\n` +
      `PHASES RUN: ${phasesRun}\nEVOLUTION:\n${evolution.join('\n')}\n\n` +
      `FILES TOUCHED: ${[...new Set(artifacts.flatMap((a) => a.filesWritten || []))].slice(0, 80).join(', ')}\n` +
      `PM FINAL: goalMet=${pmFinal.goalMet}, residual=${JSON.stringify(pmFinal.residual || [])}\n\n` +
      `Write deliverableSummary (incl. how to run/use it), a healthGrade A-F, the evolutionLog, openItems, and an honest coverageNote about anything the budget left unfinished.`,
    { label: 'synthesize', phase: 'Synthesize', model: TIER.synth, schema: SYNTH_SCHEMA }
  )
  if (!synthesis) throw new Error('synthesis agent returned null')
} catch (e) {
  synthesis = {
    deliverableSummary: `Autonomous build ran ${phasesRun} phase(s). See artifacts for what each produced.`,
    healthGrade: pmFinal.goalMet ? 'B' : 'C',
    evolutionLog: evolution.join('\n'),
    openItems: pmFinal.residual || [],
    coverageNote: `synthesis truncated (${String(e && e.message ? e.message : e)}); ${queue.length} planned phase(s) unrun.`,
  }
}

log(
  `done: ${spawned} agents, ${phasesRun} phases run, ${adoptedIdeas.length} ideas adopted, ` +
    `goalMet=${pmFinal.goalMet}, grade=${synthesis.healthGrade}, ~${Math.max(0, spentNow() - startSpent)} output tokens this run`
)
return {
  vision: VISION,
  cap: CEIL,
  capWasSet: candidates.length > 0,
  unleashed: UNLEASHED,
  agentsSpawned: spawned,
  maxAgents: MAX_AGENTS,
  charter,
  adoptedIdeas: adoptedIdeas.map((i) => i.title),
  phasesRun,
  phasesUnrun: queue.length,
  goalMet: pmFinal.goalMet,
  residual: pmFinal.residual || [],
  evolution,
  artifacts,
  synthesis,
}
