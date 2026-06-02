#!/usr/bin/env bash
# check-invariants.sh — Strata Workflow invariant verifier
#
# Mechanically asserts every charter guarantee listed in the P2 acceptance criteria.
# Run from the repo root:   bash check-invariants.sh
# Re-runnable after every later phase to confirm no regression.
#
# Exit codes:
#   0  all checks pass (green)
#   1  one or more checks failed (red)
#
# Checks:
#   1. Mode inventory      — 9 scripts + 8 reference docs present
#   2. Syntax guarantee    — every script passes `node --check`
#   3. Agent-count caps    — documented MAX_AGENTS/HARD_LIMIT/roof constant + gate present per script
#   4. Model tiering       — opus only on plan/advise/judge/audit/synth; unclassified → sonnet
#   5. Severity-gated      — votes/ceil(votes/2) logic + dedup-before-verify in review+sweep
#   6. Evolve fixes        — the five strata-evolve.js audit fixes all present
#   7. Runtime purity      — no require/import/process/fs/module newly introduced

set -euo pipefail

# ── colour helpers ──────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS() { printf "${GREEN}PASS${NC}  %s\n" "$*"; }
FAIL() { printf "${RED}FAIL${NC}  %s\n" "$*"; FAILURES=$((FAILURES + 1)); }
INFO() { printf "${YELLOW}INFO${NC}  %s\n" "$*"; }

FAILURES=0

# ── locate the skill root ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="${SCRIPT_DIR}/skills/strata-workflow"
WF="${SKILL_ROOT}/workflows"
REF="${SKILL_ROOT}/reference"

if [[ ! -d "$WF" ]]; then
  FAIL "workflows/ dir not found at ${WF}; aborting"
  exit 1
fi

echo "=== Strata Workflow invariant verifier ==="
echo "    skill root: ${SKILL_ROOT}"
echo ""

# ══════════════════════════════════════════════════════════════════════════════
# CHECK 1: MODE INVENTORY
# All 9 strata-*.js scripts and 8 reference/*.md docs must be present.
# audit is documented in reference/scale.md, not a separate audit.md.
# ══════════════════════════════════════════════════════════════════════════════
echo "── 1. Mode Inventory ──────────────────────────────────────────────────"

REQUIRED_SCRIPTS=(
  strata-focus.js strata-review.js strata-sweep.js strata-panel.js
  strata-scale.js strata-grow.js   strata-ultra.js strata-evolve.js
  strata-audit.js
)
REQUIRED_REFS=(
  focus.md review.md sweep.md panel.md
  scale.md grow.md  ultra.md evolve.md
)

for s in "${REQUIRED_SCRIPTS[@]}"; do
  f="${WF}/${s}"
  if [[ -f "$f" ]]; then
    PASS "script present: ${s}"
  else
    FAIL "script MISSING: ${s}"
  fi
done

for r in "${REQUIRED_REFS[@]}"; do
  f="${REF}/${r}"
  if [[ -f "$f" ]]; then
    PASS "reference doc present: ${r}"
  else
    FAIL "reference doc MISSING: ${r}"
  fi
done

# Confirm audit is NOT a separate reference doc (by design — documented in scale.md)
if [[ -f "${REF}/audit.md" ]]; then
  INFO "audit.md exists in reference/ (not required by charter; audit is documented in scale.md)"
fi

echo ""

# ══════════════════════════════════════════════════════════════════════════════
# CHECK 2: SYNTAX GUARANTEE
# Every script passes a module-aware node --check.
#
# Workflow scripts use `export const meta = ...` (ESM syntax).  On Node 16/18,
# `node --check <file.js>` loads the file as CommonJS and rejects `export` at
# the top level.  The version-safe approach wraps each file inside an async
# function body (the same recipe as verify-invariants.js) so that `export` is
# treated as a statement-position identifier rather than a module declaration,
# and the CJS parser accepts it on all supported Node versions (≥16).
# ══════════════════════════════════════════════════════════════════════════════
echo "── 2. Syntax Guarantee ────────────────────────────────────────────────"

if ! command -v node &>/dev/null; then
  FAIL "node not found in PATH — cannot run syntax checks"
else
  TMPDIR_SYNTAX="$(mktemp -d)"
  for f in "${WF}"/strata-*.js; do
    name="$(basename "$f")"
    wrapped="${TMPDIR_SYNTAX}/${name%.js}-wrapped.js"
    # Wrap file in an async function so `export const meta` is a statement,
    # not a top-level ESM declaration — accepted by CJS parser on Node ≥16.
    printf 'async function __w(){' > "$wrapped"
    cat "$f" >> "$wrapped"
    printf '\n}' >> "$wrapped"
    if node --check "$wrapped" 2>/dev/null; then
      PASS "syntax OK: ${name}"
    else
      err="$(node --check "$wrapped" 2>&1 || true)"
      FAIL "syntax FAIL: ${name} — ${err}"
    fi
    rm -f "$wrapped"
  done
  rmdir "$TMPDIR_SYNTAX" 2>/dev/null || true
fi

echo ""

# ══════════════════════════════════════════════════════════════════════════════
# CHECK 3: AGENT-COUNT CAPS
# Each script must contain its documented cap constant AND a gate guarding
# every agent() call.  No roof may exceed its documented ceiling.
#
# Documented ceilings (from p1-canonical-baseline.md):
#   focus/review/panel  AGENT_ROOF=40,  MAX_AGENTS formula present, canSpawn()
#   sweep               AGENT_ROOF=120, HARD_LIMIT=950, canSpawn() + canSpawnUnit()
#   scale               HARD_LIMIT=950, spawned counter, UNIT_LIMIT truncation + overCap() guard
#   grow                MAX_AGENTS=min(950,...), can() + canBuild()
#   ultra               AGENT_ROOF=120, HARD_LIMIT=950, canSpawnDyn() + gate()
#   evolve              AGENT_ROOF=120, HARD_LIMIT=950, canSpawn() + canSpawnWork()
#   audit               HARD_LIMIT=950, spawned counter, canSpawn() guards pipeline
# ══════════════════════════════════════════════════════════════════════════════
echo "── 3. Agent-Count Caps ────────────────────────────────────────────────"

# Helper: require a pattern in a file
grep_require() {
  local file="$1" pattern="$2" label="$3"
  if grep -qE "$pattern" "$file"; then
    PASS "${label}"
  else
    FAIL "${label}"
  fi
}

# focus — AGENT_ROOF=40, MAX_AGENTS formula, canSpawn
F="${WF}/strata-focus.js"
grep_require "$F" "AGENT_ROOF\s*=\s*40"    "focus: AGENT_ROOF=40 present"
grep_require "$F" "MAX_AGENTS\s*="          "focus: MAX_AGENTS constant present"
grep_require "$F" "canSpawn\s*=\s*\(\)"     "focus: canSpawn() gate defined"
grep_require "$F" "canSpawn\(\)"            "focus: canSpawn() called at agent site"
# Verify no roof above 40
if grep -qE "AGENT_ROOF\s*=\s*[0-9]+" "$F"; then
  roof=$(grep -oE "AGENT_ROOF\s*=\s*[0-9]+" "$F" | grep -oE "[0-9]+$")
  if [[ "$roof" -le 40 ]]; then
    PASS "focus: AGENT_ROOF=${roof} within ceiling (<=40)"
  else
    FAIL "focus: AGENT_ROOF=${roof} EXCEEDS documented ceiling of 40"
  fi
fi

# review — AGENT_ROOF=40, MAX_AGENTS, canSpawn
F="${WF}/strata-review.js"
grep_require "$F" "AGENT_ROOF\s*=\s*40"    "review: AGENT_ROOF=40 present"
grep_require "$F" "MAX_AGENTS\s*="          "review: MAX_AGENTS constant present"
grep_require "$F" "canSpawn\s*=\s*\(\)"     "review: canSpawn() gate defined"
grep_require "$F" "canSpawn\(\)"            "review: canSpawn() called at agent site"
if grep -qE "AGENT_ROOF\s*=\s*[0-9]+" "$F"; then
  roof=$(grep -oE "AGENT_ROOF\s*=\s*[0-9]+" "$F" | grep -oE "[0-9]+$")
  if [[ "$roof" -le 40 ]]; then
    PASS "review: AGENT_ROOF=${roof} within ceiling (<=40)"
  else
    FAIL "review: AGENT_ROOF=${roof} EXCEEDS documented ceiling of 40"
  fi
fi

# panel — AGENT_ROOF=40, MAX_AGENTS, canSpawn
F="${WF}/strata-panel.js"
grep_require "$F" "AGENT_ROOF\s*=\s*40"    "panel: AGENT_ROOF=40 present"
grep_require "$F" "MAX_AGENTS\s*="          "panel: MAX_AGENTS constant present"
grep_require "$F" "canSpawn\s*=\s*\(\)"     "panel: canSpawn() gate defined"
grep_require "$F" "canSpawn\(\)"            "panel: canSpawn() called at agent site"
if grep -qE "AGENT_ROOF\s*=\s*[0-9]+" "$F"; then
  roof=$(grep -oE "AGENT_ROOF\s*=\s*[0-9]+" "$F" | grep -oE "[0-9]+$")
  if [[ "$roof" -le 40 ]]; then
    PASS "panel: AGENT_ROOF=${roof} within ceiling (<=40)"
  else
    FAIL "panel: AGENT_ROOF=${roof} EXCEEDS documented ceiling of 40"
  fi
fi

# sweep — AGENT_ROOF=120, HARD_LIMIT=950, canSpawn + canSpawnUnit
F="${WF}/strata-sweep.js"
grep_require "$F" "AGENT_ROOF\s*=\s*120"       "sweep: AGENT_ROOF=120 present"
grep_require "$F" "HARD_LIMIT\s*=\s*950"        "sweep: HARD_LIMIT=950 present"
grep_require "$F" "canSpawn\s*=\s*\(\)"          "sweep: canSpawn() gate defined"
grep_require "$F" "canSpawnUnit\s*=\s*\(\)"      "sweep: canSpawnUnit() gate defined"
grep_require "$F" "canSpawn\(\)|canSpawnUnit\(\)" "sweep: spawn gate called at agent site"
if grep -qE "AGENT_ROOF\s*=\s*[0-9]+" "$F"; then
  roof=$(grep -oE "AGENT_ROOF\s*=\s*[0-9]+" "$F" | grep -oE "[0-9]+$")
  if [[ "$roof" -le 120 ]]; then
    PASS "sweep: AGENT_ROOF=${roof} within ceiling (<=120)"
  else
    FAIL "sweep: AGENT_ROOF=${roof} EXCEEDS documented ceiling of 120"
  fi
fi

# scale — HARD_LIMIT=950 unit-truncation (ADVISE_RESERVE + UNIT_LIMIT + spawned counter present)
F="${WF}/strata-scale.js"
grep_require "$F" "HARD_LIMIT\s*=\s*950"    "scale: HARD_LIMIT=950 present"
# The truncation uses UNIT_LIMIT = HARD_LIMIT - ADVISE_RESERVE (more precise than a bare slice(0,HARD_LIMIT))
# Accept any of: slice(0, UNIT_LIMIT) OR slice(0, HARD_LIMIT) OR slice(0, 950)
if grep -qE "slice\(0,\s*(UNIT_LIMIT|HARD_LIMIT|950)\)" "$F"; then
  PASS "scale: HARD_LIMIT-derived truncation (UNIT_LIMIT/HARD_LIMIT/950) used as unit-list truncation"
else
  FAIL "scale: HARD_LIMIT used as unit-list truncation — expected slice(0, UNIT_LIMIT) or slice(0, HARD_LIMIT) or slice(0, 950)"
fi
# Confirm UNIT_LIMIT is derived from HARD_LIMIT (the ADVISE_RESERVE pattern); the ceiling may be
# HARD_LIMIT or an explicit-agent-cap ternary (explicitMax != null ? explicitMax : HARD_LIMIT).
grep_require "$F" "UNIT_LIMIT\s*=\s*\(?[^)]*HARD_LIMIT" \
                                              "scale: UNIT_LIMIT derived from HARD_LIMIT - ADVISE_RESERVE (honest truncation; honors explicit agent cap)"
# Spawned counter must be present (ADOPTED IDEA gap closed in P3)
grep_require "$F" "let spawned\s*=\s*0" "scale: spawned counter present (honest agent-count reporting)"

# Content-anchored scale ungated-agent cross-check: corroborates verify-invariants.js.
# scale has exactly ONE known-accepted ungated agent() call — the advise agent — identified by
# its stable code signature: inside `if (ADVISE)` AND the call has `label: 'advise'`.
# Any ADDITIONAL ungated agent() call (one lacking overCap() and not the advise call) is a failure.
#
# Strategy: count lines matching agent( but NOT preceded by overCap() and NOT matching label: 'advise'.
# We use grep+awk rather than line numbers so this is line-stable.
UNGATED_AGENT_COUNT=$(awk '
  /\bagent\s*\(/ {
    # Collect context: check preceding non-empty line for overCap()
    # and forward context for label: "advise"
    linenum = NR
    lines[NR] = $0
  }
  END {
    ungated = 0
    for (i = 1; i <= NR; i++) {
      if (lines[i] ~ /\bagent\s*\(/) {
        # Find preceding non-empty line
        prev = ""
        for (j = i - 1; j >= 1; j--) {
          if (lines[j] ~ /[^ \t]/) { prev = lines[j]; break }
        }
        # Check forward context (up to 20 lines) for label: "advise"
        has_advise_label = 0
        for (j = i; j <= i + 20 && j <= NR; j++) {
          if (lines[j] ~ /label\s*:\s*["'"'"']advise["'"'"']/) {
            has_advise_label = 1; break
          }
        }
        has_gate = (prev ~ /overCap\(\)/ || lines[i] ~ /overCap\(\)/)
        if (!has_gate && !has_advise_label) {
          ungated++
        }
      }
    }
    print ungated
  }
' "$F")
if [[ "$UNGATED_AGENT_COUNT" -eq 0 ]]; then
  PASS "scale: no ungated agent() calls beyond the known-accepted advise exception (content-anchored)"
else
  FAIL "scale: ${UNGATED_AGENT_COUNT} NEW ungated agent() call(s) found (not the advise exception) — add overCap() guard"
fi

# grow — MAX_AGENTS present, can() + canBuild(), hard cap at 950
F="${WF}/strata-grow.js"
grep_require "$F" "MAX_AGENTS\s*="         "grow: MAX_AGENTS constant present"
grep_require "$F" "\bcan\s*=\s*\(\)"       "grow: can() gate defined"
grep_require "$F" "canBuild\s*=\s*\(\)"    "grow: canBuild() gate defined"
grep_require "$F" "can\(\)|canBuild\(\)"   "grow: can/canBuild called at agent site"
grep_require "$F" "Math\.min\(950"         "grow: hard cap at 950 in MAX_AGENTS"
if grep -qE "Math\.min\([0-9]+.*A\.maxAgents|A\.maxAgents.*[0-9]+" "$F"; then
  maxcap=$(grep -oE "Math\.min\(950," "$F" | head -1)
  if [[ -n "$maxcap" ]]; then
    PASS "grow: MAX_AGENTS capped to 950"
  fi
fi

# ultra — AGENT_ROOF=120, HARD_LIMIT=950, canSpawnDyn() + gate()
F="${WF}/strata-ultra.js"
grep_require "$F" "AGENT_ROOF\s*=\s*120"    "ultra: AGENT_ROOF=120 present"
grep_require "$F" "HARD_LIMIT\s*=\s*950"     "ultra: HARD_LIMIT=950 present"
grep_require "$F" "canSpawnDyn\s*=\s*\(\)"   "ultra: canSpawnDyn() gate defined"
grep_require "$F" "canSpawnDyn\(\)"           "ultra: canSpawnDyn() called at agent site"
if grep -qE "AGENT_ROOF\s*=\s*[0-9]+" "$F"; then
  roof=$(grep -oE "AGENT_ROOF\s*=\s*[0-9]+" "$F" | grep -oE "[0-9]+$")
  if [[ "$roof" -le 120 ]]; then
    PASS "ultra: AGENT_ROOF=${roof} within ceiling (<=120)"
  else
    FAIL "ultra: AGENT_ROOF=${roof} EXCEEDS documented ceiling of 120"
  fi
fi

# evolve — AGENT_ROOF=120, HARD_LIMIT=950, canSpawn + canSpawnWork
F="${WF}/strata-evolve.js"
grep_require "$F" "AGENT_ROOF\s*=\s*120"     "evolve: AGENT_ROOF=120 present"
grep_require "$F" "HARD_LIMIT\s*=\s*950"      "evolve: HARD_LIMIT=950 present"
grep_require "$F" "canSpawn\s*=\s*\(\)"        "evolve: canSpawn() gate defined"
grep_require "$F" "canSpawnWork\s*=\s*\(\)"    "evolve: canSpawnWork() gate defined"
grep_require "$F" "canSpawnWork\(\)"           "evolve: canSpawnWork() called (main loop gate)"
if grep -qE "AGENT_ROOF\s*=\s*[0-9]+" "$F"; then
  roof=$(grep -oE "AGENT_ROOF\s*=\s*[0-9]+" "$F" | grep -oE "[0-9]+$")
  if [[ "$roof" -le 120 ]]; then
    PASS "evolve: AGENT_ROOF=${roof} within ceiling (<=120)"
  else
    FAIL "evolve: AGENT_ROOF=${roof} EXCEEDS documented ceiling of 120"
  fi
fi

# audit — HARD_LIMIT=950, spawned counter, canSpawn() guards pipeline (ADOPTED IDEA gap closed)
F="${WF}/strata-audit.js"
grep_require "$F" "HARD_LIMIT\s*=\s*950"    "audit: HARD_LIMIT=950 present"
grep_require "$F" "let spawned\s*=\s*0"      "audit: spawned counter present"
grep_require "$F" "canSpawn\s*=\s*\(\)"      "audit: canSpawn() gate defined"
grep_require "$F" "canSpawn\(\)"             "audit: canSpawn() called at agent site"

echo ""

# ══════════════════════════════════════════════════════════════════════════════
# CHECK 4: MODEL TIERING
# Opus must be restricted to plan/advise/judge/audit/synth roles only.
# No per-unit/bulk worker (find/extract/build/verify/draft/revise/grade) may be
# routed to opus on the DEFAULT path.
# Unclassified roles must default to sonnet (never opus, never haiku).
# ══════════════════════════════════════════════════════════════════════════════
echo "── 4. Model Tiering ───────────────────────────────────────────────────"

# focus: TIER.find='haiku', TIER.synth='opus', no opus on find/verify default
F="${WF}/strata-focus.js"
grep_require "$F" "find:\s*'haiku'"       "focus: TIER.find=haiku"
grep_require "$F" "synth:\s*'opus'"       "focus: TIER.synth=opus"
grep_require "$F" "verify:\s*'sonnet'"    "focus: TIER.verify=sonnet (default)"
# Confirm no TIER map routes 'opus' to bulk worker role by default
# (tierHint='hard' sets implement→opus, but that is caller-optional and not the default)
if grep -qE "implement:\s*'opus'" "$F"; then
  INFO "focus: TIER.implement has an opus path — it is a non-default caller-opt-in (tierHint=hard only)"
fi
if ! grep -qE "TIER\s*=\s*\{[^}]*find:\s*'opus'" "$F"; then
  PASS "focus: find role NOT defaulting to opus"
fi

# review: TIER.scope='haiku', TIER.verify='sonnet' (default), TIER.synth='opus'
# Explicit assertion: tierHint='hard' sets TIER.verify='opus' — the ONLY worker-role opus
# promotion in review.js.  This is a documented non-default caller opt-in (mirrors focus's
# INFO note, but as a proper PASS/FAIL so a silent removal is immediately flagged).
F="${WF}/strata-review.js"
grep_require "$F" "scope:\s*'haiku'"      "review: TIER.scope=haiku"
grep_require "$F" "verify:\s*'sonnet'"    "review: TIER.verify defaults to sonnet (hard-mode opt-in path only)"
grep_require "$F" "review:\s*'sonnet'"    "review: TIER.review=sonnet (default)"
grep_require "$F" "synth:\s*'opus'"       "review: TIER.synth=opus"
if ! grep -qE "TIER\s*=\s*\{[^}]*review:\s*'opus'" "$F"; then
  PASS "review: review role NOT defaulting to opus"
fi
# Assert the hard-mode opt-in is present (same pattern as focus's tierHint=hard block)
grep_require "$F" \
  "tierHint.*===.*hard.*TIER\.verify\s*=\s*'opus'" \
  "review: tierHint='hard' sets TIER.verify='opus' (documented caller opt-in; only non-default opus worker promotion)"
# Assert no unconditional opus for scope/review (bulk worker) roles
if grep -qE "TIER\.scope\s*=\s*'opus'|TIER\.review\s*=\s*'opus'" "$F" 2>/dev/null; then
  FAIL "review: unconditional opus found for scope/review (bulk worker) role — not the documented behavior"
else
  PASS "review: no unconditional opus for scope/review worker roles (only tierHint=hard promotes verify→opus)"
fi

# sweep: TIER.map='sonnet', TIER.review='sonnet', TIER.systemic='opus', TIER.synth='opus'
F="${WF}/strata-sweep.js"
grep_require "$F" "map:\s*'sonnet'"       "sweep: TIER.map=sonnet"
grep_require "$F" "review:\s*'sonnet'"    "sweep: TIER.review=sonnet (default)"
grep_require "$F" "systemic:\s*'opus'"    "sweep: TIER.systemic=opus"
grep_require "$F" "synth:\s*'opus'"       "sweep: TIER.synth=opus"
if ! grep -qE "TIER\s*=\s*\{[^}]*map:\s*'opus'" "$F"; then
  PASS "sweep: map (bulk) role NOT defaulting to opus"
fi

# panel: TIER.advise='opus', TIER.diverge='sonnet', TIER.judge='opus', TIER.synth='opus'
F="${WF}/strata-panel.js"
grep_require "$F" "advise:\s*'opus'"      "panel: TIER.advise=opus"
grep_require "$F" "diverge:\s*'sonnet'"   "panel: TIER.diverge=sonnet (bulk contenders)"
grep_require "$F" "judge:\s*'opus'"       "panel: TIER.judge=opus"
grep_require "$F" "synth:\s*'opus'"       "panel: TIER.synth=opus"

# scale: UNIT_MODEL blocks opus, ADV_MODEL defaults to opus
F="${WF}/strata-scale.js"
grep_require "$F" "UNIT_MODEL\s*=\s*PICK\s*===\s*'opus'\s*\?\s*'sonnet'" \
                                           "scale: UNIT_MODEL downgrades opus→sonnet for workers"
grep_require "$F" "PICK\s*===\s*'opus'\s*\?\s*'sonnet'\s*:\s*PICK" \
                                           "scale: opus-to-sonnet guard for unit workers"

# grow: UNIT_MODEL blocks opus, plan/advice/audit default to opus
F="${WF}/strata-grow.js"
grep_require "$F" "A\.model\s*===\s*'haiku'\s*\|\|\s*A\.model\s*===\s*'sonnet'" \
                                           "grow: UNIT_MODEL only allows haiku/sonnet (opus blocked)"
grep_require "$F" "PLAN_MODEL\s*=" "grow: PLAN_MODEL constant present"
grep_require "$F" "ADVICE_MODEL\s*=\s*'opus'" "grow: ADVICE_MODEL=opus"
grep_require "$F" "AUDIT_MODEL\s*=\s*'opus'"  "grow: AUDIT_MODEL=opus"

# ultra: worker roles (scout/design/build/review/verify/repair) NOT opus; judge/advise/tiebreak/critic/synth ARE opus
F="${WF}/strata-ultra.js"
grep_require "$F" "scout:\s*'haiku'"      "ultra: TIER.scout=haiku"
grep_require "$F" "build:\s*'sonnet'"     "ultra: TIER.build=sonnet"
grep_require "$F" "judge:\s*'opus'"       "ultra: TIER.judge=opus"
grep_require "$F" "advise:\s*'opus'"      "ultra: TIER.advise=opus"
grep_require "$F" "synth:\s*'opus'"       "ultra: TIER.synth=opus"
if ! grep -qE "TIER\s*=\s*\{[^}]*build:\s*'opus'" "$F"; then
  PASS "ultra: build (worker) role NOT defaulting to opus"
fi

# evolve: TIER.pm='opus', TIER.director='opus', TIER.build='sonnet', TIER.synth='opus'
F="${WF}/strata-evolve.js"
grep_require "$F" "pm:\s*'opus'"          "evolve: TIER.pm=opus"
grep_require "$F" "director:\s*'opus'"    "evolve: TIER.director=opus"
grep_require "$F" "build:\s*'sonnet'"     "evolve: TIER.build=sonnet (workers)"
grep_require "$F" "grade:\s*'sonnet'"     "evolve: TIER.grade=sonnet (graders)"
grep_require "$F" "synth:\s*'opus'"       "evolve: TIER.synth=opus"
if ! grep -qE "TIER\s*=\s*\{[^}]*build:\s*'opus'" "$F"; then
  PASS "evolve: build (worker) role NOT defaulting to opus"
fi

# audit: AUDIT_MODEL defaults to opus (allowed by charter for audit role); critic hardcoded opus
F="${WF}/strata-audit.js"
grep_require "$F" "AUDIT_MODEL\s*=.*'opus'"  "audit: AUDIT_MODEL defaults to opus (audit role)"
grep_require "$F" "model:\s*'opus'"           "audit: critic uses opus"

echo ""

# ══════════════════════════════════════════════════════════════════════════════
# CHECK 5: SEVERITY-GATED VERIFY
# (a) votes = (CRITICAL||HIGH) ? 2 : 1 logic present
# (b) confirmed = real >= Math.ceil(votes / 2) quorum
# (c) cross-dimension dedup precedes verify in review; cross-unit dedup precedes
#     systemic in sweep (charter-precise reading per canonical baseline)
#
# Applies to: focus, review, sweep, ultra (grow/scale/panel/audit/evolve use
# different quality-gate patterns; they are intentionally exempt)
# ══════════════════════════════════════════════════════════════════════════════
echo "── 5. Severity-Gated Verify ───────────────────────────────────────────"

for script in strata-focus.js strata-review.js strata-sweep.js; do
  F="${WF}/${script}"
  name="${script%.js}"

  # votes formula
  grep_require "$F" \
    "votes\s*=.*CRITICAL.*HIGH.*\?\s*2\s*:\s*1|votes\s*=.*HIGH.*CRITICAL.*\?\s*2\s*:\s*1" \
    "${name}: votes=(CRITICAL||HIGH)?2:1 formula present"

  # quorum: Math.ceil(votes / 2)
  grep_require "$F" \
    "Math\.ceil\(votes\s*/\s*2\)" \
    "${name}: confirmed>=Math.ceil(votes/2) quorum present"

  # fail-open on partial ballot
  grep_require "$F" \
    "ballots\.length\s*<\s*votes" \
    "${name}: fail-open partial-ballot guard present"
done

# strata-ultra uses a semantically equivalent but structurally different pattern:
# `const high = severity==='CRITICAL'||severity==='HIGH'; const votes = high ? 2 : 1`
# quorum: `Math.ceil(ballots.length / 2)` (equiv when ballots.length==votes; fail-open handles truncation)
# This is documented in p1-canonical-baseline.md §6 as "semantic equivalence: PRESENT"
F="${WF}/strata-ultra.js"
grep_require "$F" \
  "high\s*=.*CRITICAL.*HIGH|high\s*=.*HIGH.*CRITICAL" \
  "strata-ultra: high=(CRITICAL||HIGH) boolean defined"
grep_require "$F" \
  "votes\s*=\s*high\s*\?\s*2\s*:\s*1" \
  "strata-ultra: votes=high?2:1 formula present (CRITICAL/HIGH get 2)"
grep_require "$F" \
  "Math\.ceil\(ballots\.length\s*/\s*2\)" \
  "strata-ultra: confirmed>=Math.ceil(ballots.length/2) quorum present (equiv to votes/2)"
grep_require "$F" \
  "ballots\.length\s*<\s*votes" \
  "strata-ultra: fail-open partial-ballot guard present"

# Dedup-before-verify in strata-review.js
# DUAL-TOKEN STRATEGY: assert both 'siteKey' (primary shell anchor) AND 'dedupMap' (primary JS anchor).
# This ensures a rename of either token fails BOTH check-invariants.sh AND verify-invariants.js,
# preventing silent divergence between the two independent verifiers.
F="${WF}/strata-review.js"
# Dual-token presence checks
grep_require "$F" "siteKey\s*=" "review: 'siteKey' dedup anchor present (dual-token with verify-invariants.js)"
grep_require "$F" "dedupMap"    "review: 'dedupMap' dedup anchor present (dual-token with verify-invariants.js)"
# Positional check: siteKey dedup must precede phase('Verify')
dedup_line=$(grep -n "siteKey\s*=" "$F" | head -1 | cut -d: -f1)
verify_line=$(grep -n "phase('Verify')" "$F" | head -1 | cut -d: -f1)
if [[ -n "$dedup_line" && -n "$verify_line" ]]; then
  if [[ "$dedup_line" -lt "$verify_line" ]]; then
    PASS "review: siteKey dedup (line ${dedup_line}) precedes phase('Verify') (line ${verify_line})"
  else
    FAIL "review: siteKey dedup (line ${dedup_line}) does NOT precede phase('Verify') (line ${verify_line})"
  fi
else
  FAIL "review: could not locate siteKey dedup line or Verify phase line"
fi

# Dedup-before-systemic in strata-sweep.js
# DUAL-TOKEN STRATEGY: same as review above — assert both anchors.
F="${WF}/strata-sweep.js"
# Dual-token presence checks
grep_require "$F" "siteKey\s*=" "sweep: 'siteKey' dedup anchor present (dual-token with verify-invariants.js)"
grep_require "$F" "dedupMap"    "sweep: 'dedupMap' dedup anchor present (dual-token with verify-invariants.js)"
# Positional check: siteKey dedup must precede phase('Systemic')
dedup_line=$(grep -n "siteKey\s*=" "$F" | head -1 | cut -d: -f1)
systemic_line=$(grep -n "phase('Systemic')" "$F" | head -1 | cut -d: -f1)
if [[ -n "$dedup_line" && -n "$systemic_line" ]]; then
  if [[ "$dedup_line" -lt "$systemic_line" ]]; then
    PASS "sweep: siteKey dedup (line ${dedup_line}) precedes phase('Systemic') (line ${systemic_line})"
  else
    FAIL "sweep: siteKey dedup (line ${dedup_line}) does NOT precede phase('Systemic') (line ${systemic_line})"
  fi
else
  FAIL "sweep: could not locate siteKey dedup line or Systemic phase line"
fi

# Ultra-specific: assert strata-ultra.js intentionally has NO cross-dimension dedup.
# Ultra's quality gate is the quorum ballot model (Math.ceil(ballots.length/2)).
# The ABSENCE of dedupMap in ultra is intentional — assert it so a future accidental
# addition of dedupMap is immediately flagged.
F="${WF}/strata-ultra.js"
if grep -q "dedupMap" "$F" 2>/dev/null; then
  FAIL "ultra: dedupMap found — ultra intentionally has no cross-dimension dedup (uses quorum ballots); verify this is intentional"
else
  PASS "ultra: no cross-dimension dedupMap (correct — ultra uses quorum ballot quality gate)"
fi

echo ""

# ══════════════════════════════════════════════════════════════════════════════
# CHECK 6: EVOLVE AUDIT FIXES (five specific fixes from the just-committed
#          strata-evolve.js; all five must be literally present)
# ══════════════════════════════════════════════════════════════════════════════
echo "── 6. Evolve Audit Fixes ──────────────────────────────────────────────"

F="${WF}/strata-evolve.js"

# Fix (a): MAX_REPAIRS per-phase repair cap
grep_require "$F" \
  "MAX_REPAIRS\s*=" \
  "evolve fix-a: MAX_REPAIRS constant defined"
grep_require "$F" \
  "attempts\s*>\s*MAX_REPAIRS" \
  "evolve fix-a: attempts>MAX_REPAIRS cap check present"
grep_require "$F" \
  "repairCount\s*\|\|\s*0" \
  "evolve fix-a: repairCount threaded through phase object"

# Fix (b): SYNTH_RESERVE / canSpawnWork synth-counter guard
grep_require "$F" \
  "SYNTH_RESERVE\s*=\s*1" \
  "evolve fix-b: SYNTH_RESERVE=1 defined"
grep_require "$F" \
  "canSpawnWork\s*=\s*\(\)\s*=>\s*spawned\s*<\s*MAX_AGENTS\s*-\s*SYNTH_RESERVE" \
  "evolve fix-b: canSpawnWork checks MAX_AGENTS-SYNTH_RESERVE"
grep_require "$F" \
  "canSpawnWork\(\)" \
  "evolve fix-b: canSpawnWork() guards agent calls"

# Fix (c): ghost-phase guard — want<=0 restores phase and breaks
grep_require "$F" \
  "want\s*<=\s*0" \
  "evolve fix-c: want<=0 ghost-phase guard present"
grep_require "$F" \
  "queue\.unshift\(ph\)" \
  "evolve fix-c: phase restored to queue on want<=0"
grep_require "$F" \
  "phasesRun--" \
  "evolve fix-c: phasesRun decremented on ghost-phase halt"

# Fix (d): goalMet early-exit evaluated BEFORE revisePhases append
# The break is in the if-block body (not on the same line as pm.goalMet); find the if(pm.goalMet) block
# then verify the break comes before the revisePhases check
goalmet_line=$(grep -n "pm\.goalMet" "$F" 2>/dev/null | head -1 | cut -d: -f1 || true)
revisephases_line=$(grep -n "pm\.revisePhases" "$F" 2>/dev/null | grep -v "//" | grep "Array\." | head -1 | cut -d: -f1 || true)
if [[ -n "$goalmet_line" && -n "$revisephases_line" ]]; then
  if [[ "$goalmet_line" -lt "$revisephases_line" ]]; then
    PASS "evolve fix-d: pm.goalMet check (line ${goalmet_line}) precedes pm.revisePhases append (line ${revisephases_line})"
  else
    FAIL "evolve fix-d: pm.goalMet check (line ${goalmet_line}) does NOT precede pm.revisePhases (line ${revisephases_line})"
  fi
else
  FAIL "evolve fix-d: could not locate pm.goalMet line or pm.revisePhases line (goalmet=${goalmet_line:-empty} revisephases=${revisephases_line:-empty})"
fi
# Also confirm break is present inside the goalMet block (within 5 lines of pm.goalMet)
grep_require "$F" \
  "if\s*\(pm\.goalMet\)" \
  "evolve fix-d: if(pm.goalMet) conditional present"
# Confirm the if(pm.goalMet) block contains a break (early exit).
# Anchor on the `if (pm.goalMet)` line itself — NOT the first `pm.goalMet` occurrence, which may now be an
# earlier `pmFinal = { goalMet: pm.goalMet }` assignment (the PM runs every cycle and records its verdict).
ifgoalmet_line=$(grep -nE "if\s*\(pm\.goalMet\)" "$F" 2>/dev/null | head -1 | cut -d: -f1 || true)
if [ -n "${ifgoalmet_line}" ] && awk "NR>=${ifgoalmet_line} && NR<=${ifgoalmet_line}+5 { if (/break/) found=1 } END { exit !found }" "$F" 2>/dev/null; then
  PASS "evolve fix-d: break found within if(pm.goalMet) block (early exit confirmed)"
else
  FAIL "evolve fix-d: break NOT found within if(pm.goalMet) block"
fi

# Fix (e): RANK-based severity sort feeding director's issue slice
grep_require "$F" \
  "RANK\s*=\s*\{\s*CRITICAL:\s*0" \
  "evolve fix-e: RANK = {CRITICAL:0,...} constant defined"
grep_require "$F" \
  "sortedIssues\s*=\s*.*slice.*sort.*RANK" \
  "evolve fix-e: sortedIssues RANK-based sort present"
grep_require "$F" \
  "sortedIssues\.slice\(0" \
  "evolve fix-e: sortedIssues.slice(0,...) fed to director"

echo ""

# ══════════════════════════════════════════════════════════════════════════════
# CHECK 7: RUNTIME PURITY
# No workflow script may contain: require(  ^import   process.  fs.  module.
# export const meta is the ONLY module-syntax construct and is permitted.
# ══════════════════════════════════════════════════════════════════════════════
echo "── 7. Runtime Purity ──────────────────────────────────────────────────"

for f in "${WF}"/strata-*.js; do
  name="$(basename "$f")"
  purity_fail=0

  # Check for require( — must not appear outside comments
  if grep -qE "^\s*require\(" "$f" 2>/dev/null; then
    FAIL "purity ${name}: contains require() call"
    purity_fail=1
  fi

  # Check for bare import statements (not 'export const meta')
  # export is allowed (it's the meta declaration), but import is not
  if grep -qE "^import " "$f" 2>/dev/null; then
    FAIL "purity ${name}: contains top-level import statement"
    purity_fail=1
  fi

  # Check for process. usage
  if grep -qE "[^a-zA-Z]process\." "$f" 2>/dev/null; then
    FAIL "purity ${name}: contains process.* usage"
    purity_fail=1
  fi

  # Check for fs. usage
  if grep -qE "[^a-zA-Z]fs\." "$f" 2>/dev/null; then
    FAIL "purity ${name}: contains fs.* usage"
    purity_fail=1
  fi

  # Check for module.exports or module. usage
  if grep -qE "[^a-zA-Z]module\." "$f" 2>/dev/null; then
    FAIL "purity ${name}: contains module.* usage"
    purity_fail=1
  fi

  if [[ $purity_fail -eq 0 ]]; then
    PASS "purity OK: ${name}"
  fi
done

echo ""

# ══════════════════════════════════════════════════════════════════════════════
# SUMMARY
# ══════════════════════════════════════════════════════════════════════════════
echo "=== Summary ==========================================================="
if [[ $FAILURES -eq 0 ]]; then
  printf "${GREEN}ALL CHECKS PASSED${NC} (0 failures)\n"
  echo ""
  echo "INFO (not failures) — caller opt-ins that are intentional, not bugs:"
  echo "  - focus: tierHint=hard sets implement=opus (non-default caller opt-in, not a bug)"
  exit 0
else
  printf "${RED}FAILED: ${FAILURES} check(s) failed${NC}\n"
  exit 1
fi
