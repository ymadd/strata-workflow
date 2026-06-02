export const meta = {
  name: 'strata-panel',
  description:
    "Design tournament: generate N independent approaches to ONE problem from distinct lenses, have an opus panel judge them on caller-supplied axes, then synthesize a single winner that grafts the best ideas from the runners-up. Domain-agnostic — feature architecture, library/skeleton selection, art direction, API design. Opus stays a thin advise+judge+synth layer; the cheap bulk diverges on sonnet. Count-bounded like every Strata mode.",
  // Advise is OPTIONAL (advise:false) — omit it here so no empty phase box shows when it's off;
  // phase('Advise') self-creates its group only when it actually runs. The other three always run.
  phases: [
    { title: 'Diverge', detail: 'N sonnet agents, each designs one approach from a DISTINCT lens' },
    { title: 'Judge', detail: 'one opus panel scores every contender on the caller axes and ranks them' },
    { title: 'Synthesize', detail: 'one opus agent picks the winner and grafts the best runner-up ideas into a final blueprint' },
  ],
}

// ---- args: { problem|task, contenders?, lenses?, axes?, advise?, constraints?, artifactType?, cap?, tierHint? } ----
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
const PROBLEM = A.problem || A.task
if (!PROBLEM) {
  return {
    error:
      "No problem provided. Invoke as Workflow({ scriptPath: '.../strata-panel.js', args: { problem, contenders, axes, lenses } }).",
  }
}

// ---- tunable constants (the enforcement surface) ----
const DEFAULT_CAP = 150_000
const TOKENS_PER_AGENT = 12_000
const AGENT_FLOOR = 4
const AGENT_ROOF = 40

// ---- model tiers: applied to EVERY agent() call; implicit inherit is forbidden ----
// diverge = sonnet (DRAFT/WRITE). advise/judge/synth = opus (the value of a tournament IS the judgment).
const TIER = { advise: 'opus', diverge: 'sonnet', judge: 'opus', synth: 'opus' }
if (A.tierHint === 'cheap') TIER.advise = 'sonnet' // judge/synth stay opus — never cheap the judgment

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

// ---- derive the ceiling from the cap arg / the +N directive / the default ----
const candidates = [A.cap, hardTotal()].filter((n) => typeof n === 'number' && n > 0)
const CEIL = candidates.length ? Math.min(...candidates) : DEFAULT_CAP
const SOFT = Math.floor(CEIL * 0.8)
// An explicit agent-count cap (a leading bare number like `100`) overrides the token-derived clamp and
// may exceed the soft AGENT_ROOF — bounded only by [AGENT_FLOOR, HARD_LIMIT] so the literal counter stays honest.
const HARD_LIMIT = 950
const explicitMax = typeof A.maxAgents === 'number' && isFinite(A.maxAgents) && A.maxAgents > 0 ? Math.floor(A.maxAgents) : null
const MAX_AGENTS = explicitMax != null
  ? Math.max(AGENT_FLOOR, Math.min(HARD_LIMIT, explicitMax))
  : Math.max(AGENT_FLOOR, Math.min(AGENT_ROOF, Math.floor(SOFT / TOKENS_PER_AGENT)))

// ---- the PRIMARY guard is a literal counter (needs no API, cannot fail) ----
let spawned = 0
const startSpent = spentNow()
const overBudget = () => spentNow() - startSpent >= SOFT
const canSpawn = () => spawned < MAX_AGENTS && !overBudget()

// ---- distinct lenses keep contenders from collapsing onto the same idea ----
const DEFAULT_LENSES = [
  'simplicity-first (the least-moving-parts solution)',
  'robustness-first (optimize for failure modes, scale, and edge cases)',
  'novel / creative (challenge the obvious framing; propose the non-default approach)',
  'pragmatic / reuse-existing (lean on proven patterns and what already exists)',
  'performance-first (optimize the hot path and resource cost)',
  'user / experience-first (optimize the consumer of this design)',
]
const ADVISE = A.advise !== false

// reserve agents for the fixed back stages: judge(1) + synth(1) + advise(1 if on)
const RESERVED = 2 + (ADVISE ? 1 : 0)
const availableForDiverge = Math.max(2, MAX_AGENTS - RESERVED)
const requested = typeof A.contenders === 'number' && A.contenders > 0 ? A.contenders : 4
const N = Math.max(2, Math.min(requested, 8, availableForDiverge))
const LENSES = (Array.isArray(A.lenses) && A.lenses.length ? A.lenses : DEFAULT_LENSES).slice(0, N)
while (LENSES.length < N) LENSES.push(`alternative angle #${LENSES.length + 1}`)

// ---- judging axes are caller-supplied; default to a domain-agnostic trio ----
const AXES =
  Array.isArray(A.axes) && A.axes.length ? A.axes : ['merit (does it best solve the problem)', 'simplicity', 'risk (lower is better)']
const ARTIFACT = A.artifactType || 'design / blueprint'
const CONSTRAINTS = A.constraints ? String(A.constraints) : ''

log(
  `Strata/strata-panel: cap=${CEIL} (${candidates.length ? 'set' : 'default'}), MAX_AGENTS=${MAX_AGENTS}${explicitMax != null ? ' (explicit agent cap)' : ''}, ` +
    `contenders=${N}, axes=[${AXES.join(', ')}], advise=${ADVISE}, ` +
    `tiers advise=${TIER.advise} diverge=${TIER.diverge} judge=${TIER.judge} synth=${TIER.synth}`
)

// ---- schemas ----
const DIVERGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['approach', 'rationale', 'keyIdeas', 'tradeoffs'],
  properties: {
    approach: { type: 'string', description: 'the design/proposal itself — concrete and self-contained' },
    rationale: { type: 'string', description: 'why this approach, given the assigned lens' },
    keyIdeas: { type: 'array', items: { type: 'string' }, description: 'the distinctive, transplantable ideas in this approach' },
    tradeoffs: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
}
const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rankings', 'winnerIndex', 'rationale'],
  properties: {
    rankings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'total', 'perAxis', 'strengths', 'weaknesses'],
        properties: {
          index: { type: 'integer', description: 'the contender index being scored' },
          total: { type: 'number', description: 'overall score 0-10' },
          perAxis: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['axis', 'score'],
              properties: { axis: { type: 'string' }, score: { type: 'number', description: '0-10' } },
            },
          },
          strengths: { type: 'array', items: { type: 'string' } },
          weaknesses: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    winnerIndex: { type: 'integer' },
    rationale: { type: 'string', description: 'why the winner wins, and which runner-up ideas are worth grafting' },
  },
}
const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['finalDesign', 'basedOnIndex', 'rationale'],
  properties: {
    finalDesign: { type: 'string', description: 'the chosen design, refined and self-contained — ready to hand to implementation' },
    basedOnIndex: { type: 'integer', description: 'the winning contender this is built on' },
    graftedFrom: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'idea'],
        properties: { index: { type: 'integer' }, idea: { type: 'string' } },
      },
      description: 'the best ideas pulled from the runners-up',
    },
    rationale: { type: 'string' },
    openQuestions: { type: 'array', items: { type: 'string' } },
    implementationOutline: { type: 'array', items: { type: 'string' }, description: 'ordered next steps to build it' },
  },
}

// ---- Phase 0: ADVISE — one opus brief injected into every contender (amortized over N) ----
let brief = ''
if (ADVISE && canSpawn()) {
  phase('Advise')
  spawned++
  try {
    const adv = await agent(
      `You are setting the brief for a DESIGN TOURNAMENT. ${N} independent designers will each propose one ${ARTIFACT} for this problem, then a panel will judge them.\n\n` +
        `PROBLEM:\n${PROBLEM}\n` +
        (CONSTRAINTS ? `\nHARD CONSTRAINTS:\n${CONSTRAINTS}\n` : '') +
        `\nWrite a tight brief (<300 words) that lifts every designer toward expert level: the real quality bar, the non-obvious pitfalls, the criteria that separate a great answer from a mediocre one (the panel will judge on: ${AXES.join('; ')}), and any domain best-practices they must respect. Do NOT propose a solution yourself — only the bar.`,
      { label: 'advise', phase: 'Advise', model: TIER.advise }
    )
    brief = typeof adv === 'string' ? adv : ''
  } catch (e) {
    brief = ''
  }
}

// ---- Phase 1: DIVERGE — N sonnet contenders, each from a DISTINCT lens, in parallel ----
phase('Diverge')
const briefBlock = brief ? `\nSHARED BRIEF (quality bar — respect it):\n${brief}\n` : ''
const thunks = []
for (let i = 0; i < N; i++) {
  if (!canSpawn()) {
    log(`diverge: gate hit at ${spawned}/${MAX_AGENTS}, only ${i} contenders spawned`)
    break
  }
  spawned++
  const lens = LENSES[i]
  thunks.push(() =>
    agent(
      `Design ONE ${ARTIFACT} for this problem. You are contender #${i}, working from a SPECIFIC lens — commit to it fully so the panel sees a genuinely distinct option.\n\n` +
        `YOUR LENS: ${lens}\n` +
        briefBlock +
        (CONSTRAINTS ? `\nHARD CONSTRAINTS:\n${CONSTRAINTS}\n` : '') +
        `\nPROBLEM:\n${PROBLEM}\n\n` +
        `Produce a concrete, self-contained proposal — specific enough to be judged and built, not a vague direction. Make your distinctive, transplantable ideas explicit in keyIdeas.`,
      { label: `diverge:#${i} ${lens.slice(0, 24)}`, phase: 'Diverge', model: TIER.diverge, schema: DIVERGE_SCHEMA }
    )
  )
}
const rawContenders = await parallel(thunks)
const contenders = rawContenders
  .map((c, i) => (c && c.approach ? { index: i, lens: LENSES[i], ...c } : null))
  .filter(Boolean)

if (contenders.length < 2) {
  log(`done: only ${contenders.length} valid contender(s); not enough for a tournament`)
  return {
    problem: PROBLEM,
    cap: CEIL,
    agentsSpawned: spawned,
    maxAgents: MAX_AGENTS,
    contenders,
    error: 'fewer than 2 valid contenders — re-run with a larger cap or fewer/clearer constraints',
  }
}

// ---- Phase 2: JUDGE — one opus panel scores ALL contenders (barrier: cross-comparison needs them together) ----
phase('Judge')
spawned++ // the judge always runs
let verdict
try {
  verdict = await agent(
    `You are the JUDGING PANEL of a design tournament. Score every contender on these axes, then rank them and pick a winner.\n\n` +
      `AXES (score each 0-10; weight them equally unless one is clearly dominant for this problem): ${AXES.join('; ')}\n\n` +
      `PROBLEM:\n${PROBLEM}\n` +
      (CONSTRAINTS ? `\nHARD CONSTRAINTS (penalize violations heavily):\n${CONSTRAINTS}\n` : '') +
      `\nCONTENDERS:\n${JSON.stringify(
        contenders.map((c) => ({ index: c.index, lens: c.lens, approach: c.approach, keyIdeas: c.keyIdeas, tradeoffs: c.tradeoffs, risks: c.risks })),
        null,
        2
      )}\n\n` +
      `Be discriminating — do not award everyone similar scores. In your rationale, name the runner-up ideas that the winner should absorb.`,
    { label: 'judge', phase: 'Judge', model: TIER.judge, schema: JUDGE_SCHEMA }
  )
  if (!verdict) throw new Error('judge agent returned null') // route a non-throwing null into the fail-open below
} catch (e) {
  // fail open: pick by self-reported richness so the run still yields a result
  const fallback = contenders[0]
  verdict = {
    rankings: contenders.map((c) => ({ index: c.index, total: 0, perAxis: [], strengths: [], weaknesses: [] })),
    winnerIndex: fallback.index,
    rationale: `judge stage failed (${String(e && e.message ? e.message : e)}); defaulted to contender #${fallback.index}`,
  }
}
const validIdx = new Set(contenders.map((c) => c.index))
const winnerIndex = validIdx.has(verdict.winnerIndex) ? verdict.winnerIndex : contenders[0].index
const winner = contenders.find((c) => c.index === winnerIndex)

// ---- Phase 3: SYNTHESIZE — opus picks the winner and grafts the best runner-up ideas ----
phase('Synthesize')
spawned++ // synthesis always runs
let synthesis
try {
  synthesis = await agent(
    `You are finalizing a design tournament. Take the WINNER as the base, then graft in the strongest transplantable ideas from the other contenders to produce one refined ${ARTIFACT}, ready to hand to implementation.\n\n` +
      `PROBLEM:\n${PROBLEM}\n` +
      (CONSTRAINTS ? `\nHARD CONSTRAINTS:\n${CONSTRAINTS}\n` : '') +
      `\nPANEL VERDICT:\n${JSON.stringify(verdict, null, 2)}\n\n` +
      `WINNER (contender #${winnerIndex}, lens "${winner.lens}"):\n${JSON.stringify(winner, null, 2)}\n\n` +
      `ALL CONTENDERS (for grafting):\n${JSON.stringify(
        contenders.map((c) => ({ index: c.index, lens: c.lens, keyIdeas: c.keyIdeas })),
        null,
        2
      )}\n\n` +
      `Do not blandly merge everything — keep the winner's coherence and only graft ideas that strengthen it. Record what you grafted and from where.`,
    { label: 'synthesize', phase: 'Synthesize', model: TIER.synth, schema: SYNTH_SCHEMA }
  )
  if (!synthesis) throw new Error('synthesis agent returned null') // route a non-throwing null into the fail-open below
} catch (e) {
  synthesis = {
    finalDesign: winner.approach,
    basedOnIndex: winnerIndex,
    rationale: `synthesis truncated by budget (${String(e && e.message ? e.message : e)}); returning the unmodified winner`,
    openQuestions: ['synthesis stage did not run — review the winner directly'],
  }
}

log(`done: ${spawned} agents, ${contenders.length} contenders judged, winner=#${winnerIndex}, ~${Math.max(0, spentNow() - startSpent)} output tokens this run`)
return {
  problem: PROBLEM,
  cap: CEIL,
  capWasSet: candidates.length > 0,
  agentsSpawned: spawned,
  maxAgents: MAX_AGENTS,
  contendersCount: contenders.length,
  axes: AXES,
  winnerIndex,
  verdict,
  synthesis,
  contenders,
}
