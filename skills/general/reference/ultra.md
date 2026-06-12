# ultra — `strata-ultra` (the full arc, "do the most") — how to call

For taking ONE substantial task end-to-end with maximum rigor. Runs ultracode's full arc — **understand → design → build → review → synthesize** — and **DYNAMICALLY spawns more agents where the work needs them** (not a fixed pipeline). Still bounded: a hard agent-count cap, and opus spawned only where judgment is needed. The deliberate opposite of `focus`: where focus does the least, ultra does the most the budget allows.

**ultra vs conduct:** ultra when the WHAT itself needs exploring (design alternatives, an open-ended deliverable, completeness-grown units); `conduct` when the what is clear and the work splits into file-disjoint units to execute in parallel under the fable conductor.

```js
Workflow({ scriptPath: "${CLAUDE_SKILL_DIR}/workflows/strata-ultra.js", args: {
  task: "<the one substantial task>",
  taskClass: "review|research|implement|migrate",   // tunes scout angles & review dimensions
  cap: 500000,                                       // derives MAX_AGENTS (ultra roof ≤120). higher cap = more dynamics fire
  unleashed: false,                                  // true = ignore the cap entirely (see below)
  maxAgents: 0,                                      // optional explicit override / safety bound (else cap-derived)
  adviceThreshold: 78,                               // build selfScore below this triggers an opus advice+revise
  designLenses: [ /* distinct approach angles; omit for defaults */ ],
  reviewDimensions: [ "correctness", "security", "edge cases" ],
  dryStreakLimit: 2, maxReviewRounds: 4, maxImprovementRounds: 2
} })
```

- **Dynamic escalation (opus spawned only on demand):** (1) a build unit that self-rates below `adviceThreshold` gets an opus **advice** pass + a sonnet **revise**; (2) when two verifiers **split** on a CRITICAL/HIGH issue, an opus **tie-breaker** decides; (3) when review goes dry, an opus **completeness critic** grows NEW work units for any gaps, builds them, and re-enters review — looping until it declares the deliverable complete or the budget runs out.
- **Budget split:** the front arc (understand/design/initial build) takes a lean guaranteed slice (~35%); the rest is the **dynamic back half** where escalation + gap-growth live. So a bigger cap doesn't just add agents — it lets more of the dynamic behavior actually fire. The advice/completeness passes need headroom: budget **500k+** (≈30+ agents) to see them, not just the tie-breaker.
- Returns `{ winnerLens, unitCount, dynamic: { adviceEscalations, tiebreakers, gapUnitsAdded, improvementRounds }, reviewLog, artifacts (unitId→output), synthesis }`.
- **`unleashed: true`** drops the leash entirely (true ultracode — "token cost is no constraint"): the cap-derived ceiling AND the soft token budget are ignored. The only remaining guards are the runtime's **950-agent lifetime backstop** and any `+Ntokens` hard `budget.total`. Pass an explicit `maxAgents` to bound it safely even while unleashed. Use deliberately — this is the one mode that can spend a lot.
- **ultra runs hot** — it re-passes the full artifact set to every review/verify/repair agent, so per-agent spend is high and it overshoots the token cap more than focus/scale (the agent-count counter is the hard guarantee). For **implement** tasks the build agents may also write files — invoke it from the target directory.
