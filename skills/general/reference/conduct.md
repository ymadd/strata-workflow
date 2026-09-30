# conduct — `strata-conduct` (how to call)

Fable-**conducted** fan-out execution (the in-code form of `delegation-spec.md` §3 — the instruction-packet path, complementing `delegate`'s depth path). The orchestrator tier (**fable**) appears at exactly two endpoints — ONE instruction packet, ONE closing integration review — and never executes a unit. haiku scouts the surface, sonnet builds the bulk, opus takes the hard minority (≤1/3 of units, enforced in code) plus the escalation ladder (diagnosis-only → clean-slate rebuild). File-disjoint unit groups run in parallel; any unit without declared file ownership collapses the run to sequential (safe default — parallelism is earned by the packet).

```js
Workflow({
  scriptPath: "${CLAUDE_SKILL_DIR}/workflows/strata-conduct.js",
  args: {
    task: "<full task — the complete spec up front>",
    cap: <number or omit>,            // default 200k
    orch: "fable|opus",               // default fable; set opus during the credit window or to save cost
    dataSensitive: true|false,        // true FORCES orch=opus (Mythos-class 30-day retention + human-access logging)
    units: [{ id, title, tier: "sonnet|opus", own: [..], refs: [..], spec, acceptance }], // optional explicit packet (skips scout+plan)
    tierHint: "cheap|hard",           // cheap = packet prefers sonnet everywhere; hard = verify runs on opus
    sequential: true|false,           // force one sequential group even with disjoint ownership
    dod: "<verifiable definition of done>", // default: tests pass / lint clean / no public-behavior change
  }
})
```

- **Jev routing (optional, via the `strata-assist` mod):** when the mod is installed and a TypeSafe key is set, it injects `args.jev` before the run (never under `dataSensitive`). After the plan, ONE haiku relay calls the mod's `route` tool: Jev proposes a `(model, effort)` per build/verify unit from 5 arms (haiku/low · sonnet/low · sonnet/medium · opus/medium · opus/high). The script re-enforces the bands (never fable; verify ≥ sonnet; `tierHint:'hard'` → opus), keeps the planner tier unless Jev is confident (≥0.8) and blast radius is low (<2) for a downgrade; upgrades to opus count against `OPUS_UNIT_CAP`, and falls back to the static tiers on any failure. Decisions + Jev features go to `~/.claude/strata/routes.jsonl`; the run returns `routing`. Do not pass `jev` yourself — the mod sets it.
- **Role map (the strata):** scout=haiku (reads, never writes) · exec=sonnet default, opus for the hard minority (`OPUS_UNIT_CAP = MAX_UNITS/3`, demotion logged) · verify=sonnet (`tierHint:'hard'` → opus) · diagnose/rebuild=opus · **orchestrator=fable**, plan + review only.
- **Orchestrator spend is gated by literal counters:** `ORCH_PLAN_MAX=1`, `ORCH_REVIEW_MAX=1`. The ladder tops out at opus — fable never enters it. If the fable call dies (cost window, classifier fallback, unavailability), the run degrades to opus once and logs it.
- **Escalation ladder (per unit):** build+verify ×2 at the unit tier → opus **diagnose** (≤10-step plan, output-light) → guided retry → opus **rebuild** on a clean slate (failed patches reverted via `git restore`, scoped to the unit's `own` files). Literal caps: `DIAG_PER_UNIT=1`, `REBUILD_PER_UNIT=1`.
- **Parallelism via ownership:** the packet declares `own` (files each unit modifies); overlapping units serialize in one group, disjoint groups run concurrently. `MAX_UNITS=12` (breadth — vs delegate's 6 sequential).
- **conduct vs delegate:** conduct = many parallelizable units, orchestrated by a packet, ladder tops at opus; delegate = ONE deep task, sequential, with fable as the escalation apex. If the work won't split into file-disjoint units, use delegate.
- **conduct vs ultra:** conduct when the WHAT is clear and only needs splitting + parallel execution; `ultra` when the what itself needs design exploration (alternatives judged, completeness-grown units, open-ended deliverables).
- Returns `{ unitsDone, unitsFailed, unitsSkipped, orchestrator: {model, plans, reviews}, escalations, review: {verdict, issues}, units[], coverageNote }`. The report is assembled deterministically in code; the only synthesis is the single capped integration review.
