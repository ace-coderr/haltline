import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiFail, confirmText, createApi, failText } from './api.ts'

interface Call { url: string; init: RequestInit }
function api(respond: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchFn = (async (url: string, init: RequestInit) => {
    const c = { url, init }
    calls.push(c)
    return respond(c)
  }) as unknown as typeof fetch
  return { calls, client: createApi({ baseUrl: 'https://example.supabase.co', anonKey: 'pub_key', fetchFn }) }
}
const ok = (b: object) => new Response(JSON.stringify({ ok: true, ...b }), { status: 200 })
const err = (status: number, code: string, extra: object = {}) =>
  new Response(JSON.stringify({ ok: false, error: { code, message: code, ...extra } }), { status })

test('positions: sends the device token and public key, nothing else secret', async () => {
  const { calls, client } = api(() => ok({ state: 'CALM' }))
  await client.positions('tok'.repeat(12))
  const h = calls[0]!.init.headers as Record<string, string>
  assert.equal(calls[0]!.url, 'https://example.supabase.co/functions/v1/positions')
  assert.deepEqual(Object.keys(h).sort(), ['apikey', 'x-device-token'])
  assert.equal(h.apikey, 'pub_key')
})

test('setLimit: POSTs JSON with the token', async () => {
  const { calls, client } = api(() => ok({ limit: 500 }))
  assert.deepEqual(await client.setLimit('t'.repeat(40), 500), { ok: true, limit: 500 })
  const c = calls[0]!
  assert.equal(c.init.method, 'POST')
  assert.equal(JSON.parse(c.init.body as string).limit, 500)
  assert.equal((c.init.headers as Record<string, string>)['Content-Type'], 'application/json')
})

test('transcribe: posts the WAV bytes unmodified with an audio content type', async () => {
  const { calls, client } = api(() => ok({ text: 'Set limit 500.', command: { kind: 'set_limit', amount: 500 } }))
  const wav = new Uint8Array([82, 73, 70, 70, 1, 2, 3])
  const r = await client.transcribe('t'.repeat(40), wav)
  assert.equal(r.command.kind, 'set_limit')
  const c = calls[0]!
  assert.equal(c.url, 'https://example.supabase.co/functions/v1/transcribe')
  assert.equal(c.init.method, 'POST')
  assert.equal((c.init.headers as Record<string, string>)['Content-Type'], 'audio/wav')
  assert.deepEqual([...(c.init.body as Uint8Array)], [...wav])
})

test('errors: network failure, HTTP errors with codes, and retry-after are surfaced typed', async () => {
  const down = createApi({ baseUrl: 'https://x.co', anonKey: 'k', fetchFn: (async () => { throw new TypeError('offline') }) as unknown as typeof fetch })
  await assert.rejects(down.positions('t'.repeat(40)), (e: unknown) => e instanceof ApiFail && e.network && e.status === 0)

  const e401 = api(() => err(401, 'unauthorized'))
  await assert.rejects(e401.client.positions('t'.repeat(40)), (e: unknown) => e instanceof ApiFail && e.status === 401)

  const limited = api(() => err(429, 'voice_rate_limited', { retryAfterMs: 40_000 }))
  await assert.rejects(limited.client.transcribe('t'.repeat(40), new Uint8Array(4)), (e: unknown) => e instanceof ApiFail && e.code === 'voice_rate_limited' && e.retryAfterMs === 40_000)

  const junk = api(() => new Response('<html>', { status: 502 }))
  await assert.rejects(junk.client.positions('t'.repeat(40)), (e: unknown) => e instanceof ApiFail && e.status === 502)
})

test('failText is short and glanceable for every refusal the server can give', () => {
  const mk = (code: string, retry: number | null = null) => new ApiFail(409, code, code, retry)
  assert.equal(failText(mk('cooldown', 41_200)), 'WAIT 42s')
  assert.equal(failText(mk('kill_switch')), 'WRITES OFF')
  assert.equal(failText(mk('raise_blocked')), 'USE THE SITE')
  assert.equal(failText(mk('prices_stale')), 'NO PRICES')
  assert.equal(failText(mk('something_new')), 'FAILED')
  assert.equal(failText(new ApiFail(0, 'network', 'x', null, true)), 'OFFLINE')
  assert.equal(failText(new Error('x')), 'FAILED')
})

test('confirmText: done, partial and nothing sent', () => {
  assert.equal(confirmText({ executed: 1, failed: 0, results: [] }), 'DONE · 1 ORDER')
  assert.equal(confirmText({ executed: 2, failed: 0, results: [] }), 'DONE · 2 ORDERS')
  assert.equal(confirmText({ executed: 1, failed: 1, results: [] }), 'PARTIAL 1/2')
  assert.equal(confirmText({ executed: 0, failed: 1, results: [] }), 'NOT SENT')
})
