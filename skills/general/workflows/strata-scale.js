export const meta = {
  name: 'strata-scale',
  description:
    "Strata SCALE mode: large, token-aware, model-tiered fan-out over a KNOWN work-list. Runs N independent units through a right-sized model (default sonnet; opus is never the per-unit model) and returns one schema-bounded artifact per unit. The deliberate-throughput counterpart to tiered-orchestrate's restraint.",
  phases: [
    { title: 'Advise', detail: 'one opus advisor writes a brief injected into every cheap worker (amortized)' },
    { title: 'Build', detail: 'N right-sized agents, one per unit, schema-bounded, streamed' },
  ],
}

// ---- args normalization (the runtime threads `args` as a JSON STRING) ----
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

// ---- build the unit list: explicit units | cross-product gridA x gridB | bare count ----
function buildUnits() {
  if (Array.isArray(A.units) && A.units.length) return A.units
  if (Array.isArray(A.gridA) && Array.isArray(A.gridB)) {
    const out = []
    for (const a of A.gridA) for (const b of A.gridB) out.push({ a, b })
    return out
  }
  // guard against non-finite / negative count: Infinity here would loop forever and OOM before the
  // later HARD_LIMIT truncation could ever run, so clamp to a finite, bounded integer up front.
  const n = typeof A.count === 'number' && isFinite(A.count) && A.count > 0 ? Math.min(Math.floor(A.count), 950) : 0
  const out = []
  for (let i = 0; i < n; i++) out.push({ index: i })
  return out
}
let units = buildUnits()
if (!units.length || !A.task) {
  return {
    error:
      'mass-fanout needs args.task plus a work-list: args.units[] OR args.gridA[]+args.gridB[] (cross-product) OR args.count.',
  }
}

// ---- SCALE-mode model tiering: force a right-sized model; opus is never the per-unit model ----
const PICK = A.model === 'haiku' || A.model === 'sonnet' || A.model === 'opus' ? A.model : 'sonnet'
const UNIT_MODEL = PICK === 'opus' ? 'sonnet' : PICK

// ---- lifetime-cap guard (harness hard cap is 1000; keep headroom) ----
const HARD_LIMIT = 950
// When the advise pre-pass is on (default) it adds 1 agent on top of the build units.
// Reserve 1 slot for it so the total never exceeds HARD_LIMIT.
const ADVISE_RESERVE = A.advise !== false ? 1 : 0
// An explicit agent-count cap (a leading bare number like `100`) lowers the lifetime ceiling so the
// total fan-out (build units + advise) never exceeds it; absent it, HARD_LIMIT applies.
const explicitMax = typeof A.maxAgents === 'number' && isFinite(A.maxAgents) && A.maxAgents > 0 ? Math.min(Math.floor(A.maxAgents), HARD_LIMIT) : null
const UNIT_LIMIT = (explicitMax != null ? explicitMax : HARD_LIMIT) - ADVISE_RESERVE
if (units.length > UNIT_LIMIT) {
  log(`mass-fanout: ${units.length} units exceeds ${UNIT_LIMIT} (HARD_LIMIT=${HARD_LIMIT} minus ${ADVISE_RESERVE} for advise); truncating to ${UNIT_LIMIT}.`)
  units = units.slice(0, UNIT_LIMIT)
}
// spawned counter tracks advise + build agents for honest reporting
let spawned = 0

// ---- best-effort token ceiling (baseline-corrected; in SCALE mode the COUNT is the real knob) ----
const spentNow = () => {
  try {
    return budget.spent()
  } catch (e) {
    return 0
  }
}
const startSpent = spentNow()
const CAP = typeof A.cap === 'number' && A.cap > 0 ? A.cap : Infinity
const overCap = () => spentNow() - startSpent >= CAP

// ---- per-unit artifact schema (override via A.unitSchema); default = a copy-pasteable UI component ----
const DEFAULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'category', 'html', 'css', 'description'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    category: { type: 'string' },
    description: { type: 'string' },
    html: { type: 'string', description: 'self-contained HTML markup for the component' },
    css: { type: 'string', description: 'scoped, dependency-free CSS' },
    js: { type: 'string', description: 'optional dependency-free vanilla JS; empty string if none' },
    tags: { type: 'array', items: { type: 'string' } },
  },
}
const SCHEMA = A.unitSchema && typeof A.unitSchema === 'object' ? A.unitSchema : DEFAULT_SCHEMA

const INSTRUCTIONS =
  A.instructions ||
  'Build ONE self-contained, dependency-free UI micro-interaction (vanilla HTML/CSS/JS only — no frameworks, no CDN). It MUST work standalone when dropped into an isolated iframe. Make the motion smooth, polished and visually distinct from siblings. Return it as the structured fields.'

log(
  `mass-fanout: ${units.length} units on ${UNIT_MODEL}, ~${Math.ceil(units.length / 8)} waves (8-wide), cap=${
    CAP === Infinity ? 'none' : CAP
  }`
)

// ---- ADVISE (optional, default ON): one opus advisor lifts every cheap worker, amortized over N ----
// "advise" = the user's idea to make sonnet perform near opus by injecting expert guidance up front.
let advisory = ''
const ADVISE = A.advise !== false
if (ADVISE) {
  phase('Advise')
  spawned++ // the advise agent
  const ADV_MODEL = A.adviseModel === 'sonnet' || A.adviseModel === 'haiku' ? A.adviseModel : 'opus'
  const adv = await agent(
    `${A.task}\n\nYou are a senior expert advisor. ${units.length} cheaper workers will EACH build one unit independently and blind to each other. Write ONE high-leverage ADVISORY BRIEF (<=400 words) that will be injected verbatim into every worker's prompt to lift their output to expert (opus) level. Include: (1) the quality bar — what "excellent" looks like for this task; (2) the top concrete pitfalls to avoid; (3) 2-4 reusable best-practice techniques/snippets they should apply; (4) consistency rules so independent workers produce a COHERENT set (shared conventions, naming, sizing); (5) what NOT to duplicate. Be specific and directly actionable — no fluff.`,
    {
      label: 'advise',
      phase: 'Advise',
      model: ADV_MODEL,
      schema: { type: 'object', additionalProperties: false, required: ['brief'], properties: { brief: { type: 'string', maxLength: 3500 } } },
    }
  )
  advisory = adv && adv.brief ? `\n\n--- EXPERT ADVISORY BRIEF (apply this to reach expert quality) ---\n${adv.brief}\n--- END BRIEF ---` : ''
  log(`advise: ${advisory ? `brief ready (${ADV_MODEL}), injecting into all ${units.length} workers` : 'advisor returned nothing; proceeding without'}`)
}

// ---- BUILD: one agent per unit, STREAMED via pipeline (no barrier) ----
phase('Build')
let done = 0
const results = await pipeline(units, (unit, _orig, index) => {
  // Dual gate: token-budget cap (overCap) is the primary throttle when A.cap is set;
  // counter cap (spawned >= the effective ceiling) is the hard backstop when A.cap is unset (overCap()
  // never fires when CAP=Infinity). The unit-list truncation to UNIT_LIMIT already guarantees
  // spawned never exceeds the ceiling, but the explicit counter check here closes the honesty
  // gap: the spawned counter is an actual gate, not just a reporter. An explicit maxAgents lowers it.
  if (overCap() || spawned >= (explicitMax != null ? explicitMax : HARD_LIMIT)) return null
  spawned++
  return agent(
    `${A.task}\n\n${INSTRUCTIONS}${advisory}\n\nUnit spec (build exactly this; make it distinct from siblings): ${JSON.stringify(
      unit
    )}\nUnit index: ${index}.`,
    { label: `build:${index}`, phase: 'Build', model: UNIT_MODEL, schema: SCHEMA }
  ).then((r) => {
    done++
    if (done % 25 === 0) log(`built ${done}/${units.length} (~${Math.max(0, spentNow() - startSpent)} tok this run)`)
    return r
  })
})

const built = results.filter(Boolean)
log(`mass-fanout done: ${built.length}/${units.length} built, ${spawned} agents, ~${Math.max(0, spentNow() - startSpent)} output tokens this run`)
return { task: A.task, model: UNIT_MODEL, requested: units.length, built: built.length, agentsSpawned: spawned, units: built }
