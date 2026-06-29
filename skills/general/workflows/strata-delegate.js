export const meta = {
  name: 'strata-delegate',
  description:
    'Cost-tiered execution of ONE heavy task with a frontier apex: cheap-first build (opus/sonnet) -> adversarial verify -> staged escalation (retry -> apex ADVISE diagnosis-only -> apex clean-slate rebuild). Apex spend is gated by literal counters (<=1 advise + <=1 rebuild per unit, never bulk). Savings come from routing — the apex runs only on evidence of failure — not from output suppression.',
  phases: [
    { title: 'Plan', detail: 'optional apex instruction packet (planFirst) — the output-light L0 role' },
    { title: 'Execute', detail: 'sequential per-unit build -> verify -> escalation ladder' },
    { title: 'Report', detail: 'deterministic code-side assembly (no synthesis agent)' },
  ],
}

// ---- args: { task, cap, maxAgents, apex, dataSensitive, planFirst, units?, tierHint, dod? } ----
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
      "No task provided. Invoke as Workflow({ scriptPath: '.../strata-delegate.js', args: { task, cap?, apex?, planFirst? } }).",
  }
}

// ---- tunable constants (the enforcement surface) ----
const DEFAULT_CAP = 200_000 // execution modes run hot (real builds + verifies); same family as ultra
const TOKENS_PER_AGENT = 16_000
const AGENT_FLOOR = 4
const AGENT_ROOF = 24 // delegate is depth-not-breadth: <=6 units * a short escalation ladder, never a fan-out
const HARD_LIMIT = 950
const MAX_UNITS = 6 // a packet bigger than this is a scale/ultra job, not a delegation
const BASE_ATTEMPTS = 2 // stage 1: attempt + 1 retry at the base tier (delegation-spec §5 段1)
const APEX_ADVISE_PER_UNIT = 1 // stage 2: diagnosis-only — output-light, an order cheaper than execution
const APEX_BUILD_PER_UNIT = 1 // stage 3: clean-slate rebuild — the only apex execution allowed

// ---- models: named constants, not a TIER map (delegate has roles no other mode has) ----
// Charter exception, on purpose: delegate is SINGLE-TASK EXECUTION (the L2 layer of
// delegation-spec.md), not bulk fan-out — so its default builder is opus. The apex tier exists
// only as an escalation target, capped by the literal counters above; it is never a unit default.
// The apex tier is a spend-gated escalation, NOT a config knob: it must not be copied into any other
// mode's model selection. Both verifiers (verify-invariants.js + check-invariants.sh) fail the build
// if the literal 'fable' appears outside this APEX line in any workflow — containment is mechanical.
// ⏳ KILL SWITCH (2026-06-13): the US government halted Fable 5. While true, the apex tier is forced
// to opus regardless of args — no dead fable call + fallback churn. Flip to false to restore the apex
// when the halt lifts (single point of restoration; see delegation-spec.md §0b).
const FABLE_HALTED = true
const APEX_DEFAULT = 'fable' // the only place outside APEX_MODEL the apex tier may be named
const APEX_MODEL = FABLE_HALTED ? 'opus' : A.dataSensitive === true ? 'opus' : A.apex === 'opus' ? 'opus' : APEX_DEFAULT
// dataSensitive: Mythos-class retention (30-day + human-access logging) differs from standard
// models — client/PII/financial data must not reach the apex tier without an explicit opt-in.
const EXEC_MODEL = A.tierHint === 'cheap' ? 'sonnet' : 'opus' // the single-task builder (L2); never apex, never haiku
const VERIFY_MODEL = 'sonnet' // cheap adversarial gate; tests are the real ground truth
const PLAN_MODEL = APEX_MODEL // packet generation = the output-light L0 role of the spec
// run the sonnet tier on the 1M-context variant at the call boundary (opus/apex pass through unchanged)
const longCtx = (m) => (m === 'sonnet' ? 'sonnet[1m]' : m)

// ---- budget reads are BEST-EFFORT (never let the budget API throw) ----
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
const explicitMax = typeof A.maxAgents === 'number' && isFinite(A.maxAgents) && A.maxAgents > 0 ? Math.floor(A.maxAgents) : null
const MAX_AGENTS = explicitMax != null
  ? Math.max(AGENT_FLOOR, Math.min(HARD_LIMIT, explicitMax))
  : Math.max(AGENT_FLOOR, Math.min(AGENT_ROOF, Math.floor(SOFT / TOKENS_PER_AGENT)))

// ---- the PRIMARY guard is a literal counter (needs no API, cannot fail) ----
let spawned = 0
const startSpent = spentNow()
const UNCAP_TOKENS = explicitMax != null && !(typeof A.cap === 'number' && A.cap > 0)
const overBudget = () => (UNCAP_TOKENS ? false : spentNow() - startSpent >= SOFT)
const mustReserve = () => remainingNow() < RESERVE // keep room for the escalation ladder + report
const canSpawn = () => spawned < MAX_AGENTS && !overBudget()

log(
  `Strata/delegate: cap=${CEIL} (${candidates.length ? 'set' : 'default'}), MAX_AGENTS=${MAX_AGENTS}` +
    `${explicitMax != null ? ` (explicit agent cap${UNCAP_TOKENS ? '; token budget lifted' : ''})` : ''}, ` +
    `exec=${EXEC_MODEL} verify=${VERIFY_MODEL} apex=${APEX_MODEL}${FABLE_HALTED ? ' (fable HALTED → apex forced to opus; see delegation-spec §0b)' : A.dataSensitive === true ? ' (dataSensitive: apex forced to opus)' : ''}`
)

// ---- apex caller: counts its own spawns; falls back to opus once if the apex tier errors out
// (cost-window removal, classifier fallback, unavailability — the run must degrade, not die) ----
const apexAgent = async (prompt, opts) => {
  const first = await agent(prompt, { ...opts, model: APEX_MODEL })
  if (first !== null) return first
  if (APEX_MODEL === 'opus') return null
  if (!canSpawn()) return null
  spawned++
  const optLabel = (opts && opts.label) || 'apex'
  log(`apex tier unavailable for "${optLabel}" — falling back to opus`)
  return agent(prompt, { ...opts, label: `${optLabel}:fallback-opus`, model: 'opus' })
}

// ---- schemas: schema-bounded output IS the output discipline (no narration to suppress) ----
const PACKET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['units', 'dod'],
  properties: {
    units: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'tier', 'spec', 'acceptance'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          tier: { type: 'string', enum: ['sonnet', 'opus'], description: 'executor tier — never the apex' },
          refs: { type: 'array', items: { type: 'string' }, description: 'smallest sufficient file set the executor must read' },
          spec: { type: 'string' },
          acceptance: { type: 'string' },
        },
      },
    },
    dod: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
  },
}
const BUILD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['done', 'summary', 'testsRun'],
  properties: {
    done: { type: 'boolean' },
    summary: { type: 'string', description: 'max 3 lines; do NOT restate diffs — changes live in the files' },
    testsRun: { type: 'boolean' },
    testResult: { type: 'string' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
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
const ADVICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rootCause', 'designChangeNeeded', 'plan'],
  properties: {
    rootCause: { type: 'string' },
    designChangeNeeded: { type: 'boolean' },
    plan: { type: 'array', items: { type: 'string' }, description: 'at most 10 concrete steps' },
    mustNotRepeat: { type: 'array', items: { type: 'string' } },
  },
}

const DOD =
  typeof A.dod === 'string' && A.dod
    ? A.dod
    : 'All relevant tests pass; lint clean; no change to existing public behavior.'

// ---- Phase 1: PLAN — optional apex instruction packet (the output-light L0 role) ----
phase('Plan')
let units = null
let packetRisks = []
if (A.planFirst === true && canSpawn()) {
  spawned++
  const packet = await apexAgent(
    `役割: あなたはオーケストレータ。実行はしない。前置き・解説・経過は禁止 — 出力はスキーマのみ。\n\nタスク: ${A.task}\n\nDoD: ${DOD}\n\nこのタスクを最大 ${MAX_UNITS} 個の実行ユニットに分解せよ。各ユニットに: 担当 tier(下ごしらえ・定型は sonnet、通常実装は opus — apex は指定不可)、受け手が読むべき最小ファイル集合(refs)、仕様(spec)、受入基準(acceptance)。注意: キャッシュはモデル単位で引き継がれない — refs は本当に最小にする。`,
    { label: 'plan:packet', phase: 'Plan', schema: PACKET_SCHEMA }
  )
  if (packet && Array.isArray(packet.units) && packet.units.length) {
    if (packet.units.length > MAX_UNITS) log(`plan: packet had ${packet.units.length} units — truncated to ${MAX_UNITS} (no silent caps)`)
    units = packet.units.slice(0, MAX_UNITS).map((u, i) => ({
      id: u.id || `U${i + 1}`,
      title: u.title || u.id || `unit ${i + 1}`,
      tier: u.tier === 'sonnet' ? 'sonnet' : 'opus', // sanitize: the packet can never route a unit to the apex
      refs: Array.isArray(u.refs) ? u.refs : [],
      spec: u.spec,
      acceptance: u.acceptance || DOD,
    }))
    packetRisks = Array.isArray(packet.risks) ? packet.risks : []
  } else {
    log('plan: packet unavailable — degrading to a single unit at the base tier')
  }
}
if (!units && Array.isArray(A.units) && A.units.length) {
  if (A.units.length > MAX_UNITS) log(`plan: caller passed ${A.units.length} units — truncated to ${MAX_UNITS} (no silent caps)`)
  units = A.units.slice(0, MAX_UNITS).map((u, i) => ({
    id: u.id || `U${i + 1}`,
    title: u.title || `unit ${i + 1}`,
    tier: u.tier === 'sonnet' ? 'sonnet' : 'opus',
    refs: Array.isArray(u.refs) ? u.refs : [],
    spec: u.spec || A.task,
    acceptance: u.acceptance || DOD,
  }))
}
if (!units) units = [{ id: 'U1', title: A.task.slice(0, 80), tier: EXEC_MODEL === 'sonnet' ? 'sonnet' : 'opus', refs: [], spec: A.task, acceptance: DOD }]

// ---- Phase 2: EXECUTE — sequential (units may share files; parallel builds would conflict) ----
phase('Execute')
const SILENT_RULES =
  'Discipline: run the relevant tests/lint yourself before reporting. Your ONLY output is the schema-bounded JSON. Do NOT restate diffs or narrate steps ("now I will...") — changes live in the files and are reviewed via git diff.'

const buildOnce = async (u, model, extra, label) => {
  if (!canSpawn()) return null
  spawned++
  return agent(
    `You are the EXECUTOR for one unit of a larger task. Implement it directly in the real files.\n\nUnit: ${u.title}\nSpec: ${u.spec}\nRead first (smallest sufficient set): ${u.refs && u.refs.length ? u.refs.join(', ') : '(discover the minimal set yourself)'}\nAcceptance: ${u.acceptance}\nDoD: ${DOD}\n${extra ? `\n${extra}\n` : ''}\n${SILENT_RULES}`,
    { label, phase: 'Execute', model, schema: BUILD_SCHEMA }
  )
}
const verifyOnce = async (u, build, label) => {
  if (!canSpawn() || mustReserve()) return null
  spawned++
  return agent(
    `Adversarially verify this unit against its acceptance criteria and DoD. Re-read the changed files; run the relevant tests yourself if runnable. Be skeptical — default to pass=false unless the evidence clearly supports it.\n\nUnit: ${u.title}\nAcceptance: ${u.acceptance}\nDoD: ${DOD}\nBuilder report: ${JSON.stringify(build)}`,
    { label, phase: 'Execute', model: longCtx(VERIFY_MODEL), schema: VERIFY_SCHEMA }
  )
}

const results = []
let apexAdvises = 0
let apexBuilds = 0

for (const u of units) {
  if (!canSpawn()) {
    results.push({ id: u.id, title: u.title, status: 'skipped-budget', escalation: 'none' })
    log(`execute: gate hit at ${spawned}/${MAX_AGENTS} — unit "${u.id}" skipped`)
    continue
  }

  const unitModel = longCtx(u.tier === 'sonnet' ? 'sonnet' : EXEC_MODEL)
  let escalation = 'none'
  let lastBuild = null
  let lastVerify = null
  let settled = false

  // -- stage 1: base-tier attempt + 1 retry (failures fed back, not hidden) --
  for (let attempt = 1; attempt <= BASE_ATTEMPTS && !settled; attempt++) {
    const feedback =
      attempt > 1 && lastVerify
        ? `Previous attempt failed verification: ${JSON.stringify(lastVerify.failures || lastVerify.reason)}. Fix the cause, not the symptom.`
        : ''
    lastBuild = await buildOnce(u, unitModel, feedback, `build:${u.id}#${attempt}`)
    if (!lastBuild) break // budget gate or agent death — settle below
    lastVerify = await verifyOnce(u, lastBuild, `verify:${u.id}#${attempt}`)
    if (lastVerify === null) {
      // fail-open like focus/review: an unverifiable build is accepted with a note, never escalated on no evidence
      results.push({ id: u.id, title: u.title, status: lastBuild.done ? 'done' : 'failed', escalation, verify: 'budget-skip-verify', build: lastBuild })
      settled = true
      break
    }
    if (lastBuild.done && lastVerify.pass) {
      results.push({ id: u.id, title: u.title, status: 'done', escalation, attempts: attempt, build: lastBuild, verify: lastVerify })
      settled = true
    } else if (attempt > 1) {
      escalation = 'retry'
    }
  }
  if (settled) continue

  // -- stage 2: apex ADVISE — diagnosis only, output-light; the builder retries with the plan --
  // APEX_ADVISE_PER_UNIT = 1 by construction of the ladder: this block runs at most once per unit.
  let advice = null
  if (APEX_ADVISE_PER_UNIT > 0 && canSpawn()) {
    spawned++
    apexAdvises++
    escalation = 'advise'
    advice = await apexAgent(
      `You are the escalation ADVISOR (diagnosis ONLY — do not edit files, do not write the fix).\nA cheaper executor failed this unit ${BASE_ATTEMPTS} times.\n\nUnit: ${u.title}\nSpec: ${u.spec}\nAcceptance: ${u.acceptance}\nDoD: ${DOD}\nLast builder report: ${JSON.stringify(lastBuild)}\nLast verification: ${JSON.stringify(lastVerify)}\n\nRead the relevant files, then return: the root cause, whether a design change is needed, a fix plan of AT MOST 10 concrete steps, and what must NOT be repeated. Terse — this is an output-light role.`,
      { label: `advise:${u.id}`, phase: 'Execute', schema: ADVICE_SCHEMA }
    )
    if (advice) {
      const guided = `Escalation diagnosis from the advisor — follow this plan:\nRoot cause: ${advice.rootCause}\nPlan: ${(advice.plan || []).join(' / ')}\nDo NOT repeat: ${(advice.mustNotRepeat || []).join(' / ')}`
      lastBuild = await buildOnce(u, unitModel, guided, `build:${u.id}#advised`)
      if (lastBuild) {
        lastVerify = await verifyOnce(u, lastBuild, `verify:${u.id}#advised`)
        if (lastVerify === null) {
          results.push({ id: u.id, title: u.title, status: lastBuild.done ? 'done' : 'failed', escalation, verify: 'budget-skip-verify', build: lastBuild, advice })
          continue
        }
        if (lastBuild.done && lastVerify.pass) {
          results.push({ id: u.id, title: u.title, status: 'done', escalation, build: lastBuild, verify: lastVerify, advice })
          continue
        }
      }
    }
  }

  // -- stage 3: apex clean-slate rebuild — the ONLY apex execution, once per unit --
  // APEX_BUILD_PER_UNIT = 1 by construction of the ladder: this block runs at most once per unit.
  if (APEX_BUILD_PER_UNIT > 0 && canSpawn()) {
    spawned++
    apexBuilds++
    escalation = 'apex'
    const apexBuild = await apexAgent(
      `You are the APEX EXECUTOR. Cheaper attempts failed; you get a CLEAN SLATE — the original spec and the diagnosis, NOT the failed patch history.\nFirst inspect \`git status\` and \`git diff\`; revert any uncommitted changes from prior attempts that you do not endorse (\`git restore <path>\`). Then implement from your own plan.\n\nUnit: ${u.title}\nSpec: ${u.spec}\nAcceptance: ${u.acceptance}\nDoD: ${DOD}\nAdvisor diagnosis: ${advice ? JSON.stringify(advice) : '(none — advisor stage was unavailable)'}\n\n${SILENT_RULES}`,
      { label: `apex:${u.id}`, phase: 'Execute', schema: BUILD_SCHEMA }
    )
    if (apexBuild) {
      const apexVerify = await verifyOnce(u, apexBuild, `verify:${u.id}#apex`)
      results.push({
        id: u.id,
        title: u.title,
        status: apexBuild.done && (apexVerify === null || apexVerify.pass) ? 'done' : 'failed',
        escalation,
        build: apexBuild,
        verify: apexVerify === null ? 'budget-skip-verify' : apexVerify,
        advice,
      })
      continue
    }
  }

  results.push({ id: u.id, title: u.title, status: 'failed', escalation, build: lastBuild, verify: lastVerify, advice })
}

// ---- Phase 3: REPORT — deterministic, code-side. No synthesis agent: the deliverable is the
// executed work itself; a synth agent would re-buy the whole context at output prices. ----
phase('Report')
const done = results.filter((r) => r.status === 'done').length
const failedUnits = results.filter((r) => r.status === 'failed')
const skipped = results.filter((r) => r.status === 'skipped-budget')
log(
  `done: ${spawned} agents, ~${Math.max(0, spentNow() - startSpent)} output tokens this run; ` +
    `${done}/${results.length} units done, apex usage: ${apexAdvises} advise / ${apexBuilds} rebuild (model=${APEX_MODEL})`
)
return {
  task: A.task,
  cap: CEIL,
  capWasSet: candidates.length > 0,
  agentsSpawned: spawned,
  maxAgents: MAX_AGENTS,
  dod: DOD,
  apex: { model: APEX_MODEL, advises: apexAdvises, rebuilds: apexBuilds, dataSensitive: A.dataSensitive === true },
  unitsDone: done,
  unitsFailed: failedUnits.map((r) => ({ id: r.id, title: r.title, verify: r.verify })),
  unitsSkipped: skipped.map((r) => r.id),
  risks: packetRisks,
  units: results,
  coverageNote:
    skipped.length > 0
      ? `${skipped.length} unit(s) skipped at the agent/budget gate — re-run with a larger cap`
      : failedUnits.length > 0
        ? `${failedUnits.length} unit(s) failed after the full escalation ladder — human review needed`
        : 'all units executed and verified',
}
