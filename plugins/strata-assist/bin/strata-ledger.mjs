#!/usr/bin/env node
// Strata ledger: turns finished routed runs into outcomes, evaluates them with Jev, and tunes the
// routing policy. Plain Node (no deps) so the mod only has to spawn it: $.process.run(['node', …]).
//
//   ingest [--no-eval] [--root DIR]   scan workflow transcripts, write outcomes.jsonl (idempotent)
//   tune [--dry]                       per-arm stats → bounded policy update in policy.json
//   rate good|bad [runId] [note…]      human label for a run (default: the latest ingested run)
//   stats                              print the tune report without changing anything
//
// Files (all under ~/.claude/strata): routes.jsonl (written by the mod at route time),
// outcomes.jsonl, ratings.jsonl, policy.json, ingested.json.
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HOME = homedir()
const DIR = join(HOME, '.claude', 'strata')
const F = {
  routes: join(DIR, 'routes.jsonl'),
  outcomes: join(DIR, 'outcomes.jsonl'),
  ratings: join(DIR, 'ratings.jsonl'),
  policy: join(DIR, 'policy.json'),
  ingested: join(DIR, 'ingested.json'),
}
export const JEV_MODEL = 'jev-1.13.0'
const JEV_URL = 'https://api.typesafe.ai/v1/systemone'

export const DEFAULT_POLICY = { version: 0, LOW_CONFIDENCE: 0.4, DOWNGRADE_MIN_CONFIDENCE: 0.8, DOWNGRADE_MAX_BLAST: 2 }
const BOUNDS = { LOW_CONFIDENCE: [0.3, 0.6], DOWNGRADE_MIN_CONFIDENCE: [0.7, 0.95] }
const MIN_N = 10 // no policy move on fewer samples than this per bucket
const TARGET_FIRST_PASS = 0.8
const STEP = 0.05

const readJsonl = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : [])
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }
const round = (x, n = 2) => (x == null ? null : Math.round(x * 10 ** n) / 10 ** n)

// ---------- transcripts ----------
function* workflowDirs(root) {
  if (!existsSync(root)) return
  for (const proj of readdirSync(root)) {
    const pdir = join(root, proj)
    let sessions
    try { sessions = readdirSync(pdir) } catch { continue }
    for (const s of sessions) {
      const wdir = join(pdir, s, 'subagents', 'workflows')
      if (!existsSync(wdir)) continue
      for (const wf of readdirSync(wdir)) if (existsSync(join(wdir, wf, 'journal.jsonl'))) yield join(wdir, wf)
    }
  }
}

function agentStats(dir, agentId) {
  const p = join(dir, `agent-${agentId}.jsonl`)
  let out = 0, model = null, text = ''
  for (const row of readJsonl(p)) {
    const m = row.message
    if (!m || typeof m !== 'object') continue
    if (m.role === 'assistant') {
      out += m.usage?.output_tokens ?? 0
      model = m.model ?? model
    } else if (m.role === 'user' && !text) {
      text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
    }
  }
  return { out, model, text }
}

// Parse one workflow run into per-unit outcomes. Returns null when the run was not Jev-routed.
export function parseRun(dir) {
  const journal = readJsonl(join(dir, 'journal.jsonl'))
  const started = new Map(), results = new Map()
  for (const r of journal) {
    if (r.type === 'started') started.set(r.key, r)
    if (r.type === 'result') results.set(r.key, r)
  }
  const agents = [...started.values()].map((s) => ({ label: s.label || '', agentId: s.agentId, result: results.get(s.key)?.result ?? null, done: results.has(s.key) }))
  const relay = agents.find((a) => a.label === 'route:jev')
  if (!relay) return null
  // the payload sits in the harness's "computed task" message, JSON-escaped inside the transcript
  let relayRaw = ''
  try { relayRaw = readFileSync(join(dir, `agent-${relay.agentId}.jsonl`), 'utf8') } catch {}
  const runId = (/runId\\*"\s*:\s*\\*"(r\d+)/.exec(relayRaw) || [])[1]
  if (!runId) return null
  if (agents.some((a) => !a.done)) return { runId, incomplete: true }
  const mode = (/mode\\*"\s*:\s*\\*"([a-z]+)/.exec(relayRaw) || [])[1] || null
  if (mode === 'review' || mode === 'sweep') return parseReviewRun(dir, runId, mode, agents)
  if (mode === 'scale') return parseScaleRun(dir, runId, agents)

  const units = new Map()
  const unit = (id) => units.get(id) ?? units.set(id, { id, builds: [], verifies: [], escalation: 'none', tokens: { build: 0, verify: 0, escalation: 0 }, models: new Set() }).get(id)
  for (const a of agents) {
    const m = /^(build|verify|diagnose|advise|rebuild):([^#]+)(?:#(.+))?$/.exec(a.label)
    if (!m) continue
    const [, kind, id, tag] = m
    const u = unit(id)
    const st = agentStats(dir, a.agentId)
    if (st.model) u.models.add(st.model)
    if (kind === 'build') { u.builds.push({ tag, result: a.result }); u.tokens.build += st.out }
    else if (kind === 'verify') { u.verifies.push({ tag, result: a.result }); u.tokens.verify += st.out }
    else { u.tokens.escalation += st.out; u.escalation = kind === 'diagnose' || kind === 'advise' ? (u.escalation === 'rebuild' ? 'rebuild' : 'diagnose') : 'rebuild' }
  }
  const outcomes = [...units.values()].map((u) => {
    const b1 = u.builds.find((b) => b.tag === '1')?.result
    const v1 = u.verifies.find((v) => v.tag === '1')?.result
    const lastB = u.builds.at(-1)?.result
    const lastV = u.verifies.at(-1)?.result
    return {
      runId,
      kind: 'unit',
      role: 'build',
      id: u.id,
      firstPass: !!(b1 && b1.done && v1 && v1.pass === true),
      finalPass: !!(lastV && lastV.pass === true) || (lastV == null && !!lastB?.done),
      attempts: u.builds.length,
      escalation: u.escalation,
      tokens: u.tokens,
      modelsSeen: [...u.models],
      lastBuild: lastB ?? null,
      lastVerify: lastV ?? null,
    }
  })
  return { runId, dir, outcomes }
}

// review/sweep: one outcome per routed reviewer — how many findings it raised and how many survived the
// adversarial verify. Verify labels carry no reviewer id, so each verdict is matched back to a finding by the
// label's key (review: the finding title's first 28 chars; sweep: the file name of its location).
function parseReviewRun(dir, runId, mode, agents) {
  const key = mode === 'review' ? (f) => String(f.title).slice(0, 28) : (f) => String(f.location).split(/[: ]/)[0].split('/').pop()
  const reviewers = agents.filter((a) => a.label.startsWith('review:'))
  const verdicts = new Map()
  for (const a of agents) {
    if (!a.label.startsWith('verify:') || !a.result) continue
    const k = a.label.slice('verify:'.length)
    ;(verdicts.get(k) ?? verdicts.set(k, []).get(k)).push(a.result.isReal === true)
  }
  const outcomes = reviewers.map((a) => {
    const findings = Array.isArray(a.result?.findings) ? a.result.findings : []
    let verified = 0, confirmed = 0
    for (const f of findings) {
      const votes = verdicts.get(key(f))
      if (!votes?.length) continue
      verified++
      if (votes.filter(Boolean).length >= Math.ceil(votes.length / 2)) confirmed++
    }
    const st = agentStats(dir, a.agentId)
    return { runId, kind: 'review', role: 'review', mode, id: a.label.slice('review:'.length), findings: findings.length, verified, confirmed, tokens: { review: st.out }, modelsSeen: st.model ? [st.model] : [] }
  })
  return { runId, dir, outcomes }
}

// scale: one outcome for the routed unit template — how many units came back built, and their mean tokens.
function parseScaleRun(dir, runId, agents) {
  const builds = agents.filter((a) => /^build:\d+$/.test(a.label))
  const tokens = builds.map((a) => agentStats(dir, a.agentId).out)
  const models = [...new Set(builds.map((a) => agentStats(dir, a.agentId).model).filter(Boolean))]
  return {
    runId,
    dir,
    outcomes: [{ runId, kind: 'scale', role: 'build', id: 'template', units: builds.length, built: builds.filter((a) => a.result != null).length, tokens: { build: tokens.length ? Math.round(tokens.reduce((x, y) => x + y, 0) / tokens.length) : 0 }, modelsSeen: models }],
  }
}

// ---------- Jev post-task evaluation (true = a problem) ----------
export function evalQuestions() {
  const flag = (q, t, f) => ({ type: 'noul', instructions: q, criteria: { true: t, false: f } })
  return {
    acceptance_unmet: flag('Judging only from `builder_report` and `verifier`, is any part of `unit.acceptance` left unmet?', 'Some acceptance criterion is not shown as met', 'Every acceptance criterion is shown as met'),
    off_target: flag('Did the work described in `builder_report` drift from what `unit.spec` asked for?', 'It changed things the spec did not ask for, or solved a different problem', 'It stays on what the spec asked'),
    // scoped to the unit's OWN spec: an honest note about checks outside the unit, or verification the builder
    // could not run, is not unfinished work (2026-10-01: the unscoped wording flagged 4/4 verified units)
    incomplete: flag('Is any part of what `unit.spec` asked for left unfinished according to `builder_report` (TODOs, skipped cases, partial implementation)? Notes about checks that belong to other units, or verification the builder could not run, do not count as unfinished work.', 'Some part of the requested change itself is not done', 'The requested change is done; any caveats concern checks outside the unit or unrun verification'),
    unsupported_claim: flag('Does `builder_report` claim success that `verifier` does not back with concrete evidence (tests run, files re-read)?', 'A success claim lacks verification evidence', 'Claims are backed by the verifier'),
    quality: { type: 'score', instructions: 'How well does the finished unit meet its spec, judging from the reports?', criteria: ['Failed or clearly wrong', 'Partially meets the spec with notable gaps', 'Meets the spec with minor gaps', 'Fully meets the spec with verified evidence'] },
  }
}

function jevKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY
  try { return readFileSync(join(HOME, '.config', 'typesafe', 'api_key'), 'utf8').trim() || null } catch { return null }
}

async function jevEval(key, route, o) {
  const clip = (x, n) => (typeof x === 'string' ? x : JSON.stringify(x ?? null)).slice(0, n)
  const state = {
    unit: { title: route?.title ?? o.id, spec: clip(route?.spec, 4000), acceptance: clip(route?.acceptance, 2000) },
    builder_report: clip(o.lastBuild, 6000),
    verifier: clip(o.lastVerify, 6000),
  }
  try {
    const ctl = AbortSignal.timeout(8000)
    const res = await fetch(JEV_URL, { method: 'POST', signal: ctl, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: JEV_MODEL, state, questions: evalQuestions() }) })
    if (!res.ok) return null
    const a = (await res.json()).answers
    const flags = ['acceptance_unmet', 'off_target', 'incomplete', 'unsupported_claim']
    const ev = Object.fromEntries(flags.map((k) => [k, round(a[k]?.noul, 3)]))
    ev.quality = round(a.quality?.score, 2)
    ev.flag = Math.max(...flags.map((k) => ev[k] ?? 0)) >= 0.7 // any serious flag (max, not mean)
    return ev
  } catch {
    return null
  }
}

// ---------- commands ----------
async function ingest({ noEval, root }) {
  mkdirSync(DIR, { recursive: true })
  const done = new Set(readJson(F.ingested, []))
  const routes = readJsonl(F.routes)
  const key = noEval ? null : jevKey()
  const fresh = []
  for (const dir of workflowDirs(root)) {
    if (done.has(dir)) continue
    let run
    try { run = parseRun(dir) } catch { continue }
    if (!run) { done.add(dir); continue } // not a routed run: never look again
    if (run.incomplete) continue // still running or partial: retry next time
    const ts = statSync(join(dir, 'journal.jsonl')).mtimeMs
    for (const o of run.outcomes) {
      const route = routes.find((r) => r.runId === run.runId && r.id === o.id && r.role === o.role)
      const ev = key && o.kind === 'unit' ? await jevEval(key, route, o) : null // Jev judges built units only
      const { lastBuild, lastVerify, ...rest } = o
      const row = { ts, ...rest, arm: route?.decision?.model ? `${route.decision.model}/${route.decision.effort}` : null, reason: route?.decision?.reason ?? null, policyVersion: route?.policyVersion ?? 0, eval: ev }
      appendFileSync(F.outcomes, JSON.stringify(row) + '\n')
    }
    const kind = run.outcomes[0]?.kind ?? 'unit'
    fresh.push({
      runId: run.runId,
      kind,
      units: run.outcomes.length,
      ...(kind === 'unit' ? { firstPass: run.outcomes.filter((o) => o.firstPass).length, escalations: run.outcomes.filter((o) => o.escalation !== 'none').length } : {}),
      ...(kind === 'review' ? { findings: run.outcomes.reduce((s, o) => s + o.findings, 0), confirmed: run.outcomes.reduce((s, o) => s + o.confirmed, 0) } : {}),
      ...(kind === 'scale' ? { built: run.outcomes[0].built, of: run.outcomes[0].units } : {}),
    })
    done.add(dir)
  }
  writeFileSync(F.ingested, JSON.stringify([...done].slice(-5000)))
  return { ingested: fresh }
}

export function analyze(routes, outcomes, ratings) {
  const byKey = new Map(routes.filter((r) => r.role === 'build').map((r) => [`${r.runId}:${r.id}`, r]))
  const bad = new Set(ratings.filter((r) => r.rating === 'bad').map((r) => r.runId))
  // policy tuning reads built units only (kind 'unit'; rows from before kinds existed count as units)
  const rows = outcomes.filter((o) => (o.kind ?? 'unit') === 'unit').map((o) => ({ o, r: byKey.get(`${o.runId}:${o.id}`), humanBad: bad.has(o.runId) })).filter((x) => x.r)
  const ok = (x) => x.o.firstPass && !x.humanBad
  const bucket = (xs) => ({ n: xs.length, firstPass: xs.length ? round(xs.filter(ok).length / xs.length) : null, meanBuildTokens: xs.length ? Math.round(xs.reduce((s, x) => s + (x.o.tokens?.build ?? 0), 0) / xs.length) : null, escalated: xs.filter((x) => x.o.escalation !== 'none').length })
  const arms = {}
  for (const x of rows) (arms[x.o.arm ?? 'static'] ??= []).push(x)
  const reason = (re) => rows.filter((x) => re.test(x.r.decision?.reason ?? ''))
  const midConf = rows.filter((x) => x.r.jev && x.r.jev.confidence >= 0.4 && x.r.jev.confidence < 0.6 && !/low-conf/.test(x.r.decision?.reason ?? ''))
  const evaluated = rows.filter((x) => x.o.eval)
  const agree = evaluated.filter((x) => x.o.eval.flag === !x.o.finalPass).length
  return {
    samples: rows.length,
    arms: Object.fromEntries(Object.entries(arms).map(([k, xs]) => [k, bucket(xs)])),
    downgrades: bucket(reason(/downgrade/)),
    upgrades: bucket(reason(/upgrade/)),
    keptPlanner: bucket(reason(/keep-planner/)),
    midConfidence: bucket(midConf),
    jevEval: { n: evaluated.length, agreementWithVerify: evaluated.length ? round(agree / evaluated.length) : null },
    reviewArms: armStats(outcomes.filter((o) => o.kind === 'review'), (xs) => ({
      n: xs.length,
      meanFindings: round(xs.reduce((s, o) => s + o.findings, 0) / xs.length, 1),
      confirmRate: xs.some((o) => o.verified) ? round(xs.reduce((s, o) => s + o.confirmed, 0) / Math.max(1, xs.reduce((s, o) => s + o.verified, 0))) : null,
      meanTokens: Math.round(xs.reduce((s, o) => s + (o.tokens?.review ?? 0), 0) / xs.length),
    })),
    scaleArms: armStats(outcomes.filter((o) => o.kind === 'scale'), (xs) => ({
      runs: xs.length,
      builtRate: round(xs.reduce((s, o) => s + o.built, 0) / Math.max(1, xs.reduce((s, o) => s + o.units, 0))),
      meanUnitTokens: Math.round(xs.reduce((s, o) => s + (o.tokens?.build ?? 0), 0) / xs.length),
    })),
  }
}

// report-only stats per routed arm (review/scale rows do not move the policy)
function armStats(rows, summarize) {
  const by = {}
  for (const o of rows) (by[o.arm ?? 'static'] ??= []).push(o)
  return Object.fromEntries(Object.entries(by).map(([k, xs]) => [k, summarize(xs)]))
}

// Bounded, sample-gated moves; one STEP per tune at most. Returns the new policy (unchanged when no evidence).
export function propose(policy, report) {
  const p = { ...DEFAULT_POLICY, ...policy }
  const moves = []
  const clamp = (k, v) => Math.min(BOUNDS[k][1], Math.max(BOUNDS[k][0], round(v, 2)))
  const d = report.downgrades
  if (d.n >= MIN_N && d.firstPass < TARGET_FIRST_PASS) moves.push(['DOWNGRADE_MIN_CONFIDENCE', +STEP, `downgrades first-pass ${d.firstPass} < ${TARGET_FIRST_PASS} (n=${d.n})`])
  else if (d.n >= MIN_N && d.firstPass >= 0.95) moves.push(['DOWNGRADE_MIN_CONFIDENCE', -STEP, `downgrades first-pass ${d.firstPass} ≥ 0.95 (n=${d.n}) — allow more`])
  const m = report.midConfidence
  if (m.n >= MIN_N && m.firstPass < TARGET_FIRST_PASS) moves.push(['LOW_CONFIDENCE', +STEP, `picks at confidence 0.4–0.6 first-pass ${m.firstPass} (n=${m.n}) — step those up`])
  for (const [k, delta] of moves) p[k] = clamp(k, p[k] + delta)
  if (moves.length) p.version = (p.version ?? 0) + 1
  return { policy: p, moves: moves.map(([k, d, why]) => ({ key: k, delta: d, why })) }
}

function tune({ dry }) {
  const report = analyze(readJsonl(F.routes), readJsonl(F.outcomes), readJsonl(F.ratings))
  const current = readJson(F.policy, DEFAULT_POLICY)
  const { policy, moves } = propose(current, report)
  if (!dry && moves.length) writeFileSync(F.policy, JSON.stringify({ ...policy, updatedAt: new Date().toISOString(), basis: report }, null, 2))
  return { report, policy, moves, applied: !dry && moves.length > 0 }
}

function rate(args) {
  const [rating, maybeRun, ...note] = args
  if (rating !== 'good' && rating !== 'bad') return { error: 'usage: rate good|bad [runId] [note]' }
  const runs = readJsonl(F.outcomes).map((o) => o.runId)
  const runId = /^r\d+$/.test(maybeRun ?? '') ? maybeRun : runs.at(-1)
  if (!runId) return { error: 'no ingested run to rate yet' }
  const extra = /^r\d+$/.test(maybeRun ?? '') ? note : [maybeRun, ...note].filter(Boolean)
  appendFileSync(F.ratings, JSON.stringify({ ts: Date.now(), runId, rating, note: extra.join(' ') || null }) + '\n')
  return { rated: runId, rating }
}

// ---------- main ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2)
  const flag = (f) => rest.includes(f)
  const rootAt = rest.indexOf('--root')
  const root = rootAt >= 0 ? rest[rootAt + 1] : join(HOME, '.claude', 'projects')
  mkdirSync(DIR, { recursive: true })
  let out
  if (cmd === 'ingest') out = await ingest({ noEval: flag('--no-eval'), root })
  else if (cmd === 'tune') out = tune({ dry: flag('--dry') })
  else if (cmd === 'stats') out = tune({ dry: true })
  else if (cmd === 'rate') out = rate(rest)
  else out = { error: 'usage: strata-ledger.mjs ingest|tune|stats|rate' }
  process.stdout.write(JSON.stringify(out) + '\n')
}
