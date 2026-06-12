# tiering-constants — the per-mode cap/tier header (common baseline vs intentional overrides)

The workflow runtime forbids `import`/`require`, so there is **no shared module**: every mode file owns its own header constants. That means the four cap-arithmetic constants are **physically duplicated** across files and are **intentionally non-uniform** — a higher default for the heavier modes, a wider roof for the scale-y ones. This file is the single place that records which values are the common baseline and which are deliberate overrides, so a recalibration (e.g. lowering `TOKENS_PER_AGENT` as models cheapen) stays coherent instead of silently diverging.

> This is a **maintainer reference**, not runtime config. The binding still lives in each mode's JS. When you change a constant, change it in every file the table says shares that value, and bump the plugin **version** so the whole bundle refreshes atomically (the cache is version-keyed; a partial update leaves modes enforcing different ceilings in one session).

## The four header constants

| Mode | `DEFAULT_CAP` | `TOKENS_PER_AGENT` | `AGENT_FLOOR` | `AGENT_ROOF` |
|------|--------------:|-------------------:|--------------:|-------------:|
| **focus** | 150k | 12k | 4 | 40 |
| **review** | 150k | 12k | 4 | 40 |
| **panel** | 150k | 12k | 4 | 40 |
| **debate** | 150k | 12k | 4 | 40 |
| **research** | 150k | 12k | 4 | 40 |
| **sweep** | **200k** | 12k | **6** | **120** |
| **ultra** | 150k | **16k** | **8** | **120** |
| **evolve** | **500k** | **16k** | **8** | **120** |
| **delegate** | **200k** | **16k** | 4 | **24** |
| **conduct** | **200k** | **16k** | **8** | **120** |

**Common-tier baseline** (the "restraint" family — change these together): `focus / review / panel / debate / research` = `150k / 12k / 4 / 40`.

**Intentional overrides** (do NOT normalize these away — they encode the mode's nature):
- **sweep** — `DEFAULT_CAP 200k` (a scale-y review of a whole codebase) and `ROOF 120` / `FLOOR 6` (it fans wider than the restraint family).
- **ultra** — `TOKENS_PER_AGENT 16k` (runs hot: re-passes context to workers/auditors), `FLOOR 8`, `ROOF 120`.
- **evolve** — `DEFAULT_CAP 500k` (autonomous development is a big, hot mode), `TOKENS_PER_AGENT 16k`, `FLOOR 8`, `ROOF 120`.
- **delegate** — `DEFAULT_CAP 200k` / `TOKENS_PER_AGENT 16k` (execution runs hot) but `ROOF 24`: depth-not-breadth — ≤6 sequential units × a short escalation ladder, never a fan-out. Additional literal caps: `MAX_UNITS 6`, `BASE_ATTEMPTS 2`, `APEX_ADVISE_PER_UNIT 1`, `APEX_BUILD_PER_UNIT 1` (the fable apex is spend-gated by construction).
- **conduct** — `DEFAULT_CAP 200k` / `TOKENS_PER_AGENT 16k` (execution runs hot) with `FLOOR 8` / `ROOF 120`: delegate's breadth twin — file-disjoint unit groups run in parallel. Additional literal caps: `MAX_UNITS 12`, `OPUS_UNIT_CAP = MAX_UNITS/3` (opus units stay a minority), `BASE_ATTEMPTS 2`, `DIAG_PER_UNIT 1`, `REBUILD_PER_UNIT 1` (the ladder tops out at opus), `ORCH_PLAN_MAX 1`, `ORCH_REVIEW_MAX 1` (the fable orchestrator is spend-gated by construction).

## Modes that use a different mechanism (no clamp formula)
- **scale** — no `AGENT_FLOOR`/`AGENT_ROOF`; the unit-list is truncated to `HARD_LIMIT = 950` and `COUNT` is the primary knob. Token throttle is `overCap()` (only when `args.cap` is set; otherwise `Infinity`).
- **grow** — `MAX_AGENTS = max(8, min(950, args.maxAgents ?? 150))`; the only token bound is the hard `budget.total` (`budget.remaining() <= 0`), so the agent count is the primary bound by design.

## Cross-cutting guarantees that ARE uniform (keep them identical across all files)
- `HARD_LIMIT = 950` lifetime backstop wherever present.
- The explicit-`maxAgents` override + `UNCAP_TOKENS` soft-budget lift (agent-cap-only ⇒ token budget lifted; a k/m cap re-imposes it).
- Severity/confidence-gated verify (CRITICAL/HIGH = 2 votes, else 1; fail-open on partial ballots).
- Every `agent()` declares a model from the mode's `TIER` map; opus only on plan/advise/judge/audit/synth/pm/director/ideate/frame/critic/systemic. **Two documented exceptions in `delegate`:** (a) `EXEC_MODEL` defaults to opus — it is a single-task executor (≤6 sequential units), not a bulk worker; (b) `fable` is allowed, but ONLY as `APEX_MODEL` (plan-packet / advise / clean-slate rebuild), capped at 1 advise + 1 rebuild per unit, and `dataSensitive===true` forces it to opus. **One documented exception in `conduct`:** `fable` is allowed ONLY as `ORCH_MODEL` (1 instruction packet + 1 integration review per RUN — never a unit executor, never in the escalation ladder, which tops out at opus); `dataSensitive===true` forces it to opus. These are the only two fable surfaces; both verifiers enforce containment mechanically.

If you ever add a shared-constant change, prefer updating this table in the same commit so the override rationale never drifts from the code.
