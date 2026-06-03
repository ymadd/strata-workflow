# sweep — `strata-sweep` (how to call)

For reviewing the WHOLE codebase (not a diff) at scale — leverages the dynamic-workflow fan-out. A map agent partitions the tree into **risk-ranked review units**; the units are pipelined through sonnet review → severity-gated verify (no barrier between units); findings are deduped across the whole codebase; an opus **systemic critic** finds cross-cutting / architectural issues; an opus synthesis grades health and writes an honest coverage note.

```js
Workflow({
  scriptPath: "${CLAUDE_SKILL_DIR}/workflows/strata-sweep.js",
  args: {
    root: ".",                                  // directory to audit (agents discover files themselves)
    scope: "only src/ and lib/",                // optional natural-language narrowing
    focus: "prioritize security and the payment flow",  // weights unit risk-ranking
    dimensions: [ /* override; default = correctness/security/error-handling/perf/maintainability */ ],
    exclude: ["node_modules","dist","generated"],
    maxUnits: 40,                               // the coverage knob (the riskiest N units get deep review)
    verifyFloor: "HIGH",                        // at scale, only adversarially refute CRITICAL/HIGH (default HIGH)
    severityFloor: "INFO",                      // drop findings below this before the systemic pass
    cap: 400000, tierHint: "cheap|normal|hard"  // cheap → reviewers on haiku; hard → verify on opus
  }
})
```

- **Coverage is the budget knob, and it is honest:** units are ranked by risk and the top N (within the agent counter) get deep review; any deferred units are named in the result and the `coverageNote`, never silently dropped. **Invoke from the repo root** (or set `root`) — the map/review agents run `git ls-files` / `rg` / read files themselves.
- **The systemic critic is the payoff of seeing the whole codebase:** it surfaces what no single-file reviewer can — repeated anti-patterns, a missing validation/auth/error layer, divergent handling of one concern across modules.
- Model-tiered: map/review/verify on sonnet, **opus only for the systemic critic + the final synthesis**. Pipelined so units stream through (a 40-unit repo doesn't wait at phase boundaries).
- Returns `{ healthGrade (A–F), unitsTotal, unitsDeepReviewed, unitsDeferred, findings (confirmed, deduped, severity-sorted; raisedBy>1 = same site across lenses), systemicFindings, synthesis (report grouped by severity+theme, topRisks, coverageNote) }`.
- **review vs sweep:** review takes a *known change* and ends on approve/comment/request-changes; sweep takes the *whole codebase*, partitions it, and ends on a health grade + systemic findings. For a PR, use review; for "audit this repo," use sweep.
