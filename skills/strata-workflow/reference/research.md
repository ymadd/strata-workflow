# research — `strata-research` (how to call)

Hypothesis-driven research automation — the **scientific method on a leash**. FRAME a question into testable hypotheses (opus) → INVESTIGATE each for confirming/refuting evidence (sonnet, **web-grounded by default**) → adversarially REFUTE the supported ones (sonnet, skeptic-biased) → SYNTHESIZE the surviving findings into a **cited conclusion** with explicit confidence and next experiments. A follow-up round frames NEW hypotheses from the open questions, until exhausted or the agent cap.

```js
Workflow({
  scriptPath: "${CLAUDE_SKILL_DIR}/workflows/strata-research.js",
  args: {
    question: "<the research question to investigate>",
    maxHypotheses: 4,                            // hypotheses per round (clamped; default 4)
    rounds: 3,                                   // follow-up rounds, loop-until-dry (clamped to 6; default 3)
    grounded: true,                              // web grounding ON by default (WebSearch/WebFetch + URLs)
    dataPath: "./data",                          // OR ground in local data via Bash/Read (when grounded:false)
    constraints: "<scope / out-of-bounds>",
    cap: 300000,                                 // or a bare maxAgents to cap by agent count
    tierHint: "cheap"                            // frame on sonnet (synth stays opus)
  }
})
```

- **Opus is only frame + synthesis; investigation and refutation run on sonnet.** Count per round = frame(1) + hypotheses × (investigate + gated refute); a final synth always runs (`canExplore` reserves its slot).
- **Confidence-gated refutation:** only `supported` / `partially-supported` hypotheses earn a skeptic — an already-unsupported one needs no refutation (same spirit as severity-gated verify). A hypothesis only `survives` if it holds under that scrutiny.
- **Web grounding:** investigators attach citable URLs; the refuter may re-check that sources actually say what is claimed. Unsourced claims count as unsupported.
- Returns `{ synthesis (conclusion, confidence, keyFindings+citations, openQuestions, nextExperiments), findings (per-hypothesis investigation + refute + surviving), survivingCount, roundsRun }`.
- **Distinct from `deep-research` (a web-search fan-out):** research is hypothesis-CENTRIC with a refutation gate — the web is one grounding source, not the spine. Use `deep-research` for a broad cited literature sweep; use `research` to test specific hypotheses.
- **Composes:** feed surviving findings into `debate` to stress-test them, or a `panel`/`research` conclusion into the next decision.
