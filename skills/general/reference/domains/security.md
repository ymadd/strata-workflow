# security — domain profile

A preset bundle for security & threat-modeling work: threat models, security reviews, red-team analysis, control design, vulnerability triage, and risk decisions. It lifts a generic mode to reason like a **senior red-teamer + defender**: enumerate threat actors and realistic capabilities *before* proposing controls, tie every control to a specific attack it defeats, and score by exploitability × impact × detectability rather than by vibe. The `code` profile carries a one-line `security` review dimension; this profile makes security the **primary** lens, with STRIDE/threat-actor machinery the `code` defaults don't reach.

**Use it when** the task is a threat model, a security/architecture review through an attacker's eyes, a control-vs-attack design decision, a vuln-triage or risk call, or a regulatory-exposure question. Pairs most naturally with **review/sweep** (audit a system/codebase for reachable threats), **debate** (attacker vs defender vs regulator), **panel** (competing security architectures), and **research** (does this class of attack actually reach us — frame → investigate live CVE/ATT&CK → refute → cited verdict).

## Presets

The router reads this JSON, takes the entry for the chosen mode, and merges it into that mode's args. **Precedence: caller-supplied args > this profile > the mode's own defaults.** `qualityBar` and `pitfalls` are folded into `constraints` for panel/debate/research, and prepended to the `task` text for the other modes (focus/review/sweep/scale/grow/ultra/evolve, which take no `constraints` arg). `dimensions` → focus/review/sweep; `lenses`/`axes` → panel; `positions`/`axes` → debate; `framing`/`grounded` → research.

```json
{
  "qualityBar": "Reason like a senior red-teamer who also has to defend: enumerate the threat actors and their realistic capabilities BEFORE proposing controls, tie every control to the specific attack it defeats, rate each finding by exploitability × impact × detectability (not severity-by-vibe), insist on a concrete reachable attack path rather than a theoretical weakness, prefer eliminating a class of bug over patching one instance, separate must-fix reachable threats from defense-in-depth nice-to-haves, and call out security theater (controls that look protective but stop no real attack).",
  "pitfalls": [
    "proposing controls before naming the threat actor and attack they defeat",
    "flagging a theoretical weakness with no reachable attack path as if it were exploitable",
    "severity-by-vibe instead of exploitability × impact × detectability",
    "security theater — controls that look protective but stop no real attacker",
    "patching one instance instead of eliminating the bug class",
    "trusting client-side / perimeter controls as if they were authoritative",
    "ignoring the detection/response gap (assuming prevention is the whole story)",
    "confusing compliance-passed with actually-secure"
  ],
  "focus": {
    "dimensions": [
      "trust boundaries & attack surface (where untrusted input crosses into trusted code)",
      "authentication & session management (identity, token handling, session fixation)",
      "authorization & access control (broken object/function-level authz, privilege escalation paths)",
      "data protection (secrets handling, encryption at rest/in transit, sensitive-data exposure)",
      "input handling & injection sinks (SQL/command/template/deserialization)",
      "dependencies & supply chain (known-vuln components, build/CI trust)"
    ]
  },
  "review": {
    "dimensions": [
      "Spoofing — identity/authentication weaknesses (forgeable identity, weak/missing auth, session fixation)",
      "Tampering — integrity of data/code in transit, at rest, and in the supply chain (unsigned updates, mutable shared state)",
      "Repudiation — missing/forgeable audit logging that lets an actor deny an action",
      "Information disclosure — sensitive-data exposure, secret leakage, verbose errors, side channels",
      "Denial of service — unbounded resource use, amplification, missing rate limits / quotas",
      "Elevation of privilege — broken authorization, IDOR, privilege-escalation and confused-deputy paths",
      "Injection sinks — SQL/NoSQL/command/template/LDAP/deserialization, SSRF",
      "Crypto & secrets — weak/misused primitives, hardcoded keys, bad randomness, improper key management"
    ]
  },
  "sweep": {
    "dimensions": [
      "authentication & authorization across all entry points (systemic authz gaps, IDOR clusters)",
      "injection sinks system-wide (SQL/command/template/deserialization, SSRF)",
      "secrets & crypto hygiene (hardcoded keys, weak primitives, key management) across the corpus",
      "trust-boundary & input-validation coverage (where untrusted input enters unchecked)",
      "dependency & supply-chain exposure (known CVEs, unpinned/duplicate deps, build/CI trust)",
      "logging, detection & response gaps (what an attacker could do unobserved)",
      "data protection & exposure (PII/secret handling, transport/at-rest encryption)"
    ]
  },
  "panel": {
    "lenses": [
      "zero-trust (authenticate & authorize every request; assume the network is hostile)",
      "defense-in-depth (layered controls so one failure isn't fatal)",
      "attack-surface minimization (remove the capability rather than guard it)",
      "detection & incident-response first (assume breach; optimize for fast detection and recovery)"
    ],
    "axes": [
      "reachable-threat coverage (which real attack paths it actually closes)",
      "residual risk (exploitability × impact left after the control)",
      "blast radius containment (how much a single failure exposes)",
      "detection & response capability",
      "operational cost & friction (lower is better)",
      "implementation & migration cost (lower is better)"
    ]
  },
  "debate": {
    "positions": [
      "ATTACKER — argue the system IS exploitable: name the threat actor, the concrete attack path, and the realistic capability required",
      "DEFENDER — argue the risk is acceptably controlled: show the controls that break the attack path and the residual risk",
      "REGULATOR — argue from compliance, disclosure, liability, and the user-harm / blast-radius the others discount"
    ],
    "axes": [
      "reachability of the attack path (concrete, not theoretical)",
      "exploitability × impact × detectability",
      "residual risk after the proposed controls",
      "blast radius / user harm",
      "regulatory & disclosure exposure"
    ]
  },
  "research": {
    "framing": "Decompose the question into specific threat actors and the attack paths each would take, then frame each as a falsifiable hypothesis: 'actor X can reach asset Y via path Z.' For each, state exactly which evidence — a reachable code path, a live advisory (CVE/CWE/OWASP/MITRE ATT&CK), a reproduction/PoC, or a log/telemetry signal — would confirm or refute it. Encode the STABLE taxonomy (STRIDE, OWASP Top 10, CWE classes, ATT&CK tactics) from knowledge, but treat CURRENT-threat data (specific CVEs, advisories, exploited-in-the-wild status) as requiring live lookup. An unreachable weakness counts as unsupported.",
    "grounded": true
  }
}
```

> **On `grounded:true`:** the security taxonomy (STRIDE, OWASP, CWE, ATT&CK) is stable and encoded here statically, but *which* vulnerabilities are current/exploited is not — so research-mode grounding is load-bearing for the CVE/advisory layer (live WebSearch/WebFetch), not cosmetic. This is the deliberate split that lets a static md file stay correct while delegating the moving target to runtime search.
