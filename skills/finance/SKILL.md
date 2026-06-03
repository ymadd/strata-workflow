---
name: finance
description: Strata pre-scoped to the FINANCE domain — run any Strata mode (debate / panel / research / review / …) with finance dimensions, axes, positions, and an analyst quality-bar already applied. Use for investment, valuation, capital-allocation, budgeting, or deal decisions and financial-model review. A thin alias over the shared strata-workflow engine (no duplicated logic). e.g. "/strata-workflow:finance debate Acquire CompanyX for $50M?"
argument-hint: "[mode e.g. debate] [cap] <task>"
---

# Strata — finance domain (alias)

A **thin launcher**, not a separate engine. It fixes `domain = finance` and delegates to the shared Strata router and the same bundled workflows — the cap / model-tiering / gated-verify guarantees live in **one** place (`../general/`), never duplicated here.

On activation:
1. Read the **main router** at `${CLAUDE_SKILL_DIR}/../general/SKILL.md` and follow its activation steps, with **`domain` already fixed to `finance`** (skip its domain-classification — the domain is decided).
2. Load the finance profile at `${CLAUDE_SKILL_DIR}/../general/reference/domains/finance.md` and merge its preset for the chosen mode into args (**caller args > profile > mode defaults**; `qualityBar`+`pitfalls` → `constraints` for panel/debate/research, else prepended to the `task` text).
3. The user's input after the command is `[<mode>] [<cap>] <task>` — classify tokens exactly as the main router's step 1 describes. **Mode default:** `debate` when the task is a decision/claim (the common finance case), else `focus`. The natural finance verbs are **debate** (bull/bear/base), **panel** (allocation options), **research** (driver hypotheses), and **review/sweep** (model audit).
4. Workflows: `${CLAUDE_SKILL_DIR}/../general/workflows/strata-<mode>.js`; references: `${CLAUDE_SKILL_DIR}/../general/reference/`. Resolve to absolute paths before calling `Workflow`.

Everything else — the GATE, cap math, tiering, the modes table, the cap-derivation rules — is owned by the main router. Read it; do not reimplement it here.
