# scale — `strata-scale` (+ the `strata-audit` auditor) — how to call

For a known work-list of N independent units (e.g. 500 components, N file transforms, N data records). The **count is the deliberate knob**, but the model stays right-sized (sonnet default; opus never per-unit) and schema keeps each unit light.

```js
Workflow({
  scriptPath: "${CLAUDE_SKILL_DIR}/workflows/strata-scale.js",
  args: {
    task: "<overall instruction>",
    units: [ /* explicit unit specs */ ],   // OR gridA:[...]+gridB:[...] (cross-product), OR count:500
    model: "sonnet",
    advise: true,                            // opus advise pre-pass (default on); adviseModel to tune
    instructions: "<how to build one unit>",
    unitSchema: { /* JSON Schema for one unit; default = a copy-pasteable UI component */ },
    cap: 0                                   // optional safety valve; in scale mode the COUNT is primary
  }
})
```

- Concurrency is controlled by the Workflow runtime's `pipeline()` function; the script estimates approximately 8-wide fan-out (`~ceil(N/8)` waves) in its progress log. Large N should run in the background.
- Lifetime agent cap: `HARD_LIMIT = 950`. When `advise` is on (default), 1 slot is reserved for the advise agent so build units are truncated to 949; with `advise: false` the full 950 is available for build units. A `spawned` counter tracks both the advise and build agents.
- Each unit returns **structured output** via schema — small per-unit output is the main cost lever. Files are written afterward (avoids worktree×N).

## Scale quality pipeline: ADVISE → BUILD → AUDIT → REPAIR
A **thin opus layer** wraps the cheap bulk (opus stays a few % of total).
- **ADVISE (opus ×1, pre-pass):** `strata-scale`'s `advise` (default on). One opus brief — quality bar, pitfalls, best practices, consistency rules — injected into every cheap worker. The single opus cost is amortized over N, lifting each worker toward expert level.
- **BUILD (sonnet × N):** schema-bounded right-sized fan-out.
- **AUDIT (opus):** call `strata-audit.js`. Each auditor reads ONE pre-split batch file (cheap input), grades each unit, flags broken/dup/off-spec; an opus meta-critic returns systemic issues + `regenerateIds`.
  ```js
  Workflow({ scriptPath: "${CLAUDE_SKILL_DIR}/workflows/strata-audit.js",
    args: { batchDir: "<outDir>/audit-batches", count: <N>, batchSize: 20, model: "opus", task: "<context>" } })
  ```
- **REPAIR (sonnet, failures only):** re-run `strata-scale` on just the `regenerateIds` with hardened instructions. Fix the worst, not the whole — minimal cost.

Structural checks (empty / unscoped / dup / JS syntax) are done **for free in code**; opus is reserved for subjective quality and systemic judgment.

---

## Per-mode agent ceiling reference (traced to code constants)

All constants below are from the workflow scripts in `workflows/strata-*.js` and are the canonical source of truth. The cap formula `clamp(floor(0.8*cap/tpa), floor, roof)` uses `tpa` = tokens-per-agent.

| Mode | `DEFAULT_CAP` | `TOKENS_PER_AGENT` | `AGENT_FLOOR` | `AGENT_ROOF` | `HARD_LIMIT` | Max-agents formula |
|------|--------------|--------------------|--------------|-------------|-------------|-------------------|
| **focus** | 150 000 | 12 000 | 4 | **40** | — | `clamp(floor(0.8*cap/12k), 4, 40)` |
| **review** | 150 000 | 12 000 | 4 | **40** | — | `clamp(floor(0.8*cap/12k), 4, 40)` |
| **panel** | 150 000 | 12 000 | 4 | **40** | — | `clamp(floor(0.8*cap/12k), 4, 40)` |
| **sweep** | 200 000 | 12 000 | 6 | **120** | 950 | `clamp(floor(0.8*cap/12k), 6, 120)`; `maxUnits` overrides |
| **scale** | — | — | — | — | **950** | units truncated to `HARD_LIMIT - ADVISE_RESERVE` (949 when advise=on, 950 when off); `spawned` counter tracks advise+build; COUNT is the primary knob; no clamp formula |
| **grow** | — | — | 8 | — | — | `max(8, min(950, maxAgents ?? 150))` (no `AGENT_ROOF`; 950 is the `min()` ceiling) |
| **ultra** | 150 000 | 16 000 | 8 | **120** | 950 | `clamp(floor(0.8*cap/16k), 8, 120)`; `unleashed` sets `min(950, maxAgents\|950)` |
| **evolve** | 500 000 | 16 000 | 8 | **120** | 950 | `clamp(floor(0.8*cap/16k), 8, 120)`; `unleashed` sets `min(950, maxAgents\|950)` |
| **audit** | — | — | — | — | **950** | `nBatches = min(ceil(count/batchSize), HARD_LIMIT-1)` + 1 critic; `canSpawn()` guards pipeline |

Notes:
- `HARD_LIMIT = 950` is the runtime lifetime-agent backstop for sweep/ultra/evolve/scale/audit. grow/panel/focus/review do not declare it but their `AGENT_ROOF` or `min()` ceiling makes the 950 boundary unreachable in practice.
- `TOKENS_PER_AGENT` is a blended planning estimate used only to derive `MAX_AGENTS` from the token cap. It does not cap per-agent spend.
- grow's `maxAgents` defaults to 150 but is caller-settable up to 950 (`max(8, min(950, A.maxAgents ?? 150))`).
- ultra and evolve with `unleashed: true` set `MAX_AGENTS = min(950, explicitMax ?? 950)` — the cap-derived formula is bypassed but the 950 backstop always holds.
- e.g. at 120k cap: focus/review/panel/sweep → 8 agents; ultra/evolve → 8 (floor clamps floor(96k/16k)=6 up to 8). At 300k: focus/review/panel/sweep → 20, ultra/evolve → 15. At 1m: focus/review/panel → 40 (roof), sweep → 66, ultra/evolve → 50. Model tiering is always on regardless of cap.
