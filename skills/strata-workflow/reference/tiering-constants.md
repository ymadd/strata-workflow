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

**Common-tier baseline** (the "restraint" family — change these together): `focus / review / panel / debate / research` = `150k / 12k / 4 / 40`.

**Intentional overrides** (do NOT normalize these away — they encode the mode's nature):
- **sweep** — `DEFAULT_CAP 200k` (a scale-y review of a whole codebase) and `ROOF 120` / `FLOOR 6` (it fans wider than the restraint family).
- **ultra** — `TOKENS_PER_AGENT 16k` (runs hot: re-passes context to workers/auditors), `FLOOR 8`, `ROOF 120`.
- **evolve** — `DEFAULT_CAP 500k` (autonomous development is a big, hot mode), `TOKENS_PER_AGENT 16k`, `FLOOR 8`, `ROOF 120`.

## Modes that use a different mechanism (no clamp formula)
- **scale** — no `AGENT_FLOOR`/`AGENT_ROOF`; the unit-list is truncated to `HARD_LIMIT = 950` and `COUNT` is the primary knob. Token throttle is `overCap()` (only when `args.cap` is set; otherwise `Infinity`).
- **grow** — `MAX_AGENTS = max(8, min(950, args.maxAgents ?? 150))`; the only token bound is the hard `budget.total` (`budget.remaining() <= 0`), so the agent count is the primary bound by design.

## Cross-cutting guarantees that ARE uniform (keep them identical across all files)
- `HARD_LIMIT = 950` lifetime backstop wherever present.
- The explicit-`maxAgents` override + `UNCAP_TOKENS` soft-budget lift (agent-cap-only ⇒ token budget lifted; a k/m cap re-imposes it).
- Severity/confidence-gated verify (CRITICAL/HIGH = 2 votes, else 1; fail-open on partial ballots).
- Every `agent()` declares a model from the mode's `TIER` map; opus only on plan/advise/judge/audit/synth/pm/director/ideate/frame/critic/systemic.

If you ever add a shared-constant change, prefer updating this table in the same commit so the override rationale never drifts from the code.
