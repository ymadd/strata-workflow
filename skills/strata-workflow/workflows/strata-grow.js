export const meta = {
  name: 'strata-grow',
  description:
    'Strata PROGRESSIVE task workflow: grows a generated set in self-improving rounds up to the agent cap (<=950). Each round auto-generates phases Plan -> Build -> Audit -> Repair. Build uses sonnet with SELF-ESCALATION: a worker that flags needsAdvice gets an opus /advice pass then revises. Loop-until-cap / loop-until-dry, like ultracode but model-tiered and bounded.',
  // phases are generated dynamically per round ("Round N · Plan/Build/Audit/Repair"),
  // so no static phase list — an empty array avoids orphan/unused entries in the progress view.
  phases: [],
}

// ---- args normalization (runtime threads `args` as a JSON STRING) ----
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
  return { error: 'strata-grow needs args.task (+ args.domain and optional args.gridA/gridB seed grid; optional args.goal for goal-driven stop).' }
}

// ---- config: COUNT is the real cap; opus is reserved for advice + audit (thin layer) ----
const UNIT_MODEL = A.model === 'haiku' || A.model === 'sonnet' ? A.model : 'sonnet'
// planning the domain expansion is high-leverage reasoning -> default opus (override via args.planModel)
const PLAN_MODEL = A.planModel === 'sonnet' || A.planModel === 'haiku' ? A.planModel : 'opus'
const ADVICE_MODEL = 'opus'
const AUDIT_MODEL = 'opus'
// guard: typeof NaN === 'number' is true, so add isFinite checks to prevent NaN propagating into
// MAX_AGENTS (NaN < NaN is false → can() always false → while loop never runs → silent empty result)
const MAX_AGENTS = Math.max(8, Math.min(950, typeof A.maxAgents === 'number' && isFinite(A.maxAgents) && A.maxAgents > 0 ? Math.floor(A.maxAgents) : 150))
const BATCH = Math.max(4, typeof A.batchSize === 'number' && isFinite(A.batchSize) && A.batchSize > 0 ? Math.floor(A.batchSize) : 16)
const FLOOR = typeof A.qualityFloor === 'number' && isFinite(A.qualityFloor) ? A.qualityFloor : 60
const MAX_ROUNDS = typeof A.maxRounds === 'number' && isFinite(A.maxRounds) && A.maxRounds > 0 ? Math.floor(A.maxRounds) : 24
const AUDIT_ON = A.audit !== false
// a worker self-escalates to /advice when it flags needsAdvice OR rates its own draft below this confidence
// guard: NaN would silence escalation (draft.selfScore < NaN = false); add isFinite check
const ADVICE_THRESHOLD = typeof A.adviceThreshold === 'number' && isFinite(A.adviceThreshold) ? A.adviceThreshold : 78
const DOMAIN = A.domain || A.task
const gridA = Array.isArray(A.gridA) ? A.gridA : []
const gridB = Array.isArray(A.gridB) ? A.gridB : []
const INSTRUCTIONS =
  A.instructions ||
  'Build ONE self-contained, dependency-free unit. Vanilla HTML/CSS/JS only (no frameworks/CDNs). It MUST work standalone in an isolated iframe and visibly animate. Scope EVERY CSS selector under one unique wrapper class `.uic-<slug>` (prefix child classes with the slug too); never use bare generic class names; define any SVG filter inline.'

// ---- GOAL contract: when present, Strata runs goal-driven and stops the moment the goal is MET ----
// goal = { objective, doneCriteria: { programmatic: { minCount?, auditAvgMin?, coverageFullGrid? }, qualitative } }
const GOAL = A.goal && typeof A.goal === 'object' ? A.goal : null
const DONE = GOAL && GOAL.doneCriteria && typeof GOAL.doneCriteria === 'object' ? GOAL.doneCriteria : {}
const PROG = DONE.programmatic && typeof DONE.programmatic === 'object' ? DONE.programmatic : {}

// ---- count guard (the real bound; needs no API) ----
let spawned = 0
const spentNow = () => {
  try {
    return budget.spent()
  } catch (e) {
    return 0
  }
}
const startSpent = spentNow()
// best-effort budget guard: only fires when a HARD `+Ntokens` budget.total is actually exhausted
// (remaining() is Infinity otherwise, so the agent COUNT stays the primary bound by design).
const overBudget = () => {
  try {
    return budget.remaining() <= 0
  } catch (e) {
    return false
  }
}
const can = () => spawned < MAX_AGENTS && !overBudget()
// reserve headroom each round so AUDIT + GOAL-CHECK always get to run (build/plan/repair stop earlier)
const RESERVE = Math.min(12, Math.max(4, Math.ceil(MAX_AGENTS * 0.15)))
const canBuild = () => spawned < Math.max(1, MAX_AGENTS - RESERVE) && !overBudget()

// ---- schemas ----
const COMP_FIELDS = {
  id: { type: 'string' },
  title: { type: 'string' },
  category: { type: 'string' },
  description: { type: 'string' },
  html: { type: 'string' },
  css: { type: 'string' },
  js: { type: 'string', description: 'dependency-free vanilla JS; empty string if none' },
  tags: { type: 'array', items: { type: 'string' } },
}
const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'category', 'html', 'css', 'needsAdvice'],
  properties: {
    ...COMP_FIELDS,
    selfScore: { type: 'number', description: '0-100 your honest confidence this is expert-level' },
    needsAdvice: { type: 'boolean', description: 'true if a tricky combo where an expert opinion would materially improve it' },
    adviceQuestion: { type: 'string', description: 'the specific question to ask the expert (empty if needsAdvice false)' },
  },
}
const COMP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'category', 'html', 'css'],
  properties: { ...COMP_FIELDS },
}
const ADVICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['advice'],
  properties: { advice: { type: 'string', description: 'concise, concrete, actionable expert guidance (<=180 words)' } },
}
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['specs', 'domainExhausted'],
  properties: {
    specs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['a', 'b'],
        properties: { a: { type: 'string' }, b: { type: 'string' }, note: { type: 'string' } },
      },
    },
    domainExhausted: { type: 'boolean' },
    rationale: { type: 'string' },
  },
}
const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'score', 'ok'],
        properties: {
          id: { type: 'string' },
          score: { type: 'number' },
          ok: { type: 'boolean' },
          broken: { type: 'boolean' },
          issue: { type: 'string' },
        },
      },
    },
  },
}

const cellKey = (s) => (s && s.a != null ? String(s.a) + '||' + String(s.b) : JSON.stringify(s))
const slim = (c) => ({ id: c.id, title: c.title, category: c.category, html: c.html, css: c.css, js: c.js || '' })

// ---- accumulators (covered/total seed from prior checkpoints so a checkpoint run can continue) ----
const built = []
const byId = new Map()
const covered = new Set(Array.isArray(A.coveredSeed) ? A.coveredSeed : [])
const priorTotal = typeof A.priorTotal === 'number' && Number.isFinite(A.priorTotal) && A.priorTotal >= 0 ? Math.floor(A.priorTotal) : 0
const systemic = []
const allScores = []
let goalResidual = []
let advised = 0

// ---- build one unit, with self-escalation to an opus /advice pass ----
async function buildUnit(spec, round) {
  if (!canBuild()) return null
  spawned++
  const draft = await agent(
    `${A.task}\n\n${INSTRUCTIONS}\n\nUnit spec (build exactly this; distinct from siblings): ${JSON.stringify(
      spec
    )}\nAlso self-assess honestly: set needsAdvice=true ONLY for a genuinely tricky combo where an expert tip would materially raise quality, and put your precise question in adviceQuestion. Set id=kebab slug, category=${
      spec.a != null ? 'the component type' : 'a short category'
    }, tags=[style + 1-2 descriptors].`,
    { label: `draft:${cellKey(spec)}`, phase: `Round ${round} · Build`, model: UNIT_MODEL, schema: DRAFT_SCHEMA }
  )
  if (!draft) return null
  const lowConfidence = typeof draft.selfScore === 'number' && draft.selfScore < ADVICE_THRESHOLD
  if ((draft.needsAdvice || lowConfidence) && canBuild()) {
    spawned++
    advised++
    const adv = await agent(
      `An expert is consulted by a running builder. Unit: ${JSON.stringify(spec)}. The builder asks: "${
        draft.adviceQuestion || 'How do I make this expert-level?'
      }". Their current draft CSS/JS approach: ${(draft.css || '').slice(0, 900)}\n\nGive concise, concrete, immediately-applicable expert guidance to raise it to opus-level (techniques, the right CSS/JS approach, pitfalls). Keep CSS scoping rules intact.`,
      { label: `advice:${cellKey(spec)}`, phase: `Round ${round} · Build`, model: ADVICE_MODEL, schema: ADVICE_SCHEMA }
    )
    if (adv && adv.advice && canBuild()) {
      spawned++
      const revised = await agent(
        `${A.task}\n\n${INSTRUCTIONS}\n\nUnit: ${JSON.stringify(spec)}. Your earlier draft, now improve it using this EXPERT ADVICE:\n${
          adv.advice
        }\n\nReturn the final, polished component.`,
        { label: `revise:${cellKey(spec)}`, phase: `Round ${round} · Build`, model: UNIT_MODEL, schema: COMP_SCHEMA }
      )
      if (revised) return revised
    }
  }
  return draft
}

// ---- audit a round inline (opus), components passed in the prompt, sub-batched ----
async function auditRound(comps, round) {
  const SUB = 12
  const groups = []
  for (let i = 0; i < comps.length; i += SUB) groups.push(comps.slice(i, i + SUB))
  const results = await parallel(
    groups.map((g) => () => {
      if (!can()) return { verdicts: [] }
      spawned++
      return agent(
        `Audit these UI components (JSON). For each: would it render and visibly animate? is ALL CSS scoped under one unique .uic-<slug> wrapper (no global leaks)? any undefined SVG filter? broken/empty? Grade 0-100. Return {id, score, ok (score>=${FLOOR} AND not broken), broken, issue(<=12 words)}.\n\n${JSON.stringify(
          g.map(slim)
        )}`,
        { label: `audit:r${round}`, phase: `Round ${round} · Audit`, model: AUDIT_MODEL, schema: AUDIT_SCHEMA }
      )
    })
  )
  return results.filter(Boolean).flatMap((r) => (r && r.verdicts ? r.verdicts : []))
}

// ---- GOAL-CHECK: programmatic criteria AND an opus goal-critic; BOTH must pass to declare done ----
const GOALCHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['met', 'residual'],
  properties: {
    met: { type: 'boolean' },
    residual: { type: 'array', items: { type: 'string' }, description: 'concrete gaps to close next if not met' },
    assessment: { type: 'string' },
  },
}
function currentStats() {
  const catCounts = {}
  built.forEach((c) => {
    catCounts[c.category] = (catCounts[c.category] || 0) + 1
  })
  const auditAvg = allScores.length ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length) : 0
  return { total: priorTotal + built.length, coverage: covered.size, auditAvg, catCounts }
}
function programmaticDone(st) {
  if (typeof PROG.minCount === 'number' && st.total < PROG.minCount) return false
  if (typeof PROG.auditAvgMin === 'number' && st.auditAvg < PROG.auditAvgMin) return false
  if (PROG.coverageFullGrid && gridA.length && gridB.length && covered.size < gridA.length * gridB.length) return false
  return true
}
async function goalCheck(round) {
  if (!GOAL) return { met: false, programmaticOk: false, criticMet: false, residual: [] }
  const st = currentStats()
  const programmaticOk = programmaticDone(st)
  let criticMet = false
  let residual = []
  if (can()) {
    // goal-check is essential and cheap (1 opus) — it runs from the reserved headroom (canBuild stops
    // earlier than can() by RESERVE), but it still honors MAX_AGENTS instead of a hardcoded ceiling.
    spawned++
    const critic = await agent(
      `GOAL: ${GOAL.objective}\nDONE-CRITERIA (qualitative): ${
        DONE.qualitative || '(none stated; judge whether the objective is satisfied)'
      }\nProgress: ${st.total} units; covered cells=${st.coverage}${
        gridA.length ? '/' + gridA.length * gridB.length : ''
      }; audit avg=${st.auditAvg}/100; categories=${JSON.stringify(st.catCounts)}; recent systemic issues=${JSON.stringify(
        systemic.slice(-5)
      )}.\nAre the done-criteria MET? If NOT, list concrete residual gaps to close next (these become the next round's priorities).`,
      { label: `goal-check:r${round}`, phase: `Round ${round} · Goal-check`, model: 'opus', schema: GOALCHECK_SCHEMA }
    )
    criticMet = !!(critic && critic.met)
    residual = (critic && critic.residual) || []
  }
  return { met: programmaticOk && criticMet, programmaticOk, criticMet, residual }
}

// ---- main progressive loop: auto-generated phases, goal-driven, grow to the cap ----
log(
  `strata-grow: target<=${MAX_AGENTS} agents, batch=${BATCH}, floor=${FLOOR}, unit=${UNIT_MODEL}, advice/audit=opus, goal=${
    GOAL ? 'on' : 'off'
  }`
)
let round = 0
let dryStreak = 0
let done = false
// fail open: a mid-loop throw (e.g. a hard budget.total ceiling hit inside an awaited agent()) must not
// discard everything built so far — break out and return the accumulated units as a partial result.
try {
while (can() && round < MAX_ROUNDS && dryStreak < 2) {
  round++

  // --- goal-aware round size: don't overshoot the goal; keep RESERVE for audit + goal-check ---
  let roundCap = BATCH
  if (GOAL) {
    let need = Infinity
    if (typeof PROG.minCount === 'number') need = Math.max(0, PROG.minCount - (priorTotal + built.length))
    if (PROG.coverageFullGrid && gridA.length) {
      const uncovered = gridA.length * gridB.length - covered.size
      need = Math.max(need === Infinity ? 0 : need, uncovered)
    }
    if (need !== Infinity) roundCap = Math.min(BATCH, Math.max(1, need))
  }
  // Account for the plan agent (+1) that will be spawned at the top of the round body so the
  // available build slot count is correct — prevents a "dry round" where plan runs but no build
  // unit passes canBuild() because the plan itself exhausted the pre-reserve budget.
  roundCap = Math.min(roundCap, Math.max(0, MAX_AGENTS - RESERVE - spawned - 1 /* plan */))
  if (roundCap < 1) {
    log(`round ${round}: no build budget left (reserving for plan/audit/goal-check); stopping`)
    break
  }

  // --- PLAN (auto-generates this round's focus) ---
  phase(`Round ${round} · Plan`)
  spawned++
  const catCounts = {}
  built.forEach((c) => {
    catCounts[c.category] = (catCounts[c.category] || 0) + 1
  })
  const plan = await agent(
    `You are planning round ${round} of a progressive generation task. DOMAIN: ${DOMAIN}\n` +
      (gridA.length
        ? `Seed grid: componentTypes(a)=${JSON.stringify(gridA)} ; styles(b)=${JSON.stringify(gridB)}.\n`
        : '') +
      `Already built: ${built.length} units. Counts by category: ${JSON.stringify(catCounts)}.\n` +
      `Already-covered cells (do NOT repeat): ${JSON.stringify(Array.from(covered).slice(0, 400))}.\n` +
      (systemic.length ? `Recent audit systemic issues to steer AROUND: ${JSON.stringify(systemic.slice(-6))}.\n` : '') +
      (goalResidual.length ? `PRIORITIES to close next (from the goal-check): ${JSON.stringify(goalResidual.slice(0, 6))}. Bias this batch toward these.\n` : '') +
      `Propose the NEXT batch of up to ${roundCap} specs as {a,b} pairs (do NOT exceed ${roundCap}): FIRST any uncovered seed-grid cells; only when the seed grid is exhausted, EXPAND by inventing NEW component types (a) and/or styles (b) not yet present. Keep them distinct. Set domainExhausted=true ONLY if you truly cannot propose anything fresh.`,
    { label: `plan:r${round}`, phase: `Round ${round} · Plan`, model: PLAN_MODEL, schema: PLAN_SCHEMA }
  )
  let specs = ((plan && plan.specs) || []).filter((s) => s && !covered.has(cellKey(s)))
  specs = specs.slice(0, roundCap)
  if (!specs.length) {
    dryStreak++
    log(`round ${round}: planner produced no fresh specs (dryStreak=${dryStreak}${plan && plan.domainExhausted ? ', domainExhausted' : ''})`)
    if (plan && plan.domainExhausted) break
    continue
  }
  dryStreak = 0

  // --- BUILD (with self-escalation /advice) ---
  phase(`Round ${round} · Build`)
  // mark a cell covered ONLY when its unit actually built — a budget-skipped (null) spec stays uncovered
  // so a later round / checkpoint can still pick it up (no optimistic over-counting / silent loss).
  const roundComps = (
    await parallel(
      specs.map((s) => async () => {
        const c = await buildUnit(s, round)
        if (c) covered.add(cellKey(s))
        return c
      })
    )
  ).filter(Boolean)
  for (const c of roundComps) {
    if (!c.id) continue
    if (byId.has(c.id)) c.id = c.id + '-r' + round
    byId.set(c.id, c)
    built.push(c)
  }

  // --- AUDIT + REPAIR ---
  if (AUDIT_ON && can() && roundComps.length) {
    phase(`Round ${round} · Audit`)
    const verdicts = await auditRound(roundComps, round)
    verdicts.forEach((v) => {
      if (v && typeof v.score === 'number' && Number.isFinite(v.score)) allScores.push(v.score)
    })
    const flaggedIds = new Set(verdicts.filter((v) => v && v.ok === false).map((v) => v.id))
    const issueOf = new Map(verdicts.map((v) => [v.id, v.issue || 'low quality']))
    verdicts.filter((v) => v && v.ok === false && v.issue).forEach((v) => systemic.push(v.issue))
    const toFix = roundComps.filter((c) => flaggedIds.has(c.id))
    if (toFix.length && can()) {
      phase(`Round ${round} · Repair`)
      const fixed = (
        await parallel(
          toFix.map((c) => () => {
            if (!canBuild()) return null
            spawned++
            return agent(
              `${A.task}\n\n${INSTRUCTIONS}\n\nREPAIR this component — it failed audit: "${issueOf.get(
                c.id
              )}". Rebuild it fixing that defect (especially: scope ALL CSS under .uic-<slug>; define SVG filters inline; ensure it animates). Category: ${
                c.category
              }; keep the same id "${c.id}". Title/tags as before.`,
              { label: `repair:${c.id}`, phase: `Round ${round} · Repair`, model: UNIT_MODEL, schema: COMP_SCHEMA }
            )
          })
        )
      ).filter(Boolean)
      for (const f of fixed) {
        if (!f.id) continue
        const idx = built.findIndex((x) => x.id === f.id)
        if (idx >= 0) built[idx] = f
        else built.push(f)
        byId.set(f.id, f)
      }
      log(`round ${round}: repaired ${fixed.length}/${toFix.length}`)
    }
  }

  // --- GOAL-CHECK: stop the moment the goal is met (programmatic AND opus critic) ---
  if (GOAL) {
    phase(`Round ${round} · Goal-check`)
    const gc = await goalCheck(round)
    goalResidual = gc.residual || []
    log(`round ${round} goal-check: programmatic=${gc.programmaticOk} critic=${gc.criticMet} -> ${gc.met ? 'GOAL MET' : 'continue'}`)
    if (gc.met) done = true
  }

  log(`round ${round} done: +${roundComps.length} (total ${priorTotal + built.length}), advised ${advised}, agents ${spawned}/${MAX_AGENTS}, ~${Math.max(0, spentNow() - startSpent)} tok`)
  if (done) break
}
} catch (e) {
  log(`strata-grow: stopped early on error — ${String(e && e.message ? e.message : e)}; returning ${built.length} unit(s) built so far`)
}

const finalStats = currentStats()
log(
  `strata-grow finished: ${built.length} units (+${priorTotal} prior) over ${round} rounds, ${advised} self-escalations, ${spawned} agents, done=${done}`
)
return {
  task: A.task,
  rounds: round,
  total: priorTotal + built.length,
  agentsSpawned: spawned,
  selfEscalations: advised,
  maxAgents: MAX_AGENTS,
  done, // goal met? (false when no goal set, or when the cap/dry-streak stopped it first)
  goalResidual, // open gaps — pass back at the next checkpoint
  auditAvg: finalStats.auditAvg,
  covered: Array.from(covered), // pass as args.coveredSeed to CONTINUE at the next checkpoint
  units: built,
}
