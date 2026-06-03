export const meta = {
  name: 'strata-audit',
  description:
    'Strata SCALE-mode auditor: a thin OPUS oversight layer over a large generated batch. Audit agents each read ONE pre-split batch file (cheap input), grade every unit, flag broken/dup/off-spec; then one opus meta-critic surfaces systemic issues and the regenerate list.',
  phases: [
    { title: 'Audit', detail: 'opus agents grade each unit in batches read from disk' },
    { title: 'Critic', detail: 'one opus meta-critic finds systemic issues + the regenerate list' },
  ],
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
if (!A.batchDir || typeof A.count !== 'number' || !isFinite(A.count) || A.count <= 0) {
  // reject non-finite/zero count: Math.ceil(Infinity/BATCH) -> Infinity -> Array.from({length:Infinity}) RangeError
  return {
    error:
      'mass-audit needs args.batchDir (a dir of batch-NN.json files) and args.count (a finite positive integer of total units). Optional: batchSize=20, model=opus, task.',
  }
}

// guard: isFinite prevents A.batchSize=Infinity → BATCH=Infinity → nBatchesRaw=0 → silent empty run
const BATCH = typeof A.batchSize === 'number' && isFinite(A.batchSize) && A.batchSize > 0 ? Math.floor(A.batchSize) : 20
const AUDIT_MODEL = A.model === 'sonnet' || A.model === 'haiku' ? A.model : 'opus'
// ---- literal agent-count cap: harness hard limit is 1000; keep 1 slot for the critic ----
const HARD_LIMIT = 950
const nBatchesRaw = Math.ceil(A.count / BATCH)
const nBatches = Math.min(nBatchesRaw, HARD_LIMIT - 1)  // reserve 1 slot for the critic agent
if (nBatchesRaw > nBatches) {
  log(`mass-audit: ${nBatchesRaw} batches exceeds ${HARD_LIMIT - 1}; truncating to ${nBatches} (covers ${nBatches * BATCH} of ${A.count} units).`)
}
let spawned = 0
const canSpawn = () => spawned < HARD_LIMIT
const pad = (n) => (n < 10 ? '0' : '') + n

const ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'score', 'ok'],
  properties: {
    id: { type: 'string' },
    score: { type: 'number', description: '0-100 quality (polish, distinctiveness, correctness)' },
    ok: { type: 'boolean' },
    broken: { type: 'boolean' },
    dup: { type: 'boolean' },
    issue: { type: 'string', description: '<=12 words; empty if fine' },
  },
}
const BATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: { verdicts: { type: 'array', items: ITEM } },
}

log(`mass-audit: ${A.count} units in ${nBatches} batches of ${BATCH} on ${AUDIT_MODEL}`)

// ---- AUDIT: one agent per batch; each reads only its own small batch file ----
phase('Audit')
const batchIdx = Array.from({ length: nBatches }, (_, i) => i)
const audited = await pipeline(batchIdx, (i) => {
  if (!canSpawn()) return null
  spawned++
  return agent(
    `Read the file ${A.batchDir}/batch-${pad(i)}.json — a JSON array of UI components, each {id,title,category,html,css,js}. Audit EACH component:
- Would it actually RENDER and VISIBLY ANIMATE (on load/hover/click/loop)?
- Is ALL its CSS scoped under one unique wrapper class (no global/leaking selectors)?
- Is it free of external dependencies (no CDN/frameworks/remote assets)?
- Is it broken/empty/placeholder/truncated?
- Does it duplicate another unit (same id or near-identical to a sibling)?
Grade quality 0-100 (polish, distinctiveness, correctness).${A.task ? ' Task context: ' + A.task : ''}
Return one verdict per component: {id, score, ok (score>=60 AND not broken), broken, dup, issue}.`,
    { label: `audit:${pad(i)}`, phase: 'Audit', model: AUDIT_MODEL, schema: BATCH_SCHEMA }
  )
})
const perItem = audited.filter(Boolean).flatMap((b) => (b && b.verdicts ? b.verdicts : []))

const broken = perItem.filter((v) => v.broken || v.score < 60)
const dups = perItem.filter((v) => v.dup)
const scores = perItem.map((v) => v.score).filter((n) => typeof n === 'number' && Number.isFinite(n))
const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0
log(`audit: ${perItem.length} graded, avg ${avg}/100, ${broken.length} low/broken, ${dups.length} dup`)

// ---- CRITIC: one opus meta-critic over the flagged set → systemic issues + regenerate list ----
// The 1-slot critic reserve (nBatches <= HARD_LIMIT - 1) ensures canSpawn() is true here unless
// the batch pipeline itself consumed the last slot due to a race — in which case we degrade gracefully.
phase('Critic')
const CRITIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['systemicIssues', 'overallGrade', 'regenerateIds'],
  properties: {
    systemicIssues: { type: 'array', items: { type: 'string' } },
    worstCategories: { type: 'array', items: { type: 'string' } },
    overallGrade: { type: 'string' },
    regenerateIds: { type: 'array', items: { type: 'string' } },
  },
}
const critic = canSpawn() ? (spawned++, await agent(
  `You are the lead QA critic over a batch of ${A.count} generated UI components (avg quality ${avg}/100; ${broken.length} flagged broken/low <60; ${dups.length} flagged duplicate). Flagged verdicts (JSON): ${JSON.stringify(
    [...broken, ...dups].slice(0, 140)
  )}. Identify SYSTEMIC issues (patterns across many units — e.g. a whole visual style or component-type that consistently fails or looks identical), give an overall letter grade with one sentence, name the worst categories, and produce regenerateIds = the ids worth regenerating (broken/low + clear dups; cap ~80, prioritise the worst).`,
  { label: 'critic', phase: 'Critic', model: 'opus', schema: CRITIC_SCHEMA }
)) : null

return {
  count: A.count,
  audited: perItem.length,
  avgScore: avg,
  brokenCount: broken.length,
  dupCount: dups.length,
  perItem,
  systemicIssues: critic ? critic.systemicIssues : [],
  worstCategories: critic ? critic.worstCategories : [],
  overallGrade: critic ? critic.overallGrade : 'n/a',
  regenerateIds: critic ? critic.regenerateIds : [],
}
