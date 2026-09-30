import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import { parse, candidates, agentEstimate, fmtTokens, MODES } from './strata'
import { buildRequest, readResponse, JEV_URL, type Route } from './jev'

// Strata input assist: while a /strata-workflow command is being typed, a band above the
// prompt shows how the router will read it, what can come next, and (when no mode is named)
// Jev's predicted auto-route. It never changes the prompt; it only explains it.

const draft = atom({ plugin: 'strata-assist', key: 'draft' } as const, null)
const route = atom({ plugin: 'strata-assist', key: 'route' } as const, null)

const DEBOUNCE_MS = 700
const MIN_TASK = 8 // chars before asking Jev
const TIMEOUT_MS = 3000

type Ctx = { seq: number; cache: Map<string, Route> }

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

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'strata-assist', description: 'Strata input assist: `jev on` / `jev off` toggles the Jev auto-route preview' })
    return next(e)
  })

  on('command.run', { command: 'strata-assist' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'jev off' || arg === 'jev on') {
      await $.store.set('jev', arg === 'jev on')
      return { text: `Strata assist: Jev auto-route preview ${arg === 'jev on' ? 'on' : 'off'}.` }
    }
    const key = await apiKey($)
    const on_ = (await $.store.get('jev')) !== false
    return { text: `Strata assist — Jev preview: ${on_ ? 'on' : 'off'}, API key: ${key ? 'found' : 'missing (TYPESAFE_API_KEY or ~/.config/typesafe/api_key)'}. Usage: /strata-assist jev on|off` }
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
      `Strata:${p.skill} · mode=${p.mode ?? 'auto'} · domain=${p.domain ?? '—'} · ${capText}` +
      (p.tier ? ` · tier=${p.tier}` : '') + (p.unleashed ? ' · unleashed' : '')

    const lines: string[] = []
    if (p.mode) lines.push(`${p.mode}: ${MODES[p.mode]}`)
    if (p.mode === 'evolve') lines.push('evolve は自律ビルド（既定 500k）。意図した指定か確認してください')
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
