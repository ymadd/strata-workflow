import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseRun, analyze, propose, DEFAULT_POLICY } from './strata-ledger.mjs'

// --- fixture: a routed conduct run, U1 passes first time, U2 fails once then passes after diagnosis
const dir = mkdtempSync(join(tmpdir(), 'wf_'))
const agents = [
  ['a0', 'route:jev', { routes: [] }, 'Input:\n{"mode":"conduct","runId":"r123","units":[]}', 'claude-haiku-4-5', 50],
  ['a1', 'build:U1#1', { done: true }, 'x', 'claude-haiku-4-5', 300],
  ['a2', 'verify:U1#1', { pass: true }, 'x', 'claude-sonnet-5-5', 200],
  ['a3', 'build:U2#1', { done: true }, 'x', 'claude-sonnet-5-5', 900],
  ['a4', 'verify:U2#1', { pass: false }, 'x', 'claude-sonnet-5-5', 250],
  ['a5', 'build:U2#2', { done: true }, 'x', 'claude-sonnet-5-5', 800],
  ['a6', 'verify:U2#2', { pass: false }, 'x', 'claude-sonnet-5-5', 250],
  ['a7', 'diagnose:U2', { rootCause: 'r' }, 'x', 'claude-opus-5-5', 400],
  ['a8', 'build:U2#advised', { done: true }, 'x', 'claude-sonnet-5-5', 700],
  ['a9', 'verify:U2#advised', { pass: true }, 'x', 'claude-sonnet-5-5', 260],
]
const journal = [{ type: 'launched' }]
for (const [id, label, result, prompt, model, out] of agents) {
  journal.push({ type: 'started', key: `k${id}`, agentId: id, label })
  journal.push({ type: 'result', key: `k${id}`, agentId: id, result })
  writeFileSync(join(dir, `agent-${id}.jsonl`), [
    { type: 'user', message: { role: 'user', content: prompt } },
    { type: 'assistant', message: { role: 'assistant', model, usage: { output_tokens: out } } },
  ].map((r) => JSON.stringify(r)).join('\n'))
}
writeFileSync(join(dir, 'journal.jsonl'), journal.map((r) => JSON.stringify(r)).join('\n'))
const run = parseRun(dir)
assert.equal(run.runId, 'r123')
const u1 = run.outcomes.find((o) => o.id === 'U1'), u2 = run.outcomes.find((o) => o.id === 'U2')
assert.deepEqual([u1.firstPass, u1.finalPass, u1.attempts, u1.escalation], [true, true, 1, 'none'])
assert.deepEqual([u2.firstPass, u2.finalPass, u2.attempts, u2.escalation], [false, true, 3, 'diagnose'])
assert.deepEqual(u2.tokens, { build: 2400, verify: 760, escalation: 400 })
// unrouted run → null
const d2 = mkdtempSync(join(tmpdir(), 'wf_'))
writeFileSync(join(d2, 'journal.jsonl'), JSON.stringify({ type: 'started', key: 'k', agentId: 'z', label: 'build:U1#1' }))
assert.equal(parseRun(d2), null)

// --- tuning: 12 downgrades with 7 first-pass (0.58 < 0.8) → raise DOWNGRADE_MIN_CONFIDENCE one step
const routes = [], outcomes = []
for (let i = 0; i < 12; i++) {
  routes.push({ runId: 'r1', id: `U${i}`, role: 'build', jev: { confidence: 0.9 }, decision: { model: 'haiku', effort: 'low', reason: 'jev,downgrade:sonnet→haiku' } })
  outcomes.push({ runId: 'r1', id: `U${i}`, arm: 'haiku/low', firstPass: i < 7, finalPass: true, escalation: 'none', tokens: { build: 100 } })
}
const rep = analyze(routes, outcomes, [])
assert.equal(rep.downgrades.n, 12); assert.equal(rep.downgrades.firstPass, 0.58)
const { policy, moves } = propose(DEFAULT_POLICY, rep)
assert.equal(policy.DOWNGRADE_MIN_CONFIDENCE, 0.85); assert.equal(policy.version, 1); assert.equal(moves.length, 1)
// bounded: never above 0.95
assert.equal(propose({ ...DEFAULT_POLICY, DOWNGRADE_MIN_CONFIDENCE: 0.95 }, rep).policy.DOWNGRADE_MIN_CONFIDENCE, 0.95)
// too few samples → no move
assert.equal(propose(DEFAULT_POLICY, analyze(routes.slice(0, 5), outcomes.slice(0, 5), [])).moves.length, 0)
// a human "bad" rating turns first-pass successes into failures for tuning
assert.equal(analyze(routes, outcomes, [{ runId: 'r1', rating: 'bad' }]).downgrades.firstPass, 0)

// --- review mode: reviewers are review:<dim>, verdicts verify:<title[0:28]>; majority isReal confirms
const fixture = (agents) => {
  const d = mkdtempSync(join(tmpdir(), 'wf_'))
  const j = []
  for (const [id, label, result, prompt, model, out] of agents) {
    j.push({ type: 'started', key: `k${id}`, agentId: id, label }, { type: 'result', key: `k${id}`, agentId: id, result })
    writeFileSync(join(d, `agent-${id}.jsonl`), [
      { type: 'user', message: { role: 'user', content: prompt } },
      { type: 'assistant', message: { role: 'assistant', model, usage: { output_tokens: out } } },
    ].map((r) => JSON.stringify(r)).join('\n'))
  }
  writeFileSync(join(d, 'journal.jsonl'), j.map((r) => JSON.stringify(r)).join('\n'))
  return d
}
const longTitle = 'Unchecked null deref in parseConfig when file missing'
const rv = parseRun(fixture([
  ['r0', 'route:jev', { routes: [] }, 'Input:\n{"mode":"review","runId":"r900","units":[]}', 'claude-haiku-4-5', 40],
  ['r1', 'review:correctness', { findings: [{ title: longTitle, location: 'src/a.ts:10' }, { title: 'Off by one in pager', location: 'src/p.ts:3' }] }, 'x', 'claude-sonnet-5-5', 800],
  ['r2', 'review:security', { findings: [] }, 'x', 'claude-opus-5-5', 300],
  ['v1', `verify:${longTitle.slice(0, 28)}`, { isReal: true }, 'x', 'claude-sonnet-5-5', 100],
  ['v2', `verify:${longTitle.slice(0, 28)}`, { isReal: true }, 'x', 'claude-sonnet-5-5', 100],
  ['v3', 'verify:Off by one in pager', { isReal: false }, 'x', 'claude-sonnet-5-5', 100],
]))
const corr = rv.outcomes.find((o) => o.id === 'correctness'), sec = rv.outcomes.find((o) => o.id === 'security')
assert.deepEqual([corr.kind, corr.findings, corr.verified, corr.confirmed, corr.tokens.review], ['review', 2, 2, 1, 800])
assert.deepEqual([sec.findings, sec.confirmed], [0, 0])
assert.ok(!rv.outcomes.some((o) => o.id.startsWith('Unchecked')), 'verify labels must not become units')

// --- scale mode: one template outcome; build:<index> labels are not conduct units
const sc = parseRun(fixture([
  ['s0', 'route:jev', { routes: [] }, 'Input:\n{"mode":"scale","runId":"r901","units":[]}', 'claude-haiku-4-5', 40],
  ['s1', 'build:0', { ok: 1 }, 'x', 'claude-haiku-4-5', 100],
  ['s2', 'build:1', null, 'x', 'claude-haiku-4-5', 300],
]))
assert.equal(sc.outcomes.length, 1)
assert.deepEqual([sc.outcomes[0].kind, sc.outcomes[0].id, sc.outcomes[0].units, sc.outcomes[0].built, sc.outcomes[0].tokens.build], ['scale', 'template', 2, 1, 200])

// review/scale rows never feed policy tuning, but show up as report-only arm stats
const mixed = analyze([], [{ ...corr, arm: 'sonnet/low' }, { ...sc.outcomes[0], arm: 'haiku/low' }], [])
assert.equal(mixed.samples, 0)
assert.deepEqual(mixed.reviewArms['sonnet/low'], { n: 1, meanFindings: 2, confirmRate: 0.5, meanTokens: 800 })
assert.deepEqual(mixed.scaleArms['haiku/low'], { runs: 1, builtRate: 0.5, meanUnitTokens: 200 })
console.log('all ledger tests pass')
