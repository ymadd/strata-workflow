# focus — `strata-focus` (how to call)

Restraint mode (the default). When the search surface is unknown AND cross-source synthesis is needed AND correctness warrants a verify panel: run a small **find → verify → synthesize**. One cheap haiku scout per dimension, severity-gated adversarial verify on sonnet, opus only for the final synthesis.

```js
Workflow({
  scriptPath: "${CLAUDE_SKILL_DIR}/workflows/strata-focus.js",
  args: { task: "<full task>", taskClass: "review|research|implement|migrate", cap: <number or omit>, tierHint: "cheap|normal|hard" }
})
```

- Omit `cap` and the script uses 150k.
- `taskClass` selects the default investigation dimensions (review → correctness/security/performance/tests; research → primary-sources/counter-evidence/recency/consensus; etc.); override with `dimensions: [...]`.
- Returns `{ findings (confirmed, severity-sorted), synthesis (answer, residualRisks, coverageNote) }`.
- This is the only mode the 3-way GATE's "FULL TEMPLATE" branch calls. For a known work-list use `scale`; for a known change use `review`.
