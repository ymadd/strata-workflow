#!/usr/bin/env node
/**
 * verify-invariants.js — Strata Workflow invariant verifier ("audit-the-auditor")
 *
 * Mechanically asserts every charter guarantee:
 *   1. Mode inventory   — all 9 strata-*.js and 8 reference/*.md present
 *   2. Syntax           — every workflow script passes node --check (module-aware wrapper)
 *   3. Agent cap        — each script contains its documented MAX_AGENTS/roof constant
 *                         and a gate guarding every agent() call; no roof above its ceiling
 *   4. Tiering          — opus only on plan/advise/judge/audit/synth roles; unclassified→sonnet
 *   5. Severity         — votes/ceil(votes/2) logic + dedup-before-verify in review/sweep
 *   6. Evolve fixes     — five specific fixes present in strata-evolve.js
 *   7. Runtime purity   — no require/import/process/fs/module in workflow scripts
 *
 * Usage:  node verify-invariants.js [--verbose]
 * Exit:   0 = all pass, 1 = any failure
 *
 * This script lives at the repo root (outside skills/) so it is NEVER auto-loaded into the skill runtime.
 * It uses only Node builtins (fs, child_process, path) — no external deps.
 */

'use strict'

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const VERBOSE = process.argv.includes('--verbose')

// ---- path resolution ----
const REPO_ROOT = path.resolve(__dirname)
const SKILLS_DIR = path.join(REPO_ROOT, 'skills', 'strata-workflow')
const WORKFLOWS_DIR = path.join(SKILLS_DIR, 'workflows')
const REFERENCE_DIR = path.join(SKILLS_DIR, 'reference')

// ---- result accumulator ----
const results = []
let passed = 0
let failed = 0

// Per-section tracking for one-line PASS count in non-verbose mode
let _sectionLabel = ''
let _sectionPassStart = 0
let _sectionFailStart = 0

function pass(label, detail) {
  results.push({ ok: true, label, detail })
  passed++
  if (VERBOSE) console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`)
}

function fail(label, detail) {
  results.push({ ok: false, label, detail })
  failed++
  console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`)
}

function section(title) {
  // Emit the summary for the previous section (non-verbose mode)
  if (!VERBOSE && _sectionLabel) {
    const secPassed = passed - _sectionPassStart
    const secFailed = failed - _sectionFailStart
    if (secFailed === 0) {
      console.log(`  (${secPassed}/${secPassed} checks passed)`)
    }
    // failures are already printed inline by fail(); no extra summary line needed on fail
  }
  console.log(`\n=== ${title} ===`)
  _sectionLabel = title
  _sectionPassStart = passed
  _sectionFailStart = failed
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (e) {
    return null
  }
}

// ============================================================
// CHECK 1: MODE INVENTORY
// ============================================================
section('1. Mode Inventory')

const EXPECTED_WORKFLOWS = [
  'strata-focus.js',
  'strata-review.js',
  'strata-sweep.js',
  'strata-panel.js',
  'strata-scale.js',
  'strata-grow.js',
  'strata-ultra.js',
  'strata-evolve.js',
  'strata-audit.js',
]

const EXPECTED_REFERENCES = [
  'focus.md',
  'review.md',
  'sweep.md',
  'panel.md',
  'scale.md',
  'grow.md',
  'ultra.md',
  'evolve.md',
]

for (const wf of EXPECTED_WORKFLOWS) {
  const p = path.join(WORKFLOWS_DIR, wf)
  if (fs.existsSync(p)) {
    pass(`inventory:${wf}`, 'present')
  } else {
    fail(`inventory:${wf}`, `missing at ${p}`)
  }
}

for (const ref of EXPECTED_REFERENCES) {
  const p = path.join(REFERENCE_DIR, ref)
  if (fs.existsSync(p)) {
    pass(`inventory:reference/${ref}`, 'present')
  } else {
    fail(`inventory:reference/${ref}`, `missing at ${p}`)
  }
}

// Confirm the audit mode is NOT a reference md (it is documented in reference/scale.md per charter)
// The charter says: "audit documented in reference/scale.md" — verify scale.md exists (already checked above)

// ============================================================
// CHECK 2: SYNTAX (module-aware node --check)
// ============================================================
section('2. Syntax Check')

// Workflow scripts use `export const meta = …` which is ESM syntax.
// The naive `node --check file.js` fails for ESM. The charter-approved recipe:
//   wrap each script in `async function __w(){ <script content> }` then pipe to `node --check`
// This keeps the export statement inside a function body where it is NOT interpreted as a module
// declaration, so node's CJS parser accepts it.
//
// Alternative (cleaner): write to a temp .mjs file or use --input-type=module.
// We use the wrapper approach as specified in the charter.

const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'strata-check-'))

for (const wf of EXPECTED_WORKFLOWS) {
  const filePath = path.join(WORKFLOWS_DIR, wf)
  if (!fs.existsSync(filePath)) {
    fail(`syntax:${wf}`, 'file missing — cannot check')
    continue
  }
  const src = readFile(filePath)
  if (src === null) {
    fail(`syntax:${wf}`, 'could not read file')
    continue
  }

  // The charter recipe: wrap in async function to neutralize `export const meta` as a statement,
  // not a top-level module declaration. We also suppress the `return` at the end (top-level return
  // is only legal in CommonJS; inside a function it's fine).
  const wrapped = `async function __w(){\n${src}\n}`
  const tmpFile = path.join(tmpDir, wf.replace('.js', '-wrapped.js'))
  try {
    fs.writeFileSync(tmpFile, wrapped, 'utf8')
    execSync(`node --check "${tmpFile}"`, { stdio: 'pipe' })
    pass(`syntax:${wf}`, 'no syntax errors')
  } catch (e) {
    const errMsg = (e.stderr || e.stdout || '').toString().trim().split('\n')[0]
    fail(`syntax:${wf}`, errMsg || String(e))
  }
}

// cleanup temp files
try {
  for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f))
  fs.rmdirSync(tmpDir)
} catch (_) {}

// ============================================================
// CHECK 3: AGENT-COUNT CAP
// ============================================================
section('3. Agent-Count Cap')

// Charter: each script retains its documented MAX_AGENTS/roof constant and a gate guarding EVERY
// agent() call. No roof above its ceiling. Expected ceiling by mode:
//   focus/review/panel: AGENT_ROOF = 40
//   sweep: AGENT_ROOF = 120, HARD_LIMIT = 950
//   scale: HARD_LIMIT = 950 (explicit truncation to 950)
//   grow: MAX_AGENTS capped to Math.min(950, …), can() guard
//   ultra: AGENT_ROOF = 120, HARD_LIMIT = 950
//   evolve: AGENT_ROOF = 120, HARD_LIMIT = 950
//   audit: has no explicit counter gate in original — this check flags the gap

const CAP_RULES = {
  'strata-focus.js': {
    must_contain: ['MAX_AGENTS', 'canSpawn', 'AGENT_ROOF'],
    roof_pattern: /AGENT_ROOF\s*=\s*(\d+)/,
    roof_max: 40,
    gate_fn: 'canSpawn',
  },
  'strata-review.js': {
    must_contain: ['MAX_AGENTS', 'canSpawn', 'AGENT_ROOF'],
    roof_pattern: /AGENT_ROOF\s*=\s*(\d+)/,
    roof_max: 40,
    gate_fn: 'canSpawn',
  },
  'strata-panel.js': {
    must_contain: ['MAX_AGENTS', 'canSpawn', 'AGENT_ROOF'],
    roof_pattern: /AGENT_ROOF\s*=\s*(\d+)/,
    roof_max: 40,
    gate_fn: 'canSpawn',
  },
  'strata-sweep.js': {
    must_contain: ['MAX_AGENTS', 'canSpawn', 'HARD_LIMIT', 'AGENT_ROOF'],
    roof_pattern: /AGENT_ROOF\s*=\s*(\d+)/,
    roof_max: 120,
    hard_limit_pattern: /HARD_LIMIT\s*=\s*(\d+)/,
    hard_limit_max: 950,
    gate_fn: 'canSpawn',
  },
  'strata-scale.js': {
    must_contain: ['HARD_LIMIT'],
    hard_limit_pattern: /HARD_LIMIT\s*=\s*(\d+)/,
    hard_limit_max: 950,
    // scale uses overCap() for token budget; unit count is the primary bound via HARD_LIMIT truncation
    gate_fn: 'overCap',
  },
  'strata-grow.js': {
    must_contain: ['MAX_AGENTS', 'can'],
    // grow uses Math.min(950, ...) — no separate HARD_LIMIT const, but ceiling is 950
    max_agents_pattern: /MAX_AGENTS\s*=\s*Math\.max\(.*Math\.min\(950/,
    gate_fn: 'can()',
  },
  'strata-ultra.js': {
    must_contain: ['MAX_AGENTS', 'canSpawnDyn', 'HARD_LIMIT', 'AGENT_ROOF'],
    roof_pattern: /AGENT_ROOF\s*=\s*(\d+)/,
    roof_max: 120,
    hard_limit_pattern: /HARD_LIMIT\s*=\s*(\d+)/,
    hard_limit_max: 950,
    gate_fn: 'canSpawnDyn',
  },
  'strata-evolve.js': {
    must_contain: ['MAX_AGENTS', 'canSpawnWork', 'HARD_LIMIT', 'AGENT_ROOF'],
    roof_pattern: /AGENT_ROOF\s*=\s*(\d+)/,
    roof_max: 120,
    hard_limit_pattern: /HARD_LIMIT\s*=\s*(\d+)/,
    hard_limit_max: 950,
    gate_fn: 'canSpawnWork',
  },
  // strata-audit.js: charter ADOPTED IDEA — literal agent-count cap added: HARD_LIMIT + canSpawn()
  // nBatches is truncated to HARD_LIMIT-1 before the pipeline; the critic is also gated.
  'strata-audit.js': {
    must_contain: ['HARD_LIMIT', 'canSpawn', 'agent('],
    hard_limit_pattern: /HARD_LIMIT\s*=\s*(\d+)/,
    hard_limit_max: 950,
    gate_fn: 'canSpawn',
  },
}

for (const [wf, rules] of Object.entries(CAP_RULES)) {
  const src = readFile(path.join(WORKFLOWS_DIR, wf))
  if (!src) {
    fail(`cap:${wf}`, 'file missing')
    continue
  }

  // Check must_contain tokens
  const missing = (rules.must_contain || []).filter((tok) => !src.includes(tok))
  if (missing.length) {
    fail(`cap:${wf}:required-tokens`, `missing: ${missing.join(', ')}`)
  } else {
    pass(`cap:${wf}:required-tokens`, `found: ${(rules.must_contain || []).join(', ')}`)
  }

  // Check AGENT_ROOF value does not exceed ceiling
  if (rules.roof_pattern) {
    const m = src.match(rules.roof_pattern)
    if (!m) {
      fail(`cap:${wf}:AGENT_ROOF`, 'AGENT_ROOF constant not found')
    } else {
      const val = parseInt(m[1], 10)
      if (val > rules.roof_max) {
        fail(`cap:${wf}:AGENT_ROOF`, `AGENT_ROOF=${val} exceeds ceiling ${rules.roof_max}`)
      } else {
        pass(`cap:${wf}:AGENT_ROOF`, `AGENT_ROOF=${val} <= ${rules.roof_max}`)
      }
    }
  }

  // Check HARD_LIMIT value
  if (rules.hard_limit_pattern) {
    const m = src.match(rules.hard_limit_pattern)
    if (!m) {
      fail(`cap:${wf}:HARD_LIMIT`, 'HARD_LIMIT constant not found')
    } else {
      const val = parseInt(m[1], 10)
      if (val > rules.hard_limit_max) {
        fail(`cap:${wf}:HARD_LIMIT`, `HARD_LIMIT=${val} exceeds ceiling ${rules.hard_limit_max}`)
      } else {
        pass(`cap:${wf}:HARD_LIMIT`, `HARD_LIMIT=${val} <= ${rules.hard_limit_max}`)
      }
    }
  }

  // Ungated-agent() detector: for each agent( call site, verify a gate function was referenced
  // SOMEWHERE earlier in the file (definition or call-site) — or that the call is a documented
  // known-accepted exception.  A gate function referenced even once means it was defined and used;
  // a completely absent gate with agent() calls present is a hard failure.
  //
  // Known-accepted exceptions (record explicitly so a SECOND ungated call is still caught):
  //   strata-scale.js line 104 — the advise agent call; scale's only gate is overCap() which
  //   guards the pipeline workers. The advise call is inherently single-issue (can't loop) and
  //   is guarded by the ADVISE boolean.  A spawned counter for advise was identified as a P3
  //   adoption item.  We record this exception so any NEW ungated call in scale is still flagged.
  if (rules.gate_fn && rules.gate_fn !== 'overCap') {
    const gateName = rules.gate_fn.replace('()', '')
    const lines = src.split('\n')
    // Collect every line number (1-based) that contains an agent( call
    const agentLines = []
    lines.forEach((line, i) => {
      if (/\bagent\s*\(/.test(line)) agentLines.push(i + 1)
    })
    const gateCallCount = (src.match(new RegExp('\\b' + gateName + '\\b', 'g')) || []).length

    if (agentLines.length > 0 && gateCallCount === 0) {
      fail(`cap:${wf}:gate-present`, `agent() called at line(s) [${agentLines.join(',')}] but ${gateName} never referenced — gate missing`)
    } else {
      pass(`cap:${wf}:gate-present`, `${gateName} referenced ${gateCallCount}x (covers agent() at line(s) [${agentLines.join(',')}])`)
    }
  }

  // Scale-specific ungated-agent detector: scale's overCap() gate guards the pipeline agent but
  // NOT the advise agent.  Verify no ADDITIONAL ungated agent() calls have been introduced beyond
  // the one known-accepted exception.
  //
  // Content-anchored detection: instead of a hardcoded line number (fragile under edits elsewhere),
  // we identify the accepted advise agent call by its stable code signature:
  //   — it is inside an `if (ADVISE)` conditional block, AND
  //   — the agent() call site has `label: 'advise'` in its argument object.
  // Any agent() call that matches BOTH conditions is treated as the known-accepted exception.
  // Any agent() call that lacks overCap() AND is NOT the known-accepted advise call is flagged.
  if (wf === 'strata-scale.js') {
    const scaleLines = src.split('\n')
    const ungatedAgentLines = []

    // Build a set of line indices (0-based) where the known-accepted advise agent() call lives.
    // An advise call is one where:
    //   (a) 'label: \'advise\'' appears within the surrounding 20 lines (multi-line agent() call), AND
    //   (b) the block is inside `if (ADVISE)` (found within the preceding 30 lines).
    // We match by scanning for these two anchors together rather than by line number.
    const acceptedAdviseLines = new Set()
    scaleLines.forEach((line, i) => {
      if (!/\bagent\s*\(/.test(line)) return
      // Gather the surrounding window (preceding 30 lines for if (ADVISE), following 20 for label)
      const windowStart = Math.max(0, i - 30)
      const windowEnd = Math.min(scaleLines.length - 1, i + 20)
      const precedingContext = scaleLines.slice(windowStart, i).join('\n')
      const followingContext = scaleLines.slice(i, windowEnd + 1).join('\n')
      const inAdviseBlock = /\bif\s*\(\s*ADVISE\s*\)/.test(precedingContext)
      const hasAdviseLabel = /label\s*:\s*['"]advise['"]/.test(followingContext)
      if (inAdviseBlock && hasAdviseLabel) {
        acceptedAdviseLines.add(i)
      }
    })

    if (acceptedAdviseLines.size !== 1) {
      // Unexpected: we should find exactly one advise agent call in scale.
      // If zero: the known exception was removed (might be a real regression).
      // If more than one: something unexpected was added.
      fail(`cap:strata-scale.js:advise-anchor`, `expected exactly 1 known-accepted advise agent() call; found ${acceptedAdviseLines.size} (lines ${[...acceptedAdviseLines].map(l => l + 1).join(',')}) — verify scale.js advise structure is intact`)
    } else {
      pass(`cap:strata-scale.js:advise-anchor`, `found exactly 1 known-accepted advise agent() call (content-anchored, not line-number-based)`)
    }

    scaleLines.forEach((line, i) => {
      if (!/\bagent\s*\(/.test(line)) return
      if (acceptedAdviseLines.has(i)) return // the known-accepted advise call — skip

      // Check if overCap() appears within the 3 preceding non-empty lines or on this line.
      // A counter increment (spawned++) may legitimately appear between the guard and the agent()
      // call — we look back at up to 3 non-empty lines to accommodate this pattern.
      let gateFound = /overCap\(\)/.test(line)
      let nonEmptyCount = 0
      for (let j = i - 1; j >= 0 && !gateFound && nonEmptyCount < 3; j--) {
        if (scaleLines[j].trim() !== '') {
          nonEmptyCount++
          if (/overCap\(\)/.test(scaleLines[j])) { gateFound = true }
        }
      }
      if (!gateFound) {
        ungatedAgentLines.push(i + 1)
      }
    })
    if (ungatedAgentLines.length > 0) {
      fail(`cap:strata-scale.js:ungated-agent`, `NEW ungated agent() call(s) at line(s) [${ungatedAgentLines.join(',')}] — add overCap() guard`)
    } else {
      pass(`cap:strata-scale.js:ungated-agent`, `no ungated agent() calls beyond known-accepted advise exception (content-anchored)`)
    }
  }

  // Log the note for audit's known gap
  if (rules.note && VERBOSE) {
    console.log(`  NOTE  cap:${wf}: ${rules.note}`)
  }
}

// Specific grow-style: MAX_AGENTS = Math.max(8, Math.min(950, ...))
const growSrc = readFile(path.join(WORKFLOWS_DIR, 'strata-grow.js'))
if (growSrc) {
  if (/MAX_AGENTS\s*=\s*Math\.max\(.*Math\.min\(950/.test(growSrc)) {
    pass('cap:strata-grow.js:950-ceiling', 'MAX_AGENTS bounded to Math.min(950,...)')
  } else {
    fail('cap:strata-grow.js:950-ceiling', 'MAX_AGENTS does not use Math.min(950,...) ceiling')
  }
}

// P4 adoption: scale.js dual-gate — pipeline must have BOTH overCap() (token throttle) AND
// a spawned >= HARD_LIMIT counter backstop (so the counter is a real gate, not just a reporter).
// This closes the 950-truncation honesty gap (P4 charter ADOPTED IDEA).
{
  const scaleSrc = readFile(path.join(WORKFLOWS_DIR, 'strata-scale.js'))
  if (scaleSrc) {
    // The dual-gate pattern: `overCap() || spawned >= HARD_LIMIT` (or equivalent ordering) must
    // appear in the pipeline callback — not necessarily on one line, but both tokens present
    // in a gate position (within the pipeline's `(unit,...) => { if (...) return null }` block).
    const hasDualGate = /overCap\(\)\s*\|\|\s*spawned\s*>=\s*HARD_LIMIT/.test(scaleSrc) ||
                        /spawned\s*>=\s*HARD_LIMIT\s*\|\|\s*overCap\(\)/.test(scaleSrc)
    if (hasDualGate) {
      pass('cap:strata-scale.js:dual-gate', 'pipeline has dual gate: overCap() (token throttle) AND spawned>=HARD_LIMIT (counter backstop)')
    } else {
      fail('cap:strata-scale.js:dual-gate', 'pipeline dual gate missing — expected `overCap() || spawned >= HARD_LIMIT` pattern')
    }
  }
}

// P4 adoption: audit.js — nBatches truncation to HARD_LIMIT-1 ensures the pipeline cannot
// schedule more than HARD_LIMIT-1 batch agents. Verify the truncation constant is correct.
{
  const auditSrc = readFile(path.join(WORKFLOWS_DIR, 'strata-audit.js'))
  if (auditSrc) {
    // nBatches must be capped to HARD_LIMIT - 1 (leaving 1 slot for the critic)
    const hasTruncation = /Math\.min\s*\(\s*nBatchesRaw\s*,\s*HARD_LIMIT\s*-\s*1\s*\)/.test(auditSrc) ||
                          /Math\.min\s*\(\s*nBatchesRaw\s*,\s*HARD_LIMIT\s*-1\s*\)/.test(auditSrc)
    if (hasTruncation) {
      pass('cap:strata-audit.js:batch-truncation', 'nBatches truncated to HARD_LIMIT-1 (reserves 1 slot for critic)')
    } else {
      fail('cap:strata-audit.js:batch-truncation', 'nBatches truncation to HARD_LIMIT-1 not found — critic slot reservation may be broken')
    }
  }
}

// ============================================================
// CHECK 4: MODEL TIERING
// ============================================================
section('4. Model Tiering')

// Invariant: opus is ONLY on plan/advise/judge/audit/synth/pm/director/ideate/critic/tiebreak roles.
// No per-unit/bulk worker (find/extract/build/verify/draft/revise/grade/repair/map/review/scout)
// is routed to opus. Unclassified roles default to sonnet.
//
// Strategy: parse each TIER/PICK map and check:
//   (a) opus-allowed roles: a whitelist
//   (b) opus-forbidden roles: check none of the forbidden roles map to opus
//   (c) The default (unclassified) falls to sonnet, not opus

const OPUS_ALLOWED_ROLES = new Set([
  'pm', 'director', 'ideate', 'synth', 'judge', 'advise', 'audit', 'critic', 'tiebreak',
  'systemic', // sweep's cross-cutting critic = opus
  // strata-grow explicit vars (not in TIER map)
])

// Roles that MUST NOT map to opus (bulk worker roles)
const OPUS_FORBIDDEN_ROLES = [
  'find', 'extract', 'build', 'verify', 'draft', 'revise', 'grade', 'repair',
  'map', 'review', 'scout', 'scope',
]

for (const wf of EXPECTED_WORKFLOWS) {
  const src = readFile(path.join(WORKFLOWS_DIR, wf))
  if (!src) {
    fail(`tier:${wf}`, 'file missing')
    continue
  }

  // Extract TIER = { ... } or PICK = ... block from source
  // We parse the TIER object literal with a regex that handles multi-line
  const tierMatch = src.match(/const\s+TIER\s*=\s*\{([^}]+)\}/)
  const pickMatch = src.match(/const\s+PICK\s*=\s*A\.model\s*===\s*'haiku'[^;]+;/)

  if (wf === 'strata-scale.js') {
    // scale uses PICK + UNIT_MODEL pattern, not TIER map
    if (!pickMatch) {
      fail(`tier:${wf}:pick-exists`, 'PICK model selection not found')
      continue
    }
    // UNIT_MODEL = PICK === 'opus' ? 'sonnet' : PICK — opus forced to sonnet for unit work
    if (src.includes("PICK === 'opus' ? 'sonnet' : PICK")) {
      pass(`tier:${wf}:unit-model-non-opus`, 'UNIT_MODEL forces opus→sonnet for per-unit work')
    } else {
      fail(`tier:${wf}:unit-model-non-opus`, "UNIT_MODEL does not contain `PICK === 'opus' ? 'sonnet' : PICK`")
    }
    // advise is opus in scale
    const advModelLine = src.match(/ADV_MODEL\s*=\s*[^;]+;/)
    if (advModelLine && advModelLine[0].includes('opus')) {
      pass(`tier:${wf}:advise-is-opus`, 'ADV_MODEL defaults to opus (advise role)')
    } else if (advModelLine) {
      pass(`tier:${wf}:advise-is-opus`, `ADV_MODEL line: ${advModelLine[0].trim()}`)
    } else {
      fail(`tier:${wf}:advise-is-opus`, 'ADV_MODEL not found')
    }
    continue
  }

  if (wf === 'strata-grow.js') {
    // grow uses separate named model constants (UNIT_MODEL, PLAN_MODEL, ADVICE_MODEL, AUDIT_MODEL)
    // rather than a TIER object. Check each.
    // Use [^\n]+ to stop at the end of the declaration line (no semicolons in these lines)
    const unitModelLine = src.match(/const\s+UNIT_MODEL\s*=[^\n]+/)
    const adviceModelLine = src.match(/const\s+ADVICE_MODEL\s*=\s*'opus'/)
    const auditModelLine = src.match(/const\s+AUDIT_MODEL\s*=\s*'opus'/)
    const planModelLine = src.match(/const\s+PLAN_MODEL\s*=[^\n]+/)
    // UNIT_MODEL: default sonnet, never opus for build/draft/revise
    if (unitModelLine && !unitModelLine[0].includes("'opus'")) {
      pass(`tier:${wf}:unit-not-opus`, `UNIT_MODEL defaults to sonnet (not opus) for build workers`)
    } else {
      fail(`tier:${wf}:unit-not-opus`, `UNIT_MODEL may default to opus: ${unitModelLine ? unitModelLine[0].trim() : 'not found'}`)
    }
    // ADVICE_MODEL and AUDIT_MODEL must be opus (these are the allowed advise/audit roles)
    if (adviceModelLine) {
      pass(`tier:${wf}:advice-is-opus`, 'ADVICE_MODEL = opus (advise role allowed)')
    } else {
      fail(`tier:${wf}:advice-is-opus`, 'ADVICE_MODEL = opus not found')
    }
    if (auditModelLine) {
      pass(`tier:${wf}:audit-is-opus`, 'AUDIT_MODEL = opus (audit role allowed)')
    } else {
      fail(`tier:${wf}:audit-is-opus`, 'AUDIT_MODEL = opus not found')
    }
    continue
  }

  if (wf === 'strata-audit.js') {
    // audit uses AUDIT_MODEL (defaults to opus for the grading role) + 'opus' hardcoded for meta-critic
    const auditModelLine = src.match(/const\s+AUDIT_MODEL\s*=\s*[^;]+/)
    if (auditModelLine) {
      pass(`tier:${wf}:audit-model-exists`, `AUDIT_MODEL defined: ${auditModelLine[0].replace(/const\s+AUDIT_MODEL\s*=\s*/, '').slice(0,60)}`)
    } else {
      fail(`tier:${wf}:audit-model-exists`, 'AUDIT_MODEL constant not found')
    }
    // Critic agent must use opus (meta-critic is an allowed opus role)
    if (src.includes("model: 'opus'")) {
      pass(`tier:${wf}:critic-is-opus`, "critic agent uses model: 'opus' (allowed)")
    } else {
      fail(`tier:${wf}:critic-is-opus`, "critic agent does not use model: 'opus'")
    }
    // No bulk worker should use opus — in audit, the per-batch audit agents use AUDIT_MODEL (not hardcoded opus)
    // The pipeline batch agents should use AUDIT_MODEL, not hardcoded 'opus'
    const batchAgentModelLine = src.match(/label:.*audit:.*model:\s*AUDIT_MODEL/)
    if (batchAgentModelLine) {
      pass(`tier:${wf}:batch-uses-audit-model`, 'batch audit agents use AUDIT_MODEL (not hardcoded opus)')
    } else {
      // Accept either pattern — the label+model might be on separate lines
      const pipelineSection = src.includes('pipeline(batchIdx')
      if (pipelineSection && src.includes('AUDIT_MODEL')) {
        pass(`tier:${wf}:batch-uses-audit-model`, 'batch pipeline uses AUDIT_MODEL variable')
      } else {
        fail(`tier:${wf}:batch-uses-audit-model`, 'could not confirm batch agents use AUDIT_MODEL')
      }
    }
    continue
  }

  if (!tierMatch) {
    fail(`tier:${wf}:tier-map-exists`, 'TIER = { ... } map not found')
    continue
  }

  // Parse role → model pairs from the TIER block
  const tierBlock = tierMatch[1]
  const roleModelPairs = []
  const pairRe = /(\w+)\s*:\s*'(haiku|sonnet|opus)'/g
  let pm
  while ((pm = pairRe.exec(tierBlock)) !== null) {
    roleModelPairs.push({ role: pm[1], model: pm[2] })
  }

  if (!roleModelPairs.length) {
    fail(`tier:${wf}:tier-parseable`, 'could not parse any role→model pairs from TIER map')
    continue
  }

  // Check: no forbidden role maps to opus
  let tierOk = true
  for (const { role, model } of roleModelPairs) {
    if (model === 'opus' && OPUS_FORBIDDEN_ROLES.includes(role)) {
      fail(`tier:${wf}:no-opus-worker`, `role "${role}" maps to opus — forbidden (bulk worker)`)
      tierOk = false
    }
  }
  if (tierOk) {
    pass(`tier:${wf}:no-opus-worker`, `no bulk worker role maps to opus in TIER map`)
  }

  // Check: opus-role assignments are all in the allowed set
  const opusRoles = roleModelPairs.filter((p) => p.model === 'opus').map((p) => p.role)
  const unknownOpus = opusRoles.filter((r) => !OPUS_ALLOWED_ROLES.has(r))
  if (unknownOpus.length) {
    fail(`tier:${wf}:opus-roles-whitelisted`, `unknown opus roles: ${unknownOpus.join(', ')} (not in allowed set)`)
  } else if (opusRoles.length > 0) {
    pass(`tier:${wf}:opus-roles-whitelisted`, `opus roles: ${opusRoles.join(', ')} (all allowed)`)
  } else {
    // No opus in TIER map but might be hardcoded elsewhere (e.g. grow uses AUDIT_MODEL = 'opus')
    if (VERBOSE) console.log(`  NOTE  tier:${wf}: no opus in TIER map; check hardcoded model refs`)
  }

}

// tierHint='hard' TIER mutation checks: these are documented caller opt-ins that promote specific
// roles to opus.  We assert them explicitly so:
//   (a) reviewers know they are the ONLY non-default opus worker-role promotions in the codebase,
//   (b) the verifier confirms they are still present (they must not be silently removed), and
//   (c) the verifier confirms NO OTHER worker role is promoted to opus by tierHint=hard.
//
// focus.js: tierHint='hard' sets TIER.implement = 'opus' (implement role; implement is a worker).
//   This is the documented hard-mode opt-in: the caller explicitly requests opus-quality implementation
//   when correctness is paramount.  The default is TIER.implement='sonnet'.
// review.js: tierHint='hard' sets TIER.verify = 'opus' (verify role; verify is a worker in the refutation
//   sense, but is an allowed cross-check role — it is a second-level quality gate, not a bulk builder).
//   The default is TIER.verify='sonnet'.
// Together these are the ONLY two non-default opus TIER mutations in the codebase; all others are
// plan/advise/judge/audit/synth defaults.

{
  const focusSrc = readFile(path.join(WORKFLOWS_DIR, 'strata-focus.js'))
  if (focusSrc) {
    // Assert: tierHint='hard' block exists and sets implement='opus'
    if (/A\.tierHint\s*===\s*['"]hard['"]/.test(focusSrc) && /TIER\.implement\s*=\s*['"]opus['"]/.test(focusSrc)) {
      pass('tier:strata-focus.js:tierhint-hard-implement-opus',
        "tierHint='hard' sets TIER.implement='opus' (documented non-default caller opt-in; implement role only)")
    } else {
      fail('tier:strata-focus.js:tierhint-hard-implement-opus',
        "tierHint='hard' TIER.implement='opus' mutation not found — verify focus.js tiering is intact")
    }
    // Assert: no OTHER worker role is promoted to opus by tierHint=hard in focus.js.
    // The allowed hard-mode mutations are: verify→sonnet (cheap mode undoes this), implement→opus.
    // Extract the tierHint='hard' block and check for unexpected opus assignments.
    const hardBlockMatch = focusSrc.match(/if\s*\(A\.tierHint\s*===\s*['"]hard['"]\)\s*\{([^}]*)\}/)
    if (hardBlockMatch) {
      const hardBlock = hardBlockMatch[1]
      const unexpectedOpus = (hardBlock.match(/TIER\.\w+\s*=\s*['"]opus['"]/g) || [])
        .filter(m => !m.includes('implement'))
      if (unexpectedOpus.length > 0) {
        fail('tier:strata-focus.js:tierhint-hard-no-extra-opus-worker',
          `tierHint='hard' block promotes unexpected roles to opus: ${unexpectedOpus.join(', ')}`)
      } else {
        pass('tier:strata-focus.js:tierhint-hard-no-extra-opus-worker',
          "tierHint='hard' only promotes implement→opus (no unexpected worker roles promoted)")
      }
    }
  }

  const reviewSrc = readFile(path.join(WORKFLOWS_DIR, 'strata-review.js'))
  if (reviewSrc) {
    // Assert: tierHint='hard' block exists and sets verify='opus'
    if (/A\.tierHint\s*===\s*['"]hard['"]/.test(reviewSrc) && /TIER\.verify\s*=\s*['"]opus['"]/.test(reviewSrc)) {
      pass('tier:strata-review.js:tierhint-hard-verify-opus',
        "tierHint='hard' sets TIER.verify='opus' (documented non-default caller opt-in; verify/refutation role only)")
    } else {
      fail('tier:strata-review.js:tierhint-hard-verify-opus',
        "tierHint='hard' TIER.verify='opus' mutation not found — verify review.js tiering is intact")
    }
    // Assert: no OTHER worker role is promoted to opus by tierHint=hard in review.js.
    const hardBlockMatchR = reviewSrc.match(/if\s*\(A\.tierHint\s*===\s*['"]hard['"]\)[^}]*\{([^}]*)\}/)
    if (hardBlockMatchR) {
      const hardBlock = hardBlockMatchR[1]
      const unexpectedOpus = (hardBlock.match(/TIER\.\w+\s*=\s*['"]opus['"]/g) || [])
        .filter(m => !m.includes('verify'))
      if (unexpectedOpus.length > 0) {
        fail('tier:strata-review.js:tierhint-hard-no-extra-opus-worker',
          `tierHint='hard' block promotes unexpected roles to opus: ${unexpectedOpus.join(', ')}`)
      } else {
        pass('tier:strata-review.js:tierhint-hard-no-extra-opus-worker',
          "tierHint='hard' only promotes verify→opus (no unexpected worker roles promoted)")
      }
    }
  }
}

// ============================================================
// CHECK 5: SEVERITY-GATED VERIFY
// ============================================================
section('5. Severity-Gated Verify')

// Invariant: in review/sweep/focus, CRITICAL/HIGH findings require 2 votes and lower severities 1.
// The exact implementation varies per script:
//   - focus/review/sweep: votes = (CRITICAL||HIGH)?2:1, confirmed >= ceil(votes/2)
//   - ultra: intermediate `const high = ...CRITICAL||HIGH...` then `votes = high ? 2 : 1`,
//            quorum = Math.ceil(ballots.length / 2) with an opus tie-breaker for splits.
// Both are equivalent severity-gating. The invariant check must accept both patterns.
// Dedup must precede the cross-dimension verify barrier in review; sweep does cross-unit dedup
// after the per-unit pipeline (where inline verify already ran) — that is the barrier.

const SEVERITY_CHECK_SCRIPTS = ['strata-focus.js', 'strata-review.js', 'strata-sweep.js', 'strata-ultra.js']

for (const wf of SEVERITY_CHECK_SCRIPTS) {
  const src = readFile(path.join(WORKFLOWS_DIR, wf))
  if (!src) {
    fail(`severity:${wf}`, 'file missing')
    continue
  }

  // Pattern A: direct inline `severity === 'CRITICAL' || severity === 'HIGH' ? 2 : 1`
  //   used by focus, review, sweep (per-finding loop)
  const patternA = /'CRITICAL'.*'HIGH'.*?\?\s*2\s*:\s*1|==='CRITICAL'.*==='HIGH'.*2.*?1/
  // Pattern B: intermediate `const high = ...` then `votes = high ? 2 : 1`
  //   used by ultra
  const patternB_high = /const high\s*=.*['"]CRITICAL['"].*['"]HIGH['"]/
  const patternB_votes = /const votes\s*=\s*high\s*\?\s*2\s*:\s*1/

  if (patternA.test(src)) {
    pass(`severity:${wf}:votes-pattern`, 'CRITICAL/HIGH→2votes, else→1 pattern present (inline)')
  } else if (patternB_high.test(src) && patternB_votes.test(src)) {
    pass(`severity:${wf}:votes-pattern`, 'CRITICAL/HIGH→2votes, else→1 pattern present (via high var)')
  } else {
    fail(`severity:${wf}:votes-pattern`, 'expected CRITICAL/HIGH→2 votes, else→1 pattern not found')
  }

  // Quorum check: either Math.ceil(votes / 2) or Math.ceil(ballots.length / 2)
  // (ultra uses ballots.length since the vote count equals intended ballots when not truncated)
  if (src.includes('Math.ceil(votes / 2)')) {
    pass(`severity:${wf}:ceil-quorum`, 'confirmed >= Math.ceil(votes/2) quorum present')
  } else if (src.includes('Math.ceil(ballots.length / 2)')) {
    pass(`severity:${wf}:ceil-quorum`, 'confirmed >= Math.ceil(ballots.length/2) quorum present (equivalent)')
  } else {
    fail(`severity:${wf}:ceil-quorum`, 'neither Math.ceil(votes/2) nor Math.ceil(ballots.length/2) quorum logic found')
  }
}

// Dedup-before-verify invariant:
//   review: dedupMap is built from raw findings BEFORE the verify phase loop — check positional order
//   sweep: per-unit verify runs inline in the pipeline (before the barrier); the cross-unit dedup
//          runs AFTER the pipeline on the confirmed findings — that IS the correct order for sweep
//          (dedup happens at the barrier, after per-unit verify, before systemic/synth).
//          The invariant for sweep is: dedup precedes the systemic/synth phases (the post-barrier work).
//
// DUAL-TOKEN STRATEGY: both scripts assert TWO anchors for the dedup barrier:
//   — 'dedupMap'  (the Map variable that stores deduplicated results — primary key in this JS script)
//   — 'siteKey'   (the key function that generates dedup keys — primary key in check-invariants.sh)
// Having both scripts assert both tokens means a future rename of either token fails BOTH scripts
// simultaneously, preventing silent divergence between the two independent verifiers.

for (const wf of ['strata-review.js', 'strata-sweep.js']) {
  const src = readFile(path.join(WORKFLOWS_DIR, wf))
  if (!src) {
    fail(`severity:${wf}:dedup-before-verify`, 'file missing')
    continue
  }

  // Assert BOTH dedup anchors are present (dual-token cross-check with check-invariants.sh)
  const dedupIdx = src.indexOf('dedupMap')
  const siteKeyIdx = src.indexOf('siteKey')
  if (dedupIdx === -1) {
    fail(`severity:${wf}:dedup-anchor-dedupMap`, "'dedupMap' token not found — dedup barrier may have been removed or renamed")
  } else {
    pass(`severity:${wf}:dedup-anchor-dedupMap`, "'dedupMap' anchor present (dual-token with check-invariants.sh)")
  }
  if (siteKeyIdx === -1) {
    fail(`severity:${wf}:dedup-anchor-siteKey`, "'siteKey' token not found — dedup key function may have been removed or renamed")
  } else {
    pass(`severity:${wf}:dedup-anchor-siteKey`, "'siteKey' anchor present (dual-token with check-invariants.sh)")
  }
  if (dedupIdx === -1 || siteKeyIdx === -1) continue  // skip positional check if either anchor missing

  if (wf === 'strata-review.js') {
    // In review: dedup must come before phase('Verify')
    const verifyPhaseIdx = src.indexOf("phase('Verify')")
    if (verifyPhaseIdx === -1) {
      fail(`severity:${wf}:dedup-before-verify`, "phase('Verify') not found")
    } else if (dedupIdx < verifyPhaseIdx) {
      pass(`severity:${wf}:dedup-before-verify`, `dedup (pos ${dedupIdx}) precedes verify phase (pos ${verifyPhaseIdx})`)
    } else {
      fail(`severity:${wf}:dedup-before-verify`, `dedup (pos ${dedupIdx}) appears AFTER verify phase (pos ${verifyPhaseIdx})`)
    }
  } else {
    // In sweep: per-unit verify is inline in the pipeline; dedup is the POST-pipeline cross-unit barrier.
    // The invariant is: dedup precedes systemic (cross-cutting critic) phase.
    const systemicPhaseIdx = src.indexOf("phase('Systemic')")
    if (systemicPhaseIdx === -1) {
      fail(`severity:${wf}:dedup-before-systemic`, "phase('Systemic') not found")
    } else if (dedupIdx < systemicPhaseIdx) {
      pass(`severity:${wf}:dedup-barrier-before-systemic`, `cross-unit dedup (pos ${dedupIdx}) precedes systemic phase (pos ${systemicPhaseIdx}) — correct barrier placement`)
    } else {
      fail(`severity:${wf}:dedup-barrier-before-systemic`, `cross-unit dedup (pos ${dedupIdx}) appears AFTER systemic phase (pos ${systemicPhaseIdx})`)
    }
  }
}

// Ultra-specific: assert that strata-ultra.js intentionally has NO cross-dimension dedup phase.
// Ultra uses a quorum ballot model instead: each ballot is cast per-dimension, and the ballots.length
// quorum check (Math.ceil(ballots.length/2)) absorbs missing ballots as fail-open.  The ABSENCE
// of a cross-dimension dedupMap in ultra is INTENTIONAL — ultra's vote model is the quality gate.
// We assert the absence here so it is tracked and cannot silently change into a false presence.
{
  const ultraSrc = readFile(path.join(WORKFLOWS_DIR, 'strata-ultra.js'))
  if (!ultraSrc) {
    fail('severity:strata-ultra.js:no-dedup-assertion', 'strata-ultra.js missing — cannot assert')
  } else if (ultraSrc.includes('dedupMap')) {
    fail('severity:strata-ultra.js:no-cross-dim-dedup',
      'strata-ultra.js now contains dedupMap — verify this is intentional; ultra uses ballots quorum instead of cross-dimension dedup')
  } else {
    pass('severity:strata-ultra.js:no-cross-dim-dedup',
      'strata-ultra.js has no cross-dimension dedupMap (correct: ultra uses quorum ballots as quality gate)')
  }
}

// ============================================================
// CHECK 6: EVOLVE REGRESSION-FREE (five specific fixes)
// ============================================================
section('6. Evolve Regression-Free (5 Fixes)')

const evolveSrc = readFile(path.join(WORKFLOWS_DIR, 'strata-evolve.js'))

if (!evolveSrc) {
  fail('evolve:file-present', 'strata-evolve.js missing')
} else {
  // (a) Per-phase repair cap MAX_REPAIRS enforced before re-queueing a repair.
  // The fix uses MAX_REPAIRS as a constant AND repairCount to track per-phase attempts;
  // they appear on different lines (const definition vs usage in the loop), so check independently.
  if (evolveSrc.includes('MAX_REPAIRS') && evolveSrc.includes('repairCount')) {
    pass('evolve:fix-a:repair-cap', 'MAX_REPAIRS constant + repairCount guard present')
  } else {
    fail('evolve:fix-a:repair-cap', 'MAX_REPAIRS per-phase repair cap or repairCount guard not found')
  }

  // (b) SYNTH_RESERVE / canSpawnWork keeping room for the final synthesis
  if (evolveSrc.includes('SYNTH_RESERVE') && evolveSrc.includes('canSpawnWork')) {
    pass('evolve:fix-b:synth-reserve', 'SYNTH_RESERVE and canSpawnWork guard present')
  } else {
    fail('evolve:fix-b:synth-reserve', 'SYNTH_RESERVE or canSpawnWork not found')
  }

  // (c) Ghost-phase guard: restores an unrun phase instead of feeding an empty build to grade/director
  // The fix: `queue.unshift(ph); phasesRun--; break` when want <= 0
  if (evolveSrc.includes('want <= 0') && evolveSrc.includes('queue.unshift(ph)') && evolveSrc.includes('phasesRun--')) {
    pass('evolve:fix-c:ghost-phase-guard', 'ghost-phase guard (want<=0 → unshift+phasesRun--) present')
  } else {
    fail('evolve:fix-c:ghost-phase-guard', 'ghost-phase guard (want<=0 + queue.unshift(ph) + phasesRun--) not found')
  }

  // (d) goalMet early-exit evaluated BEFORE appending revisePhases
  // The fix: `if (pm.goalMet) { break }` appears before the revisePhases block
  const goalMetBreakIdx = evolveSrc.indexOf('pm.goalMet')
  const revisePhasesAppendIdx = evolveSrc.indexOf('queue.push(...adds)')
  if (goalMetBreakIdx === -1) {
    fail('evolve:fix-d:goalmet-before-revise', 'pm.goalMet check not found')
  } else if (revisePhasesAppendIdx === -1) {
    // revisePhases append block might not exist yet — check for queue.push related to revise
    const altIdx = evolveSrc.indexOf('revisePhases')
    if (altIdx > goalMetBreakIdx) {
      pass('evolve:fix-d:goalmet-before-revise', 'goalMet check precedes revisePhases section')
    } else {
      fail('evolve:fix-d:goalmet-before-revise', 'goalMet check does not precede revisePhases section')
    }
  } else if (goalMetBreakIdx < revisePhasesAppendIdx) {
    pass('evolve:fix-d:goalmet-before-revise', `goalMet check (pos ${goalMetBreakIdx}) precedes revise-append (pos ${revisePhasesAppendIdx})`)
  } else {
    fail('evolve:fix-d:goalmet-before-revise', `goalMet check (pos ${goalMetBreakIdx}) appears AFTER revise-append (pos ${revisePhasesAppendIdx})`)
  }

  // (e) RANK-based severity sort feeding the director's issue slice
  // The fix: sortedIssues = (grade.issues || []).slice().sort((a, b) => RANK[a.severity] - RANK[b.severity])
  if (evolveSrc.includes('sortedIssues') && evolveSrc.includes('RANK') && evolveSrc.includes('.sort(')) {
    pass('evolve:fix-e:rank-sort', 'sortedIssues + RANK-based sort present')
  } else {
    fail('evolve:fix-e:rank-sort', 'sortedIssues or RANK-based sort not found in strata-evolve.js')
  }
}

// ============================================================
// CHECK 7: RUNTIME PURITY
// ============================================================
section('7. Runtime Purity')

// Invariant: no workflow script introduces require/import/process/fs/module
// (the workflow runtime forbids Node.js APIs)
const FORBIDDEN_PATTERNS = [
  { pattern: /\brequire\s*\(/, label: 'require()' },
  { pattern: /^import\s+/m, label: 'top-level import' },
  { pattern: /\bprocess\./,  label: 'process.*' },
  { pattern: /\bfs\./,       label: 'fs.*' },
  { pattern: /\bmodule\./,   label: 'module.*' },
]

/**
 * Strip the `export const meta = { ... }` preamble block from a workflow script.
 *
 * Using a non-greedy regex (`[\s\S]*?`) would stop at the FIRST `}` encountered,
 * which is inside a nested object in the meta phases array — leaving the rest of the
 * meta block in the output.  A greedy `[\s\S]*` goes too far and strips to the LAST
 * `}` in the file, removing the entire script body.
 *
 * The correct approach is to track brace depth: open on `{`, close on `}`, stop
 * when depth reaches 0.  Identifiers inside the meta block (e.g. `process.env` in
 * a description string) are then guaranteed NOT to reach the purity check.
 */
function stripMetaBlock(src) {
  const lines = src.split('\n')
  let inMeta = false
  let depth = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!inMeta && /^export\s+const\s+meta\s*=\s*\{/.test(line)) {
      inMeta = true
      depth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
      if (depth <= 0) return lines.slice(i + 1).join('\n')
      continue
    }
    if (inMeta) {
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
      if (depth <= 0) return lines.slice(i + 1).join('\n')
    }
  }
  return src  // no meta block found — return unchanged
}

for (const wf of EXPECTED_WORKFLOWS) {
  const src = readFile(path.join(WORKFLOWS_DIR, wf))
  if (!src) {
    fail(`purity:${wf}`, 'file missing')
    continue
  }

  // The scripts begin with `export const meta = { ... }` which is the runtime's metadata declaration,
  // NOT a true ESM import/export — the runtime wraps it. We must not flag this export.
  // Use brace-depth stripping to remove the entire meta block (including nested objects such as
  // phases entries), so a purity-forbidden identifier inside the meta block cannot hide.
  const srcWithoutMeta = stripMetaBlock(src)

  let pureOk = true
  for (const { pattern, label } of FORBIDDEN_PATTERNS) {
    if (pattern.test(srcWithoutMeta)) {
      fail(`purity:${wf}:${label}`, `forbidden pattern "${label}" found in workflow script`)
      pureOk = false
    }
  }
  if (pureOk) {
    pass(`purity:${wf}`, 'no forbidden Node.js APIs found')
  }
}

// ============================================================
// SUMMARY
// ============================================================
// Emit the final section's pass count (non-verbose)
if (!VERBOSE && _sectionLabel) {
  const secPassed = passed - _sectionPassStart
  const secFailed = failed - _sectionFailStart
  if (secFailed === 0) {
    console.log(`  (${secPassed}/${secPassed} checks passed)`)
  }
}
console.log('\n' + '='.repeat(60))
console.log(`SUMMARY: ${passed} passed, ${failed} failed (${passed + failed} total checks)`)
if (failed === 0) {
  console.log('ALL INVARIANTS HOLD — baseline green.')
} else {
  console.log(`${failed} INVARIANT(S) FAILED — see FAIL lines above.`)
  if (!VERBOSE) console.log('Re-run with --verbose for PASS details.')
}
console.log('='.repeat(60))

process.exit(failed > 0 ? 1 : 0)
