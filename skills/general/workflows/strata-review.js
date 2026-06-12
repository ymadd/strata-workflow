export const meta = {
  name: 'strata-review',
  description:
    "Code review over a KNOWN changeset (git diff / PR / paths). Fans out one sonnet reviewer per dimension grounded in real file:line evidence, dedups overlapping findings across dimensions, adversarially REFUTES each one (severity-gated), then synthesizes a prioritized report with an approve/comment/request-changes verdict. Distinct from focus: focus does cheap haiku exploration of an unknown surface; review does deep sonnet scrutiny of a specific change, with a dedup barrier and a verdict. Count-bounded and model-tiered like every Strata mode.",
  phases: [
    { title: 'Scope', detail: 'one cheap haiku agent enumerates the changed files/hunks to ground the review' },
    { title: 'Review', detail: 'N sonnet reviewers, one per dimension, each grounding findings in file:line' },
    { title: 'Verify', detail: 'dedup across dimensions, then severity-gated adversarial REFUTE on sonnet' },
    { title: 'Synthesize', detail: 'one opus agent ranks findings and issues a verdict + coverage note' },
  ],
}

// ---- args: { target?, diff?, paths?, pr?, baseRef?, dimensions?, fix?, severityFloor?, cap?, tierHint? } ----
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
const DEFAULT_CAP = 150_000
const TOKENS_PER_AGENT = 12_000
const AGENT_FLOOR = 4
const AGENT_ROOF = 40

// ---- model tiers: applied to EVERY agent() call; implicit inherit is forbidden ----
// scope = haiku (enumerate). review/verify = sonnet (reason about real code). synth = opus (judgment + verdict).
const TIER = { scope: 'haiku', review: 'sonnet', verify: 'sonnet', synth: 'opus' }
if (A.tierHint === 'cheap') TIER.review = 'haiku' // shallow pass: drop reviewers to haiku (verify/synth stay as-is)
if (A.tierHint === 'hard') TIER.verify = 'opus' // spend opus on the refutation when correctness is critical

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
const RESERVE = Math.min(40_000, Math.floor(CEIL * 0.2))
// An explicit agent-count cap (a leading bare number like `100`) overrides the token-derived clamp and
// may exceed the soft AGENT_ROOF — bounded only by [AGENT_FLOOR, HARD_LIMIT] so the literal counter stays honest.
const HARD_LIMIT = 950
const explicitMax = typeof A.maxAgents === 'number' && isFinite(A.maxAgents) && A.maxAgents > 0 ? Math.floor(A.maxAgents) : null
const MAX_AGENTS = explicitMax != null
  ? Math.max(AGENT_FLOOR, Math.min(HARD_LIMIT, explicitMax))
  : Math.max(AGENT_FLOOR, Math.min(AGENT_ROOF, Math.floor(SOFT / TOKENS_PER_AGENT)))
const FINDERS = Math.min(8, Math.max(2, Math.ceil(MAX_AGENTS * 0.4)))

// ---- the PRIMARY guard is a literal counter (needs no API, cannot fail) ----
let spawned = 0
// budget.spent() is the SHARED, cumulative turn pool — measure THIS run relative to a baseline.
const startSpent = spentNow()
// An explicit agent cap with NO explicit token cap makes the agent count the SOLE binding limit:
// lift the soft token budget so it can't silently undercut the cap. A hard budget.total (the +N
// directive, enforced by the runtime) still applies; passing a k/m token cap too re-imposes SOFT.
const UNCAP_TOKENS = explicitMax != null && !(typeof A.cap === 'number' && A.cap > 0)
const overBudget = () => (UNCAP_TOKENS ? false : spentNow() - startSpent >= SOFT)
const mustReserve = () => remainingNow() < RESERVE
const canSpawn = () => spawned < MAX_AGENTS && !overBudget()

// ---- resolve the review target into a single, self-describing instruction the finders share ----
// The change can come in four ways; finders have Bash/Read and resolve it themselves.
const SEVERITY_FLOOR = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].includes(A.severityFloor) ? A.severityFloor : 'INFO'
const WANT_FIX = A.fix === true
const BASE = A.baseRef ? String(A.baseRef) : 'main'
let SCOPE_INSTRUCTION
if (A.diff) {
  SCOPE_INSTRUCTION = `Review THIS unified diff (do not go looking for other changes):\n\n${String(A.diff)}`
} else if (A.pr) {
  SCOPE_INSTRUCTION = `Review pull request ${A.pr}. Get the diff yourself with \`gh pr diff ${A.pr}\` and read the touched files for context.`
} else if (Array.isArray(A.paths) && A.paths.length) {
  SCOPE_INSTRUCTION = `Review the code at these paths (a targeted audit of existing code, not a diff):\n${A.paths.map((p) => `- ${p}`).join('\n')}`
} else {
  SCOPE_INSTRUCTION = `Review the current branch's changes vs \`${BASE}\`. Get them yourself with \`git diff ${BASE}...HEAD\` (fall back to \`git diff\` for uncommitted work) and read the touched files for context.`
}
const TARGET_NOTE = A.target ? `\nWhat this change is meant to do (reviewer context): ${A.target}\n` : ''

log(
  `Strata/strata-review: cap=${CEIL} (${candidates.length ? 'set' : 'default'}), MAX_AGENTS=${MAX_AGENTS}${explicitMax != null ? ` (explicit agent cap${UNCAP_TOKENS ? '; token budget lifted' : ''})` : ''}, ` +
    `finders=${FINDERS}, floor=${SEVERITY_FLOOR}, fix=${WANT_FIX}, ` +
    `tiers review=${TIER.review} verify=${TIER.verify} synth=${TIER.synth}`
)

// ---- review dimensions: caller-overridable, else a code-review default set ----
const DEFAULT_DIMS = [
  'correctness (logic errors, off-by-one, wrong conditions, broken invariants, race conditions)',
  'security (injection, auth/authorization gaps, secret leakage, unsafe deserialization, SSRF)',
  'error-handling (unhandled rejections, swallowed errors, missing validation, resource leaks)',
  'performance (N+1, needless allocations, blocking I/O on hot paths, accidental O(n^2))',
  'tests (missing coverage for the change, weak assertions, untested edge/error paths)',
  'maintainability (naming, dead code, duplication, leaky abstractions, convention drift)',
]
const baseDims = Array.isArray(A.dimensions) && A.dimensions.length ? A.dimensions : DEFAULT_DIMS
const DIMS = baseDims.slice(0, FINDERS)

// ---- schemas ----
const SCOPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['files'],
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string' },
          churn: { type: 'string', description: 'rough size of the change, e.g. "+40/-3"' },
          summary: { type: 'string', description: 'one line: what changed here' },
        },
      },
    },
    overview: { type: 'string', description: 'one-paragraph summary of what the changeset does' },
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
          location: { type: 'string', description: 'file:line of the issue (REQUIRED — ground it in the real code)' },
          evidence: { type: 'string', description: 'the quoted code/line(s) that prove the issue' },
          rationale: { type: 'string', description: 'why this is a problem and what it leads to' },
          suggestedFix: { type: 'string', description: 'concrete fix (only when asked); a patch sketch or precise instruction' },
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
    revisedSeverity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'], description: 'corrected severity if the finder mis-rated it' },
  },
}
const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'report'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'comment', 'request-changes'], description: 'approve = nothing blocking; request-changes = >=1 confirmed CRITICAL/HIGH' },
    summary: { type: 'string', maxLength: 1500, description: 'a few sentences: overall health of the change and the headline issues' },
    report: { type: 'string', maxLength: 12000, description: 'the full review, grouped by severity, each item with file:line, the problem, and the fix — do NOT quote the diff or restate finding evidence at length' },
    blocking: { type: 'array', items: { type: 'string' }, description: 'the must-fix items (confirmed CRITICAL/HIGH), each as "file:line — issue"' },
    coverageNote: { type: 'string', maxLength: 2000, description: 'what was NOT reviewed (dimensions/files skipped by the agent budget) — be honest' },
  },
}

// ---- Phase 1: SCOPE — one cheap haiku agent grounds the review in the actual changed files ----
phase('Scope')
let scope = { files: [], overview: '' }
if (canSpawn()) {
  spawned++
  try {
    scope =
      (await agent(
        `Enumerate the changed files in this review target so reviewers know exactly what to scrutinize. Do not review yet — just list the touched files with a one-line summary each, and a short overview of what the change does.\n${TARGET_NOTE}\n${SCOPE_INSTRUCTION}`,
        { label: 'scope', phase: 'Scope', model: TIER.scope, schema: SCOPE_SCHEMA }
      )) || scope
  } catch (e) {
    scope = { files: [], overview: '' }
  }
}
const fileList = (scope.files || []).map((f) => f.path).filter(Boolean)
const SCOPE_BLOCK =
  (scope.overview ? `\nCHANGE OVERVIEW:\n${scope.overview}\n` : '') +
  (fileList.length ? `\nFILES IN SCOPE (review only these):\n${fileList.map((p) => `- ${p}`).join('\n')}\n` : '')

// ---- Phase 2: REVIEW — one sonnet reviewer per dimension, each grounded in file:line ----
phase('Review')
const fixClause = WANT_FIX
  ? ' For every finding, include a concrete suggestedFix (a patch sketch or precise instruction).'
  : ''
const found = await pipeline(DIMS, (dim) => {
  if (!canSpawn()) {
    log(`review: gate hit at ${spawned}/${MAX_AGENTS}, skipping "${dim}"`)
    return { findings: [] }
  }
  spawned++
  return agent(
    `You are a senior reviewer examining a code change through ONE lens only: "${dim}". Ignore issues outside this lens — another reviewer covers those.\n${TARGET_NOTE}${SCOPE_BLOCK}\n${SCOPE_INSTRUCTION}\n\n` +
      `Read the actual changed code. Report only concrete, real issues — each MUST cite file:line in location and quote the offending code in evidence. Do not invent issues to fill a quota; an empty findings list is a valid result for a clean change.${fixClause}`,
    { label: `review:${dim.split(' ')[0]}`, phase: 'Review', model: TIER.review, schema: FINDINGS_SCHEMA }
  )
})

// ---- DEDUP (the barrier-justified step): N dimension-reviewers overlap; collapse same-site findings
//      BEFORE spending verify agents, keeping the highest severity and merging rationale provenance. ----
const RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 }
const FLOOR_RANK = RANK[SEVERITY_FLOOR]
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
// Dedup on the FULL file:line (not just the file): two distinct bugs at different lines must NOT
// collapse merely because their titles look alike. With full-location keying, raisedBy>1 genuinely
// means "the same site flagged by N independent lenses" — a real corroboration signal.
// full title (not a prefix): two distinct issues at the SAME line with a shared title prefix must not collide
const siteKey = (it) => `${norm(it.location)}::${norm(it.title)}`
const dedupMap = new Map()
found
  .filter(Boolean)
  .flatMap((f) => (f && f.findings ? f.findings : []))
  .filter((it) => it && it.title && it.location)
  // Honor the severity floor before spending verify, but NEVER silently drop an unrecognized severity:
  // a real finding could carry an off-enum label, so unknown-severity items pass through to verify.
  .filter((it) => RANK[it.severity] === undefined || RANK[it.severity] <= FLOOR_RANK)
  .forEach((it) => {
    const k = siteKey(it)
    const prev = dedupMap.get(k)
    if (!prev) {
      dedupMap.set(k, { ...it, raisedBy: 1 })
    } else {
      // keep the more severe rating; record that multiple lenses flagged the same site (corroboration signal)
      const keepSeverer = (RANK[it.severity] ?? 9) < (RANK[prev.severity] ?? 9)
      dedupMap.set(k, {
        ...prev,
        severity: keepSeverer ? it.severity : prev.severity,
        evidence: prev.evidence || it.evidence,
        rationale: prev.rationale || it.rationale,
        suggestedFix: prev.suggestedFix || it.suggestedFix,
        raisedBy: prev.raisedBy + 1,
      })
    }
  })
const items = [...dedupMap.values()].sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9))
log(`review: ${items.length} distinct findings after dedup (from ${found.filter(Boolean).reduce((n, f) => n + ((f.findings || []).length), 0)} raw)`)

// ---- Phase 3: VERIFY — severity-gated adversarial REFUTE (2 votes for CRITICAL/HIGH, else 1) ----
phase('Verify')
const verified = []
for (const it of items) {
  if (!canSpawn() || mustReserve()) {
    verified.push({ ...it, confirmed: true, note: 'budget-skip-verify' })
    continue
  }
  const votes = it.severity === 'CRITICAL' || it.severity === 'HIGH' ? 2 : 1
  const thunks = []
  for (let v = 0; v < votes; v++) {
    if (!canSpawn() || mustReserve()) break // recheck the reserve per vote, not just at the block start
    spawned++
    thunks.push(() =>
      agent(
        `Try to REFUTE this review finding. Re-read the cited code at ${it.location} and decide whether it is a REAL issue or a false positive. Be skeptical — a finding survives only if the evidence clearly supports it; default isReal=false when uncertain. If the severity is mis-rated, set revisedSeverity.\n\nFINDING:\n${JSON.stringify({ title: it.title, severity: it.severity, location: it.location, evidence: it.evidence, rationale: it.rationale })}`,
        { label: `verify:${String(it.title).slice(0, 28)}`, phase: 'Verify', model: TIER.verify, schema: VERDICT_SCHEMA }
      )
    )
  }
  const ballots = (await parallel(thunks)).filter(Boolean)
  // Fail OPEN on a missing OR partial ballot: if we could not cast the full vote count, the budget
  // truncated us — do NOT let a lone adversarial vote reject a finding the 2-vote rule exists to protect.
  if (ballots.length < votes) {
    verified.push({ ...it, confirmed: true, note: ballots.length === 0 ? 'budget-skip-verify' : 'budget-partial-verify' })
    continue
  }
  const real = ballots.filter((r) => r.isReal).length
  // adopt a corrected severity if a majority of refuters agree on one
  const revisions = ballots.map((r) => r.revisedSeverity).filter(Boolean)
  const revised = revisions.length && revisions.every((s) => s === revisions[0]) ? revisions[0] : it.severity
  // quorum is against the INTENDED vote count, so a full 2-vote CRITICAL needs a real majority to drop
  verified.push({ ...it, severity: revised, confirmed: real >= Math.ceil(votes / 2) })
}

// ---- Phase 4: SYNTHESIZE — the ONE opus stage: rank confirmed findings, write the report, issue a verdict ----
phase('Synthesize')
const confirmed = verified.filter((f) => f.confirmed).sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9))
const blockingCount = confirmed.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH').length
spawned++ // the synthesis agent always runs
let synthesis
try {
  synthesis = await agent(
    `You are the lead reviewer writing the final verdict on a code change.\n${TARGET_NOTE}` +
      (scope.overview ? `\nCHANGE OVERVIEW:\n${scope.overview}\n` : '') +
      `\nCONFIRMED FINDINGS (post adversarial verification, sorted by severity; \`raisedBy\` > 1 means multiple independent reviewers flagged the same site — strong signal):\n${JSON.stringify(confirmed, null, 2)}\n\n` +
      `Write the review:\n` +
      `- verdict: "request-changes" if any CRITICAL/HIGH is confirmed (${blockingCount} present), else "comment" if there are MEDIUM/LOW items worth raising, else "approve".\n` +
      `- report: group findings by severity; for each give file:line, the problem in one or two sentences, and the fix.\n` +
      `- blocking: list only the must-fix (CRITICAL/HIGH) items.\n` +
      `- coverageNote: state honestly what was NOT reviewed (dimensions or files skipped by the agent budget).\n` +
      `Do not pad the report with non-issues. If the change is clean, say so plainly.`,
    { label: 'synthesize', phase: 'Synthesize', model: TIER.synth, schema: SYNTH_SCHEMA }
  )
  // agent() can resolve to null (e.g. the run is skipped) WITHOUT throwing — route that into the
  // fail-open below instead of letting `synthesis.verdict` throw an uncaught TypeError later.
  if (!synthesis) throw new Error('synthesis agent returned null')
} catch (e) {
  // fail open: derive a verdict mechanically so the run still yields an actionable result
  synthesis = {
    verdict: blockingCount > 0 ? 'request-changes' : confirmed.length ? 'comment' : 'approve',
    summary: 'Synthesis stage truncated by budget; returning mechanically-derived verdict over the confirmed findings.',
    report: confirmed.map((f) => `[${f.severity}] ${f.location} — ${f.title}: ${f.rationale || f.evidence}`).join('\n') || 'No confirmed issues.',
    blocking: confirmed.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH').map((f) => `${f.location} — ${f.title}`),
    coverageNote: `synthesis truncated (${String(e && e.message ? e.message : e)})`,
  }
}

log(
  `done: ${spawned} agents, ${confirmed.length} confirmed (${blockingCount} blocking), ` +
    `verdict=${synthesis.verdict}, ~${Math.max(0, spentNow() - startSpent)} output tokens this run`
)
return {
  target: A.target || SCOPE_INSTRUCTION.slice(0, 80),
  cap: CEIL,
  capWasSet: candidates.length > 0,
  agentsSpawned: spawned,
  maxAgents: MAX_AGENTS,
  dimensionsReviewed: DIMS.length,
  filesInScope: fileList,
  confirmedCount: confirmed.length,
  blockingCount,
  verdict: synthesis.verdict,
  findings: confirmed,
  synthesis,
}
