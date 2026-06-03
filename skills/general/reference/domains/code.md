# code — domain profile

A preset bundle for software-engineering work: code review, codebase audit, exploration, architecture decisions, debugging, feasibility. It makes the (previously implicit) coding defaults explicit so any mode reasons like a staff engineer. `review`/`sweep` were already specialized for this domain; the profile extends the same expertise to `focus`/`panel`/`debate`/`research`.

**Use it when** the task is about a codebase, a known change, an API/architecture decision, a bug, or a build-vs-buy call. Pairs with **review** (a known diff), **sweep** (whole-codebase audit), **focus** (explore an unknown area), **panel/debate** (design / build-vs-buy), and **research** (root-cause / feasibility).

## Presets

The router reads this JSON, takes the entry for the chosen mode, and merges it into that mode's args. **Precedence: caller args > this profile > mode defaults.** `dimensions` → focus/review/sweep; `lenses`/`axes` → panel; `positions`/`axes` → debate; `framing` → research. `qualityBar`+`pitfalls` fold into `constraints` (panel/debate/research) or are prepended to the task text (focus/review/sweep/…).

```json
{
  "qualityBar": "Reason like a staff engineer: ground every claim in real file:line evidence, prefer the simplest correct change over a rewrite, respect existing conventions and patterns, separate must-fix correctness/security from nice-to-have style, expect tests for behavioral changes, flag any breaking change to a public API/contract, and never propose a change you cannot justify against the codebase as it actually is.",
  "pitfalls": [
    "flagging style/preference as if it were a bug",
    "proposing a rewrite where a local fix suffices",
    "ignoring existing patterns and conventions",
    "claims not grounded in file:line evidence",
    "security theater over real, reachable threats",
    "treating missing tests as acceptable for a behavioral change",
    "breaking a public API/contract without calling it out"
  ],
  "focus": {
    "dimensions": [
      "architecture & layering (modules, boundaries, responsibilities)",
      "data & control flow (how a request/value moves through the system)",
      "entry points & public API surface",
      "key dependencies & external integrations",
      "conventions & idioms actually in use",
      "test coverage map (what is and isn't exercised)"
    ]
  },
  "review": {
    "dimensions": [
      "correctness (logic errors, off-by-one, broken invariants, resource leaks)",
      "security (injection, auth/authorization gaps, secret leakage, unsafe deserialization, SSRF)",
      "error handling & robustness (unhandled errors, missing validation, swallowed exceptions)",
      "concurrency & async (data races, deadlocks, unhandled promise rejections, ordering/atomicity assumptions)",
      "API & backward compatibility (breaking signature/behavior changes, semver, schema/contract drift)",
      "testing (coverage of the change, missing edge/boundary cases, brittle/flaky patterns, untested error paths)",
      "performance (N+1, accidental O(n^2), blocking I/O on hot paths, needless allocation)",
      "maintainability (naming, dead code, duplication, leaky abstractions, convention drift)"
    ]
  },
  "sweep": {
    "dimensions": [
      "correctness (logic errors, broken invariants, race conditions, resource leaks)",
      "security (injection, auth/authorization gaps, secret leakage, unsafe deserialization, SSRF)",
      "error-handling & robustness (unhandled errors, missing validation, swallowed exceptions)",
      "dependency & supply-chain (outdated/duplicate deps, known CVEs, license risk)",
      "performance (systemic N+1, accidental O(n^2), blocking I/O on hot paths)",
      "testing & coverage gaps (under-tested critical paths, missing integration coverage)",
      "maintainability & architecture (dead code, duplication, leaky abstractions, layering violations, convention drift)"
    ]
  },
  "panel": {
    "lenses": [
      "simplicity-first (least moving parts)",
      "robustness-first (failure modes, scale, edge cases)",
      "type-safety / correctness-by-construction (make illegal states unrepresentable)",
      "performance-first (optimize the hot path)",
      "pragmatic / reuse-existing (lean on proven patterns and what already exists)",
      "testability-first (easy to test in isolation)"
    ],
    "axes": [
      "correctness / soundness",
      "simplicity",
      "maintainability",
      "testability",
      "performance",
      "migration cost (lower is better)"
    ]
  },
  "debate": {
    "positions": [
      "BUILD — argue for building it ourselves",
      "BUY — argue for an existing library / framework / service",
      "STOPGAP — argue for the minimal change that ships now"
    ],
    "axes": [
      "correctness / risk",
      "maintenance burden",
      "time-to-ship",
      "operational cost",
      "extensibility"
    ]
  },
  "research": {
    "framing": "Decompose the question into the code paths / components involved; hypothesize about behavior, root cause, or feasibility; for each hypothesis state which code, test, log, or doc evidence would confirm or refute it. Use Bash/Read on the repository (and run targeted tests/reproductions) as the primary source.",
    "grounded": false
  }
}
```
