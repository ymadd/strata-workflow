export const meta = {
  name: 'strata-debug',
  description:
    'Root-cause debugging on a leash for bugs whose cause is unknown. REPRODUCE the symptom (sonnet) -> FRAME ranked hypotheses, each with ONE discriminating experiment (opus) -> TEST the experiments in parallel (sonnet; in isolated git worktrees when the tree is clean) -> reframe from the evidence until a cause is confirmed or the rounds run out -> FIX with a regression test that fails before and passes after (sonnet) -> adversarially VERIFY (sonnet) -> SYNTHESIZE a root-cause report (opus). fix:false stops at the diagnosis. Distinct from research (web-grounded questions) and delegate (the fix is already known). Model-tiered and agent-count bounded like every Strata mode.',
  // rounds are generated dynamically ("Round N"), so no static phase list — empty avoids orphan entries.
  phases: [],
}

// ---- args: { task|symptom, repro?, fix?, maxHypotheses?, rounds?, dod?, conversation?, cap?, maxAgents?, tierHint? } ----
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
const SYMPTOM = A.symptom || A.task
if (!SYMPTOM) {
  return {
    error:
      "No symptom provided. Invoke as Workflow({ scriptPath: '.../strata-debug.js', args: { task: '<what goes wrong, where, since when>', repro?, fix? } }).",
  }
}

// ---- tunable constants (the enforcement surface) ----
const DEFAULT_CAP = 200_000 // debugging runs real commands and a fix; same family as delegate/conduct
const TOKENS_PER_AGENT = 14_000
const AGENT_FLOOR = 6 // repro + frame + 1 test + fix + verify + synth is the smallest useful run
const AGENT_ROOF = 40
const FIX_ATTEMPTS = 2 // fix + 1 retry fed with the verifier's failures

// ---- model tiers: applied to EVERY agent() call; implicit inherit is forbidden ----
// frame/synth = opus (choosing what to test and explaining the cause IS the value).
// repro/test/fix/verify = sonnet (running commands, instrumenting, writing the fix).
const TIER = { repro: 'sonnet', frame: 'opus', test: 'sonnet', fix: 'sonnet', verify: 'sonnet', synth: 'opus' }
// Reasoning effort per role, pinned so agents never inherit the main loop's (often high/xhigh) effort:
// low = mechanical scan/map, medium = bounded build/review/verify, high = judgment (judge/synth/critic).
const EFFORT = { repro: 'medium', frame: 'high', test: 'medium', fix: 'medium', verify: 'medium', synth: 'high' }
if (A.tierHint === 'cheap') TIER.frame = 'sonnet' // synth stays opus — never cheap the final explanation
if (A.tierHint === 'hard') TIER.verify = 'opus' // spend opus on the refutation when the fix is high-stakes

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
const HARD_LIMIT = 950
const explicitMax = typeof A.maxAgents === 'number' && isFinite(A.maxAgents) && A.maxAgents > 0 ? Math.floor(A.maxAgents) : null
const MAX_AGENTS = explicitMax != null
  ? Math.max(AGENT_FLOOR, Math.min(HARD_LIMIT, explicitMax))
  : Math.max(AGENT_FLOOR, Math.min(AGENT_ROOF, Math.floor(SOFT / TOKENS_PER_AGENT)))

// ---- the PRIMARY guard is a literal counter (needs no API, cannot fail) ----
let spawned = 0
const startSpent = spentNow()
const UNCAP_TOKENS = explicitMax != null && !(typeof A.cap === 'number' && A.cap > 0)
const overBudget = () => (UNCAP_TOKENS ? false : spentNow() - startSpent >= SOFT)
// reserve 1 slot for the always-run final synthesis
const canSpawn = () => spawned < MAX_AGENTS - 1 && !overBudget()

const MAX_ROUNDS = Math.max(1, Math.min(typeof A.rounds === 'number' && A.rounds > 0 ? Math.floor(A.rounds) : 3, 4))
const HYP_PER_ROUND = Math.max(1, Math.min(typeof A.maxHypotheses === 'number' && A.maxHypotheses > 0 ? Math.floor(A.maxHypotheses) : 3, 5))
const DO_FIX = A.fix !== false
// Experiments leave room for fix + verify (+ synthesis): an unverified fix is the one outcome this mode
// must not produce by running out of slots (observed 2026-10-01: cap 120k → MAX_AGENTS=6, the tests took
// the last free slot and the fix shipped unverified).
const FIX_RESERVE = DO_FIX ? 2 : 0
const canExperiment = () => spawned < MAX_AGENTS - 1 - FIX_RESERVE && !overBudget()
const DOD = A.dod || 'the regression test fails without the fix and passes with it; the relevant existing tests still pass'
const CONVERSATION = A.conversation ? `\nCONTEXT FROM THE REQUESTING SESSION (intent, what was already tried):\n${String(A.conversation)}\n` : ''

log(
  `Strata/debug: cap=${CEIL} (${candidates.length ? 'set' : 'default'}), MAX_AGENTS=${MAX_AGENTS}${explicitMax != null ? ` (explicit agent cap${UNCAP_TOKENS ? '; token budget lifted' : ''})` : ''}, ` +
    `rounds<=${MAX_ROUNDS}, hyp/round<=${HYP_PER_ROUND}, fix=${DO_FIX}, ` +
    `tiers repro=${TIER.repro} frame=${TIER.frame} test=${TIER.test} fix=${TIER.fix} verify=${TIER.verify} synth=${TIER.synth}`
)

// ---- schemas: schema-bounded output IS the output discipline ----
const REPRO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reproduced', 'observed', 'dirtyTree'],
  properties: {
    reproduced: { type: 'boolean' },
    command: { type: 'string', description: 'the exact command/test that shows the symptom' },
    observed: { type: 'string', description: 'what actually happens (error text, wrong output) — quoted, trimmed' },
    expected: { type: 'string' },
    dirtyTree: { type: 'boolean', description: 'true if `git status --porcelain` shows uncommitted changes' },
    suspectFiles: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string', description: 'conditions that matter (env, data, timing); why it did not reproduce, if so' },
  },
}
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
        required: ['hypothesis', 'experiment', 'confirmIf', 'refuteIf'],
        properties: {
          hypothesis: { type: 'string', description: 'a specific causal claim about the code' },
          experiment: { type: 'string', description: 'ONE concrete experiment that discriminates this hypothesis from the others (instrument, bisect, minimal repro, targeted test)' },
          confirmIf: { type: 'string' },
          refuteIf: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    exhausted: { type: 'boolean', description: 'true if no fresh, testable hypothesis remains' },
  },
}
const TEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'evidence'],
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'inconclusive'] },
    evidence: { type: 'string', description: 'what you ran and what it printed — quoted, trimmed' },
    location: { type: 'string', description: 'file:line of the faulty code, when confirmed' },
    newLead: { type: 'string', description: 'anything the experiment revealed that points elsewhere' },
  },
}
const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['done', 'summary', 'filesTouched'],
  properties: {
    done: { type: 'boolean' },
    summary: { type: 'string' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    regressionTest: { type: 'string', description: 'the test that reproduces the bug, and how to run it' },
    failsWithoutFix: { type: 'boolean', description: 'you ran the regression test with the fix reverted and it failed' },
    testResult: { type: 'string' },
  },
}
const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pass', 'reason'],
  properties: {
    pass: { type: 'boolean' },
    reason: { type: 'string' },
    failures: { type: 'array', items: { type: 'string' } },
  },
}
const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rootCause', 'confidence', 'report'],
  properties: {
    rootCause: { type: 'string', maxLength: 2000 },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    evidenceChain: { type: 'array', items: { type: 'string' }, description: 'symptom → experiment → observation → cause, one step per entry' },
    report: { type: 'string', maxLength: 6000 },
    residualRisks: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
  },
}

const sBlock = `SYMPTOM:\n${SYMPTOM}\n` + (A.repro ? `\nKNOWN REPRO (from the caller):\n${String(A.repro)}\n` : '') + CONVERSATION
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim()

// ---- Phase 1: REPRODUCE — pin the symptom to a command before theorising ----
phase('Reproduce')
let repro = null
if (canSpawn()) {
  spawned++
  repro = await agent(
    `Reproduce this bug. Do NOT fix anything and do NOT edit tracked files — find the smallest command or test that shows the symptom, run it, and quote what it prints. Also run \`git status --porcelain\` INSIDE the project that contains the bug (not the session's working directory) and report whether it has uncommitted changes; if that project is not a git repository, report dirtyTree=true.\n\n${sBlock}`,
    { label: 'repro', phase: 'Reproduce', model: TIER.repro, effort: EFFORT.repro, schema: REPRO_SCHEMA }
  )
}
if (!repro) log('reproduce: no result — hypotheses will be framed from the symptom text alone')
else log(`reproduce: ${repro.reproduced ? `reproduced via \`${repro.command || '?'}\`` : 'NOT reproduced'}${repro.dirtyTree ? ' (dirty tree)' : ''}`)
// Experiments run in isolated worktrees only when the tree is clean: a worktree starts from HEAD, so it
// would silently drop the uncommitted change that may BE the bug. On a dirty tree they run in place, read-only.
const ISOLATE = !!repro && repro.dirtyTree === false
const reproBlock = repro
  ? `\nREPRODUCTION:\n${JSON.stringify({ reproduced: repro.reproduced, command: repro.command, observed: repro.observed, expected: repro.expected, suspectFiles: repro.suspectFiles, notes: repro.notes }, null, 2)}\n`
  : ''
const experimentRules = ISOLATE
  ? 'You are in an isolated git worktree: you MAY add temporary logging/asserts or bisect to run the experiment. Nothing you change here reaches the real tree.'
  : 'You are in the REAL working tree (it has uncommitted changes, is not a git repository, or its state is unknown): do NOT modify, create or delete ANY file in the project — tracked or not. Copy what you need to a fresh temp directory and instrument the copy, or use a debugger / extra flags. Do NOT write the fix or a regression test: that is a later stage, run only once a cause is confirmed.'

// ---- Phase 2: rounds of FRAME -> TEST until a cause is confirmed ----
const tested = new Set()
const results = [] // { round, h, test }
let confirmed = null
let roundsRun = 0
for (let round = 1; round <= MAX_ROUNDS && !confirmed; round++) {
  if (!canExperiment()) {
    log(`round ${round}: agent gate reached (${spawned}/${MAX_AGENTS}, ${FIX_RESERVE} held for fix+verify); stopping`)
    break
  }
  const groupLabel = `Round ${round}`
  phase(groupLabel)
  roundsRun = round
  spawned++
  const prior = results.length
    ? `\nALREADY TESTED (do NOT repeat; use what they showed):\n${results.map((r) => `- [${r.test ? r.test.verdict : 'untested'}] ${r.h.hypothesis}${r.test && r.test.evidence ? ` — ${String(r.test.evidence).slice(0, 300)}` : ''}${r.test && r.test.newLead ? ` (lead: ${r.test.newLead})` : ''}`).join('\n')}\n`
    : ''
  let frame = null
  try {
    frame = await agent(
      `You are diagnosing a bug whose cause is unknown. Read the relevant code, then propose up to ${HYP_PER_ROUND} specific causal hypotheses, ranked most-likely first. For each, design ONE experiment that would discriminate it from the others (instrumentation, bisect, a minimal reproduction, a targeted test) — not "read the code more".\n\n${sBlock}${reproBlock}${prior}\nSet exhausted=true only if no fresh, testable hypothesis remains.`,
      { label: `frame:r${round}`, phase: groupLabel, model: TIER.frame, effort: EFFORT.frame, schema: FRAME_SCHEMA }
    )
  } catch (e) {
    frame = null
  }
  if (!frame) {
    log(`round ${round}: frame unavailable — stopping`)
    break
  }
  const hyps = (frame.hypotheses || []).filter((h) => h && h.hypothesis && !tested.has(norm(h.hypothesis))).slice(0, HYP_PER_ROUND)
  if (!hyps.length || frame.exhausted) {
    log(`round ${round}: no fresh hypotheses${frame.exhausted ? ' (framer reports exhausted)' : ''}`)
    break
  }
  hyps.forEach((h) => tested.add(norm(h.hypothesis)))
  const round_ = await parallel(
    hyps.map((h, i) => () => {
      if (!canExperiment()) return null
      spawned++
      return agent(
        `Run ONE experiment to test a hypothesis about a bug, then report the verdict from what you OBSERVED — not from what the code looks like. "inconclusive" is a valid answer.\n${experimentRules}\n\n${sBlock}${reproBlock}\nHYPOTHESIS: ${h.hypothesis}\nEXPERIMENT: ${h.experiment}\nCONFIRMED IF: ${h.confirmIf}\nREFUTED IF: ${h.refuteIf}\nFILES: ${(h.files || []).join(', ') || '(find them)'}`,
        { label: `test:r${round}:${i + 1}`, phase: groupLabel, model: TIER.test, effort: EFFORT.test, schema: TEST_SCHEMA, ...(ISOLATE ? { isolation: 'worktree' } : {}) }
      ).then((test) => ({ round, h, test }))
    })
  )
  for (const r of round_.filter(Boolean)) results.push(r)
  const skipped = round_.filter((r) => !r).length
  if (skipped) log(`round ${round}: ${skipped} experiment(s) not run — agent slots held for fix+verify+synthesis (raise cap to test more)`)
  confirmed = results.find((r) => r.test && r.test.verdict === 'confirmed') || null
  log(`round ${round}: ${round_.filter(Boolean).length} experiment(s) — ${confirmed ? `CONFIRMED: ${confirmed.h.hypothesis}` : 'no cause confirmed yet'}`)
}

// ---- Phase 3: FIX + adversarial VERIFY (only on a confirmed cause) ----
let fix = null
let verify = null
let fixAttempts = 0
if (DO_FIX && confirmed) {
  phase('Fix')
  for (let attempt = 1; attempt <= FIX_ATTEMPTS && canSpawn(); attempt++) {
    fixAttempts = attempt
    spawned++
    const feedback = attempt > 1 && verify ? `\nThe previous fix FAILED verification: ${JSON.stringify(verify.failures || verify.reason)}. Fix the cause, not the symptom.\n` : ''
    fix = await agent(
      `Fix this bug in the real working tree. The cause has been CONFIRMED by an experiment. First write a regression test that reproduces the symptom and FAILS; then fix the cause; then show the test passes. Run the test once with your fix reverted to prove it fails without it (restore the fix afterwards). Keep the change minimal and scoped to the cause.\n\n${sBlock}${reproBlock}\nCONFIRMED CAUSE: ${confirmed.h.hypothesis}\nEVIDENCE: ${confirmed.test.evidence}\nLOCATION: ${confirmed.test.location || '(see evidence)'}\nDoD: ${DOD}${feedback}`,
      { label: `fix#${attempt}`, phase: 'Fix', model: TIER.fix, effort: EFFORT.fix, schema: FIX_SCHEMA }
    )
    if (!fix) break
    if (!canSpawn()) {
      log('fix: no agent slot left for verification — returning the fix unverified')
      break
    }
    spawned++
    verify = await agent(
      `Adversarially verify a bug fix. Default to pass=false unless the evidence clearly supports it. Re-run the regression test and the relevant existing tests yourself; check the fix addresses the confirmed cause (not just the one repro), and that the regression test really fails without it.\n\n${sBlock}\nCONFIRMED CAUSE: ${confirmed.h.hypothesis}\nDoD: ${DOD}\nFIXER REPORT: ${JSON.stringify(fix)}`,
      { label: `verify#${attempt}`, phase: 'Fix', model: TIER.verify, effort: EFFORT.verify, schema: VERIFY_SCHEMA }
    )
    if (!verify || verify.pass) break
  }
} else if (DO_FIX) {
  log('fix: skipped — no cause was confirmed (a fix without a confirmed cause is a guess)')
}

// ---- Phase 4: SYNTHESIZE — the root-cause report (always runs) ----
phase('Synthesize')
if (spawned < HARD_LIMIT) spawned++
else log('synthesis: HARD_LIMIT reached; running synthesis without incrementing the counter')
let synthesis
try {
  synthesis = await agent(
    `Write the root-cause report for this debugging run. State the cause only as strongly as the experiments support it; if nothing was confirmed, say so and rank what remains. Build the evidence chain from the observations below, not from code reading.\n\n${sBlock}${reproBlock}\nEXPERIMENTS:\n${JSON.stringify(results.map((r) => ({ round: r.round, hypothesis: r.h.hypothesis, experiment: r.h.experiment, verdict: r.test ? r.test.verdict : 'not run', evidence: r.test ? r.test.evidence : null, location: r.test ? r.test.location : null })), null, 2)}\n\nFIX: ${fix ? JSON.stringify(fix) : DO_FIX ? '(not attempted)' : '(diagnosis only — fix:false)'}\nVERIFICATION: ${verify ? JSON.stringify(verify) : '(none)'}`,
    { label: 'synthesize', phase: 'Synthesize', model: TIER.synth, effort: EFFORT.synth, schema: SYNTH_SCHEMA }
  )
  if (!synthesis) throw new Error('synthesis agent returned null')
} catch (e) {
  synthesis = {
    rootCause: confirmed ? confirmed.h.hypothesis : 'not determined',
    confidence: 'low',
    report: `synthesis stage did not run (${String(e && e.message ? e.message : e)}) — see experiments`,
  }
}

const fixStatus = !DO_FIX ? 'not-requested' : !confirmed ? 'no-confirmed-cause' : !fix ? 'not-attempted' : verify && verify.pass ? 'verified' : verify ? 'failed-verification' : 'unverified'
log(`done: ${spawned} agents, ${roundsRun} round(s), ${results.length} experiment(s), cause ${confirmed ? 'confirmed' : 'NOT confirmed'}, fix ${fixStatus}, ~${Math.max(0, spentNow() - startSpent)} output tokens this run`)
return {
  symptom: SYMPTOM,
  cap: CEIL,
  capWasSet: candidates.length > 0,
  agentsSpawned: spawned,
  maxAgents: MAX_AGENTS,
  reproduced: repro ? repro.reproduced : null,
  isolatedExperiments: ISOLATE,
  roundsRun,
  experiments: results.map((r) => ({ round: r.round, hypothesis: r.h.hypothesis, verdict: r.test ? r.test.verdict : 'not run', location: r.test ? r.test.location : null })),
  confirmedCause: confirmed ? { hypothesis: confirmed.h.hypothesis, evidence: confirmed.test.evidence, location: confirmed.test.location || null } : null,
  fix: { status: fixStatus, attempts: fixAttempts, filesTouched: fix ? fix.filesTouched : [], regressionTest: fix ? fix.regressionTest || null : null },
  verify,
  synthesis,
}
