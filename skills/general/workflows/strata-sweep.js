export const meta = {
  name: 'strata-sweep',
  description:
    "Codebase-wide review at scale. Maps the whole tree into risk-ranked review units, fans out one sonnet reviewer per unit (pipelined: each unit reviews then severity-gated-verifies on its own, no barrier), dedups findings across the whole codebase, then runs an opus SYSTEMIC critic that surfaces cross-cutting / architectural issues no single-file reviewer can see, and an opus synthesis that grades overall health with an HONEST coverage note. Where strata-review scrutinizes ONE known change, strata-sweep audits the entire codebase — coverage is the budget knob: the riskiest units are reviewed first within the agent cap, and what was NOT reached is reported, never silently dropped. Count-bounded and model-tiered like every Strata mode.",
  phases: [
    { title: 'Map', detail: 'one agent enumerates the tree and partitions it into risk-ranked review units (+ an architecture sketch)' },
    { title: 'Review', detail: 'pipelined sonnet reviewers, one per unit — each reviews then severity-gated-verifies its own findings' },
    { title: 'Systemic', detail: 'one opus critic finds cross-cutting / architectural issues across all confirmed findings' },
    { title: 'Synthesize', detail: 'one opus agent grades health, ranks top risks, and writes an honest coverage note' },
  ],
}

// ---- args: { root?, scope?, focus?, dimensions?, exclude?, partitionHint?, severityFloor?, verifyFloor?, maxUnits?, cap?, tierHint? } ----
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

// ---- tunable constants (the enforcement surface) ----
const DEFAULT_CAP = 200_000 // sweep is a scale-y mode; a higher default than focus/review
const TOKENS_PER_AGENT = 12_000
const AGENT_FLOOR = 6
const AGENT_ROOF = 120 // sweep can fan out wider than focus/review (roof 40); still a hard ceiling
const HARD_LIMIT = 950 // runtime lifetime-agent backstop; never exceed

// ---- model tiers: applied to EVERY agent() call; implicit inherit is forbidden ----
// map = sonnet (must understand structure). review/verify = sonnet. systemic/synth = opus (the cross-cutting judgment).
const TIER = { map: 'sonnet', review: 'sonnet', verify: 'sonnet', systemic: 'opus', synth: 'opus' }
// run every sonnet-tier agent on the 1M-context variant (the cheap bulk carries the long inputs); haiku/opus untouched
for (const k in TIER) if (TIER[k] === 'sonnet') TIER[k] = 'sonnet[1m]'
if (A.tierHint === 'cheap') TIER.review = 'haiku' // shallow sweep: drop per-unit reviewers to haiku (systemic/synth stay opus)
if (A.tierHint === 'hard') TIER.verify = 'opus' // spend opus on refutation when correctness is paramount

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

// ---- derive the ceiling from the cap arg / the +N directive / the default; min() if both ----
const candidates = [A.cap, hardTotal()].filter((n) => typeof n === 'number' && n > 0)
const CEIL = candidates.length ? Math.min(...candidates) : DEFAULT_CAP
const SOFT = Math.floor(CEIL * 0.8)
const RESERVE = Math.min(50_000, Math.floor(CEIL * 0.2))
const DERIVED = Math.max(AGENT_FLOOR, Math.min(AGENT_ROOF, Math.floor(SOFT / TOKENS_PER_AGENT)))
// MAX_AGENTS is the hard TOTAL agent ceiling (map + reviews + verifies + systemic + synth).
const explicitUnits = typeof A.maxUnits === 'number' && A.maxUnits > 0 ? Math.min(A.maxUnits, HARD_LIMIT) : null
// An explicit agent-count cap (a leading bare number like `100`) overrides the token-derived total and may
// exceed the soft AGENT_ROOF — bounded only by [AGENT_FLOOR, HARD_LIMIT]. maxUnits (review breadth) still applies under it.
const explicitMax = typeof A.maxAgents === 'number' && isFinite(A.maxAgents) && A.maxAgents > 0 ? Math.min(Math.floor(A.maxAgents), HARD_LIMIT) : null
const MAX_AGENTS = explicitMax != null
  ? Math.max(AGENT_FLOOR, explicitMax)
  : Math.min(HARD_LIMIT, explicitUnits ? Math.max(AGENT_FLOOR, explicitUnits + 4) : DERIVED)
// Reserve the last 2 slots for the always-run systemic + synth stages.
const SYNTH_RESERVE = 2
// How many review units we'll actually deep-review: the riskiest first, within the counter.
const REVIEW_CEIL = Math.max(2, MAX_AGENTS - SYNTH_RESERVE - 1 /* map */)
const TARGET_UNITS = explicitUnits || REVIEW_CEIL

// ---- the PRIMARY guard is a literal counter (needs no API, cannot fail) ----
let spawned = 0
const startSpent = spentNow()
// An explicit agent cap with NO explicit token cap makes the agent count the SOLE binding limit:
// lift the soft token budget so it can't silently undercut the cap. A hard budget.total (the +N
// directive, enforced by the runtime) still applies; passing a k/m token cap too re-imposes SOFT.
const UNCAP_TOKENS = explicitMax != null && !(typeof A.cap === 'number' && A.cap > 0)
const overBudget = () => (UNCAP_TOKENS ? false : spentNow() - startSpent >= SOFT)
const mustReserve = () => remainingNow() < RESERVE
const canSpawn = () => spawned < MAX_AGENTS && !overBudget()
// review/verify must leave room for systemic + synth
const canSpawnUnit = () => spawned < MAX_AGENTS - SYNTH_RESERVE && !overBudget()

// ---- scope resolution: the map agent does the discovery itself (it has Bash/Read) ----
const ROOT = A.root ? String(A.root) : '.'
const SCOPE_HINT = A.scope ? String(A.scope) : '' // e.g. "only src/ and lib/", "the API layer"
const EXCLUDE = Array.isArray(A.exclude) && A.exclude.length ? A.exclude : ['node_modules', 'dist', 'build', 'vendor', '.git', 'coverage', '*.min.*', 'lock files', 'generated code']
const FOCUS = A.focus ? String(A.focus) : '' // free-text steer, e.g. "prioritize security and the payment flow"

// ---- grounding context (NEW): the conversation/intent behind the sweep + the project's own conventions ----
//  • conversation: caller-supplied (subagents can't see the parent session) — injected into every reviewer.
//  • conventions: false = the map only infers conventions from code (legacy behavior); a non-empty string =
//    used verbatim as the authoritative conventions; omitted/true = the map ALSO reads CLAUDE.md / AGENTS.md
//    and merges stated conventions (precedence) with code-inferred ones.
const CONVERSATION = typeof A.conversation === 'string' && A.conversation.trim() ? A.conversation.trim() : ''
const CONV_BLOCK = CONVERSATION
  ? `\nCONVERSATION / INTENT (what this audit is for — judge the code against THIS where relevant; flag missed requirements and unrequested scope creep):\n${CONVERSATION}\n`
  : ''
const CONVENTIONS_OFF = A.conventions === false
const CONVENTIONS_LITERAL = typeof A.conventions === 'string' && A.conventions.trim() ? A.conventions.trim() : ''
const CONVENTIONS_AUTO = !CONVENTIONS_OFF && !CONVENTIONS_LITERAL // default: the map reads CLAUDE.md/AGENTS.md too
const SEVERITY_FLOOR = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].includes(A.severityFloor) ? A.severityFloor : 'INFO'
const VERIFY_FLOOR = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].includes(A.verifyFloor) ? A.verifyFloor : 'HIGH' // at scale, only refute the serious ones

const RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 }
const FLOOR_RANK = RANK[SEVERITY_FLOOR]
const VERIFY_RANK = RANK[VERIFY_FLOOR]

const DEFAULT_DIMS = [
  'correctness (logic errors, broken invariants, race conditions, resource leaks)',
  'security (injection, auth/authorization gaps, secret leakage, unsafe deserialization, SSRF)',
  'error-handling & robustness (unhandled errors, missing validation, swallowed exceptions)',
  'performance (N+1, accidental O(n^2), blocking I/O on hot paths)',
  'maintainability (dead code, duplication, leaky abstractions, convention drift)',
]
const baseDims = Array.isArray(A.dimensions) && A.dimensions.length ? A.dimensions : DEFAULT_DIMS
// The adherence lens (and final DIM_LINE) is assembled after the map resolves conventions — see below.
const ADHERENCE_DIM =
  'convention & intent adherence (does the code follow the PROJECT CONVENTIONS above / CLAUDE.md, and — when a CONVERSATION/INTENT is given — does it satisfy it; flag convention drift and missed/over-built requirements)'

log(
  `Strata/strata-sweep: cap=${CEIL} (${candidates.length ? 'set' : 'default'}), MAX_AGENTS=${MAX_AGENTS}${explicitMax != null ? ` (explicit agent cap${UNCAP_TOKENS ? '; token budget lifted' : ''})` : ''}, ` +
    `target units=${TARGET_UNITS}, review ceil=${REVIEW_CEIL}, verifyFloor=${VERIFY_FLOOR}, ` +
    `tiers review=${TIER.review} verify=${TIER.verify} systemic=${TIER.systemic} synth=${TIER.synth}`
)

// ---- schemas ----
const MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['units', 'architecture'],
  properties: {
    architecture: { type: 'string', description: 'a short sketch of what this codebase is and how it is structured (layers, entry points, key modules)' },
    conventions: { type: 'string', description: 'the conventions/patterns a reviewer should hold the code to — from CLAUDE.md/AGENTS.md if present (stated, authoritative) merged with patterns inferred from the code itself' },
    totalFiles: { type: 'integer', description: 'how many source files exist in scope (so coverage can be reported honestly)' },
    units: {
      type: 'array',
      description: 'the codebase partitioned into coherent review units, each a small set of related files',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'paths', 'risk'],
        properties: {
          id: { type: 'string', description: 'short stable id, e.g. "auth" or "api/routes"' },
          paths: { type: 'array', items: { type: 'string' }, description: 'the files in this unit' },
          risk: { type: 'number', description: 'review-priority 0-10 (10 = highest risk surface: security-sensitive, complex, high-churn, central)' },
          reason: { type: 'string', description: 'why this risk score (what makes it worth reviewing first)' },
        },
      },
    },
  },
}
const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'location', 'evidence'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] },
          location: { type: 'string', description: 'file:line of the issue (REQUIRED — ground it in real code)' },
          evidence: { type: 'string', description: 'the quoted code that proves the issue' },
          rationale: { type: 'string', description: 'why it is a problem and what it leads to' },
          suggestedFix: { type: 'string', description: 'concrete fix or precise instruction' },
        },
      },
    },
  },
}
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isReal', 'reason'],
  properties: {
    isReal: { type: 'boolean' },
    reason: { type: 'string' },
    revisedSeverity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] },
  },
}
const SYSTEMIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['systemicFindings'],
  properties: {
    systemicFindings: {
      type: 'array',
      description: 'cross-cutting issues that span many units — the things a single-file reviewer cannot see',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'theme', 'rationale'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] },
          theme: { type: 'string', description: 'e.g. "inconsistent error handling", "no input validation layer", "auth checks duplicated and divergent"' },
          affectedAreas: { type: 'array', items: { type: 'string' }, description: 'units/paths exhibiting the pattern' },
          rationale: { type: 'string' },
          recommendation: { type: 'string', description: 'the systemic fix (often architectural, not a one-line patch)' },
        },
      },
    },
  },
}
const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['healthGrade', 'summary', 'report', 'coverageNote'],
  properties: {
    healthGrade: { type: 'string', enum: ['A', 'B', 'C', 'D', 'F'], description: 'overall codebase health from this sweep' },
    summary: { type: 'string', maxLength: 1500, description: 'a few sentences: the headline state of the codebase and its biggest risks' },
    report: { type: 'string', maxLength: 12000, description: 'the review grouped by severity AND by theme; reference each finding as "file:line — issue — one-line fix". Do NOT restate evidence/rationale text — the full findings are returned as data alongside this report' },
    topRisks: { type: 'array', items: { type: 'string' }, description: 'the ranked must-address items, each "file:line — issue" or "theme — issue"' },
    coverageNote: { type: 'string', maxLength: 2000, description: 'HONEST coverage: how many units existed, how many were deep-reviewed, which were skipped by the agent budget, and what verification depth was applied' },
  },
}

// ---- Phase 1: MAP — one agent partitions the codebase into risk-ranked units + an architecture sketch ----
phase('Map')
// How the map should source the conventions it returns: read CLAUDE.md (AUTO), defer to a caller literal, or infer-only.
const MAP_CONV_TASK = CONVENTIONS_LITERAL
  ? ' The caller supplied authoritative conventions, so you need not restate them — focus the `conventions` field on code-inferred patterns that do NOT contradict the supplied set.'
  : CONVENTIONS_AUTO
    ? " Read the repo's CLAUDE.md / AGENTS.md (root + nested) and .cursor/rules if present for STATED conventions, AND infer conventions from the code itself; return both merged in `conventions`, stated taking precedence."
    : ' (infer the conventions from the code itself).'
let map = { units: [], architecture: '', conventions: '', totalFiles: 0 }
if (canSpawn()) {
  spawned++
  try {
    map =
      (await agent(
        `Map a codebase for a scaled review. Do NOT review yet — your job is to discover the tree and partition it into coherent REVIEW UNITS, ranked by risk so the most important code is reviewed first.\n\n` +
          `ROOT: ${ROOT}\n` +
          (SCOPE_HINT ? `SCOPE: ${SCOPE_HINT}\n` : '') +
          `EXCLUDE (vendored / generated / non-source): ${EXCLUDE.join(', ')}\n` +
          (FOCUS ? `REVIEWER FOCUS (weight risk toward this): ${FOCUS}\n` : '') +
          `\nDiscover the files yourself (e.g. \`git ls-files\`, or \`find\`/\`rg --files\` honoring the excludes). Then:\n` +
          `1) Group related files into at most ${TARGET_UNITS} coherent units (by module/feature/directory — keep a unit small enough to review in one pass). If there are more files than fit, make larger but still-coherent units; never silently omit areas — fold them into a unit or list them.\n` +
          `2) Score each unit's risk 0-10 (10 = security-sensitive, complex, high-churn, or central to the system). Riskiest units get reviewed first.\n` +
          `3) Sketch the architecture (what this is, its layers/entry points) and the conventions the code should be held to.${MAP_CONV_TASK} These feed a later cross-cutting critic.\n` +
          `4) Report totalFiles so coverage can be stated honestly.`,
        { label: 'map', phase: 'Map', model: TIER.map, schema: MAP_SCHEMA }
      )) || map
  } catch (e) {
    map = { units: [], architecture: '', conventions: '', totalFiles: 0 }
  }
}
const allUnits = (map.units || []).filter((u) => u && u.id && Array.isArray(u.paths) && u.paths.length)
if (allUnits.length === 0) {
  log('done: map produced no review units — check ROOT/scope or raise the cap')
  return {
    root: ROOT,
    cap: CEIL,
    agentsSpawned: spawned,
    maxAgents: MAX_AGENTS,
    error: 'no review units were produced (empty/unreadable scope, or the map agent was budget-skipped)',
    architecture: map.architecture || '',
  }
}
// riskiest first; deep-review only as many as the counter allows, and record what we skip (no silent truncation)
const ranked = [...allUnits].sort((a, b) => (b.risk ?? 0) - (a.risk ?? 0))
const unitsToReview = ranked.slice(0, REVIEW_CEIL)
const unitsSkipped = ranked.slice(REVIEW_CEIL)
if (unitsSkipped.length) {
  log(`map: ${allUnits.length} units; deep-reviewing top ${unitsToReview.length} by risk, ${unitsSkipped.length} deferred by budget (${unitsSkipped.map((u) => u.id).join(', ')})`)
} else {
  log(`map: ${allUnits.length} units, all within budget`)
}

// Effective conventions: a caller literal wins; otherwise whatever the map returned (CLAUDE.md-merged or inferred).
const CONVENTIONS = CONVENTIONS_LITERAL || String(map.conventions || '').trim()
const groundOn = !!(CONVERSATION || CONVENTIONS)
log(`sweep: grounding — conversation=${!!CONVERSATION}, conventions=${CONVENTIONS ? (CONVENTIONS_LITERAL ? 'literal' : CONVENTIONS_AUTO ? 'auto-CLAUDE.md+code' : 'code-inferred') : 'none'}`)
// Insert the adherence lens at high priority only when grounding exists; sweep reviews every unit across ALL
// dims (no FINDERS slice), so this adds a lens to each per-unit reviewer at no extra agent cost.
const DIMS = groundOn ? [...baseDims.slice(0, 2), ADHERENCE_DIM, ...baseDims.slice(2)] : baseDims
const DIM_LINE = DIMS.map((d) => `- ${d}`).join('\n')

const CONTEXT_BLOCK =
  (map.architecture ? `\nARCHITECTURE:\n${map.architecture}\n` : '') +
  (CONVENTIONS ? `\nCONVENTIONS TO HOLD THE CODE TO:\n${CONVENTIONS}\n` : '') +
  CONV_BLOCK +
  (FOCUS ? `\nREVIEWER FOCUS: ${FOCUS}\n` : '')

// ---- Phase 2: REVIEW — pipelined per unit: review (sonnet) THEN severity-gated verify, no barrier between units ----
phase('Review')
const reviewUnit = (unit) => {
  if (!canSpawnUnit()) {
    log(`review: gate hit at ${spawned}/${MAX_AGENTS}, skipping unit "${unit.id}"`)
    return { unit, findings: [], skipped: true }
  }
  spawned++
  return agent(
    `You are a senior reviewer auditing ONE unit of a larger codebase. Review every file in this unit for the dimensions below. Read the actual code.\n` +
      CONTEXT_BLOCK +
      `\nUNIT: ${unit.id}  (risk ${unit.risk ?? '?'} — ${unit.reason || ''})\nFILES:\n${unit.paths.map((p) => `- ${p}`).join('\n')}\n\n` +
      `DIMENSIONS:\n${DIM_LINE}\n\n` +
      `Report only concrete, real issues — each MUST cite file:line in location and quote the offending code in evidence. An empty findings list is valid for clean code; do not invent issues to fill a quota.`,
    { label: `review:${unit.id}`, phase: 'Review', model: TIER.review, schema: FINDINGS_SCHEMA }
  ).then((r) => ({ unit, findings: (r && r.findings ? r.findings : []).filter((f) => f && f.title && f.location) }))
}
const verifyUnit = (reviewed, unit) => {
  if (!reviewed || !reviewed.findings || !reviewed.findings.length) return reviewed || { unit, findings: [] }
  // at scale, only adversarially refute findings AT OR ABOVE the verify floor (default HIGH); the rest pass with a note
  const out = []
  return (async () => {
    for (const f of reviewed.findings) {
      const sev = RANK[f.severity]
      if (sev === undefined || sev > VERIFY_RANK || !canSpawnUnit() || mustReserve()) {
        // note: label each skip reason distinctly so callers can debug coverage accurately.
        // sev===undefined means the schema returned an unrecognized severity string — pass-through confirmed
        // so the finding is never silently dropped, but mark it for auditability.
        const skipNote = sev === undefined ? 'unknown-severity-pass' : sev > VERIFY_RANK ? 'below-verify-floor' : 'budget-skip-verify'
        out.push({ ...f, unitId: unit.id, confirmed: true, note: skipNote })
        continue
      }
      // severity-gated: CRITICAL/HIGH get 2 adversarial votes (one refuter is not enough to drop a serious
      // finding); anything else 1. (With the default verifyFloor=HIGH every verified finding gets 2.)
      const votes = f.severity === 'CRITICAL' || f.severity === 'HIGH' ? 2 : 1
      const thunks = []
      for (let v = 0; v < votes; v++) {
        if (!canSpawnUnit() || mustReserve()) break
        spawned++
        thunks.push(() =>
          agent(
            `Try to REFUTE this finding from a codebase review. Re-read the cited code at ${f.location} and decide whether it is a REAL issue or a false positive. Be skeptical; default isReal=false when the evidence does not clearly support it. Set revisedSeverity if it is mis-rated.\n\nFINDING:\n${JSON.stringify({ title: f.title, severity: f.severity, location: f.location, evidence: f.evidence, rationale: f.rationale })}`,
            { label: `verify:${f.location.split(/[: ]/)[0].split('/').pop()}`, phase: 'Review', model: TIER.verify, schema: VERDICT_SCHEMA }
          )
        )
      }
      const ballots = (await parallel(thunks)).filter(Boolean)
      // Fail OPEN on a missing OR partial ballot; quorum is against the INTENDED vote count, so a 2-vote
      // CRITICAL/HIGH needs a real majority to be rejected (a lone refuter can never drop it).
      if (ballots.length < votes) {
        out.push({ ...f, unitId: unit.id, confirmed: true, note: ballots.length === 0 ? 'budget-skip-verify' : 'budget-partial-verify' })
        continue
      }
      const real = ballots.filter((b) => b.isReal).length
      const revisions = ballots.map((b) => b.revisedSeverity).filter(Boolean)
      const revised = revisions.length && revisions.every((s) => s === revisions[0]) ? revisions[0] : f.severity
      out.push({ ...f, unitId: unit.id, severity: revised, confirmed: real >= Math.ceil(votes / 2) })
    }
    return { unit, findings: out }
  })()
}
const perUnit = await pipeline(unitsToReview, reviewUnit, verifyUnit)

// ---- DEDUP (barrier): collapse the same file:line+title across the whole codebase before the systemic pass ----
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
const siteKey = (it) => `${norm(it.location)}::${norm(it.title)}`
const dedupMap = new Map()
let rawCount = 0
;(perUnit || [])
  .filter(Boolean)
  .flatMap((u) => (u && u.findings ? u.findings : []))
  .filter((it) => it && it.title && it.location && it.confirmed)
  .filter((it) => RANK[it.severity] === undefined || RANK[it.severity] <= FLOOR_RANK)
  .forEach((it) => {
    rawCount++
    const k = siteKey(it)
    const prev = dedupMap.get(k)
    if (!prev) {
      dedupMap.set(k, { ...it, raisedBy: 1 })
    } else {
      const keepSeverer = (RANK[it.severity] ?? 9) < (RANK[prev.severity] ?? 9)
      dedupMap.set(k, { ...prev, severity: keepSeverer ? it.severity : prev.severity, raisedBy: prev.raisedBy + 1 })
    }
  })
const confirmed = [...dedupMap.values()].sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9))
const blockingCount = confirmed.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH').length
log(`review: ${confirmed.length} distinct confirmed findings (from ${rawCount} raw), ${blockingCount} CRITICAL/HIGH`)

// ---- Phase 3: SYSTEMIC — one opus critic reads the aggregate + architecture and surfaces cross-cutting issues ----
phase('Systemic')
let systemic = { systemicFindings: [] }
if (canSpawn()) {
  spawned++
  try {
    systemic =
      (await agent(
        `You are a principal engineer doing the CROSS-CUTTING pass of a codebase review. Per-unit reviewers already found the local issues below; your job is the issues they CANNOT see from one unit — systemic patterns, architectural weaknesses, repeated anti-patterns, inconsistent handling of the same concern across modules, missing layers (validation/auth/error boundaries), and convention drift.\n` +
          (map.architecture ? `\nARCHITECTURE:\n${map.architecture}\n` : '') +
          (CONVENTIONS ? `\nINTENDED CONVENTIONS:\n${CONVENTIONS}\n` : '') +
          CONV_BLOCK +
          `\nCONFIRMED PER-UNIT FINDINGS (note recurring locations/themes — \`raisedBy\`>1 or the same theme across many units is a systemic signal):\n${JSON.stringify(
            confirmed.map((f) => ({ unit: f.unitId, severity: f.severity, title: f.title, location: f.location })),
            null,
            2
          )}\n\n` +
          `UNITS DEEP-REVIEWED: ${unitsToReview.map((u) => u.id).join(', ')}\n` +
          (unitsSkipped.length ? `UNITS DEFERRED BY BUDGET (call out if any look high-risk): ${unitsSkipped.map((u) => `${u.id}(risk ${u.risk})`).join(', ')}\n` : '') +
          `\nReport only genuine systemic issues; do not restate single-unit findings. Each needs a theme, the affected areas, and a systemic (often architectural) recommendation.`,
        { label: 'systemic', phase: 'Systemic', model: TIER.systemic, schema: SYSTEMIC_SCHEMA }
      )) || systemic
  } catch (e) {
    systemic = { systemicFindings: [] }
  }
}
const systemicFindings = (systemic.systemicFindings || []).filter((s) => s && s.title)

// ---- Phase 4: SYNTHESIZE — the final opus stage: grade health, rank risks, write an HONEST coverage note ----
phase('Synthesize')
spawned++ // synthesis always runs
const coverageFacts = {
  unitsTotal: allUnits.length,
  unitsDeepReviewed: unitsToReview.length,
  unitsDeferred: unitsSkipped.map((u) => ({ id: u.id, risk: u.risk })),
  totalFiles: map.totalFiles || null,
  verifyFloor: VERIFY_FLOOR,
}
let synthesis
try {
  synthesis = await agent(
    `You are the lead reviewer writing the final report of a codebase-wide sweep. Grade overall health, rank the top risks, and be HONEST about coverage.\n` +
      (map.architecture ? `\nARCHITECTURE:\n${map.architecture}\n` : '') +
      (CONVENTIONS ? `\nCONVENTIONS THE CODE WAS HELD TO:\n${CONVENTIONS}\n` : '') +
      CONV_BLOCK +
      `\nCONFIRMED PER-UNIT FINDINGS (severity-sorted; raisedBy>1 = multiple sites/lenses):\n${JSON.stringify(confirmed, null, 2)}\n\n` +
      `SYSTEMIC / CROSS-CUTTING FINDINGS:\n${JSON.stringify(systemicFindings, null, 2)}\n\n` +
      `COVERAGE FACTS (state these plainly in coverageNote — what was reviewed vs deferred by the agent budget, and the verification depth):\n${JSON.stringify(coverageFacts, null, 2)}\n\n` +
      `Write the report: healthGrade A-F; a grouped report (by severity AND theme) combining per-unit and systemic issues, each as "file:line — issue — one-line fix" (do NOT restate evidence or rationale text — the confirmed findings are returned verbatim as data alongside this report); topRisks ranked; and a coverageNote that does NOT overstate completeness. If deferred units look high-risk, say a follow-up sweep is needed.`,
    { label: 'synthesize', phase: 'Synthesize', model: TIER.synth, schema: SYNTH_SCHEMA }
  )
  if (!synthesis) throw new Error('synthesis agent returned null') // route a non-throwing null into the fail-open
} catch (e) {
  synthesis = {
    healthGrade: blockingCount > 3 ? 'D' : blockingCount > 0 ? 'C' : confirmed.length ? 'B' : 'A',
    summary: 'Synthesis stage truncated by budget; returning a mechanically-derived grade over the confirmed + systemic findings.',
    report:
      (confirmed.map((f) => `[${f.severity}] ${f.location} — ${f.title}`).join('\n') || 'No confirmed per-unit issues.') +
      (systemicFindings.length ? `\n\nSYSTEMIC:\n${systemicFindings.map((s) => `[${s.severity}] ${s.theme} — ${s.title}`).join('\n')}` : ''),
    topRisks: confirmed.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH').map((f) => `${f.location} — ${f.title}`),
    coverageNote: `synthesis truncated (${String(e && e.message ? e.message : e)}); reviewed ${unitsToReview.length}/${allUnits.length} units, verifyFloor=${VERIFY_FLOOR}.`,
  }
}

log(
  `done: ${spawned} agents, ${confirmed.length} confirmed (${blockingCount} CRITICAL/HIGH) + ${systemicFindings.length} systemic, ` +
    `grade=${synthesis.healthGrade}, units ${unitsToReview.length}/${allUnits.length}, ~${Math.max(0, spentNow() - startSpent)} output tokens this run`
)
return {
  root: ROOT,
  cap: CEIL,
  capWasSet: candidates.length > 0,
  agentsSpawned: spawned,
  maxAgents: MAX_AGENTS,
  grounding: { conversation: !!CONVERSATION, conventions: CONVENTIONS ? (CONVENTIONS_LITERAL ? 'literal' : CONVENTIONS_AUTO ? 'auto-CLAUDE.md+code' : 'code-inferred') : 'none' },
  unitsTotal: allUnits.length,
  unitsDeepReviewed: unitsToReview.length,
  unitsDeferred: unitsSkipped.map((u) => u.id),
  confirmedCount: confirmed.length,
  blockingCount,
  healthGrade: synthesis.healthGrade,
  findings: confirmed,
  systemicFindings,
  synthesis,
}
