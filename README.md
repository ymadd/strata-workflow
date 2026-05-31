# Strata Workflow

A **model-tiered, budget-bounded, multi-mode agent-orchestration skill** for [Claude Code](https://claude.com/claude-code).

> **Built on Claude Code's dynamic Workflows + ultracode** — the structured multi-agent fan-out you already know, re-engineered so it won't blow your token budget or run everything on the biggest model.

Strata keeps the value of structured multi-agent fan-out while fixing the two ways an unbounded "spawn agents for everything" approach goes wrong:

1. **Over-spawning that exhausts the session budget early.** Strata bounds spend by a literal **agent-count cap** derived from a token budget you choose at invocation.
2. **Running every subagent on the biggest model.** Strata **right-sizes every agent** like geological *strata* — cheap bulk on haiku/sonnet, with a thin opus layer reserved for planning, advising, judging, and auditing.

> The binding guarantees live in **code** (the bundled workflow scripts), not in prose — so they can't be argued out of their caps mid-run.

## Why

Fan-out is powerful but easy to overdo: a panel of opus agents on every task burns the budget and overpays for work a smaller model does just as well. Strata's thesis is *right-size the model, bound the spend* — a thin opus "bun" over cheap bulk, with a hard agent-count ceiling that no prompt can override.

## Modes

| Mode | Script | Use it when | Opus is used for |
|------|--------|-------------|------------------|
| **focus** | `strata-focus.js` | The search surface is unknown and you need cross-source synthesis (research / debug / scoping). | synthesis only |
| **review** | `strata-review.js` | You have a KNOWN change (git diff / PR / paths) and want a graded review — dimension reviewers → dedup → adversarial refute → verdict (approve / comment / request-changes). | the verdict only |
| **sweep** | `strata-sweep.js` | You want to audit the WHOLE codebase — map into risk-ranked units → pipelined per-unit review+verify → cross-codebase dedup → systemic/architectural critic → health grade with an honest coverage note. | systemic critic + synthesis |
| **panel** | `strata-panel.js` | ONE problem with many valid approaches — you want to *choose* the best design (architecture, API design, library selection, art direction). | advise + judge + synthesize |
| **scale** | `strata-scale.js` | A known work-list of N independent units (e.g. generate 500 components, transform N files). | advise pre-pass + audit |
| **grow** | `strata-grow.js` | A self-improving generation loop that grows toward a cap or a goal, auto-generating rounds (Plan → Build → Audit → Repair). | plan + advise + audit |
| **ultra** | `strata-ultra.js` | ONE substantial task taken end-to-end: understand → design → build → review → synthesize. ultracode's full arc that *dynamically* spawns agents where needed (opus advice / tie-breaks / completeness-grown units). Capped, or `unleashed`. | judge + advice + tie-break + critic + synthesize |
| **evolve** | `strata-evolve.js` | Autonomous, self-propagating development toward a vision: a **PM** (opus) owns the goal + ideation, a **Director** (opus) grows an EMERGENT phase plan and SUBDIVIDES important phases (spawning more agents) until the PM judges it done. Writes real files. | PM + Director + ideation + synthesize |
| _audit_ | `strata-audit.js` | A thin opus oversight layer that grades a large generated batch and returns systemic issues + a regenerate list. | grading + meta-critique |

**Shared DNA:** focus = few done smartly · review = one change scrutinized to a verdict · sweep = the whole codebase reviewed at scale · panel = many proposed, one chosen · scale = many done cheaply · grow = many grown cheaply while self-improving · ultra = one task done exhaustively, capped · evolve = an autonomous build that grows its own phase plan. `panel` *decides*; `scale`/`grow` *build*; `review` *judges a change*; `sweep` *audits the codebase*; `ultra`/`evolve` *do the most the cap allows* (ultra on a fixed arc, evolve on an emergent one). `focus` does the least. (focus vs review: *unknown surface, cheap haiku exploration* vs *known change, deep sonnet scrutiny + dedup + verdict*.)

## Model tiering

Every `agent()` call declares a model; implicit "inherit the big model" is treated as a bug.

- **FIND / EXTRACT / FORMAT / CLASSIFY → haiku**
- **TRACE / WRITE-CODE / VOTE / DRAFT / REVISE → sonnet**
- **SYNTHESIZE / JUDGE / ROOT-CAUSE / PLAN / ADVISE / AUDIT → opus** (a few stages per run)

A bigger token budget buys *more agents*, never a bigger per-agent model.

## Install

Strata ships as a **Claude Code plugin** (this repo is also its own marketplace), and the same skill works **standalone** if you prefer. Pick one.

### As a plugin (recommended)

```
/plugin marketplace add ymadd/strata-workflow
/plugin install strata-workflow@strata-workflow
```

The first command registers this repo as a marketplace; the second installs the plugin (`<plugin>@<marketplace>`). Claude Code auto-discovers the bundled skill.

### As a standalone skill

Clone the skill directory straight into where Claude Code looks for skills:

```bash
# user-level (available in every project)
git clone https://github.com/ymadd/strata-workflow /tmp/strata && \
  cp -R /tmp/strata/skills/strata-workflow ~/.claude/skills/strata-workflow

# OR project-level (available in one repo)
cp -R /tmp/strata/skills/strata-workflow <your-repo>/.claude/skills/strata-workflow
```

Requires Claude Code with the **Workflow** tool available. No external dependencies, no build step — the skill is self-contained: the workflow scripts carry their own guards, and SKILL.md references them via `${CLAUDE_SKILL_DIR}`, so the same files work in either install mode.

## Usage

Invoke the skill and, optionally, lead with a token budget that derives all the caps:

```
/strata-workflow 300k <your task>
```

- The leading `300k` (or `120k`, `1m`, …) is read as the **token cap**; default is `150k`.
- From it Strata derives `MAX_AGENTS = clamp(floor(0.8 * cap / 12k), 4, 40)` for focus/review/panel (sweep/ultra/evolve use a ≤120 roof; grow takes an explicit `maxAgents`; scale uses `HARD_LIMIT=950` unit-list truncation).
- The token cap is *approximate*; the **agent-count counter is the hard guarantee**.

The skill picks a mode via a deliberate gate (default: do the least — solo, or a small fan-out only when breadth-of-evidence justifies it), then calls the matching workflow. See [`SKILL.md`](./skills/strata-workflow/SKILL.md) for the full model-facing specification, the gate, the per-mode call signatures, and the Goal-alignment flow used by `grow`.

## How it works

- **Primary guard — a literal agent counter** that needs no API and cannot fail: checked before every spawn.
- **Model tiering** applied as a role→model map on every agent.
- **Severity-gated verification** (e.g. 2 votes for CRITICAL/HIGH findings, 1 otherwise) instead of a flat N-reviewer panel.
- **Budget is a secondary, best-effort guard** — read relative to a start baseline and wrapped so an inert or throwing budget API never breaks a run.

## Repository layout

```
strata-workflow/                    # repo root — also its own plugin + marketplace
├── .claude-plugin/
│   ├── plugin.json                 # plugin manifest
│   └── marketplace.json            # marketplace listing (single-plugin)
├── skills/
│   └── strata-workflow/
│       ├── SKILL.md                # lean router: the gate, cap math, tiering rules (small, always-loaded)
│       ├── reference/              # per-mode call signatures — read on demand, not into context
│       │   ├── focus.md   review.md   sweep.md    panel.md
│       │   ├── scale.md   grow.md     ultra.md    evolve.md
│       └── workflows/
│           ├── strata-focus.js     # find → verify → synthesize
│           ├── strata-review.js    # code review of a change: dimension reviewers → dedup → refute → verdict
│           ├── strata-sweep.js     # codebase-wide review: map → risk-ranked units → systemic critic → grade
│           ├── strata-panel.js     # design tournament: diverge → judge → synthesize
│           ├── strata-scale.js     # advise → build (×N) → audit → repair
│           ├── strata-grow.js      # self-improving / goal-driven progressive loop
│           ├── strata-ultra.js     # full task arc: understand → design → build → review → synthesize
│           ├── strata-evolve.js    # autonomous self-propagating dev: PM + Director grow an emergent phase plan
│           └── strata-audit.js     # opus oversight: grade a batch, return systemic issues
├── README.md                       # this file
└── LICENSE
```

The workflow scripts are plain JavaScript executed by Claude Code's Workflow runtime (no Node.js APIs; top-level `await`/`return` allowed). Each is self-contained and can be invoked directly via `Workflow({ scriptPath, args })`. **Progressive disclosure:** SKILL.md stays a small, always-loaded router; each mode's full call signature lives in `reference/<mode>.md` and is read only when that mode runs — so adding modes doesn't grow per-activation context. Both SKILL.md and the references point at scripts via `${CLAUDE_SKILL_DIR}/...` so paths resolve in both plugin and standalone installs.

## Built on dynamic Workflows + ultracode

Strata stands on the best of Claude Code's orchestration stack and sharpens it:

- **Claude Code's dynamic Workflows** — every Strata mode is a dynamic workflow script on the `Workflow` runtime (`agent()`, `pipeline()`, `parallel()`, `phase()`, `budget`). You get deterministic fan-out, streaming progress, and structured outputs out of the box.
- **ultracode** — Strata takes ultracode's structured fan-out (decompose → fan out → adversarially verify → synthesize) and makes it *affordable*: where ultracode treats token cost as no constraint and leans on the biggest model, Strata bounds spend by a hard agent-count cap and right-sizes every agent's model. Same orchestration power, a fraction of the burn.

## License

[MIT](./LICENSE) © 2026 yamato kobayashi
