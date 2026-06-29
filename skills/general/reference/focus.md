# focus — `strata-focus` (how to call)

Restraint mode (the default). When the search surface is unknown AND cross-source synthesis is needed AND correctness warrants a verify panel: run a small **find → verify → synthesize**. One cheap haiku scout per dimension, severity-gated adversarial verify on sonnet, opus only for the final synthesis.

```js
Workflow({
  scriptPath: "${CLAUDE_SKILL_DIR}/workflows/strata-focus.js",
  args: {
    task: "<full task>", taskClass: "review|research|implement|migrate", cap: <number or omit>, tierHint: "cheap|normal|hard",
    // ── grounding context (both optional; injected into scouts, refuters, and the synthesis) ──
    conversation: "<the dialogue/intent behind the task>",  // caller-supplied (subagents can't see the parent session)
    conventions: true,  // OPT-IN here (focus is general, not code-locked): true = scouts consult CLAUDE.md/AGENTS.md;
    //                      a string = use it verbatim; omitted/false = off. When present, an "adherence" lens is added.
  }
})
```

- Omit `cap` and the script uses 150k.
- `taskClass` selects the default investigation dimensions (review → correctness/security/performance/tests; research → primary-sources/counter-evidence/recency/consensus; etc.); override with `dimensions: [...]`.
- **Grounding is opt-in here** (unlike code-locked review/sweep which auto-read `CLAUDE.md`): focus also runs non-code tasks (research/migrate), so it never auto-reads convention docs. Pass `conversation` to judge intent-fidelity, and `conventions: true` (or a string) when the task IS about a codebase and you want convention adherence checked.
- Returns `{ findings (confirmed, severity-sorted), synthesis (answer, residualRisks, coverageNote) }`.
- This is the only mode the 3-way GATE's "FULL TEMPLATE" branch calls. For a known work-list use `scale`; for a known change use `review`.
