export const meta = {
  name: 'strata-debate',
  description:
    "Dialectic stress-test of ONE proposition. Distinct from panel (which judges N independent designs): debate runs an ADVERSARIAL exchange — each position drafts an opening, then rebuts the others over R rounds, sharpening the disagreement. An opus moderator extracts the points that SURVIVED rebuttal and the unresolved cruxes; an opus synthesis returns a reasoned, integrated verdict (not a winner-take-all). Same Strata DNA: model-tiered (sonnet argues, opus judges/synthesizes), agent-count bounded, survival-gated like refute. Domain-agnostic — strategy go/no-go, bull vs bear, build vs buy, research hypotheses in tension.",
  phases: [
    { title: 'Open', detail: 'each position drafts its opening case on sonnet, grounded in evidence' },
    { title: 'Rebut', detail: 'R rounds of adversarial rebuttal — each side answers the others, on sonnet' },
    { title: 'Judge', detail: 'one opus moderator extracts surviving points + unresolved cruxes' },
    { title: 'Synthesize', detail: 'one opus agent returns an integrated, reasoned verdict' },
  ],
}

// ---- args: { proposition|task, positions?, rounds?, axes?, grounded?, constraints?, cap?, maxAgents?, tierHint? } ----
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
const PROPOSITION = A.proposition || A.task
if (!PROPOSITION) {
  return {
    error:
      "No proposition provided. Invoke as Workflow({ scriptPath: '.../strata-debate.js', args: { proposition, positions?, rounds?, axes? } }).",
  }
}

// ---- tunable constants (the enforcement surface) ----
const DEFAULT_CAP = 150_000
const TOKENS_PER_AGENT = 12_000
const AGENT_FLOOR = 4
const AGENT_ROOF = 40

// ---- model tiers: applied to EVERY agent() call; implicit inherit is forbidden ----
// argue/rebut = sonnet (DRAFT). judge/synth = opus (the value of a debate IS the judgment).
const TIER = { argue: 'sonnet', rebut: 'sonnet', judge: 'opus', synth: 'opus' }
// run every sonnet-tier agent on the 1M-context variant (the cheap bulk carries the long inputs); a hard-hint opus promotion below still wins
for (const k in TIER) if (TIER[k] === 'sonnet') TIER[k] = 'sonnet[1m]'
// hard = spend opus on the arguments when the stakes are very high. Promote BOTH argue AND rebut:
// an ablation (rebut-opus vs all-opus vs all-sonnet, blind-judged) found the discriminating lift —
// surfacing the unstated crux, decision-usefulness — comes from opus on the judgment-adjacent REBUTTAL
// step (read the opponent's strongest case, name the assumption it rests on), NOT from opus openings.
// The prior code promoted only `argue`, withholding opus from the very role that carries the payoff.
if (A.tierHint === 'hard') {
  TIER.argue = 'opus'
  TIER.rebut = 'opus'
}

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
// An explicit agent cap with NO explicit token cap makes the agent count the SOLE binding limit:
// lift the soft token budget so it can't silently undercut the cap. A hard budget.total (the +N
// directive, enforced by the runtime) still applies; passing a k/m token cap too re-imposes SOFT.
const UNCAP_TOKENS = explicitMax != null && !(typeof A.cap === 'number' && A.cap > 0)
const overBudget = () => (UNCAP_TOKENS ? false : spentNow() - startSpent >= SOFT)
// reserve 2 slots for the always-run judge + synth back stages
const canArgue = () => spawned < MAX_AGENTS - 2 && !overBudget()

// ---- positions: at least 2 stances; default PRO vs CON, capped at 4 to keep the exchange legible ----
const DEFAULT_POSITIONS = ['PRO — argue FOR the proposition', 'CON — argue AGAINST the proposition']
const rawPositions = Array.isArray(A.positions) && A.positions.length >= 2 ? A.positions : DEFAULT_POSITIONS
const POSITIONS = rawPositions.slice(0, Math.min(4, rawPositions.length)).map((p) => String(p))
const P = POSITIONS.length

// ---- rounds: opening (1) + R rebuttal rounds per position, fit within the agent budget ----
// total argue agents = P * (1 + ROUNDS); the canArgue() gate is the hard bound, this just right-sizes R.
const requestedRounds = typeof A.rounds === 'number' && A.rounds > 0 ? Math.floor(A.rounds) : 2
const availForDebate = Math.max(P, MAX_AGENTS - 2) // 2 reserved for judge + synth
const maxRoundsFit = Math.max(0, Math.floor(availForDebate / P) - 1)
const ROUNDS = Math.max(1, Math.min(requestedRounds, maxRoundsFit || 1, 5))

// ---- judging axes: caller-supplied; default to a domain-agnostic trio ----
const AXES =
  Array.isArray(A.axes) && A.axes.length
    ? A.axes
    : ['evidential strength (claims backed by real evidence)', 'logical soundness (no fallacies, holds under rebuttal)', 'addresses the strongest counterargument']
const CONSTRAINTS = A.constraints ? String(A.constraints) : ''
const GROUNDED = A.grounded === true
const groundNote = GROUNDED
  ? '\nGround your strongest factual claims in citable sources: use WebSearch / WebFetch to find them and put the URL in evidence. An unsupported assertion is a weak one.'
  : ''

log(
  `Strata/strata-debate: cap=${CEIL} (${candidates.length ? 'set' : 'default'}), MAX_AGENTS=${MAX_AGENTS}${explicitMax != null ? ` (explicit agent cap${UNCAP_TOKENS ? '; token budget lifted' : ''})` : ''}, ` +
    `positions=${P}, rounds=${ROUNDS}, grounded=${GROUNDED}, axes=[${AXES.join(', ')}], ` +
    `tiers argue=${TIER.argue} rebut=${TIER.rebut} judge=${TIER.judge} synth=${TIER.synth}`
)

// ---- schemas ----
const OPEN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['thesis', 'points'],
  properties: {
    thesis: { type: 'string', description: 'the position stated in one sharp sentence' },
    points: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'support'],
        properties: {
          claim: { type: 'string' },
          support: { type: 'string', description: 'the reasoning/evidence backing the claim' },
          url: { type: 'string', description: 'citable source, if grounded' },
        },
      },
    },
    anticipatedCounter: { type: 'string', description: 'the strongest objection you expect, named honestly' },
  },
}
const REBUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rebuttals'],
  properties: {
    rebuttals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['targetPosition', 'targetClaim', 'rebuttal'],
        properties: {
          targetPosition: { type: 'string', description: 'which opponent position you are answering' },
          targetClaim: { type: 'string', description: 'the specific opposing claim you are rebutting' },
          rebuttal: { type: 'string' },
          url: { type: 'string' },
        },
      },
    },
    concessions: { type: 'array', items: { type: 'string' }, description: 'opposing points you honestly concede' },
    reinforced: { type: 'array', items: { type: 'string' }, description: 'your own claims you strengthen this round' },
  },
}
const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['perPosition', 'cruxes', 'rationale'],
  properties: {
    perPosition: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['position', 'score', 'survivingPoints', 'refutedPoints'],
        properties: {
          position: { type: 'string' },
          score: { type: 'number', description: 'overall persuasiveness 0-10 after rebuttal' },
          survivingPoints: { type: 'array', items: { type: 'string' }, description: 'claims that withstood rebuttal' },
          refutedPoints: { type: 'array', items: { type: 'string' }, description: 'claims that were successfully refuted' },
        },
      },
    },
    cruxes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'whyUnresolved'],
        properties: { question: { type: 'string' }, whyUnresolved: { type: 'string' } },
      },
      description: 'the core disagreements the debate did NOT settle',
    },
    rationale: { type: 'string' },
  },
}
const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['conclusion', 'reasoning', 'confidence'],
  properties: {
    conclusion: { type: 'string', maxLength: 6000, description: 'the integrated, reasoned verdict — not winner-take-all' },
    reasoning: { type: 'string', maxLength: 6000, description: 'how the surviving points combine to support the conclusion — cite points concisely, do NOT reproduce full argument texts' },
    survivingPoints: { type: 'array', items: { type: 'string' } },
    cruxes: { type: 'array', items: { type: 'string' }, description: 'what stays unresolved and would change the verdict' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    recommendation: { type: 'string', description: 'the actionable call, if the proposition asks for a decision' },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

const propBlock =
  `PROPOSITION under debate:\n${PROPOSITION}\n` + (CONSTRAINTS ? `\nHARD CONSTRAINTS / context (respect these):\n${CONSTRAINTS}\n` : '')

// transcript accumulates every contribution so each later agent argues against the real, latest record
const transcript = [] // { round, position, kind, content }
const summarize = (entries) =>
  entries.map((e) => `[${e.kind} · ${e.position}${e.round ? ` · round ${e.round}` : ''}]\n${JSON.stringify(e.content)}`).join('\n\n')

// ---- Phase 1: OPEN — each position drafts its opening case in parallel ----
phase('Open')
const openThunks = []
for (let i = 0; i < P; i++) {
  if (!canArgue()) {
    log(`open: gate hit at ${spawned}/${MAX_AGENTS}, only ${i}/${P} openings spawned`)
    break
  }
  spawned++
  const pos = POSITIONS[i]
  openThunks.push(() =>
    agent(
      `You are debating ONE proposition. Take this position and make its strongest honest opening case — you will be rebutted, so anticipate the best counterargument.\n\n` +
        `YOUR POSITION: ${pos}\n\n` +
        propBlock +
        groundNote +
        `\nBe concrete and specific. State a sharp thesis and the load-bearing points that support it.`,
      { label: `open:${pos.slice(0, 24)}`, phase: 'Open', model: TIER.argue, schema: OPEN_SCHEMA }
    ).then((r) => ({ position: pos, content: r }))
  )
}
const openings = (await parallel(openThunks)).filter((o) => o && o.content && o.content.thesis)
if (openings.length < 2) {
  log(`done: only ${openings.length} valid opening(s); not enough for a debate`)
  return {
    proposition: PROPOSITION,
    cap: CEIL,
    agentsSpawned: spawned,
    maxAgents: MAX_AGENTS,
    openings,
    error: 'fewer than 2 valid openings — re-run with a larger cap or clearer proposition',
  }
}
for (const o of openings) transcript.push({ round: 0, position: o.position, kind: 'opening', content: o.content })
// only positions that actually produced an opening continue into the rebuttal rounds
const livePositions = openings.map((o) => o.position)

// ---- Phase 2: REBUT — R rounds; within a round each side rebuts the OTHERS in parallel; rounds are sequential ----
phase('Rebut')
for (let round = 1; round <= ROUNDS; round++) {
  const priorRecord = summarize(transcript)
  const rebutThunks = []
  for (const pos of livePositions) {
    if (!canArgue()) {
      log(`rebut round ${round}: gate hit at ${spawned}/${MAX_AGENTS}`)
      break
    }
    spawned++
    rebutThunks.push(() =>
      agent(
        `You are in round ${round} of a debate. Read the full record below, then REBUT the opposing positions: attack their weakest load-bearing claims, defend yours against their attacks, and concede anything that is genuinely right (conceding strengthens your credibility).\n\n` +
          `YOUR POSITION: ${pos}\n\n` +
          propBlock +
          `\nFULL RECORD SO FAR:\n${priorRecord}\n` +
          groundNote +
          `\nBe specific: name the exact opposing claim you target. Do not repeat your opening — advance the argument.`,
        { label: `rebut:r${round}:${pos.slice(0, 18)}`, phase: 'Rebut', model: TIER.rebut, schema: REBUT_SCHEMA }
      ).then((r) => ({ position: pos, content: r }))
    )
  }
  if (!rebutThunks.length) break
  const rebuttals = (await parallel(rebutThunks)).filter((r) => r && r.content && Array.isArray(r.content.rebuttals))
  for (const r of rebuttals) transcript.push({ round, position: r.position, kind: 'rebuttal', content: r.content })
  if (overBudget()) {
    log(`rebut: soft budget reached after round ${round}; closing the exchange early`)
    break
  }
}

// ---- Phase 3: JUDGE — one opus moderator extracts surviving points + unresolved cruxes (barrier: needs the whole record) ----
phase('Judge')
spawned++ // the judge always runs
let verdict
try {
  verdict = await agent(
    `You are the neutral MODERATOR of a debate. Read the entire record and judge it on the merits — you are not picking a team, you are extracting what the exchange established.\n\n` +
      `For each position: score its overall persuasiveness AFTER rebuttal (0-10), list the points that SURVIVED rebuttal, and the points that were successfully REFUTED. Then name the CRUXES — the core disagreements the debate did not settle and why.\n\n` +
      `JUDGING AXES: ${AXES.join('; ')}\n\n` +
      propBlock +
      `\nFULL RECORD:\n${summarize(transcript)}\n\n` +
      `Be discriminating. A claim only "survives" if it was actually tested and held; an untested claim is not a strong one.`,
    { label: 'judge', phase: 'Judge', model: TIER.judge, schema: JUDGE_SCHEMA }
  )
  if (!verdict) throw new Error('judge agent returned null')
} catch (e) {
  verdict = {
    perPosition: livePositions.map((pos) => ({ position: pos, score: 0, survivingPoints: [], refutedPoints: [] })),
    cruxes: [],
    rationale: `judge stage failed (${String(e && e.message ? e.message : e)}); returning the raw transcript for manual review`,
  }
}

// ---- Phase 4: SYNTHESIZE — one opus agent returns an integrated verdict (not winner-take-all) ----
phase('Synthesize')
spawned++ // synthesis always runs
let synthesis
try {
  synthesis = await agent(
    `You are closing a debate. Do NOT crown a winner — instead integrate the points that survived rebuttal across ALL positions into the single most defensible conclusion, state your confidence, and surface the cruxes that would change it.\n\n` +
      propBlock +
      `\nMODERATOR VERDICT:\n${JSON.stringify(verdict, null, 2)}\n\n` +
      `FULL RECORD:\n${summarize(transcript)}\n\n` +
      `If the proposition asks for a decision, give the actionable recommendation. Be honest about residual uncertainty — a confident wrong answer is worse than a calibrated one.`,
    { label: 'synthesize', phase: 'Synthesize', model: TIER.synth, schema: SYNTH_SCHEMA }
  )
  if (!synthesis) throw new Error('synthesis agent returned null')
} catch (e) {
  synthesis = {
    conclusion: 'synthesis stage did not run — review the moderator verdict and transcript directly',
    reasoning: `synthesis truncated (${String(e && e.message ? e.message : e)})`,
    confidence: 'low',
    openQuestions: ['synthesis stage did not run'],
  }
}

log(
  `done: ${spawned} agents, ${livePositions.length} positions × ${ROUNDS} rebuttal round(s), ~${Math.max(0, spentNow() - startSpent)} output tokens this run`
)
return {
  proposition: PROPOSITION,
  cap: CEIL,
  capWasSet: candidates.length > 0,
  agentsSpawned: spawned,
  maxAgents: MAX_AGENTS,
  positions: livePositions,
  rounds: ROUNDS,
  grounded: GROUNDED,
  axes: AXES,
  verdict,
  synthesis,
  transcript,
}
