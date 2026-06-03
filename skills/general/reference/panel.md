# panel — `strata-panel` (how to call)

For ONE problem with many valid approaches, where the value is **choosing the right design**, not producing volume. N contenders each design from a DISTINCT lens → an opus panel scores them on **caller-supplied axes** → an opus synthesis picks the winner and grafts the best runner-up ideas into a final, build-ready blueprint. Domain-agnostic: feature architecture, API design, library/skeleton selection, art direction.

```js
Workflow({
  scriptPath: "${CLAUDE_SKILL_DIR}/workflows/strata-panel.js",
  args: {
    problem: "<the ONE problem to solve>",
    contenders: 4,                              // N designs (clamped to fit the cap; default 4)
    lenses: [ /* distinct angles; omit for sensible defaults (simplicity/robustness/novel/pragmatic/perf/UX) */ ],
    axes: [ "extensibility", "security", "simplicity", "migration cost" ],  // how the panel judges; default {merit,simplicity,risk}
    advise: true,                               // opus brief injected into every contender (default on)
    constraints: "<hard constraints the panel penalizes>",
    artifactType: "architecture blueprint",     // what each contender produces (default "design / blueprint")
    cap: 150000
  }
})
```

- **Opus is the advise + judge + synth layer; the N contenders diverge on sonnet.** Count = N + judge(1) + synth(1) + advise(1 if on); bounded by the same agent counter.
- Returns `{ winnerIndex, verdict (ranked per-axis scores + strengths/weaknesses), synthesis (finalDesign, basedOnIndex, graftedFrom, implementationOutline), contenders }`.
- **Composes as a front stage:** hand `synthesis.finalDesign` to implementation, or to `strata-grow`/`strata-scale` to build it (e.g. panel picks an art direction → grow builds the sections).
- Distinct `lenses` are what stop the contenders collapsing onto one idea — keep them genuinely different.
