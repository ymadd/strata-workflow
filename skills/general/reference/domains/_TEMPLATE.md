# <domain> — domain profile (TEMPLATE — copy to `<domain>.md` and fill in)

One paragraph: what this domain covers and which modes it pairs with best. A profile adds **no machinery** — it only presets the args the modes already accept so a generic mode reasons like a domain expert.

## Presets

The router reads this JSON, takes the entry for the chosen mode, and merges it into that mode's args. **Precedence: caller args > this profile > mode defaults.** `qualityBar` and `pitfalls` fold into `constraints` for panel/debate/research, and are prepended to the `task` text for the other modes. Include only the mode entries that make sense for the domain; omit the rest.

```json
{
  "qualityBar": "<one expert-level sentence that lifts every agent to a professional bar in this domain>",
  "pitfalls": ["<common domain mistake>", "<another>"],
  "review":   { "dimensions": ["<what a reviewer scrutinizes in this domain>"] },
  "sweep":    { "dimensions": ["<corpus-wide review dimensions>"] },
  "panel":    { "lenses": ["<distinct design angles>"], "axes": ["<judging axes>"] },
  "debate":   { "positions": ["<stance A>", "<stance B>", "<optional stance C>"], "axes": ["<judging axes>"] },
  "research": { "framing": "<how to frame testable hypotheses in this domain>", "grounded": true }
}
```

Notes:
- **Before shipping, the profile must pass the adoption gate** — a hardened 3-arm ablation showing the "security signature." See `_ADOPTION-GATE.md`. Don't argue a profile in; measure it in.
- Keep arrays tight and genuinely domain-specific — a shallow profile is worse than none. Aim for depth in 1–2 domains over breadth across many.
- `axes`/`lenses`/`positions`/`dimensions` map 1:1 to the mode args of the same name; `framing` is injected into research's hypothesis-framing prompt; `qualityBar`+`pitfalls` go into `constraints` (panel/debate/research) or are prepended to the `task` text (other modes).
- The file name (minus `.md`) is the domain token, e.g. `marketing.md` → `/strata-workflow marketing panel "..."`.
