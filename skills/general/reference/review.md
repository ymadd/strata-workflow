# review — `strata-review` (how to call)

For scrutinizing a KNOWN changeset (a diff, a PR, or specific paths) and returning a verdict. One sonnet reviewer per dimension grounds findings in real `file:line` → findings are **deduped across dimensions** (a barrier — the one place all findings meet, so overlapping flags don't each burn a verify agent) → each is **adversarially refuted** (CRITICAL/HIGH = 2 votes, else 1) → an opus synthesis writes a prioritized report and issues **approve / comment / request-changes**.

```js
Workflow({
  scriptPath: "${CLAUDE_SKILL_DIR}/workflows/strata-review.js",
  args: {
    target: "<what the change is meant to do (reviewer context)>",
    // pick ONE scope source (else it defaults to the current branch vs main):
    diff: "<a literal unified diff>",          // OR
    pr: "<PR number/ref — agents run `gh pr diff` themselves>", // OR
    paths: ["src/auth/**", "lib/x.ts"],        // targeted audit of existing code (not a diff)
    baseRef: "main",                            // base for the default `git diff <base>...HEAD`
    dimensions: [ /* override; default = correctness/security/error-handling/perf/tests/maintainability */ ],
    // ── grounding context (both optional; both injected into reviewers, refuters, and the verdict) ──
    conversation: "<the dialogue/intent that produced this change — requirements, agreed decisions>",
    //   ↑ MUST be passed by you: subagents can't see the parent session. Lets reviewers judge intent-fidelity
    //     (missed requirements, unrequested scope creep), not just diff-correctness.
    conventions: true,  // true/omitted = the scope agent reads the repo's CLAUDE.md/AGENTS.md itself;
    //                      a string = use it verbatim (you already hold CLAUDE.md — pass it directly);
    //                      false = off. When present, an "adherence" lens is auto-added at high priority.
    fix: false,                                 // true = include a concrete suggestedFix per finding (NOT applied to disk)
    severityFloor: "INFO",                      // drop anything below this before verify (e.g. "HIGH" for blocking-only)
    cap: 200000, tierHint: "cheap|normal|hard"  // hard → verify on opus; cheap → reviewers on haiku
  }
})
```

- **Grounding (CLAUDE.md + conversation):** by default the cheap scope agent also reads the repo's `CLAUDE.md`/`AGENTS.md` and distills the conventions every reviewer is then held to (no extra agent — folded into the scope pass). Pass `conversation` to feed the intent/requirements the change must satisfy; reviewers then check **intent-fidelity** (did it do what was asked — nothing missed, nothing extra) alongside the diff. Whenever either is present, a **convention & intent adherence** lens is inserted right after correctness/security so it survives the finder cap. As the caller you usually already hold `CLAUDE.md` and the dialogue — pass them in rather than relying solely on the auto-read.
- **Reviewers are sonnet (not haiku)** — finding real bugs needs reasoning over the code, not cheap scanning. Opus is reserved for the final verdict only; verify stays sonnet (or opus under `tierHint:"hard"`).
- The scope is resolved by the agents themselves (they have Bash/Read): they run `git diff` / `gh pr diff` or read the named paths. **For diff/PR/default scope, invoke from the target repo.**
- Returns `{ verdict, blockingCount, findings (confirmed, deduped, severity-sorted; `raisedBy>1` = multiple lenses corroborated the same site), synthesis (report, blocking[], coverageNote) }`.
- vs `focus` with `taskClass:"review"`: focus explores an *unknown* surface with haiku scouts and a free-text task; **review** scrutinizes a *specific* change with sonnet reviewers, dedups overlapping findings, and ends on a verdict. Reach for review when you have an actual diff/PR; focus when the surface to review is itself unknown.
- vs `sweep`: review = ONE change; sweep = the whole codebase, partitioned and fanned out.
