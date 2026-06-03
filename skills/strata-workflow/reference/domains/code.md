# code — domain profile

A preset bundle for software-engineering work: code review, architecture decisions, debugging, feasibility. It makes the (previously implicit) coding defaults explicit so any mode reasons like a staff engineer. This is the domain that `review`/`sweep` were already specialized for; the profile extends the same expertise to `panel`/`debate`/`research`.

**Use it when** the task is about a codebase, an API/architecture decision, a bug, or a build-vs-buy call. Most modes default to a coding framing already, so `code` is mainly useful to (a) make the framing explicit and (b) carry the coding quality-bar into the domain-agnostic verbs (panel/debate/research).

## Presets

The router reads this JSON, takes the entry for the chosen mode, and merges it into that mode's args. **Precedence: caller args > this profile > mode defaults.** `qualityBar` and `pitfalls` append into `constraints`.

```json
{
  "qualityBar": "Reason like a staff engineer: ground every claim in real file:line evidence, prefer the simplest correct change over a rewrite, respect existing conventions and patterns, separate must-fix correctness/security from nice-to-have style, and never propose a change you cannot justify against the codebase as it actually is.",
  "pitfalls": [
    "flagging style/preference as if it were a bug",
    "proposing a rewrite where a local fix suffices",
    "ignoring existing patterns and conventions",
    "claims not grounded in file:line evidence",
    "security theater over real, reachable threats"
  ],
  "review": {
    "dimensions": [
      "correctness (logic errors, off-by-one, broken invariants, race conditions, resource leaks)",
      "security (injection, auth/authorization gaps, secret leakage, unsafe deserialization, SSRF)",
      "error handling & robustness (unhandled errors, missing validation, swallowed exceptions)",
      "performance (N+1, accidental O(n^2), blocking I/O on hot paths)",
      "maintainability (naming, dead code, duplication, leaky abstractions, convention drift)"
    ]
  },
  "sweep": {
    "dimensions": [
      "correctness (logic errors, broken invariants, race conditions, resource leaks)",
      "security (injection, auth/authorization gaps, secret leakage, unsafe deserialization, SSRF)",
      "error-handling & robustness (unhandled errors, missing validation, swallowed exceptions)",
      "performance (N+1, accidental O(n^2), blocking I/O on hot paths)",
      "maintainability (dead code, duplication, leaky abstractions, convention drift)"
    ]
  },
  "panel": {
    "lenses": [
      "simplicity-first (least moving parts)",
      "robustness-first (failure modes, scale, edge cases)",
      "performance-first (optimize the hot path)",
      "pragmatic / reuse-existing (lean on proven patterns and what already exists)"
    ],
    "axes": [
      "correctness / soundness",
      "simplicity",
      "maintainability",
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
      "extensibility"
    ]
  },
  "research": {
    "framing": "Decompose the question into the code paths / components involved; hypothesize about behavior, root cause, or feasibility; ground each hypothesis in what the code, tests, and docs actually show. Use Bash/Read on the repository as the primary source.",
    "grounded": false
  }
}
```
