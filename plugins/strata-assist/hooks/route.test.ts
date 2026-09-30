import assert from 'node:assert/strict'
import { decide } from './route.ts'
const J = (choice: string, confidence: number, blast = 1, extra: Record<string, number> = {}) =>
  ({ choice, confidence, probabilities: { [choice]: confidence, ...extra }, complexity: 1, ambiguity: 1, blast })
const b = (plannerTier?: 'sonnet' | 'opus') => ({ id: 'U1', role: 'build' as const, spec: 'x', plannerTier })
// plain pick
assert.deepEqual(decide(b(), J('sonnet/medium', 0.9)), { id: 'U1', role: 'build', model: 'sonnet', effort: 'medium', reason: 'jev' })
// verify band floor: haiku clamped up to sonnet/low
const v = decide({ id: 'V', role: 'verify', spec: 'x' }, J('haiku/low', 0.77, 1, { 'sonnet/low': 0.2 }))
assert.equal(v.model, 'sonnet'); assert.equal(v.effort, 'low'); assert.match(v.reason, /clamped:haiku\/low/)
// clamp with low confidence does NOT step up again (e2e regression: haiku 0.35 on verify → sonnet/low, not opus)
const c = decide({ id: 'V', role: 'verify', spec: 'x' }, J('haiku/low', 0.35, 1, { 'sonnet/medium': 0.25, 'sonnet/low': 0.17 }))
assert.deepEqual([c.model, c.effort], ['sonnet', 'low'])
// low confidence steps up
assert.equal(decide(b(), J('sonnet/low', 0.3)).effort, 'medium')
// planner opus, Jev confident + low blast → downgrade allowed
assert.match(decide(b('opus'), J('sonnet/low', 0.9, 1)).reason, /downgrade:opus→sonnet/)
// planner opus, high blast → keep opus
const k = decide(b('opus'), J('sonnet/low', 0.9, 3)); assert.equal(k.model, 'opus'); assert.match(k.reason, /keep-planner/)
// planner opus, low confidence → keep
assert.equal(decide(b('opus'), J('sonnet/medium', 0.6, 1)).model, 'opus')
// planner sonnet, Jev says haiku but conf 0.7 → keep sonnet/low
const h = decide(b('sonnet'), J('haiku/low', 0.7, 0.5)); assert.equal(h.model, 'sonnet'); assert.equal(h.effort, 'low')
// planner sonnet, Jev says opus → upgrade flagged
assert.match(decide(b('sonnet'), J('opus/high', 0.95, 3)).reason, /upgrade:sonnet→opus/)
// jev failure → no model (script falls back to static)
assert.equal(decide(b('sonnet'), null).model, undefined)
console.log('all route policy tests pass')
