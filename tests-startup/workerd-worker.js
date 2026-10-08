/* eslint no-console: 0 */
/* global addEventListener */
import postgres from './cf/src/index.js'
addEventListener('unhandledrejection', (event) => console.error('WORKER_UNHANDLED_REJECTION', event.reason?.stack || String(event.reason)))
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
  }
}
export default {
  async fetch(request, env, context) {
    const url = new URL(request.url)
    if (url.pathname === '/health') return Response.json({ ready: true })
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
      return Response.json({ name, passed: !error, result, error }, { status: error ? 500 : 200 })
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
        const reserved = await sql.reserve()
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
    return Response.json({ name, passed: !error, result, error }, { status: error ? 500 : 200 })
  }
}
