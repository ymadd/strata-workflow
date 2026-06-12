# delegate — `strata-delegate` (how to call)

Cost-tiered **execution** of one heavy task with a frontier apex (the in-code form of `delegation-spec.md`). Cheap-first: the builder runs on opus (or sonnet for prep units), a sonnet verifier gates the DoD adversarially, and the apex tier (**fable**) enters only on evidence of failure — first as a **diagnosis-only advisor**, then (at most once per unit) as a **clean-slate rebuilder**. Savings come from routing, not output suppression: all worker output is schema-bounded, diffs are never restated (review via `git diff`).

```js
Workflow({
  scriptPath: "${CLAUDE_SKILL_DIR}/workflows/strata-delegate.js",
  args: {
    task: "<full task — the complete spec up front>",
    cap: <number or omit>,            // default 200k
    apex: "fable|opus",               // default fable; set opus during the credit window or to save cost
    dataSensitive: true|false,        // true FORCES apex=opus (Mythos-class 30-day retention + human-access logging)
    planFirst: true|false,            // true = apex emits an instruction packet (≤6 units) before executing
    units: [{ id, title, tier: "sonnet|opus", refs: [..], spec, acceptance }], // optional explicit work-list (skips planFirst)
    tierHint: "cheap",                // cheap = builder runs on sonnet instead of opus
    dod: "<verifiable definition of done>", // default: tests pass / lint clean / no public-behavior change
  }
})
```

- **Escalation ladder (per unit):** build+verify ×2 at the base tier → apex **advise** (≤10-step plan, output-light) → guided retry → apex **rebuild** on a clean slate (failed patches reverted via `git restore`, no failure-history carryover). Literal caps: `APEX_ADVISE_PER_UNIT=1`, `APEX_BUILD_PER_UNIT=1`.
- **Charter exception, on purpose:** the default builder is **opus** — delegate is single-task execution (≤6 units, sequential), not bulk fan-out. The apex tier is never a unit default and never bulk; `fable` appears only as `APEX_MODEL`.
- **Apex fallback:** if the fable call dies (cost window, classifier fallback to Opus 4.8, unavailability), the run degrades to opus once and logs it — it never dies on tier availability.
- Units execute **sequentially** (they may share files; parallel builds would conflict). A packet larger than 6 units is a `scale`/`ultra` job, not a delegation.
- Returns `{ unitsDone, unitsFailed, unitsSkipped, apex: {model, advises, rebuilds}, units[], coverageNote }`. No synthesis agent — the deliverable is the executed work; the report is assembled deterministically in code.
- Adoption discipline: which task categories deserve `planFirst`/direct-apex is an **empirical** question — measure L2-vs-apex quality/turns/usage during the free window (see `delegation-spec.md` §7) before hard-wiring routing.
