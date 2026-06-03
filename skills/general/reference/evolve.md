# evolve — `strata-evolve` (autonomous, self-propagating development) — how to call

For autonomously building toward a user's vision while *generating ideas* to make it better. A **PM (opus)** owns the "what/why" — turns the vision into a charter, selects which bold ideas to fold in, and is the **goal-critic**. A **DIRECTOR (opus)** owns the "how" — drafts an **emergent** phase plan (not a fixed arc) and, at each phase audit, decides **PASS / SUBDIVIDE / REPAIR**. SUBDIVIDE splits an important-or-risky phase into finer sub-phases and spawns MORE agents — the plan grows itself. Sonnet workers build the real artifacts each phase. Stops when the PM judges the vision met, or the agent cap / budget is hit.

> **Decide the goal first.** This is the highest-stakes mode — it self-propagates and writes real files. Agree a **Goal Contract** with the human (see grow's "Step 0 — Goal alignment" in `reference/grow.md`) and pass it as `goal` before launching; in `unleashed` runs especially, confirm scope first.

```js
Workflow({ scriptPath: "${CLAUDE_SKILL_DIR}/workflows/strata-evolve.js", args: {
  vision: "<what the user wants to build, in their words>",
  root: ".",                                  // workers write real files here — invoke from the target dir
  goal: { objective, doneCriteria },          // optional explicit Goal Contract (PM honors it)
  ideation: "bold",                           // "bold" (propose new directions, default) | "conservative" (spec-faithful)
  maxDepth: 3,                                // how deep a phase may be recursively SUBDIVIDED (self-propagation backstop)
  maxPhases: 40,                              // hard backstop on total phases run
  maxRepairs: 2,                              // per-phase repair cap (default 2) so one failing phase can't starve the queue
  cap: 500000,                                // derives MAX_AGENTS (roof ≤120). bigger cap = more phases / subdivision fire
  unleashed: false,                           // true = ignore the cap entirely (see ultra.md); the 950 backstop still holds
  maxAgents: 0,                               // optional explicit override / safety bound
  tierHint: "cheap|normal|hard"               // cheap → ideation on sonnet (pm/director judgment stays opus)
} })
```

- **Roles:** PM = "are we building the right thing?" (charter, idea selection, vision checks, goal-critic). Director = "are we building it well?" (plan, subdivide, allocate, repair). Workers = sonnet build; a cheap sonnet grade feeds each audit. **Opus is the two overseers + ideation + final synthesis only.**
- **Self-propagation, bounded:** SUBDIVIDE inserts finer sub-phases at `depth+1` (only while `depth < maxDepth`); the PM can append downstream phases (REVISE). The literal agent counter (≤950), `maxPhases`, `maxDepth`, and the budget all bound the growth — it cannot expand forever.
- **Writes real files** under `root`. Treat like ultra-implement: invoke from the target directory; it is the one mode that both spawns autonomously AND mutates the filesystem.
- Returns `{ charter, adoptedIdeas, phasesRun, phasesUnrun, goalMet, residual, evolution (how the plan grew), artifacts (per-phase manifests), synthesis (deliverableSummary, healthGrade, evolutionLog, openItems, coverageNote) }`.
- **vs ultra:** ultra runs a FIXED arc (understand→design→build→review→synth) and is dynamic *within* it; evolve's PHASES THEMSELVES are created and mutated by the PM+Director. **vs grow:** grow repeats a fixed round shape and grows the *count* of generated units; evolve grows the *plan*. Reach for evolve when the work is "build this product, and figure out the right phases as you go."
