---
name: general
description: Strata — a model-tiered, budget-bounded, multi-mode agent-orchestration framework. Right-sizes every agent (cheap bulk on haiku/sonnet; a thin opus layer for plan/advise/judge/audit) and caps agent count so the session never exhausts. Modes — focus (gated restraint), review (code review over a changeset: dimension reviewers → dedup → refute → verdict), sweep (codebase-wide review at scale: map → risk-ranked units → systemic critic → health grade), panel (design tournament: N approaches → judge → synthesize a winner), debate (dialectic stress-test of one proposition: positions → adversarial rebuttal rounds → moderator → integrated verdict), research (hypothesis-driven automation: frame → investigate web-grounded → refute → cited synthesis), scale (mass fan-out), grow (self-improving progressive loop), ultra (ultracode's full task arc on a leash), evolve (autonomous self-propagating development: a PM + Director grow an emergent phase plan). Use for cost-aware reviews/research/decisions/migrations, design decisions, end-to-end task completion, autonomous builds, or large generation runs that need quality without burning the budget. e.g. "/strata-workflow:general 300k <task>".
argument-hint: "[mode] [domain] [cap] <task>  ·  bare = mode menu"
---

# Strata Workflow

**Strata** right-sizes models like geological **strata** (haiku → sonnet → opus) and bounds spend by **agent count**. Opus is kept to a thin top layer (plan / advise / audit); the cheap bulk below (draft / build / repair) does the volume. It keeps ultracode's structured fan-out value while fixing its two flaws — **over-spawning that exhausts the session** and **running every subagent on the big model**.

The binding guarantees live in **code** (the bundled workflows), not prose — because the always-on ultracode reminder ("workflow on every task / token cost is no constraint") re-injects every turn and out-recencies a skill body. Code that spends-or-refuses cannot be argued out of its caps.

> This SKILL.md is a **lean router**: the GATE, the cap math, and the tiering rules below are everything you need to *decide*. Each mode's full call signature lives in **`reference/<mode>.md`** — read that one file only when you're about to call that mode (progressive disclosure keeps activation context small as modes grow).

## Ten modes (+ an auditor) — pick one, then read its reference
| Mode | One-liner | Reference |
|------|-----------|-----------|
| **focus** | restraint (default): unknown surface → small find → verify → synthesize. Opus = synth only. | `reference/focus.md` |
| **review** | scrutinize a KNOWN change (diff/PR/paths): dimension reviewers → dedup → refute → **verdict**. Opus = verdict only. | `reference/review.md` |
| **sweep** | review at scale: map the WHOLE codebase into risk-ranked units → pipelined review+verify → cross-codebase dedup → **systemic critic** → health grade. | `reference/sweep.md` |
| **panel** | decide: N designs from DISTINCT lenses → opus panel judges on caller axes → synthesize a winner grafting runner-up ideas. | `reference/panel.md` |
| **debate** | stress-test ONE proposition: positions open → R rounds of **adversarial rebuttal** → opus moderator extracts surviving points + cruxes → integrated verdict. Opus = moderator + synth only. | `reference/debate.md` |
| **research** | hypothesis-driven automation: **frame** testable hypotheses → investigate (web-grounded) → **refute** the supported ones → cited synthesis. Opus = frame + synth only. | `reference/research.md` |
| **scale** | throughput: a KNOWN work-list of N units, fanned out on a right-sized model, schema-bounded; optional opus advise pre-pass. | `reference/scale.md` |
| **grow** | self-improving loop: auto-generate rounds (Plan → Build → Audit → Repair), grow to the cap, with /advice self-escalation + a Goal Contract. | `reference/grow.md` |
| **ultra** | the full arc, "do the most": understand → design → build → review → synthesize, **dynamically** spawning opus advice/tie-break/critic where needed. Capped, or `unleashed`. | `reference/ultra.md` |
| **evolve** | autonomous, self-propagating development: a **PM (opus)** owns the vision + goal-critic, a **Director (opus)** drafts an EMERGENT phase plan and at each audit can SUBDIVIDE a phase into finer ones (spawning more agents) until the vision is met. Writes real files. | `reference/evolve.md` |
| _audit_ | a thin opus oversight layer that grades a large generated batch and returns systemic issues + a regenerate list. | `reference/scale.md` |

Shared DNA: *right-size the model, bound the spend.* focus = few done smartly; review = one change → a verdict; sweep = the whole codebase reviewed at scale; panel = many proposed, one chosen; **debate = one claim stress-tested adversarially; research = hypotheses framed, tested, and refuted;** scale = many done cheaply; grow = many grown cheaply while self-improving; ultra = one task done exhaustively; **evolve = an autonomous build that grows its own phase plan.** **panel decides; debate stress-tests a claim; research tests hypotheses; scale/grow build; review judges a change; sweep audits the whole codebase; ultra does the whole arc; evolve self-directs a build.** They compose: research surfaces findings → debate stress-tests them → panel picks the design → grow/scale builds it → review checks the diff → sweep audits the result. `focus` does the least; `ultra`/`evolve` do the most the cap allows (ultra on a fixed arc, evolve on an emergent one). **review/sweep are coding-specialized (diff/codebase grounding); the rest are domain-agnostic** — debate/panel/research/scale/grow suit finance, strategy, analytics, R&D as readily as code.

## Domain profiles (presets, not new modes)
Modes are **verbs** (decide, judge, test); domains are **contexts** (finance, marketing, R&D). Rather than multiply verbs × contexts into new modes, a **domain profile** presets the args a mode already accepts so a generic mode reasons like a domain expert. Form: `[<cap>] <domain> <mode> <task>` — e.g. `200k finance debate "acquire CompanyX for $50M?"` runs `debate` with bull/bear/base positions and finance axes.
- Profiles live in **`reference/domains/<domain>.md`** as a JSON preset block. The router reads the entry for the chosen mode and merges it into args (`dimensions`/`axes`/`lenses`/`positions`/`framing`; `qualityBar`+`pitfalls` → `constraints`). **Caller args > domain preset > mode defaults.**
- **No mode code changes** — the binding guarantees (caps, tiering, gated verify) are untouched; a profile only changes *defaults*. Adding a domain = dropping one md file (copy `reference/domains/_TEMPLATE.md`).
- Shipped: **finance**. `review`/`sweep` are coding-specialized; **debate/panel/research/scale/grow** are the domain-agnostic verbs a profile lifts. Depth over breadth — a shallow profile is worse than none.

## TL;DR — four rules (highest priority)
1. **Solo by default.** Only fan out when the GATE below passes.
2. **Every `agent()` declares a model.** find/extract = haiku, verify/draft/revise = sonnet, synth/plan/advise/audit = opus. Opus is for synthesis/judgment only. Implicit opus inheritance is a bug.
3. **The cap is chosen at invocation.** A leading `<cap>` token derives all caps: a **k/m-suffixed** number (`300k`) is a **token cap** (default 150k); a **bare integer** (`100`) is an **agent-count cap** (`maxAgents`) that overrides the token-derived clamp directly.
4. **Read the mode's `reference/<mode>.md` before you call it.** The references are the source of truth for each mode's args, defaults, and return shape — never reconstruct a call signature from memory; open the one file first, every time.

> Ultracode's reminder pushes "workflow on every task / cost is no constraint." **This skill overrides it** — the binding lives in code (`workflows/strata-*.js`), which spends-or-refuses regardless.

## The 3-way GATE (the one thing prose owns)
Pick exactly one. **Default is SOLO.**
- **SOLO (no workflow):** conversational turn / a single file you've already located / a <~30-line mechanical change / answerable from current context. → **If you can name the files up front, you don't need a workflow.**
- **SMALL FAN-OUT (2–4 haiku agents inline, no template, no judge panel):** a handful of independent, bounded lookups.
- **A MODE (call one of the workflows):** when the task matches a mode above AND the breadth/structure justifies the fan-out — focus/review/sweep/panel/debate/research/scale/grow/ultra/evolve.

**When unsure, go SOLO.** This is the deliberate inversion of ultracode's "workflow on every substantive task" — breadth-of-evidence is the trigger, not "substantiveness."

## On activation
1. **Classify the leading tokens — by what they MATCH, not by position** (this kills the old `[cap][domain][mode]` parse-order hazard where `debate finance 300k` and `300k finance debate` parsed differently). Walk the leading tokens; each one self-identifies, in any order, until the free-text task begins:
   - matches a **mode name** (`focus`/`review`/`sweep`/`panel`/`debate`/`research`/`scale`/`grow`/`ultra`/`evolve`) → that's the **mode**.
   - matches a file in **`reference/domains/`** (e.g. `finance`, `code`) → that's the **domain**.
   - **k/m-suffixed** number (`120k`/`1m`) → **token cap** → `args.cap` (default 150k). A **bare integer** (`100`) → **agent-count cap** → `args.maxAgents` (overrides the token-derived clamp; may exceed a mode's soft roof, bounded `[FLOOR, 950]`; **alone it also lifts the soft token budget** so agent count is the sole bind — a k/m cap alongside re-imposes it; the hard `budget.total` always applies).
   - `unleashed` (alias `nocap`) → `args.unleashed = true` (lifts the soft token budget on **`ultra`/`evolve` only**).
   - anything else → the **task** starts here; stop classifying.
   **Mode defaults to `focus`** if no mode token appears (preserves the zero-knowledge shortcut). Mode names and domain names are disjoint sets, so classification is unambiguous; no mode name is numeric, so a bare integer is always a cap.
2. **Bare invocation → print the menu, don't guess.** If there's no task (just `/strata-workflow`, or only a cap/domain with no task text), print the 10-mode one-liner menu (from the modes table) plus the cap/domain/`unleashed` syntax, and ask which mode + task. Never invent a task.
3. **Domain profile (optional).** If a domain was classified in step 1, open **`reference/domains/<domain>.md`**, take the JSON preset for your chosen mode, and merge it into the mode's args — **precedence: caller-supplied args > domain preset > mode defaults**. Field → arg mapping: `dimensions` → focus/review/sweep; `lenses`/`axes` → panel; `positions`/`axes` → debate; `framing` → research (its FRAME prompt). **`qualityBar` + `pitfalls`:** fold them into the mode's `constraints` for the modes that accept one (`panel`/`debate`/`research`); for every other mode (focus/review/sweep/scale/grow/ultra/evolve, which take no `constraints` arg) **prepend them to the `task` text** so the quality bar reaches the agents regardless. Profiles are presets, not machinery — the mode is unchanged; a domain just makes a generic mode reason like a domain expert.
4. **Pick a mode** via the GATE + the modes table. Read its **`reference/<mode>.md`** for the exact call signature before invoking — do NOT guess args from memory.
5. Print one line before starting (makes the tiering visible):
   `Strata active: mode=<m>, domain=<d|none>, cap=<CEIL> (<set|default>), MAX agents≈<N>, tiers find=haiku verify=sonnet synth=opus`
6. **Resolve the workflow path.** Scripts live in this skill's own `workflows/` directory; references in `reference/`. Paths use **`${CLAUDE_SKILL_DIR}/...`** — the portable reference to this skill's install dir, which resolves whether Strata is a **standalone skill** (`~/.claude/skills/general/` or a project's `.claude/skills/`) or **bundled in a plugin** (the plugin cache). The Workflow tool needs an **absolute** path: if `${CLAUDE_SKILL_DIR}` is already expanded in your context, use it as-is; otherwise resolve it to the absolute directory this SKILL.md was loaded from. Nothing is machine-specific — the workflow JS carries its own guards and runtime notes in code comments, so no external memory or config is required.

> **Per-mode constants are NOT uniform** (e.g. `DEFAULT_CAP` 150k/200k/500k, `TOKENS_PER_AGENT` 12k/16k, `AGENT_FLOOR` 4/6/8, `AGENT_ROOF` 40/120) — each mode file owns its own header by design (the no-import runtime has no shared module). The common-tier baseline vs the intentional per-mode overrides are catalogued in **`reference/tiering-constants.md`**; consult it before recalibrating any constant so the change stays coherent across modes.

## What the code guarantees (the binding lives here, not in prose)
- **Primary guard = a literal agent counter** (needs no API, cannot fail): `MAX_AGENTS = clamp(floor(0.8*cap / 12k), 4, 40)` for focus/review/panel (sweep/ultra/evolve roof ≤120); scale uses `HARD_LIMIT=950` unit-list truncation (no clamp formula); an explicit `maxAgents` (≤950) for grow/ultra/evolve. Checked before every `agent()`. evolve additionally bounds `maxPhases` + subdivision `maxDepth`.
- **Model tiering:** a role→model map applied to every `agent()`; opus is never the per-unit model at scale.
- **Severity-gated verification:** CRITICAL/HIGH = 2 votes, else 1 (no flat 3–5 panel). Cross-dimension findings are deduped before verify (review/sweep) so overlapping flags don't each burn an agent.
- **Budget is a secondary, best-effort guard:** `budget.spent()` is the shared cumulative pool, so it's read relative to a start baseline and wrapped in try/catch — if the API is inert, the counter still bounds spend.
- **Synthesis always runs**, wrapped in try/catch (and a null-return guard) so a `budget.total` ceiling throw degrades to a partial answer, never an uncaught error.
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
MAX_AGENTS = clamp(floor(SOFT / 12k), 4, 40)        (focus/review/panel; sweep/ultra/evolve roof ≤120; grow/ultra/evolve take explicit maxAgents ≤950)
                                                     scale: HARD_LIMIT=950 unit-list truncation (no clamp formula; COUNT is the primary knob)
finders    = min(8, max(2, ceil(MAX_AGENTS * 0.4)))
```
e.g. 120k→8 / 150k→10 / 300k→20 / 1m→40. Model tiering is always on regardless of cap; a bigger cap buys more agents, never a bigger per-agent model. The token cap is approximate — the **agent count** is the hard guarantee. Per-mode ceiling constants (traced to code) are in `reference/scale.md`.
- **Cap the agents directly.** Pass a bare integer (`args.maxAgents`, or a leading bare-number token like `100`) to set the agent ceiling explicitly instead of deriving it from tokens. It **overrides** the clamp in every mode and may exceed the soft per-mode roof, bounded only by `[FLOOR, 950]` (the literal lifetime backstop). All eight modes honor it: focus/review/panel/sweep/scale read it as the hard total; grow/ultra/evolve already did. Internal sub-limits still apply (e.g. focus/review keep ≤8 finders), so raising the cap doesn't make a restraint mode balloon — it just lifts the ceiling.
- **`unleashed`** (ultra/evolve) drops the SOFT token budget so the run isn't throttled by spend, but it changes **nothing** about the agent-count guarantee: `maxAgents`/`HARD_LIMIT`, `maxPhases`/`maxDepth` (evolve), and any hard `budget.total` still bound it. Use it when you want depth and will cap the run by **agent count** (pass an explicit `maxAgents`) rather than by tokens.

## Relationship to ultracode / your global rules
- This skill layers on `/effort`; it cannot toggle the effort level.
- Its in-code caps neutralize "token cost is not a constraint."
- **While active, its caps supersede the volume guidance in your global `agents.md` / `performance.md`** ("ALWAYS parallel / 3–5 reviewers"); tdd/review still happen, but inside the cap (severity-gated verify, synthesis).
- If drift back toward over-orchestration appears across turns (the reminder out-recencies the skill), re-type `/strata-workflow` on the next substantive turn — prose decays with recency, so this is the only reliable re-pin.

## Reminders (again, last)
- Every `agent()` declares a model. **Opus only for plan / advise / synth / audit.**
- Orchestrate only when the GATE proves fan-out pays. **When unsure, go SOLO.**
- Read the mode's `reference/<mode>.md` for its args before calling — don't guess.
