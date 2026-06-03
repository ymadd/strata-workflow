---
name: code
description: Strata pre-scoped to the CODE domain — run any Strata mode (review / sweep / panel / debate / research / …) with software-engineering dimensions, axes, and a staff-engineer quality-bar already applied. Use for code review, architecture decisions, debugging, feasibility, or build-vs-buy calls. A thin alias over the shared strata-workflow engine (no duplicated logic). e.g. "/strata-workflow:code review the current branch".
argument-hint: "[mode e.g. review] [cap] <task>"
---

# Strata — code domain (alias)

A **thin launcher**, not a separate engine. It fixes `domain = code` and delegates to the shared Strata router and the same bundled workflows — the cap / model-tiering / gated-verify guarantees live in **one** place (`../general/`), never duplicated here.

On activation:
1. Read the **main router** at `${CLAUDE_SKILL_DIR}/../general/SKILL.md` and follow its activation steps, with **`domain` already fixed to `code`** (skip its domain-classification — the domain is decided).
2. Load the code profile at `${CLAUDE_SKILL_DIR}/../general/reference/domains/code.md` and merge its preset for the chosen mode into args (**caller args > profile > mode defaults**; `qualityBar`+`pitfalls` → `constraints`).
3. The user's input after the command is `[<mode>] [<cap>] <task>` — classify tokens exactly as the main router's step 1 describes. **Mode default:** `focus` (unknown surface), but the natural coding verbs are **review** (a known change), **sweep** (whole-codebase audit), **panel/debate** (design / build-vs-buy), and **research** (root-cause / feasibility).
4. Workflows: `${CLAUDE_SKILL_DIR}/../general/workflows/strata-<mode>.js`; references: `${CLAUDE_SKILL_DIR}/../general/reference/`. Resolve to absolute paths before calling `Workflow`.

Everything else — the GATE, cap math, tiering, the modes table, the cap-derivation rules — is owned by the main router. Read it; do not reimplement it here.
