# finance — domain profile

A preset bundle for financial analysis, valuation, capital-allocation, and deal work. It does **not** add machinery — it fills in the args the modes already accept (`dimensions`, `axes`, `lenses`, `positions`, `constraints`) with an expert-level financial default so a generic mode reasons like a financial analyst.

**Use it when** the task is an investment/financing/valuation/budget/deal decision or a financial-model review. Pairs most naturally with **debate** (bull/bear/base), **panel** (allocation options), **research** (driver hypotheses), and **review/sweep** (model audit).

## Presets

The router reads this JSON, takes the entry for the chosen mode, and merges it into that mode's args. **Precedence: caller-supplied args > this profile > the mode's own defaults.** `qualityBar` and `pitfalls` are appended into `constraints` for every mode.

```json
{
  "qualityBar": "Reason at the level of a buy-side financial analyst: treat management/seller projections skeptically, separate one-time items from recurring, make the discount rate and time-horizon assumptions explicit and always attach a sensitivity, never conflate nominal vs real, attach a confidence level and name the conditions under which the conclusion flips.",
  "pitfalls": [
    "anchoring on the seller's / management's projections",
    "ignoring deal, integration, and financing costs",
    "treating one-time gains as recurring",
    "leaving the discount rate / WACC implicit",
    "survivorship bias in comparables",
    "confusing correlation with causation among drivers",
    "mixing nominal and real figures"
  ],
  "review": {
    "dimensions": [
      "calculation accuracy (formula/sign/unit errors, broken cell ranges, hardcoded overrides)",
      "internal consistency (subtotals tie to totals; the three statements reconcile; period-to-period continuity)",
      "assumption validity (growth, margins, WACC, terminal growth — each grounded, not asserted)",
      "accounting & regulatory (revenue recognition, lease/tax treatment, required disclosures)",
      "sensitivity & scenarios (result swing to key assumptions; base/bear/bull present)",
      "liquidity & solvency (cash conversion, covenant headroom, the point of any cash shortfall)"
    ]
  },
  "sweep": {
    "dimensions": [
      "calculation accuracy across all linked sheets",
      "cross-statement & cross-period reconciliation",
      "assumption validity and where unsupported assumptions cluster",
      "accounting/regulatory exposure",
      "sensitivity coverage and missing scenarios"
    ]
  },
  "panel": {
    "lenses": [
      "capital-preservation (conservative, downside-first)",
      "growth-maximizing (aggressive)",
      "hedged (cap the downside, give up some upside)",
      "tail-risk (assume an extreme adverse scenario)"
    ],
    "axes": [
      "expected value (probability-weighted)",
      "risk-adjusted return",
      "downside / tail risk (lower is better)",
      "liquidity impact",
      "opportunity cost",
      "execution / integration risk"
    ]
  },
  "debate": {
    "positions": [
      "BULL — argue the upside case with evidence",
      "BEAR — argue the downside case with evidence",
      "BASE — argue the neutral most-likely case"
    ],
    "axes": [
      "expected value (probability-weighted)",
      "risk-adjusted return",
      "downside / tail risk",
      "execution / integration risk",
      "opportunity cost"
    ]
  },
  "research": {
    "framing": "Decompose the question into value drivers, then hypothesize in driver -> correlation -> causation order. For each hypothesis state exactly which financial/market data (filings, official statistics, regulatory documents) would confirm or refute it. Prefer primary sources.",
    "grounded": true
  }
}
```
