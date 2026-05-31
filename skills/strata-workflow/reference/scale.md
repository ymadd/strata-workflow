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

- Concurrency is machine-bound (`min(16, cores-2)`); N units run in `ceil(N/concurrency)` waves, so large N should run in the background.
- Lifetime agent cap is 1000; the script truncates at 950 for headroom.
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
