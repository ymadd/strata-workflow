# debug — `strata-debug` (how to call)

Root-cause debugging for a bug whose **cause is unknown**. It reproduces the symptom first, then runs rounds of **hypothesis → one discriminating experiment each**, stops as soon as an experiment CONFIRMS a cause, and only then writes a fix with a regression test. A fix is never attempted on an unconfirmed cause — that would be a guess.

```js
Workflow({
  scriptPath: "${CLAUDE_SKILL_DIR}/workflows/strata-debug.js",
  args: {
    task: "<symptom: what goes wrong, where, since when, error text>",
    repro: "<optional: a known command/test that shows it>",
    fix: true|false,                  // default true; false = diagnosis only (stop at the confirmed cause)
    maxHypotheses: <1-5>,             // per round, default 3
    rounds: <1-4>,                    // default 3
    dod: "<optional definition of done for the fix>",
    conversation: "<intent / what was already tried — subagents can't see this session>",
    cap: <number or omit>,            // default 200k
    tierHint: "cheap|hard",           // cheap = frame on sonnet; hard = verify on opus
  }
})
```

- **Flow:** REPRODUCE (sonnet, read-only, also reports `git status`) → per round: FRAME (opus: ranked hypotheses, each with ONE experiment — instrument, bisect, minimal repro, targeted test) → TEST all experiments in parallel (sonnet) → stop on the first `confirmed` → FIX (sonnet: regression test that fails first, then the fix, then prove it fails with the fix reverted) → adversarial VERIFY (sonnet, `hard` → opus), one retry fed with the failures → SYNTHESIZE (opus: root cause, evidence chain, residual risks). Synthesis always runs.
- **Experiment isolation:** on a CLEAN tree, experiments run in isolated git worktrees and may add temporary logging or bisect freely. On a DIRTY tree they run in place and must not edit tracked files — a worktree starts from HEAD and would drop the uncommitted change that may be the bug. The run reports `isolatedExperiments`.
- **Model roles:** repro/test/fix/verify = sonnet · frame/synth = opus. Effort pinned per role (frame/synth high, the rest medium).
- **Caps:** `MAX_AGENTS = clamp(floor(0.8*cap/14k), 5, 40)`, one slot reserved for synthesis; `rounds ≤ 4`, `maxHypotheses ≤ 5`, `FIX_ATTEMPTS = 2`.
- **debug vs research:** research answers an open question from web/data evidence; debug finds a defect in THIS code by running experiments. **debug vs delegate:** delegate executes a known change; debug is for when you don't yet know what to change. **debug vs focus:** focus finds and verifies issues on an unknown surface; debug chases one symptom to its cause.
- Returns `{ reproduced, isolatedExperiments, roundsRun, experiments[], confirmedCause, fix: {status, attempts, filesTouched, regressionTest}, verify, synthesis: {rootCause, confidence, evidenceChain, report, residualRisks, nextSteps} }`. `fix.status` ∈ `verified | failed-verification | unverified | not-attempted | no-confirmed-cause | not-requested`.
