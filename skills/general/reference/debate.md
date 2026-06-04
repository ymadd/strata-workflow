# debate — `strata-debate` (how to call)

For pressure-testing ONE proposition where the value is **stress-testing a claim**, not picking among designs. Each position drafts an opening case → R rounds of **adversarial rebuttal** sharpen the disagreement → an opus moderator extracts the points that **survived rebuttal** and the unresolved **cruxes** → an opus synthesis returns an integrated, reasoned verdict (not winner-take-all). Domain-agnostic: strategy go/no-go, bull vs bear, build vs buy, two research hypotheses in tension.

```js
Workflow({
  scriptPath: "${CLAUDE_SKILL_DIR}/workflows/strata-debate.js",
  args: {
    proposition: "<the ONE claim/question to debate>",
    positions: [ "PRO — argue FOR", "CON — argue AGAINST" ],  // 2–4 stances; default PRO/CON
    rounds: 2,                                   // rebuttal rounds (clamped to fit the cap; default 2)
    axes: [ "evidential strength", "logical soundness", "addresses the strongest counter" ], // how the moderator judges
    grounded: false,                             // true → sides cite web sources via WebSearch/WebFetch
    constraints: "<context the debaters must respect>",
    cap: 150000,                                 // or a bare maxAgents to cap by agent count
    tierHint: "hard"                             // promote BOTH argue + rebut to opus when stakes are very high (ablation: the lift comes from opus on the rebuttal step)
  }
})
```

- **Opus is only the moderator + synthesis; the positions argue/rebut on sonnet.** Count = positions × (1 opening + R rebuttals) + judge(1) + synth(1); bounded by the same agent counter (`canArgue` reserves the back two slots).
- **Survival-gated like refute:** a claim only counts as "surviving" if it was actually tested and held — the moderator separates `survivingPoints` from `refutedPoints` per position.
- Returns `{ verdict (perPosition survivingPoints/refutedPoints + cruxes), synthesis (conclusion, confidence, cruxes, recommendation), transcript }`.
- **Distinct from `panel`:** panel judges N *independent* designs in parallel; debate runs an *adversarial exchange* on one proposition, so positions answer each other round to round.
- **Composes:** feed a `panel` winner or a `research` conclusion into debate to adversarially stress-test it before committing.
