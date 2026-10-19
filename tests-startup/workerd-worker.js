/* eslint no-console: 0 */
/* global addEventListener */
import postgres from './driver.js'
let unhandled = []
addEventListener('unhandledrejection', (event) => {
  const reason = event.reason?.stack || String(event.reason)
  unhandled.push(reason)
  console.error('WORKER_UNHANDLED_REJECTION', reason)
})
const nativeSetTimeout = globalThis.setTimeout
globalThis.setTimeout = function(callback, delay, ...extra) {
  if (extra.length) throw new TypeError('Failed to execute \'setTimeout\': parameter 3 is not of type \'Array\'.')
  return nativeSetTimeout(callback, delay)
}
function equal(a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('Mismatch ' + JSON.stringify({ expected: b, actual: a }))
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function within(promise, ms, label) {
  let timer
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' did not settle within ' + ms + 'ms')), ms) })
  try { return await Promise.race([promise, limit]) } finally { clearTimeout(timer) }
}
function client(port, options = {}) {
  return postgres({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', ssl: false, prepare: false, fetch_types: false, ...options })
}
const scenarios = {
  async timers(port) {
    const sql = client(port, { max: 1, idle_timeout: 1, max_lifetime: 1, connect_timeout: 2 })
    const [{ pid: first }] = await sql`select pg_backend_pid() as pid`
    await sleep(2500)
    const [{ pid: second }] = await within(sql`select pg_backend_pid() as pid`, 3000, 'query after timers')
    if (first === second) throw new Error('Connection was not recycled by the timers')
    await within(sql.end({ timeout: 1 }), 3000, 'end')
    return { first, second }
  },
  async 'connect-timeout'(port) {
    const sql = client(port, { max: 1, connect_timeout: 1 })
    const started = Date.now()
    const error = await within(sql`select 1`.then(() => null, (e) => e), 4000, 'connect timeout')
    if (error?.code !== 'CONNECT_TIMEOUT') throw new Error('Expected CONNECT_TIMEOUT, got ' + (error?.code || error?.message))
    await within(sql.end({ timeout: 0 }), 3000, 'end')
    return { code: error.code, ms: Date.now() - started }
  },
  async 'end-timeout'(port) {
    const sql = client(port, { max: 1 })
    await sql`select 1`
    const slow = sql`select pg_sleep(30)`.then(() => 'finished', (e) => e.code || e.message)
    await sleep(200)
    const started = Date.now()
    await within(sql.end({ timeout: 0.2 }), 3000, 'end with timeout')
    const outcome = await within(slow, 3000, 'in-flight query')
    if (outcome === 'finished') throw new Error('pg_sleep finished')
    return { outcome, ms: Date.now() - started }
  },
  async 'end-plain'(port) {
    const times = []
    for (let i = 0; i < 4; i++) {
      const sql = client(port, { max: 1 + (i % 2) })
      await Promise.all([sql`select 1 as x`, sql`select 2 as x`])
      const started = Date.now()
      await within(sql.end(), 3000, 'sql.end() #' + i)
      times.push(Date.now() - started)
    }
    return { times }
  },
  async 'end-while-connecting'(port) {
    const outcomes = []
    const yields = [0, 1, 2, 4, 8, 'macrotask', 1, 2]
    for (let i = 0; i < yields.length; i++) {
      const sql = client(port, { max: 1 })
      const query = sql`select 1`.then(() => 'resolved', (e) => e.code || e.message)
      if (yields[i] === 'macrotask') await sleep(0)
      else for (let n = 0; n < yields[i]; n++) await null
      await within(sql.end({ timeout: 0 }), 3000, 'sql.end({ timeout: 0 }) #' + i)
      outcomes.push(await within(query, 3000, 'pending query #' + i))
    }
    return { outcomes }
  },
  async 'end-tls'(port) {
    const times = []
    for (let i = 0; i < 3; i++) {
      const sql = client(port, { max: 1, ssl: 'require' })
      const [{ ssl }] = await sql`select ssl from pg_stat_ssl where pid = pg_backend_pid()`
      if (ssl !== true) throw new Error('Connection was not encrypted')
      const started = Date.now()
      await within(sql.end(), 3000, 'tls sql.end() #' + i)
      times.push(Date.now() - started)
    }
    return { times }
  },
  async 'copy-out'(port) {
    const sql = client(port, { max: 1 })
    const rows = 50000
    const readable = await within(sql.unsafe('copy (select generate_series(1, ' + rows + ')) to stdout').readable(), 3000, 'copy readable')
    const consume = async() => {
      let bytes = 0
        , chunks = 0
      for await (const chunk of readable) {
        bytes += chunk.length
        if (++chunks % 50 === 0) await sleep(1)
      }
      return { bytes, chunks }
    }
    const result = await within(consume(), 10000, 'copy stream')
    let expected = 0
    for (let i = 1; i <= rows; i++) expected += String(i).length + 1
    equal(result.bytes, expected)
    await within(sql.end(), 3000, 'end')
    return result
  },
  async 'ssl-prefer-declined'(port) {
    const sql = client(port, { max: 1, ssl: 'prefer', connect_timeout: 3 })
    const [{ ssl }] = await within(sql`select ssl from pg_stat_ssl where pid = pg_backend_pid()`, 6000, 'query with ssl: prefer')
    equal(ssl, false)
    await within(sql.end(), 3000, 'end')
    return { ssl }
  },
  async 'tls-untrusted-ca'(port) {
    const sql = client(port, { max: 1, ssl: 'require', connect_timeout: 5 })
    const started = Date.now()
    const error = await within(sql`select 1`.then(() => null, (e) => e), 9000, 'untrusted certificate')
    const ms = Date.now() - started
    if (!error) throw new Error('Connected despite an untrusted certificate')
    if (error.code === 'CONNECT_TIMEOUT') throw new Error('Untrusted certificate reported as CONNECT_TIMEOUT after ' + ms + 'ms')
    await within(sql.end({ timeout: 0 }), 3000, 'end')
    return { code: error.code, message: error.message, ms }
  },
  async subscribe(port) {
    const sql = client(port, { max: 1 })
    await sql`create table if not exists workerd_subscribe (id bigint primary key, value text)`
    await sql`drop publication if exists alltables`
    await sql`create publication alltables for all tables`
    const id = Date.now()
    let received
    const delivered = new Promise((resolve) => { received = resolve })
    const { unsubscribe } = await within(
      sql.subscribe('insert:workerd_subscribe', (row) => row.id === String(id) && received(row)),
      5000,
      'subscribe'
    )
    await sql`insert into workerd_subscribe ${ sql({ id, value: 'workerd' }) }`
    const row = await within(delivered, 5000, 'subscribe delivery')
    await within(unsubscribe(), 3000, 'unsubscribe')
    await within(sql.end(), 3000, 'end')
    return { row }
  },
  async 'diagnostics-channel'() {
    const dc = await import('node:diagnostics_channel')
    const seen = []
    const listener = (message) => seen.push(message)
    dc.subscribe('postgres:workerd-check', listener)
    dc.channel('postgres:workerd-check').publish({ marker: 1 })
    dc.unsubscribe('postgres:workerd-check', listener)
    equal(seen, [{ marker: 1 }])
    const events = []
    const tracing = typeof dc.tracingChannel === 'function' ? dc.tracingChannel('postgres:workerd-check') : null
    if (tracing) {
      tracing.subscribe({
        start: () => events.push('start'),
        end: () => events.push('end'),
        asyncStart: () => events.push('asyncStart'),
        asyncEnd: () => events.push('asyncEnd'),
        error: () => events.push('error')
      })
      await tracing.tracePromise(async() => 1, {})
    }
    return { tracingChannel: Boolean(tracing), events }
  }
}
export default {
  async fetch(request, env, context) {
    const url = new URL(request.url)
    if (url.pathname === '/health') return Response.json({ ready: true })
    unhandled = []
    const name = url.searchParams.get('case')
        , port = Number(url.searchParams.get('port'))
    context.waitUntil(new Promise((resolve) => setTimeout(resolve, 20000)))
    if (scenarios[name]) {
      let error
        , result
      try {
        result = await scenarios[name](port)
      } catch (e) {
        error = { message: e.message, code: e.code, stack: e.stack }
      }
      await sleep(300)
      return Response.json({ name, passed: !error, result, error, unhandled }, { status: error ? 500 : 200 })
    }
    const sql = postgres({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      database: 'postgres',
      ssl: false,
      max: 1,
      prepare: false,
      fetch_types: !name.includes('false'),
      connect_timeout: 2
    })
    let error
      , result
    try {
      if (name === 'cold-reserve-false') {
        const reserved = await within(sql.reserve(), 2000, 'reserve on a cold pool')
        result = await reserved.unsafe('select 42 as marker', [], { simple: true })
        equal(result[0].marker, 42)
        reserved.release()
      } else if (name.startsWith('arrays-')) {
        result = await sql`select array[1,null]::int[] as ints, array['NULL',null]::text[] as texts,
          array[true,false]::boolean[] as bools, array['{"a":1}',null]::jsonb[] as jsons`
        if (result[0].ints[1] !== null) throw new Error('Numeric SQL NULL was not preserved')
        equal(result[0], { ints: [1, null], texts: ['NULL', null], bools: [true, false], jsons: [{ a: 1 }, null] })
      } else if (name === 'catalog-error') {
        try {
          await sql.reserve()
          throw new Error('Expected catalog rejection')
        } catch (e) {
          equal({ code: e.code, message: e.message }, { code: '42501', message: 'catalog denied' })
          result = { code: e.code, message: e.message }
        }
      } else { throw new Error('Unknown scenario ' + name) }
    } catch (e) {
      error = { message: e.message, code: e.code, stack: e.stack }
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return Response.json({ name, passed: !error, result, error, unhandled }, { status: error ? 500 : 200 })
  }
}
