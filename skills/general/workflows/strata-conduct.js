export const meta = {
  name: 'strata-conduct',
  description:
    'Fable-conducted fan-out execution: haiku scouts the surface, the fable ORCHESTRATOR emits ONE instruction packet (units routed to sonnet by default, opus only for the hard minority), file-disjoint unit groups build in parallel with a per-unit escalation ladder (retry -> opus diagnosis-only -> opus clean-slate rebuild), then the orchestrator closes with ONE integration review. Apex spend is gated by literal counters (1 plan + 1 review, never bulk, never a unit executor).',
  phases: [
    { title: 'Scout', detail: 'haiku reconnaissance: code map + verification surface' },
    { title: 'Plan', detail: 'orchestrator instruction packet — the output-light L0 role' },
    { title: 'Execute', detail: 'file-disjoint groups in parallel; sequential ladder per unit' },
    { title: 'Review', detail: 'one orchestrator integration review over the assembled results' },
  ],
}

// ---- args: { task, cap, maxAgents, orch, dataSensitive, units?, tierHint, dod, sequential } ----
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
      "No task provided. Invoke as Workflow({ scriptPath: '.../strata-conduct.js', args: { task, cap?, orch?, dataSensitive? } }).",
  }
}

// ---- tunable constants (the enforcement surface) ----
const DEFAULT_CAP = 200_000 // execution modes run hot (real builds + verifies); same family as sweep/delegate
const TOKENS_PER_AGENT = 16_000
const AGENT_FLOOR = 8
const AGENT_ROOF = 120 // conduct is breadth-not-depth: parallel unit groups, scale-y family roof
const HARD_LIMIT = 950
const MAX_UNITS = 12 // wider than delegate's 6 (fan-out), but a packet bigger than this is a scale/ultra job
const OPUS_UNIT_CAP = Math.max(1, Math.floor(MAX_UNITS / 3)) // opus units are the exception, never the bulk
const BASE_ATTEMPTS = 2 // stage 1: attempt + 1 retry at the unit tier (delegation-spec §5 段1)
const DIAG_PER_UNIT = 1 // stage 2: opus diagnosis-only — output-light, an order cheaper than execution
const REBUILD_PER_UNIT = 1 // stage 3: opus clean-slate rebuild — the only escalated execution allowed
const ORCH_PLAN_MAX = 1 // the orchestrator emits exactly one instruction packet
const ORCH_REVIEW_MAX = 1 // ... and exactly one closing integration review

// ---- models: named constants, not a TIER map (conduct has roles no restraint mode has) ----
// The orchestrator tier exists ONLY at the two endpoints of the run (plan packet + integration
// review), capped by the literal ORCH_* constants above; it never executes a unit and never enters
// the escalation ladder — that ladder tops out at opus. Both verifiers (verify-invariants.js +
// check-invariants.sh) fail the build if the apex literal appears outside ORCH lines.
// ⏳ KILL SWITCH (2026-06-13): the US government halted Fable 5. While true, the orchestrator tier is
// forced to opus regardless of args — no dead fable call + fallback churn. Flip to false to restore the
// orchestrator when the halt lifts (single point of restoration; see delegation-spec.md §0b).
const FABLE_HALTED = true
const ORCH_DEFAULT = 'fable' // the only line outside ORCH_MODEL where the apex tier may be named
const ORCH_MODEL = FABLE_HALTED ? 'opus' : A.dataSensitive === true ? 'opus' : A.orch === 'opus' ? 'opus' : ORCH_DEFAULT
// dataSensitive: Mythos-class retention (30-day + human-access logging) differs from standard
// models — client/PII/financial data must not reach the orchestrator tier without an explicit opt-in.
const SCOUT_MODEL = 'haiku' // reconnaissance reads, never writes
const EXEC_DEFAULT = 'sonnet' // the bulk unit builder; the packet may promote a hard MINORITY to opus
const VERIFY_MODEL = A.tierHint === 'hard' ? 'opus' : 'sonnet' // hard: spend opus on refutation (same opt-in as review)
const DIAG_MODEL = 'opus' // escalation advisor — a judgment role, diagnosis only
const REBUILD_MODEL = 'opus' // escalation executor (documented exception: single failed unit, never bulk)

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
const mustReserve = () => remainingNow() < RESERVE // keep room for the closing integration review
const canSpawn = () => spawned < MAX_AGENTS && !overBudget()

log(
  `Strata/conduct: cap=${CEIL} (${candidates.length ? 'set' : 'default'}), MAX_AGENTS=${MAX_AGENTS}` +
    `${explicitMax != null ? ` (explicit agent cap${UNCAP_TOKENS ? '; token budget lifted' : ''})` : ''}, ` +
    `scout=${SCOUT_MODEL} exec=${EXEC_DEFAULT} verify=${VERIFY_MODEL} escalate=${DIAG_MODEL} orch=${ORCH_MODEL}` +
    `${FABLE_HALTED ? ' (fable HALTED → orchestrator forced to opus; see delegation-spec §0b)' : A.dataSensitive === true ? ' (dataSensitive: orchestrator forced to opus)' : ''}`
)

// ---- orchestrator caller: the ONLY surface where the apex tier may run. Counts its own spawns;
// falls back to opus once if the apex tier errors out (cost-window removal, classifier fallback,
// unavailability — the run must degrade, not die). ----
const orchAgent = async (prompt, opts) => {
  const first = await agent(prompt, { ...opts, model: ORCH_MODEL })
  if (first !== null) return first
  if (ORCH_MODEL === 'opus') return null
  if (!canSpawn()) return null
  spawned++
  const optLabel = (opts && opts.label) || 'orch'
  log(`orchestrator tier unavailable for "${optLabel}" — falling back to opus`)
  return agent(prompt, { ...opts, label: `${optLabel}:fallback-opus`, model: 'opus' })
}

// ---- schemas: schema-bounded output IS the output discipline (no narration to suppress) ----
const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'files'],
  properties: {
    findings: { type: 'string', description: 'terse map of what matters for this task' },
    files: { type: 'array', items: { type: 'string' } },
    commands: { type: 'array', items: { type: 'string' }, description: 'test/lint/build commands that verify the DoD' },
    risks: { type: 'array', items: { type: 'string' } },
  },
}
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
        required: ['id', 'title', 'tier', 'own', 'spec', 'acceptance'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          tier: { type: 'string', enum: ['sonnet', 'opus'], description: 'executor tier — opus only for the hard minority, never the orchestrator' },
          own: { type: 'array', items: { type: 'string' }, description: 'files this unit will MODIFY — must be disjoint across units for parallel execution' },
          refs: { type: 'array', items: { type: 'string' }, description: 'smallest sufficient read set for the executor' },
          spec: { type: 'string' },
          acceptance: { type: 'string' },
        },
      },
    },
    dod: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
    integration: { type: 'string', description: 'what the closing review must check ACROSS units (seams, contracts, regressions)' },
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
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary'],
  properties: {
    verdict: { type: 'string', enum: ['ship', 'fix', 'block'] },
    summary: { type: 'string', description: 'max 5 lines' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'where', 'what'],
        properties: {
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          where: { type: 'string' },
          what: { type: 'string' },
        },
      },
    },
    followUps: { type: 'array', items: { type: 'string' } },
  },
}

const DOD =
  typeof A.dod === 'string' && A.dod
    ? A.dod
    : 'All relevant tests pass; lint clean; no change to existing public behavior.'

// ---- Phase 1: SCOUT — haiku reconnaissance feeding the packet (reads only, never writes) ----
phase('Scout')
let scoutMap = null
let scoutHarness = null
if (!Array.isArray(A.units) || !A.units.length) {
  const scouts = await parallel([
    () => {
      if (!canSpawn()) return Promise.resolve(null)
      spawned++
      return agent(
        `Reconnaissance ONLY — read, never modify. Map the smallest part of this codebase that matters for the task below: the relevant files/modules, how they connect, and anything a planner must know to split the work into independent units.\n\nTask: ${A.task}\n\nReturn terse findings + the file list. No prose beyond the schema.`,
        { label: 'scout:map', phase: 'Scout', model: SCOUT_MODEL, schema: SCOUT_SCHEMA }
      )
    },
    () => {
      if (!canSpawn()) return Promise.resolve(null)
      spawned++
      return agent(
        `Reconnaissance ONLY — read, never modify. Identify the VERIFICATION surface for the task below: how to run the relevant tests/lint/build, which existing tests cover the touched area, and what regressions to watch.\n\nTask: ${A.task}\nDoD: ${DOD}\n\nReturn terse findings + exact commands. No prose beyond the schema.`,
        { label: 'scout:harness', phase: 'Scout', model: SCOUT_MODEL, schema: SCOUT_SCHEMA }
      )
    },
  ])
  scoutMap = scouts[0]
  scoutHarness = scouts[1]
}

// ---- Phase 2: PLAN — ONE orchestrator instruction packet (the output-light L0 role) ----
phase('Plan')
let units = null
let packetRisks = []
let integration = ''
let orchPlans = 0
if ((!Array.isArray(A.units) || !A.units.length) && ORCH_PLAN_MAX > 0 && canSpawn()) {
  spawned++
  orchPlans++
  const scoutBrief =
    `Scout map: ${scoutMap ? JSON.stringify(scoutMap) : '(unavailable)'}\n` +
    `Verification surface: ${scoutHarness ? JSON.stringify(scoutHarness) : '(unavailable)'}`
  const packet = await orchAgent(
    `役割: あなたはオーケストレータ。実行はしない。前置き・解説・経過は禁止 — 出力はスキーマのみ。\n\nタスク: ${A.task}\n\nDoD: ${DOD}\n\n${scoutBrief}\n\nこのタスクを最大 ${MAX_UNITS} 個の実行ユニットに分解せよ。各ユニットに:\n- tier: 既定は sonnet。設計判断・横断・高リスクの難所のみ opus(全体の1/3まで${A.tierHint === 'cheap' ? '。今回は cheap 指定 — 可能な限り sonnet に寄せる' : ''})。オーケストレータ自身は指定不可。\n- own: そのユニットが変更するファイル集合。並列実行のためユニット間で重複させない分割を選ぶ。\n- refs: 受け手が読むべき最小ファイル集合(キャッシュはモデル単位で引き継がれない — 本当に最小にする)。\n- spec / acceptance: 受け手が自己検証して自己終了できる粒度で。\nintegration: 全ユニット完了後にレビューがユニット横断で確認すべき継ぎ目(契約・回帰)を1段落で。`,
    { label: 'orch:packet', phase: 'Plan', schema: PACKET_SCHEMA }
  )
  if (packet && Array.isArray(packet.units) && packet.units.length) {
    if (packet.units.length > MAX_UNITS) log(`plan: packet had ${packet.units.length} units — truncated to ${MAX_UNITS} (no silent caps)`)
    let opusUnits = 0
    units = packet.units.slice(0, MAX_UNITS).map((u, i) => {
      let tier = u.tier === 'opus' ? 'opus' : 'sonnet' // sanitize: the packet can never route a unit to the orchestrator
      if (tier === 'opus') {
        opusUnits++
        if (opusUnits > OPUS_UNIT_CAP) {
          log(`plan: opus unit ${opusUnits} exceeds OPUS_UNIT_CAP=${OPUS_UNIT_CAP} — "${u.id || i + 1}" demoted to sonnet (opus is never the bulk)`)
          tier = 'sonnet'
        }
      }
      return {
        id: u.id || `U${i + 1}`,
        title: u.title || u.id || `unit ${i + 1}`,
        tier,
        own: Array.isArray(u.own) ? u.own : [],
        refs: Array.isArray(u.refs) ? u.refs : [],
        spec: u.spec,
        acceptance: u.acceptance || DOD,
      }
    })
    packetRisks = Array.isArray(packet.risks) ? packet.risks : []
    integration = typeof packet.integration === 'string' ? packet.integration : ''
  } else {
    log('plan: packet unavailable — degrading to a single unit at the base tier')
  }
}
if (!units && Array.isArray(A.units) && A.units.length) {
  if (A.units.length > MAX_UNITS) log(`plan: caller passed ${A.units.length} units — truncated to ${MAX_UNITS} (no silent caps)`)
  units = A.units.slice(0, MAX_UNITS).map((u, i) => ({
    id: u.id || `U${i + 1}`,
    title: u.title || `unit ${i + 1}`,
    tier: u.tier === 'opus' ? 'opus' : 'sonnet',
    own: Array.isArray(u.own) ? u.own : [],
    refs: Array.isArray(u.refs) ? u.refs : [],
    spec: u.spec || A.task,
    acceptance: u.acceptance || DOD,
  }))
}
if (!units) units = [{ id: 'U1', title: A.task.slice(0, 80), tier: 'sonnet', own: [], refs: [], spec: A.task, acceptance: DOD }]

// ---- Phase 3: EXECUTE — file-disjoint groups in parallel, sequential ladder inside a group ----
phase('Execute')

// Grouping: units whose `own` sets overlap share files and must serialize. A unit with NO declared
// ownership could conflict with anything — so any undeclared unit (or A.sequential) collapses the
// whole run into one sequential group. Deterministic and safe; parallelism is earned by the packet.
const undeclared = units.some((u) => !u.own.length)
let groups
if (A.sequential === true || undeclared || units.length === 1) {
  if (undeclared && units.length > 1) log('execute: a unit declared no file ownership — running ALL units sequentially (safe default)')
  groups = [units]
} else {
  groups = []
  for (const u of units) {
    const ownSet = new Set(u.own)
    const overlapping = groups.filter((g) => g.some((m) => m.own.some((f) => ownSet.has(f))))
    if (!overlapping.length) {
      groups.push([u])
    } else {
      const merged = [...overlapping.flat(), u]
      groups = [...groups.filter((g) => !overlapping.includes(g)), merged]
    }
  }
  log(`execute: ${units.length} units in ${groups.length} file-disjoint group(s) (parallel across groups)`)
}

const SILENT_RULES =
  'Discipline: run the relevant tests/lint yourself before reporting. Your ONLY output is the schema-bounded JSON. Do NOT restate diffs or narrate steps ("now I will...") — changes live in the files and are reviewed via git diff.'
const HARNESS_BRIEF = scoutHarness ? `Verification surface (from scout): ${JSON.stringify(scoutHarness.commands || scoutHarness.findings)}` : ''

const buildOnce = async (u, model, extra, label) => {
  if (!canSpawn()) return null
  spawned++
  return agent(
    `You are the EXECUTOR for one unit of a larger conducted task. Implement it directly in the real files.\n\nUnit: ${u.title}\nSpec: ${u.spec}\nOwn (the ONLY files you may modify): ${u.own.length ? u.own.join(', ') : '(unrestricted — single-unit run)'}\nRead first (smallest sufficient set): ${u.refs.length ? u.refs.join(', ') : '(discover the minimal set yourself)'}\nAcceptance: ${u.acceptance}\nDoD: ${DOD}\n${HARNESS_BRIEF}\n${extra ? `\n${extra}\n` : ''}\n${SILENT_RULES}`,
    { label, phase: 'Execute', model, schema: BUILD_SCHEMA }
  )
}
const verifyOnce = async (u, build, label) => {
  if (!canSpawn() || mustReserve()) return null
  spawned++
  return agent(
    `Adversarially verify this unit against its acceptance criteria and DoD. Re-read the changed files; run the relevant tests yourself if runnable. Be skeptical — default to pass=false unless the evidence clearly supports it.\n\nUnit: ${u.title}\nAcceptance: ${u.acceptance}\nDoD: ${DOD}\nBuilder report: ${JSON.stringify(build)}`,
    { label, phase: 'Execute', model: VERIFY_MODEL, schema: VERIFY_SCHEMA }
  )
}

let diagCount = 0
let rebuildCount = 0

const runUnit = async (u) => {
  if (!canSpawn()) {
    log(`execute: gate hit at ${spawned}/${MAX_AGENTS} — unit "${u.id}" skipped`)
    return { id: u.id, title: u.title, status: 'skipped-budget', escalation: 'none' }
  }

  const unitModel = u.tier === 'opus' ? 'opus' : EXEC_DEFAULT
  let escalation = 'none'
  let lastBuild = null
  let lastVerify = null

  // -- stage 1: unit-tier attempt + 1 retry (failures fed back, not hidden) --
  for (let attempt = 1; attempt <= BASE_ATTEMPTS; attempt++) {
    const feedback =
      attempt > 1 && lastVerify
        ? `Previous attempt failed verification: ${JSON.stringify(lastVerify.failures || lastVerify.reason)}. Fix the cause, not the symptom.`
        : ''
    lastBuild = await buildOnce(u, unitModel, feedback, `build:${u.id}#${attempt}`)
    if (!lastBuild) break // budget gate or agent death — fall through to the ladder/settle
    lastVerify = await verifyOnce(u, lastBuild, `verify:${u.id}#${attempt}`)
    if (lastVerify === null) {
      // fail-open like focus/review: an unverifiable build is accepted with a note, never escalated on no evidence
      return { id: u.id, title: u.title, status: lastBuild.done ? 'done' : 'failed', escalation, verify: 'budget-skip-verify', build: lastBuild }
    }
    if (lastBuild.done && lastVerify.pass) {
      return { id: u.id, title: u.title, status: 'done', escalation, attempts: attempt, build: lastBuild, verify: lastVerify }
    }
    if (attempt > 1) escalation = 'retry'
  }

  // -- stage 2: opus DIAGNOSIS only — output-light; the unit tier retries with the plan --
  // DIAG_PER_UNIT = 1 by construction of the ladder: this block runs at most once per unit.
  let advice = null
  if (DIAG_PER_UNIT > 0 && canSpawn()) {
    spawned++
    diagCount++
    escalation = 'diagnose'
    advice = await agent(
      `You are the escalation ADVISOR (diagnosis ONLY — do not edit files, do not write the fix).\nA cheaper executor failed this unit ${BASE_ATTEMPTS} times.\n\nUnit: ${u.title}\nSpec: ${u.spec}\nAcceptance: ${u.acceptance}\nDoD: ${DOD}\nLast builder report: ${JSON.stringify(lastBuild)}\nLast verification: ${JSON.stringify(lastVerify)}\n\nRead the relevant files, then return: the root cause, whether a design change is needed, a fix plan of AT MOST 10 concrete steps, and what must NOT be repeated. Terse — this is an output-light role.`,
      { label: `diagnose:${u.id}`, phase: 'Execute', model: DIAG_MODEL, schema: ADVICE_SCHEMA }
    )
    if (advice) {
      const guided = `Escalation diagnosis from the advisor — follow this plan:\nRoot cause: ${advice.rootCause}\nPlan: ${(advice.plan || []).join(' / ')}\nDo NOT repeat: ${(advice.mustNotRepeat || []).join(' / ')}`
      lastBuild = await buildOnce(u, unitModel, guided, `build:${u.id}#advised`)
      if (lastBuild) {
        lastVerify = await verifyOnce(u, lastBuild, `verify:${u.id}#advised`)
        if (lastVerify === null) {
          return { id: u.id, title: u.title, status: lastBuild.done ? 'done' : 'failed', escalation, verify: 'budget-skip-verify', build: lastBuild, advice }
        }
        if (lastBuild.done && lastVerify.pass) {
          return { id: u.id, title: u.title, status: 'done', escalation, build: lastBuild, verify: lastVerify, advice }
        }
      }
    }
  }

  // -- stage 3: opus clean-slate rebuild — the ONLY escalated execution, once per unit.
  // The ladder tops out HERE: the orchestrator tier never builds. REBUILD_PER_UNIT = 1 by construction. --
  if (REBUILD_PER_UNIT > 0 && canSpawn()) {
    spawned++
    rebuildCount++
    escalation = 'rebuild'
    const rebuild = await agent(
      `You are the ESCALATION EXECUTOR. Cheaper attempts failed; you get a CLEAN SLATE — the original spec and the diagnosis, NOT the failed patch history.\nFirst inspect \`git status\` and \`git diff\` for the files this unit owns; revert any uncommitted changes from prior attempts that you do not endorse (\`git restore <path>\` — ONLY within this unit's own files). Then implement from your own plan.\n\nUnit: ${u.title}\nSpec: ${u.spec}\nOwn (the ONLY files you may modify): ${u.own.length ? u.own.join(', ') : '(unrestricted — single-unit run)'}\nAcceptance: ${u.acceptance}\nDoD: ${DOD}\nAdvisor diagnosis: ${advice ? JSON.stringify(advice) : '(none — advisor stage was unavailable)'}\n\n${SILENT_RULES}`,
      { label: `rebuild:${u.id}`, phase: 'Execute', model: REBUILD_MODEL, schema: BUILD_SCHEMA }
    )
    if (rebuild) {
      const rebuildVerify = await verifyOnce(u, rebuild, `verify:${u.id}#rebuild`)
      return {
        id: u.id,
        title: u.title,
        status: rebuild.done && (rebuildVerify === null || rebuildVerify.pass) ? 'done' : 'failed',
        escalation,
        build: rebuild,
        verify: rebuildVerify === null ? 'budget-skip-verify' : rebuildVerify,
        advice,
      }
    }
  }

  return { id: u.id, title: u.title, status: 'failed', escalation, build: lastBuild, verify: lastVerify, advice }
}

const runGroup = async (group) => {
  const out = []
  for (const u of group) out.push(await runUnit(u))
  return out
}
const grouped = await parallel(groups.map((g) => () => runGroup(g)))
const results = grouped.filter(Boolean).flat()

// ---- Phase 4: REVIEW — ONE orchestrator integration review (the seams, not the diffs) ----
phase('Review')
let review = null
let orchReviews = 0
const done = results.filter((r) => r.status === 'done').length
if (ORCH_REVIEW_MAX > 0 && done > 0 && canSpawn()) {
  spawned++
  orchReviews++
  review = await orchAgent(
    `You are the ORCHESTRATOR closing a conducted run. Review the INTEGRATION of the completed units — the seams between them, not each diff (per-unit verification already ran). Read the touched files where units meet; run the cross-cutting tests if runnable.\n\nTask: ${A.task}\nDoD: ${DOD}\nIntegration focus from the packet: ${integration || '(none recorded)'}\nUnit results: ${JSON.stringify(results.map((r) => ({ id: r.id, title: r.title, status: r.status, escalation: r.escalation, files: r.build && r.build.filesTouched })))}\n\nVerdict: ship (coherent, DoD met) / fix (specific issues listed) / block (a unit must be redone). Terse — this is an output-light role; max 5-line summary, issues as structured entries only.`,
    { label: 'orch:review', phase: 'Review', schema: REVIEW_SCHEMA }
  )
  if (!review) log('review: integration review unavailable — returning unit results without a closing verdict')
} else if (done === 0) {
  log('review: no units completed — skipping the integration review (nothing to integrate)')
}

// ---- report: deterministic, code-side. No synthesis agent beyond the single capped review. ----
const failedUnits = results.filter((r) => r.status === 'failed')
const skipped = results.filter((r) => r.status === 'skipped-budget')
log(
  `done: ${spawned} agents, ~${Math.max(0, spentNow() - startSpent)} output tokens this run; ` +
    `${done}/${results.length} units done, escalations: ${diagCount} diagnose / ${rebuildCount} rebuild, ` +
    `orchestrator: ${orchPlans} plan / ${orchReviews} review (model=${ORCH_MODEL})`
)
return {
  task: A.task,
  cap: CEIL,
  capWasSet: candidates.length > 0,
  agentsSpawned: spawned,
  maxAgents: MAX_AGENTS,
  dod: DOD,
  orchestrator: { model: ORCH_MODEL, plans: orchPlans, reviews: orchReviews, dataSensitive: A.dataSensitive === true },
  escalations: { diagnoses: diagCount, rebuilds: rebuildCount },
  groups: groups.length,
  unitsDone: done,
  unitsFailed: failedUnits.map((r) => ({ id: r.id, title: r.title, verify: r.verify })),
  unitsSkipped: skipped.map((r) => r.id),
  risks: packetRisks,
  review,
  units: results,
  coverageNote:
    skipped.length > 0
      ? `${skipped.length} unit(s) skipped at the agent/budget gate — re-run with a larger cap`
      : failedUnits.length > 0
        ? `${failedUnits.length} unit(s) failed after the full escalation ladder — human review needed`
        : review && review.verdict !== 'ship'
          ? `all units executed; integration review says "${review.verdict}" — see review.issues`
          : 'all units executed, verified, and integration-reviewed',
}
