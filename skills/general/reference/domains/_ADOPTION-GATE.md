# Domain-profile adoption gate (read before shipping a new profile)

A domain profile is only worth shipping if it **measurably changes agent behavior for the better** — "a shallow profile is worse than none." This is the empirical bar a candidate profile must clear, and the worked examples that calibrate it. It exists because intuition is unreliable here: the same candidate (`security`) looked redundant on an easy test and load-bearing on a hard one. **Don't argue a profile in; measure it in.**

## The test — a 3-arm ablation

Run the SAME mode on ONE realistic, hard task (with a known answer key), three ways, and have a **blind** judge score the outputs against the key:

1. **GENERIC** — no injection (the mode's bare default).
2. **POSTURE** — inject only `qualityBar` + `pitfalls` (the prose constraints).
3. **FULL** — inject the whole profile (posture **+** the mechanical `dimensions`/`lenses`/`axes`).

Aggregate per arm **deterministically in code** (the judge scores, your harness counts — never let an agent do the arithmetic). Use ≥4 replicates/arm (≥10–12 to firm up a claim); producers on the tier that actually ships the work (sonnet), judges on opus.

### Design the fixture to discriminate (this is the hard part)
The easy mistake is a fixture everything aces — at ceiling, no arm can separate. A good fixture has:
- **Headroom**: un-capped scoring (recall *count*, false-positive *count*, depth 0–10), not all-or-nothing booleans that pin at 100%.
- **A seeded miss**: one important item placed **only in the `dimensions`, NOT in the posture prose** — the analog of STRIDE's *Repudiation* category. This is what isolates whether the mechanical layer adds coverage the posture can't.
- **Decoys**: plausible-but-wrong items; escalating them is the false-positive / "theater" signal.
- **A chain / second-order item**: tests whether the arm reasons about consequences vs lists findings in isolation.

## The bar — the "security signature"

A profile **clears the gate** only if FULL shows the signature security showed on a hardened fixture:

- the **seeded-miss category is absent in EVERY non-mechanical arm** (generic AND posture both miss it), and **FULL takes it to ceiling** — i.e. the mechanical layer *adds a capability no other arm had*; and
- a **real-find lift on the order of +1.0** (FULL vs POSTURE), not a rounding-error +0.2.

**Beating POSTURE is not enough.** FULL must beat the **best baseline, including plain GENERIC**. A posture that *suppresses* a catch generic already had (it happens — see product/PM below) can make FULL look great merely by *recovering* the generic baseline. That is regression-recovery, not contribution. Compute `FULL − GENERIC` on the seeded-miss dimension; if it's ~0, the mechanical layer earned nothing.

## Worked examples (the calibration)

| | seeded miss (generic / posture / full) | realFound full−posture | verdict |
|---|---|---|---|
| **security** (STRIDE → Repudiation) | **0% / 0% / 100%** | **+1.0** | **SHIP** — full adds an absent category |
| **product/PM** (checklist → 2nd-order) | 100% / 50% / 100% | +0.25 | **DON'T SHIP** — generic already at ceiling; full only *recovers* what posture suppressed |

- **security** is the positive control: free-form review systematically omits the *Repudiation / audit-logging* category, so the STRIDE enumeration is genuinely additive. Full beat posture **and** generic. Ship FULL.
- **product/PM** is the negative control: generic models already apply product common-sense (second-order effects, guardrail metrics) at ceiling, so the checklist adds no category they structurally forget. The mechanical dimensions are **redundant** — the domain is *posture-thin*. If anything ships for such a domain, ship POSTURE-only, and only after confirming the posture doesn't *suppress* a baseline catch.

## Caveats baked into the rule
- **Ceilings destroy the test.** If a metric pins at 100%/0% across all arms, it carries no signal — redesign the fixture, don't conclude from it.
- **Small n is directional, not final.** n=4/arm shows direction; require n≥10–12 (and ideally a rotated answer-key/fixture) before treating a ship/no-ship call as authoritative.
- **This gate is about profile-injection content, NOT orchestration structure.** It measures whether *injected domain vocabulary* lifts a generic mode. It says nothing about whether a *structural role* in a workflow (e.g. evolve's PM/Director division of labor) helps — that is a different question, tested differently.

> Bottom line: a new `reference/domains/<x>.md` ships only after a hardened 3-arm ablation shows the security signature. Otherwise it's breadth that dilutes trust — exactly what the framework's depth-over-breadth rule forbids.
