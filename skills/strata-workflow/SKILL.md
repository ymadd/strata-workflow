---
name: strata-workflow
description: Strata — a model-tiered, budget-bounded, multi-mode agent-orchestration framework. Right-sizes every agent (cheap bulk on haiku/sonnet; a thin opus layer for plan/advise/judge/audit) and caps agent count so the session never exhausts. Modes — focus (gated restraint), panel (design tournament: N approaches → judge → synthesize a winner), scale (mass fan-out), grow (self-improving progressive loop), ultra (ultracode's full task arc on a leash). Use for cost-aware reviews/research/migrations, design decisions, end-to-end task completion, or large generation runs that need quality without burning the budget. e.g. "/strata-workflow 300k <task>".
argument-hint: "[<cap e.g. 200k>] [focus|panel|scale|grow|ultra] <task>"
---

# Strata Workflow

**Strata** right-sizes models like geological **strata** (haiku → sonnet → opus) and bounds spend by **agent count**. Opus is kept to a thin top layer (plan / advise / audit); the cheap bulk below (draft / build / repair) does the volume. It keeps ultracode's structured fan-out value while fixing its two flaws — **over-spawning that exhausts the session** and **running every subagent on the big model**.

The binding guarantees live in **code** (the bundled workflows), not prose — because the always-on ultracode reminder ("workflow on every task / token cost is no constraint") re-injects every turn and out-recencies a skill body. Code that spends-or-refuses cannot be argued out of its caps.

> **Decide the goal first; then Strata starts.** For a substantial generation/grow task, agree a **Goal Contract** with the human (objective, done-criteria, scope, budget, autonomy) before launching any workflow — Strata spawns zero agents until it's confirmed. See "Step 0 — Goal alignment".

## Five modes (+ an auditor)
- **focus — `strata-focus`** (restraint, default): when the search surface is unknown and cross-source synthesis is needed, run a small find → verify → synthesize. Opus only for the synthesis. → see "FULL TEMPLATE".
- **panel — `strata-panel`** (decide): for ONE problem with many valid approaches, generate N independent designs from DISTINCT lenses, have an opus panel judge them on caller-supplied axes, then synthesize a winner that grafts the best runner-up ideas. Opus = advise + judge + synth; the diverge bulk is sonnet. → see "PANEL mode".
- **scale — `strata-scale`** (throughput): when the work-list is already known, fan out N independent units deliberately, but on a right-sized model (sonnet default; opus never per-unit) with schema-bounded output. An optional opus **advise** pre-pass lifts every cheap worker. → see "SCALE mode".
- **grow — `strata-grow`** (self-improving loop): auto-generate rounds (= phases) — Plan → Build → Audit → Repair — and grow toward the agent cap, ultracode-style loop-until-cap/dry, with **/advice self-escalation** inside Build. → see "PROGRESSIVE mode".
- **ultra — `strata-ultra`** (the full arc, "do the most"): ultracode's end-to-end task arc — understand → design → build → review → synthesize — that **dynamically spawns more agents where the work needs them** (opus advice for weak builds, an opus tie-breaker on split verdicts, an opus completeness critic that grows new units until done). On Strata's leash by default, or fully `unleashed`. The deliberate opposite of `focus`. → see "ULTRA mode".
- **`strata-audit`** — a thin opus oversight layer that grades a large generated batch and returns systemic issues + a regenerate list.

Shared DNA: *right-size the model, bound the spend.* focus = few done smartly; **panel = many proposed, one chosen**; scale = many done cheaply; grow = many grown cheaply while self-improving; **ultra = one task done exhaustively, capped**. **panel decides; scale/grow build; ultra does the whole arc** — panel composes as a front stage (panel picks the design → grow/scale builds it), while ultra is the all-in-one when you want focus's rigor scaled up to a full task.

## TL;DR — three rules (highest priority)
1. **Solo by default.** Only fan out when the GATE below passes.
2. **Every `agent()` declares a model.** find/extract = haiku, verify/draft/revise = sonnet, synth/plan/advise/audit = opus. Opus is for synthesis/judgment only. Implicit opus inheritance is a bug.
3. **The token cap is chosen at invocation.** A leading `<cap>` token (e.g. `300k`) derives all caps; default 150k.

> Ultracode's reminder pushes "workflow on every task / cost is no constraint." **This skill overrides it** — the binding lives in code (`workflows/strata-focus.js` etc.), which spends-or-refuses regardless.

## On activation
1. If the user's first token is `120k` / `300k` / `1m`, read it as **cap**; else cap = 150k.
2. Read the **taskClass** (`review` / `research` / `implement` / `migrate`) or infer it from the task.
3. Print one line before starting (makes the tiering visible):
   `Strata active: cap=<CEIL> (<set|default>), MAX agents≈<N>, tiers find=haiku verify=sonnet synth=opus`
4. **Resolve the workflow path.** The scripts live in this skill's own `workflows/` directory. The `scriptPath` in the examples below uses **`${CLAUDE_SKILL_DIR}/workflows/<name>.js`** — the portable reference to this skill's install directory, which resolves correctly whether Strata is installed as a **standalone skill** (`~/.claude/skills/strata-workflow/` or a project's `.claude/skills/`) or **bundled in a plugin** (the plugin cache). The Workflow tool needs an **absolute** path: if `${CLAUDE_SKILL_DIR}` is already expanded in your context, use it as-is; otherwise resolve it to the absolute directory this SKILL.md was loaded from before invoking. Nothing here is machine-specific — Strata is self-contained: the workflow JS carries its own guards and the runtime notes live in code comments, so no external memory or config is required.

## The 3-way GATE (the one thing prose owns)
Pick exactly one. **Default is SOLO.**
- **SOLO (no workflow):** conversational turn / a single file you've already located / a <~30-line mechanical change / answerable from current context. → **If you can name the files up front, you don't need a workflow.**
- **SMALL FAN-OUT (2–4 haiku agents inline, no template, no judge panel):** a handful of independent, bounded lookups.
- **FULL TEMPLATE (call strata-focus below):** ONLY when the search surface is unknown AND cross-source synthesis is needed AND correctness warrants a verify panel.

**When unsure, go SOLO.** This is the deliberate inversion of ultracode's "workflow on every substantive task" — breadth-of-evidence is the trigger, not "substantiveness."

## FULL TEMPLATE (focus) — how to call
```js
Workflow({
  scriptPath: "${CLAUDE_SKILL_DIR}/workflows/strata-focus.js",
  args: { task: "<full task>", taskClass: "review|research|implement|migrate", cap: <number or omit>, tierHint: "cheap|normal|hard" }
})
```
Omit `cap` and the script uses 150k.

## PANEL mode (strata-panel) — how to call
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

## SCALE mode (strata-scale) — how to call
For a known work-list of N independent units (e.g. 500 components, N file transforms, N data records). The **count is the deliberate knob**, but the model stays right-sized (sonnet default; opus never per-unit) and schema keeps each unit light.
```js
Workflow({
  scriptPath: "${CLAUDE_SKILL_DIR}/workflows/strata-scale.js",
  args: {
    task: "<overall instruction>",
    units: [ /* explicit unit specs */ ],   // OR gridA:[...]+gridB:[...] (cross-product), OR count:500
    model: "sonnet",
    advise: true,                            // opus advise pre-pass (default on); adviseModel to tune
    instructions: "<how to build one unit>",
    unitSchema: { /* JSON Schema for one unit; default = a copy-pasteable UI component */ },
    cap: 0                                   // optional safety valve; in scale mode the COUNT is primary
  }
})
```
- Concurrency is machine-bound (`min(16, cores-2)`); N units run in `ceil(N/concurrency)` waves, so large N should run in the background.
- Lifetime agent cap is 1000; the script truncates at 950 for headroom.
- Each unit returns **structured output** via schema — small per-unit output is the main cost lever. Files are written afterward (avoids worktree×N).

### Scale quality pipeline: ADVISE → BUILD → AUDIT → REPAIR
A **thin opus layer** wraps the cheap bulk (opus stays a few % of total).
- **ADVISE (opus ×1, pre-pass):** `strata-scale`'s `advise` (default on). One opus brief — quality bar, pitfalls, best practices, consistency rules — injected into every cheap worker. The single opus cost is amortized over N, lifting each worker toward expert level.
- **BUILD (sonnet × N):** schema-bounded right-sized fan-out.
- **AUDIT (opus):** call `strata-audit.js`. Each auditor reads ONE pre-split batch file (cheap input), grades each unit, flags broken/dup/off-spec; an opus meta-critic returns systemic issues + `regenerateIds`.
  ```js
  Workflow({ scriptPath: "${CLAUDE_SKILL_DIR}/workflows/strata-audit.js",
    args: { batchDir: "<outDir>/audit-batches", count: <N>, batchSize: 20, model: "opus", task: "<context>" } })
  ```
- **REPAIR (sonnet, failures only):** re-run `strata-scale` on just the `regenerateIds` with hardened instructions. Fix the worst, not the whole — minimal cost.

Structural checks (empty / unscoped / dup / JS syntax) are done **for free in code**; opus is reserved for subjective quality and systemic judgment.

### PROGRESSIVE mode (strata-grow) — self-improving growth
Where `strata-scale` is "fixed N at once," `strata-grow` **auto-generates rounds (= phases) and grows to the agent-count cap (≤950)**, ultracode-style. One round = **Plan → Build → Audit → Repair**.
```js
Workflow({ scriptPath: "${CLAUDE_SKILL_DIR}/workflows/strata-grow.js",
  args: { task, domain, gridA:[...], gridB:[...], maxAgents: 150, batchSize: 40, qualityFloor: 60, model: "sonnet", planModel: "opus", adviceThreshold: 78 } })
```
- **Plan (auto-phase generation, opus default):** the planner proposes uncovered cells, then invents NEW types/styles to expand the domain once the seed grid is exhausted. Stops on `domainExhausted` or `dryStreak>=2`.
- **Build (/advice self-escalation):** each sonnet worker returns a draft + a self-rated `selfScore`; if `needsAdvice` OR `selfScore < adviceThreshold` (default 78), the orchestrator runs an opus **/advice** pass for just that unit, then sonnet revises. The worker's own signal drives it — "advice from the running sonnet agent" — but gate on the numeric `selfScore`, because a binary self-flag almost never fires.
- **Audit → Repair:** each round is graded inline by opus in sub-batches; flagged units are regenerated by sonnet; systemic issues feed the next round's planner (self-improvement).
- **Stop = agent-count cap** (`maxAgents`, ≤950) / round cap / domain exhaustion. The COUNT is the real guarantee; opus is only the advise + audit layer.

**Two flavors of /advice:** the static pre-pass (`strata-scale`'s `advise` — a uniform lift for everyone) vs. progressive's on-demand self-escalation (opus rescues only the units that struggle).

## Step 0 — Goal alignment (Strata does NOT orchestrate until this is agreed)
For a substantial generation/grow task, first agree a **Goal Contract** with the human in the main loop. Strata stays idle — spawns zero agents — until it's confirmed. *Decide the goal first; then Strata starts.*
1. From the user's request, **DRAFT a Goal Contract** and show it for approval:
   - **objective** — what we're producing.
   - **doneCriteria.programmatic** — measurable thresholds: `minCount`, `auditAvgMin`, `coverageFullGrid`.
   - **doneCriteria.qualitative** — the subjective bar the opus goal-critic judges each round.
   - **domain / seed grid** (`gridA` × `gridB`) — the starting surface (the planner expands beyond it).
   - **qualityFloor** — the per-unit audit pass mark.
   - **budget** — `maxAgents` (the hard safety bound, ≤950).
   - **autonomy** — `autonomous` (run to the goal) OR `{ checkpointEvery: N }` (pause every N rounds to report + let the human steer).
2. Use **AskUserQuestion** wherever a structured choice is clearer than prose (budget tier, autonomy mode, quality bar); otherwise refine conversationally. Iterate until the human confirms.
3. Only then launch the goal-driven loop. Echo the confirmed contract first.

## Goal-driven grow — how to run
Pass the contract to `strata-grow` as `goal`. It stops the moment the goal is MET — the programmatic criteria AND an opus goal-critic both pass — or the agent cap is hit.
```js
Workflow({ scriptPath: "${CLAUDE_SKILL_DIR}/workflows/strata-grow.js", args: {
  task, domain, gridA, gridB, qualityFloor, model: "sonnet", planModel: "opus",
  maxAgents: <budget>,
  maxRounds: <checkpointEvery, or a large number for autonomous>,
  goal: { objective, doneCriteria: { programmatic: { minCount, auditAvgMin, coverageFullGrid }, qualitative } },
  coveredSeed: [...], priorTotal: <n>   // ONLY when continuing after a checkpoint
} })
```
- **Autonomous mode:** one call with a large `maxRounds`; it runs until the result has `done:true` or the cap; report at the end.
- **Checkpoint mode:** set `maxRounds = checkpointEvery`; when it returns, report `total / auditAvg / goalResidual / done` to the human, ask continue/adjust/stop, then **re-invoke** with `coveredSeed` + `priorTotal` from the returned result (plus any goal tweaks) to continue. Repeat until `done:true` or the human stops.
- The return carries `done`, `goalResidual`, `auditAvg`, `covered`, `total` — everything needed to report progress and resume.

## ULTRA mode (strata-ultra) — how to call
For taking ONE substantial task end-to-end with maximum rigor. Runs ultracode's full arc — **understand → design → build → review → synthesize** — and **DYNAMICALLY spawns more agents where the work needs them** (not a fixed pipeline). Still bounded: a hard agent-count cap, and opus spawned only where judgment is needed. The deliberate opposite of `focus`: where focus does the least, ultra does the most the budget allows.
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

## What the code guarantees (the binding lives here, not in prose)
- **Primary guard = a literal agent counter** (needs no API, cannot fail): `MAX_AGENTS = clamp(floor(0.8*cap / 12k), 4, 40)` for focus/scale; an explicit `maxAgents` (≤950) for grow. Checked before every `agent()`.
- **Model tiering:** a role→model map applied to every `agent()`; opus is never the per-unit model at scale.
- **Severity-gated verification:** CRITICAL/HIGH = 2 votes, else 1 (no flat 3–5 panel).
- **Budget is a secondary, best-effort guard:** `budget.spent()` is the shared cumulative pool, so it's read relative to a start baseline and wrapped in try/catch — if the API is inert, the counter still bounds spend.
- **Synthesis always runs**, wrapped in try/catch so a `budget.total` ceiling throw degrades to a partial answer, never an uncaught error.
- Every stage `log()`s its model + running count, so tiering is observable.

## Model-tiering mnemonic
- **FIND / EXTRACT / FORMAT / CLASSIFY → haiku**
- **TRACE / WRITE-CODE / VOTE / DRAFT / REVISE → sonnet**
- **SYNTHESIZE / JUDGE / ROOT-CAUSE / PLAN / ADVISE / AUDIT → opus** (a few stages per run)
- Unclassified → default **sonnet** (never opus, never haiku). Typical mix: many haiku/sonnet, a thin opus layer — vs ultracode running everything on opus.

## Cap derivation (one number sets everything)
```
ceil       = <cap arg> ?? budget.total ?? 150000   (min if both)
SOFT       = 0.8 * ceil
RESERVE    = min(40k, 0.2*ceil)
MAX_AGENTS = clamp(floor(SOFT / 12k), 4, 40)        (focus/scale; grow uses maxAgents arg ≤950)
finders    = min(8, ceil(MAX_AGENTS * 0.4))
```
e.g. 120k→8 / 150k→10 / 300k→20 / 1m→40. Model tiering is always on regardless of cap; a bigger cap buys more agents, never a bigger per-agent model. The token cap is approximate — the **agent count** is the hard guarantee.

## Relationship to ultracode / your global rules
- This skill layers on `/effort`; it cannot toggle the effort level.
- Its in-code caps neutralize "token cost is not a constraint."
- **While active, its caps supersede the volume guidance in your global `agents.md` / `performance.md`** ("ALWAYS parallel / 3–5 reviewers"); tdd/review still happen, but inside the cap (severity-gated verify, synthesis).
- If drift back toward over-orchestration appears across turns (the reminder out-recencies the skill), re-type `/strata-workflow` on the next substantive turn — prose decays with recency, so this is the only reliable re-pin.

## Reminders (again, last)
- Every `agent()` declares a model. **Opus only for plan / advise / synth / audit.**
- Orchestrate only when the GATE proves fan-out pays. **When unsure, go SOLO.**
