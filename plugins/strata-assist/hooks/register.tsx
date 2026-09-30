import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import { parse, candidates, agentEstimate, fmtTokens, MODES, VARIANTS } from './strata'
import { buildRequest, readResponse, JEV_URL, JEV_MODEL, type Route } from './jev'
import { buildQuestions, buildState, readAnswers, decide, DEFAULT_POLICY, type Policy, type RouteUnit } from './route'

// Strata input assist: while a /strata-workflow command is being typed, a band above the
// prompt shows how the router will read it, what can come next, and (when no mode is named)
// Jev's predicted auto-route. It never changes the prompt; it only explains it.

const draft = atom({ plugin: 'strata-assist', key: 'draft' } as const, null)
const route = atom({ plugin: 'strata-assist', key: 'route' } as const, null)

const DEBOUNCE_MS = 700
const MIN_TASK = 8 // chars before asking Jev
const TIMEOUT_MS = 3000

type Ctx = { seq: number; cache: Map<string, Route> }

const ROUTE_TOOL = 'mcp__strata-assist__route'
const ROUTED_WORKFLOWS = /strata-(conduct|delegate|review|sweep|scale)(\.js)?$/

// One Jev System One call with a hard deadline; null on any failure (callers fall back, never block).
async function jevPost($: Engine, key: string, body: unknown): Promise<any | null> {
  try {
    const res = await Promise.race([
      $.http.fetch(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      $.clock.sleep(TIMEOUT_MS).then(() => null),
    ])
    return res && res.ok ? JSON.parse(res.text) : null
  } catch {
    return null
  }
}

// Append-only routing ledger (JSONL) — the raw material for evaluation and tuning (step ④).
async function appendLedger($: Engine, rows: unknown[]) {
  const home = await $.env.get('HOME')
  if (!home || !rows.length) return
  const dir = `${home}/.claude/strata`
  const path = `${dir}/routes.jsonl`
  try {
    await $.process.run(['mkdir', '-p', dir])
    let prev = ''
    try {
      const t = (await $.fs.read(path)) as unknown
      prev = typeof t === 'string' ? t : String((t as any)?.text ?? '')
    } catch {}
    await $.fs.write(path, prev + rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  } catch {}
}

// Tuned routing policy written by `strata-ledger tune`; defaults when absent or malformed.
async function loadPolicy($: Engine): Promise<Policy> {
  const home = await $.env.get('HOME')
  try {
    const t = (await $.fs.read(`${home}/.claude/strata/policy.json`)) as unknown
    const p = JSON.parse(typeof t === 'string' ? t : String((t as any)?.text ?? ''))
    const ok = (k: keyof Policy) => typeof p[k] === 'number'
    return ok('LOW_CONFIDENCE') && ok('DOWNGRADE_MIN_CONFIDENCE') && ok('DOWNGRADE_MAX_BLAST') ? { ...DEFAULT_POLICY, ...p } : DEFAULT_POLICY
  } catch {
    return DEFAULT_POLICY
  }
}

// Runs bin/strata-ledger.mjs (plain Node: reads transcripts, calls Jev, writes the ledger).
async function ledger($: Engine, argv: string[]): Promise<any> {
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/bin/strata-ledger.mjs`, ...argv], { timeoutMs: 120_000 })
    const line = r.stdout.trim().split('\n').pop() || '{}'
    return r.exitCode === 0 ? JSON.parse(line) : { error: (r.stderr || line).slice(0, 300) }
  } catch (err) {
    return { error: String(err).slice(0, 300) }
  }
}

// After a turn: ingest finished routed runs; tell the person what came in and how to rate it.
async function autoIngest($: Engine) {
  if ((await $.store.get('jev')) === false) return
  const out = await ledger($, ['ingest'])
  const runs = Array.isArray(out?.ingested) ? out.ingested : []
  for (const r of runs) {
    const what =
      r.kind === 'review' ? `${r.confirmed}/${r.findings} findings confirmed` : r.kind === 'scale' ? `${r.built}/${r.of} units built` : `first-pass ${r.firstPass}/${r.units}, escalations ${r.escalations}`
    $.ui.toast(`Strata ${r.runId}: ${what} — /strata-assist rate good|bad`)
  }
}

// The route tool: Jev per unit (parallel) → policy → ledger → compact routes for the relay agent.
async function serveRoute($: Engine, input: any): Promise<string> {
  const units: RouteUnit[] = Array.isArray(input?.units) ? input.units.slice(0, 40) : []
  const mode = String(input?.mode ?? '')
  const key = (await $.store.get('jev')) === false ? undefined : await apiKey($)
  const answers = await Promise.all(
    units.map(u => (key ? jevPost($, key, { model: JEV_MODEL, state: buildState(u, mode), questions: buildQuestions() }) : Promise.resolve(null))),
  )
  const ts = await $.clock.now()
  const policy = await loadPolicy($)
  const rows: unknown[] = []
  const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.slice(0, n) : null)
  const routes = units.map((u, i) => {
    const j = readAnswers(answers[i])
    const d = decide(u, j, policy)
    rows.push({
      ts, runId: input?.runId ?? null, mode, id: u.id, role: u.role, plannerTier: u.plannerTier ?? null,
      title: clip(u.title, 200), spec: clip(u.spec, 4000), acceptance: clip(u.acceptance, 2000),
      jevModel: JEV_MODEL, policyVersion: policy.version, jev: j, decision: d,
    })
    return d
  })
  await appendLedger($, rows)
  return JSON.stringify({ routes })
}

// TYPESAFE_API_KEY from the environment, else ~/.config/typesafe/api_key (keeps the key out of settings/transcripts)
async function apiKey($: Engine): Promise<string | undefined> {
  const fromEnv = await $.env.get('TYPESAFE_API_KEY')
  if (fromEnv) return fromEnv
  const home = await $.env.get('HOME')
  if (!home) return undefined
  try {
    const text = (await $.fs.read(`${home}/.config/typesafe/api_key`)) as unknown
    const key = String(typeof text === 'string' ? text : (text as any)?.text ?? '').trim()
    return key || undefined
  } catch {
    return undefined
  }
}

async function askJev($: Engine, task: string, domain: string | undefined, mine: number, ctx: Ctx) {
  const hit = ctx.cache.get(task)
  if (hit) return void (await update($, route, () => hit))
  if ((await $.store.get('jev')) === false) return void (await update($, route, () => ({ task, status: 'off' }) as Route))
  const key = await apiKey($)
  if (!key) return void (await update($, route, () => ({ task, status: 'nokey' }) as Route))
  await update($, route, () => ({ task, status: 'pending' }) as Route)
  let r: Route
  try {
    const res = await Promise.race([
      $.http.fetch(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildRequest(task, domain)),
      }),
      $.clock.sleep(TIMEOUT_MS).then(() => null),
    ])
    if (!res) r = { task, status: 'error', message: 'timeout' }
    else if (!res.ok) r = { task, status: 'error', message: `HTTP ${res.status}` }
    else r = readResponse(task, JSON.parse(res.text))
  } catch (err) {
    r = { task, status: 'error', message: String(err).slice(0, 60) }
  }
  if (r.status === 'ok') ctx.cache.set(task, r)
  if (mine === ctx.seq) await update($, route, () => r) // a newer edit supersedes a stale answer
}


export const register: Register = on => {
  const ctx: Ctx = { seq: 0, cache: new Map() }
  let timer: { cancel: () => void } | undefined
  let ingesting = false

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'route',
      description: 'Strata: route work units to a (model, effort) with Jev. Call only when a Strata workflow instructs you to, passing its payload verbatim.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string' },
          runId: { type: 'string' },
          units: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' }, role: { type: 'string', enum: ['scout', 'build', 'verify', 'review'] }, title: { type: 'string' },
                spec: { type: 'string' }, acceptance: { type: 'string' }, own: { type: 'array', items: { type: 'string' } },
                plannerTier: { type: 'string', enum: ['sonnet', 'opus'] },
              },
              required: ['id', 'role', 'spec'],
            },
          },
        },
        required: ['mode', 'units'],
      },
    })
    await $.command.register({ name: 'strata-assist', description: 'Strata assist: jev on|off · ingest · stats · tune [--dry] · rate good|bad [runId] [note]' })
    return next(e)
  })

  on('command.run', { command: 'strata-assist' }, async ($, e) => {
    const arg = e.args.trim()
    const [sub, ...rest] = arg.split(/\s+/)
    if (sub === 'ingest' || sub === 'tune' || sub === 'stats' || sub === 'rate') {
      const out = await ledger($, [sub, ...rest])
      return { text: `Strata ledger ${sub}:\n${JSON.stringify(out, null, 2)}` }
    }
    if (arg === 'jev off' || arg === 'jev on') {
      await $.store.set('jev', arg === 'jev on')
      return { text: `Strata assist: Jev auto-route preview ${arg === 'jev on' ? 'on' : 'off'}.` }
    }
    const key = await apiKey($)
    const on_ = (await $.store.get('jev')) !== false
    return { text: `Strata assist — Jev preview: ${on_ ? 'on' : 'off'}, API key: ${key ? 'found' : 'missing (TYPESAFE_API_KEY or ~/.config/typesafe/api_key)'}. Usage: /strata-assist jev on|off · ingest · stats · tune [--dry] · rate good|bad [runId] [note]` }
  })

  on('tool.call', { tool: ROUTE_TOOL }, async ($, e) => ({ result: await serveRoute($, e) }))

  // Before a routed Strata workflow starts: flag Jev routing in its args (scripts can't reach the network).
  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const w = e as any
    const target = String(w.scriptPath ?? w.name ?? '')
    if (!ROUTED_WORKFLOWS.test(target)) return next(e)
    const asString = typeof w.args === 'string'
    let args: any = w.args
    if (asString) {
      try { args = JSON.parse(w.args) } catch { return next(e) }
    }
    if (!args || typeof args !== 'object' || args.dataSensitive === true || args.jev) return next(e)
    if ((await $.store.get('jev')) === false || !(await apiKey($))) return next(e)
    const runId = `r${await $.clock.now()}`
    const withJev = { ...args, jev: { route: true, tool: ROUTE_TOOL, runId } }
    return next({ ...w, args: asString ? JSON.stringify(withJev) : withJev })
  })

  on('prompt.edit', async ($, e, next) => {
    const res = await next(e)
    const text = (res as any)?.text ?? e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    const p = parse(text)
    await update($, draft, () => p)
    const mine = ++ctx.seq
    timer?.cancel()
    if (p && p.inTask && !p.mode && p.task.length >= MIN_TASK) {
      timer = $.clock.after(DEBOUNCE_MS, () => void askJev($, p.task, p.domain, mine, ctx))
    }
    return res
  })

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    if (!ingesting) {
      ingesting = true
      $.clock.after(0, () =>
        void autoIngest($).finally(() => {
          ingesting = false
        }),
      )
    }
    return res
  })

  on('prompt.submit', async ($, e, next) => {
    timer?.cancel()
    await update($, draft, () => null)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, draft)
    if (!p || e.props.hasSurvey) return next(e)
    const r = await read($, route)
    const { Box, Text } = $.ui.resolve(e)
    const est = agentEstimate(p)
    const capText = p.maxAgents
      ? `agents=${p.maxAgents} (explicit)`
      : est
        ? `cap=${fmtTokens(est.cap)}${est.capSet ? '' : ' (default)'} · agents≈${est.agents}`
        : p.cap ? `cap=${fmtTokens(p.cap)}` : 'cap=mode default'
    const head =
      `Strata:${p.skill} · mode=${p.mode ? p.mode + (p.variant ? `+${p.variant}` : '') : 'auto'} · domain=${p.domain ?? '—'} · ${capText}` +
      (p.tier ? ` · tier=${p.tier}` : '') + (p.unleashed ? ' · unleashed' : '')

    const lines: string[] = []
    if (p.mode) lines.push(`${p.mode}: ${MODES[p.mode]}${p.variant ? ` · ${p.variant}: ${VARIANTS[p.variant].about}` : ''}`)
    if (p.variant === 'emergent') lines.push('ultra emergent（旧 evolve）は自律ビルド（既定 500k）。意図した指定か確認してください')
    if (!p.inTask) {
      const next_ = candidates(p)
      lines.push(next_.length ? `次に置ける語: ${next_.slice(0, 10).join('  ')}${p.mode ? '' : '  (省略すると自動選択)'}` : 'タスクを書いてください')
      if (!p.mode && !p.task && p.partial === '') lines.push('何も書かずに送信 → モード一覧を表示')
    } else if (!p.mode) {
      if (!r || r.task !== p.task) lines.push(p.task.length < MIN_TASK ? 'auto-route: タスクをもう少し書くと予測します' : 'auto-route: …')
      else if (r.status === 'pending') lines.push('auto-route: Jev に問い合わせ中…')
      else if (r.status === 'nokey') lines.push('auto-route 予測なし: API キー未設定 (TYPESAFE_API_KEY か ~/.config/typesafe/api_key)')
      else if (r.status === 'off') lines.push('auto-route 予測: off (/strata-assist jev on)')
      else if (r.status === 'error') lines.push(`auto-route 予測失敗: ${r.message}（実行時はルーターが判断します）`)
      else {
        const pct = (x: number) => `${Math.round(x * 100)}%`
        const low = r.confidence < 0.5
        lines.push(
          `auto-route 予測 → ${r.choice === 'solo' ? 'solo（ワークフロー不要）' : r.choice} ${pct(r.confidence)}` +
            (r.second ? ` · 次点 ${r.second} ${pct(r.secondP ?? 0)}` : '') +
            (low ? ' · 確信度低：モード名を先頭に書くと確実' : ''),
        )
        if (r.sensitive >= 0.5) lines.push(`⚠ 顧客/個人/非公開財務データの兆候 (${pct(r.sensitive)}) → delegate/conduct では dataSensitive:true 推奨`)
      }
    }

    return (
      <Box flexDirection="column">
        <Text bold>{head}</Text>
        {lines.map(l => (
          <Text dimColor>{l}</Text>
        ))}
      </Box>
    )
  })
}
