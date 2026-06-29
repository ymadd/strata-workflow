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
    // ── grounding context (both optional; injected into every per-unit reviewer + systemic + synth) ──
    conversation: "<the intent behind this audit — what it's for, what 'good' looks like>",  // caller-supplied
    conventions: true,  // true/omitted = the map reads CLAUDE.md/AGENTS.md AND infers from code (merged);
    //                      a string = authoritative conventions verbatim; false = infer-from-code only (legacy).
    //                      When grounding is present, an "adherence" lens is added to every unit reviewer.
    exclude: ["node_modules","dist","generated"],
    maxUnits: 40,                               // the coverage knob (the riskiest N units get deep review)
    verifyFloor: "HIGH",                        // at scale, only adversarially refute CRITICAL/HIGH (default HIGH)
    severityFloor: "INFO",                      // drop findings below this before the systemic pass
    cap: 400000, tierHint: "cheap|normal|hard"  // cheap → reviewers on haiku; hard → verify on opus
  }
})
```

- **Coverage is the budget knob, and it is honest:** units are ranked by risk and the top N (within the agent counter) get deep review; any deferred units are named in the result and the `coverageNote`, never silently dropped. **Invoke from the repo root** (or set `root`) — the map/review agents run `git ls-files` / `rg` / read files themselves.
- **Grounding (CLAUDE.md + conversation):** the map already infers conventions from the code; by default it now ALSO reads the repo's `CLAUDE.md`/`AGENTS.md` and merges them (stated taking precedence) so reviewers and the systemic critic hold the codebase to the project's *declared* standards, surfacing convention drift across modules. Pass `conversation` to ground the audit in why it's being run. Either grounding adds an **adherence** lens to every per-unit reviewer at no extra agent cost.
- **The systemic critic is the payoff of seeing the whole codebase:** it surfaces what no single-file reviewer can — repeated anti-patterns, a missing validation/auth/error layer, divergent handling of one concern across modules.
- Model-tiered: map/review/verify on sonnet, **opus only for the systemic critic + the final synthesis**. Pipelined so units stream through (a 40-unit repo doesn't wait at phase boundaries).
- Returns `{ healthGrade (A–F), unitsTotal, unitsDeepReviewed, unitsDeferred, findings (confirmed, deduped, severity-sorted; raisedBy>1 = same site across lenses), systemicFindings, synthesis (report grouped by severity+theme, topRisks, coverageNote) }`.
- **review vs sweep:** review takes a *known change* and ends on approve/comment/request-changes; sweep takes the *whole codebase*, partitions it, and ends on a health grade + systemic findings. For a PR, use review; for "audit this repo," use sweep.
