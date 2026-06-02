export const meta = {
  name: 'strata-research',
  description:
    "Hypothesis-driven research automation — the scientific method on a leash. FRAME a question into testable hypotheses (opus) -> INVESTIGATE each for confirming/refuting evidence (sonnet, web-grounded by default via WebSearch/WebFetch, or local data via Bash/Read) -> adversarially REFUTE the supported ones (sonnet, skeptic-biased) -> SYNTHESIZE surviving findings into a cited conclusion with explicit confidence and next experiments. Loops: a follow-up round frames NEW hypotheses from the open questions until exhausted or the agent cap. Distinct from deep-research (a web-search fan-out): research is hypothesis-CENTRIC with a refutation gate; the web is one grounding source, not the spine. Model-tiered and agent-count bounded like every Strata mode.",
  // rounds are generated dynamically ("Round N"), so no static phase list — empty avoids orphan entries.
  phases: [],
}

// ---- args: { question|task, maxHypotheses?, rounds?, grounded?, dataPath?, constraints?, cap?, maxAgents?, tierHint? } ----
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
const QUESTION = A.question || A.task
if (!QUESTION) {
  return {
    error:
      "No question provided. Invoke as Workflow({ scriptPath: '.../strata-research.js', args: { question, maxHypotheses?, rounds?, grounded? } }).",
  }
}

// ---- tunable constants (the enforcement surface) ----
const DEFAULT_CAP = 150_000
const TOKENS_PER_AGENT = 12_000
const AGENT_FLOOR = 4
const AGENT_ROOF = 40

// ---- model tiers: applied to EVERY agent() call; implicit inherit is forbidden ----
// frame/synth = opus (the reasoning IS the value). investigate/refute = sonnet. extraction = haiku.
const TIER = { frame: 'opus', investigate: 'sonnet', refute: 'sonnet', synth: 'opus' }
if (A.tierHint === 'cheap') TIER.frame = 'sonnet' // synth stays opus — never cheap the final integration

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
// reserve 1 slot for the always-run final synthesis
const canExplore = () => spawned < MAX_AGENTS - 1 && !overBudget()

// ---- loop sizing: rounds of hypotheses, each round bounded; canExplore() is the hard guard ----
const requestedRounds = typeof A.rounds === 'number' && A.rounds > 0 ? Math.floor(A.rounds) : 3
const MAX_ROUNDS = Math.max(1, Math.min(requestedRounds, 6))
const HYP_PER_ROUND = Math.max(1, Math.min(typeof A.maxHypotheses === 'number' && A.maxHypotheses > 0 ? Math.floor(A.maxHypotheses) : 4, 8))
const GROUNDED = A.grounded !== false // web grounding is ON by default
const DATA_PATH = A.dataPath ? String(A.dataPath) : ''
const CONSTRAINTS = A.constraints ? String(A.constraints) : ''
const sourceNote = GROUNDED
  ? 'GATHER EVIDENCE FROM THE WEB: use WebSearch to find sources and WebFetch to read them. Every factual claim must carry a citable URL; an unsourced claim counts as unsupported.'
  : DATA_PATH
    ? `GATHER EVIDENCE FROM LOCAL DATA at \`${DATA_PATH}\`: use Bash/Read to inspect it. Cite the file/location backing each claim.`
    : 'GATHER EVIDENCE from the most authoritative sources you can reach (web if available, else reason from established knowledge and FLAG that a claim is unsourced).'

log(
  `Strata/strata-research: cap=${CEIL} (${candidates.length ? 'set' : 'default'}), MAX_AGENTS=${MAX_AGENTS}${explicitMax != null ? ` (explicit agent cap${UNCAP_TOKENS ? '; token budget lifted' : ''})` : ''}, ` +
    `rounds<=${MAX_ROUNDS}, hyp/round<=${HYP_PER_ROUND}, grounded=${GROUNDED}, ` +
    `tiers frame=${TIER.frame} investigate=${TIER.investigate} refute=${TIER.refute} synth=${TIER.synth}`
)

// ---- schemas ----
const FRAME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hypotheses'],
  properties: {
    hypotheses: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['hypothesis', 'confirmIf', 'refuteIf'],
        properties: {
          hypothesis: { type: 'string', description: 'a specific, testable claim' },
          confirmIf: { type: 'string', description: 'what evidence would confirm it' },
          refuteIf: { type: 'string', description: 'what evidence would refute it' },
        },
      },
    },
    exhausted: { type: 'boolean', description: 'true if no fresh, untested hypotheses remain worth investigating' },
  },
}
const INVESTIGATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['support', 'evidence', 'confidence', 'reasoning'],
  properties: {
    support: { type: 'string', enum: ['supported', 'partially-supported', 'unsupported', 'inconclusive'] },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['finding'],
        properties: {
          finding: { type: 'string' },
          source: { type: 'string', description: 'name/title of the source' },
          url: { type: 'string', description: 'citable URL (or file location for local data)' },
        },
      },
    },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reasoning: { type: 'string' },
  },
}
const REFUTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['holds', 'reasoning'],
  properties: {
    holds: { type: 'boolean', description: 'does the hypothesis still hold after skeptical scrutiny?' },
    weaknesses: { type: 'array', items: { type: 'string' } },
    confounds: { type: 'array', items: { type: 'string' }, description: 'alternative explanations the evidence does not rule out' },
    revisedSupport: { type: 'string', enum: ['supported', 'partially-supported', 'unsupported', 'inconclusive'] },
    reasoning: { type: 'string' },
  },
}
const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['conclusion', 'confidence', 'reasoning'],
  properties: {
    conclusion: { type: 'string', description: 'the integrated answer to the research question' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reasoning: { type: 'string', description: 'how the surviving findings combine to support the conclusion' },
    keyFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['finding'],
        properties: { finding: { type: 'string' }, citations: { type: 'array', items: { type: 'string' } } },
      },
    },
    openQuestions: { type: 'array', items: { type: 'string' } },
    nextExperiments: { type: 'array', items: { type: 'string' }, description: 'what to investigate next to raise confidence' },
  },
}

const qBlock = `RESEARCH QUESTION:\n${QUESTION}\n` + (CONSTRAINTS ? `\nSCOPE / CONSTRAINTS:\n${CONSTRAINTS}\n` : '')
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim()
const tested = new Set()
const findings = [] // { round, hypothesis, confirmIf, refuteIf, investigation, refute, surviving }

// ---- the loop: FRAME -> (INVESTIGATE -> REFUTE) per hypothesis, round after round until dry or cap ----
let roundsRun = 0
for (let round = 1; round <= MAX_ROUNDS; round++) {
  if (!canExplore()) {
    log(`round ${round}: agent gate reached (${spawned}/${MAX_AGENTS}); stopping`)
    break
  }
  const groupLabel = `Round ${round}`
  phase(groupLabel)
  roundsRun = round

  // ---- FRAME: opus turns the question (round 1) or the open questions (later) into fresh testable hypotheses ----
  spawned++
  const priorBlock = findings.length
    ? `\nALREADY TESTED (do NOT repeat; propose only NEW angles):\n${findings.map((f) => `- [${f.surviving ? 'survived' : f.investigation ? f.investigation.support : 'untested'}] ${f.hypothesis}`).join('\n')}\n`
    : ''
  let frame
  try {
    frame = await agent(
      `You are framing round ${round} of a hypothesis-driven research program. Break the question into specific, TESTABLE hypotheses — each with what evidence would confirm it and what would refute it.\n\n` +
        qBlock +
        priorBlock +
        `\nPropose up to ${HYP_PER_ROUND} hypotheses. Prefer the ones that, if tested, most reduce uncertainty about the question. Set exhausted=true only if no fresh, testable hypothesis remains.`,
      { label: `frame:r${round}`, phase: groupLabel, model: TIER.frame, schema: FRAME_SCHEMA }
    )
    if (!frame) throw new Error('frame returned null')
  } catch (e) {
    log(`round ${round}: frame failed (${String(e && e.message ? e.message : e)}); stopping the loop`)
    break
  }
  let hyps = (frame.hypotheses || []).filter((h) => h && h.hypothesis && !tested.has(norm(h.hypothesis))).slice(0, HYP_PER_ROUND)
  if (!hyps.length || frame.exhausted) {
    log(`round ${round}: no fresh hypotheses${frame.exhausted ? ' (framer reports exhausted)' : ''} — converged`)
    break
  }
  hyps.forEach((h) => tested.add(norm(h.hypothesis)))

  // ---- INVESTIGATE -> REFUTE, streamed per hypothesis (no barrier between the two stages) ----
  // REFUTE is confidence-gated: only the SUPPORTED / PARTIALLY-supported hypotheses earn a skeptic
  // (an already-unsupported hypothesis needs no refutation — same spirit as severity-gated verify).
  const roundResults = await pipeline(
    hyps,
    (h) => {
      if (!canExplore()) return null
      spawned++
      return agent(
        `Investigate this hypothesis rigorously and decide how well the evidence supports it.\n\n` +
          qBlock +
          `\nHYPOTHESIS: ${h.hypothesis}\nWOULD CONFIRM: ${h.confirmIf}\nWOULD REFUTE: ${h.refuteIf}\n\n` +
          sourceNote +
          `\nReport the support level honestly — "inconclusive" and "unsupported" are valid, useful outcomes. Attach your evidence with sources.`,
        { label: `investigate:r${round}:${norm(h.hypothesis).slice(0, 28)}`, phase: groupLabel, model: TIER.investigate, schema: INVESTIGATE_SCHEMA }
      ).then((inv) => ({ h, inv }))
    },
    (prev) => {
      if (!prev || !prev.inv) return null
      const inv = prev.inv
      const worthRefuting = inv.support === 'supported' || inv.support === 'partially-supported'
      if (!worthRefuting) return { h: prev.h, investigation: inv, refute: null, surviving: false }
      if (!canExplore()) return { h: prev.h, investigation: inv, refute: null, surviving: inv.support === 'supported' }
      spawned++
      return agent(
        `Try to REFUTE this research finding. Be a skeptic: look for confounds, weak evidence, cherry-picking, and alternative explanations the investigator missed. The hypothesis only "holds" if the evidence clearly survives scrutiny — default holds=false when it does not.\n\n` +
          qBlock +
          `\nHYPOTHESIS: ${prev.h.hypothesis}\n\nINVESTIGATOR'S CASE:\n${JSON.stringify(inv, null, 2)}\n\n` +
          (GROUNDED ? 'You may use WebSearch/WebFetch to check the cited sources actually say what is claimed.' : ''),
        { label: `refute:r${round}:${norm(prev.h.hypothesis).slice(0, 28)}`, phase: groupLabel, model: TIER.refute, schema: REFUTE_SCHEMA }
      ).then((ref) => ({ h: prev.h, investigation: inv, refute: ref, surviving: !!(ref && ref.holds) }))
    }
  )
  for (const r of roundResults.filter(Boolean)) {
    findings.push({ round, hypothesis: r.h.hypothesis, confirmIf: r.h.confirmIf, refuteIf: r.h.refuteIf, investigation: r.investigation, refute: r.refute, surviving: r.surviving })
  }
  if (overBudget()) {
    log(`soft budget reached after round ${round}; closing investigation`)
    break
  }
}

const surviving = findings.filter((f) => f.surviving)

// ---- SYNTHESIZE — opus integrates the SURVIVING findings into a cited conclusion (always runs) ----
phase('Synthesize')
if (spawned < HARD_LIMIT) spawned++
else log('synthesis: HARD_LIMIT reached; running synthesis without incrementing the counter')
let synthesis
try {
  synthesis = await agent(
    `You are concluding a hypothesis-driven research program. Integrate the findings that SURVIVED adversarial refutation into the most defensible answer to the question. Be explicit about confidence and about what stays open.\n\n` +
      qBlock +
      `\nSURVIVING FINDINGS (held under refutation):\n${JSON.stringify(surviving.map((f) => ({ hypothesis: f.hypothesis, support: f.investigation.support, confidence: f.investigation.confidence, evidence: f.investigation.evidence })), null, 2)}\n\n` +
      `REJECTED / INCONCLUSIVE (for honesty about what did NOT pan out):\n${JSON.stringify(
        findings.filter((f) => !f.surviving).map((f) => ({ hypothesis: f.hypothesis, support: f.investigation ? f.investigation.support : 'untested', refutedBecause: f.refute ? f.refute.reasoning : null })),
        null,
        2
      )}\n\n` +
      `Carry citations through to keyFindings. Do not overclaim — calibrate the confidence to the evidence that actually survived. List the next experiments that would raise confidence.`,
    { label: 'synthesize', phase: 'Synthesize', model: TIER.synth, schema: SYNTH_SCHEMA }
  )
  if (!synthesis) throw new Error('synthesis agent returned null')
} catch (e) {
  synthesis = {
    conclusion: surviving.length ? 'synthesis stage did not run — review the surviving findings directly' : 'no hypotheses survived refutation; the question remains open',
    confidence: 'low',
    reasoning: `synthesis truncated (${String(e && e.message ? e.message : e)})`,
    openQuestions: ['synthesis stage did not run'],
  }
}

log(
  `done: ${spawned} agents, ${roundsRun} round(s), ${findings.length} hypotheses tested, ${surviving.length} survived, ~${Math.max(0, spentNow() - startSpent)} output tokens this run`
)
return {
  question: QUESTION,
  cap: CEIL,
  capWasSet: candidates.length > 0,
  agentsSpawned: spawned,
  maxAgents: MAX_AGENTS,
  roundsRun,
  grounded: GROUNDED,
  hypothesesTested: findings.length,
  survivingCount: surviving.length,
  synthesis,
  findings,
}
