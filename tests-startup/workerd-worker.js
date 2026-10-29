/* eslint no-console: 0 */
/* global addEventListener */
import * as drivers from './driver.js'
let unhandled = []
addEventListener('unhandledrejection', (event) => {
  const reason = event.reason?.stack || String(event.reason)
  unhandled.push(reason)
  console.error('WORKER_UNHANDLED_REJECTION', reason)
})
const nativeSetTimeout = globalThis.setTimeout
let strictTimers = true
globalThis.setTimeout = function(callback, delay, ...extra) {
  if (strictTimers && extra.length) throw new TypeError('Failed to execute \'setTimeout\': parameter 3 is not of type \'Array\'.')
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
let target = null
let isolate = null
let served = 0
const servedByBuild = {}
function client(port, { ssl, ...options } = {}) {
  return target.url
    ? target.postgres(target.url, { prepare: false, fetch_types: false, ...options })
    : target.postgres({
      host: '127.0.0.1', port, user: 'postgres', database: 'postgres', ssl: ssl || false, prepare: false, fetch_types: false, ...options
    })
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
    const sql = client(port, { max: 1, publications: 'workerd_subscribe' })
    await sql`create table if not exists workerd_subscribe (id bigint primary key, value text)`
    await sql`create publication workerd_subscribe for table workerd_subscribe`.catch((error) => {
      if (error.code !== '42710')
        throw error
    })
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
  },
  async 'tls-private-ca'() {
    const results = []
    for (const ssl of ['require', 'prefer']) {
      const sql = target.postgres(target.supabaseUrl, { max: 1, ssl, prepare: false, fetch_types: false, connect_timeout: 5 })
      const started = Date.now()
      const error = await within(sql`select 1`.then(() => null, (e) => e), 9000, 'private CA with ssl: ' + ssl)
      const ms = Date.now() - started
      await within(sql.end({ timeout: 0 }), 3000, 'end')
      if (!error) throw new Error('Connected with ssl: ' + ssl + ' despite a private CA')
      if (error.code !== 'TLS_CLOSED' || ms > 3000) throw new Error('ssl: ' + ssl + ' rejected with ' + error.code + ' after ' + ms + 'ms')
      results.push({ ssl, code: error.code, ms })
    }
    return results
  },
  async 'ssl-verify'(port) {
    const sql = client(port, { max: 1 })
    const [{ x }] = await within(sql`select 1 as x`, 10000, 'verified TLS query')
    await within(sql.end(), 3000, 'end')
    const plain = target.postgres(target.url, { max: 1, ssl: false, connect_timeout: 5, prepare: false, fetch_types: false })
    const error = await within(plain`select 1`.then(() => null, (e) => e), 9000, 'plaintext query')
    await within(plain.end({ timeout: 0 }), 3000, 'end')
    if (!error) throw new Error('The server accepted a connection without TLS')
    return { x, plaintext: error.code || error.message }
  },
  async pooled() {
    const sql = target.postgres(target.pooledUrl, { max: 2, prepare: false, fetch_types: false })
    const rows = await within(Promise.all(Array.from({ length: 20 }, (_, i) => sql`select ${ i }::int as i`)), 10000, 'pooled queries')
    equal(rows.map(([{ i }]) => i), Array.from({ length: 20 }, (_, i) => i))
    await within(sql.end(), 3000, 'end')
    return { queries: rows.length }
  },
  async cpu() {
    const q = target.search
    const hyperdriven = q.get('target') === 'hyperdrive'
    const sql = hyperdriven
      ? target.postgres(target.hyperdriveSupabase, {
        max: 5,
        prepare: true,
        fetch_types: q.get('fetch_types') === 'true',
        idle_timeout: 20,
        connect_timeout: 10,
        types: { bigint: { to: 20, from: [20], parse: Number, serialize: String } },
        connection: { search_path: 'public' }
      })
      : target.postgres(q.get('target') === 'neon' ? target.url : target.supabaseUrl, {
        max: 2,
        prepare: false,
        fetch_types: q.get('fetch_types') === 'true',
        connect_timeout: 10
      })
    const [{ x }] = await sql`select 1 as x`
    hyperdriven && await Promise.all([
      sql`select ${ 1 }::int as a, ${ 'b' }::text as b, now() as c`,
      sql`select ${ 2 }::bigint as n, ${ [1, 2] }::int[] as xs`,
      sql`select generate_series(1, ${ 20 }) as i`
    ])
    await sql.end({ timeout: 5 })
    const build = q.get('build')
    servedByBuild[build] = (servedByBuild[build] || 0) + 1
    return { x, isolate, served, buildServed: servedByBuild[build] }
  },
  async 'no-end'(port) {
    const sql = client(port, { max: 1, connection: { application_name: target.search.get('tag') } })
    const [{ x }] = await sql`select 1 as x`
    return { x }
  },
  async backends(port) {
    const sql = client(port, { max: 1 })
    const [{ n }] = await sql`select count(*)::int as n from pg_stat_activity where application_name = ${ target.search.get('tag') }`
    await sql.end()
    return { n }
  },
  hyperdrive: () => hyperdrive(target.hyperdrive),
  'hyperdrive-pooled': () => hyperdrive(target.hyperdrivePooled),
  'hyperdrive-supabase': () => hyperdrive(target.hyperdriveSupabase),
  'abort-neon': () => aborts(target.url, [{ prepare: true }, { prepare: false }]),
  'abort-neon-pooled': () => aborts(target.pooledUrl, [{ prepare: false }]),
  'abort-supabase-pooler': () => aborts(target.supabaseUrl, [{ prepare: false }]),
  'abort-hyperdrive': () => aborts(target.hyperdrive, [{ prepare: true, closes: true }, { prepare: false }]),
  'abort-hyperdrive-pooled': () => aborts(target.hyperdrivePooled, [{ prepare: true, closes: true }, { prepare: false }]),
  'abort-hyperdrive-supabase': () => aborts(target.hyperdriveSupabase, [{ prepare: true, closes: true }, { prepare: false }])
}
async function aborts(connectionString, variants) {
  const results = {}
  for (const variant of variants)
    results['prepare-' + variant.prepare] = await abort(connectionString, variant)
  return results
}
async function abort(connectionString, { prepare, closes = false }) {
  const sql = target.postgres(connectionString, { max: 2, prepare, fetch_types: false, connect_timeout: 10 })
  const command = (x) => x.command
  const failure = (e) => e.code || e.name
  await sql`create table if not exists workerd_abort (tag text, x int, j jsonb)`
  const tag = crypto.randomUUID()
  const pipelined = async(failing) => {
    const reserved = await sql.reserve()
    try {
      return await within(Promise.all([
        reserved`begin`.then(command, failure),
        reserved`insert into workerd_abort (tag, x) values (${ tag }, 1)`.then(command, failure),
        failing(reserved).then(command, failure),
        reserved`insert into workerd_abort (tag, x) values (${ tag }, 2)`.then(command, failure),
        reserved`commit`.then(command, failure)
      ]), 10000, 'pipelined transaction')
    } finally {
      reserved.release()
    }
  }
  const aborted = (results, code) => closes
    ? equal([results[2], results[4]], [code, 'CONNECTION_CLOSED'])
    : equal(results.slice(2), [code, '25P02', 'ROLLBACK'])
  const undefinedValue = await pipelined((s) => s`insert into workerd_abort (tag, x) values (${ tag }, ${ undefined })`)
  aborted(undefinedValue, 'UNDEFINED_VALUE')
  const afterDescribe = await pipelined((s) => s`insert into workerd_abort (tag, j) values (${ tag }, ${ { a: 1n } })`)
  aborted(afterDescribe, 'TypeError')
  const begin = await within(sql.begin((s) => {
    s`insert into workerd_abort (tag, x) values (${ tag }, 3)`.execute()
    s`insert into workerd_abort (tag, x) values (${ tag }, ${ undefined })`.execute().catch(() => undefined)
    return 'committed'
  }).then((x) => x, (e) => [e.code, e.cause && e.cause.code]), 10000, 'sql.begin')
  closes || equal(begin, ['TRANSACTION_ROLLED_BACK', 'UNDEFINED_VALUE'])
  const outside = await within(Promise.all([
    sql`insert into workerd_abort (tag, x) values (${ tag }, 4)`.then(command, failure),
    sql`insert into workerd_abort (tag, x) values (${ tag }, ${ undefined })`.then(command, failure),
    sql`insert into workerd_abort (tag, x) values (${ tag }, 5)`.then(command, failure)
  ]), 10000, 'queries outside a transaction')
  equal(outside, ['INSERT', 'UNDEFINED_VALUE', 'INSERT'])
  const [{ xs }] = await sql`select array_agg(x order by x) as xs from workerd_abort where tag = ${ tag }`
  equal(xs, [4, 5])
  await sql`delete from workerd_abort where tag = ${ tag }`
  await within(sql.end(), 3000, 'end')
  return { undefinedValue, afterDescribe, begin, outside, xs }
}
async function hyperdrive(connectionString) {
  const sql = target.postgres(connectionString, { max: 5, fetch_types: false })
  await sql`create table if not exists workerd_hyperdrive (id bigint primary key, value text)`
  const first = Date.now() * 1000 + Math.floor(Math.random() * 20) * 50
  const ids = Array.from({ length: 50 }, (_, i) => first + i)
  await within(Promise.all(ids.map(async(id) => {
    await sql`insert into workerd_hyperdrive ${ sql({ id, value: String(id) }) }`
    const [{ value }] = await sql`select value from workerd_hyperdrive where id = ${ id }`
    equal(value, String(id))
  })), 20000, 'hyperdrive queries')
  await sql`delete from workerd_hyperdrive where id >= ${ first } and id < ${ first + ids.length }`
  await within(sql.end(), 3000, 'end')
  return { queries: ids.length * 2 + 2 }
}
export default {
  async fetch(request, env, context) {
    const url = new URL(request.url)
    if (env.EDGE_TOKEN && request.headers.get('authorization') !== 'Bearer ' + env.EDGE_TOKEN)
      return new Response('unauthorized', { status: 401 })
    if (url.pathname === '/health') return Response.json({ ready: true })
    unhandled = []
    isolate = isolate || crypto.randomUUID()
    served++
    target = {
      postgres: drivers[url.searchParams.get('build')] || drivers.default,
      url: env.DATABASE_URL,
      pooledUrl: env.POOLED_URL,
      supabaseUrl: env.SUPABASE_URL,
      search: url.searchParams,
      hyperdrive: env.HYPERDRIVE?.connectionString,
      hyperdrivePooled: env.HYPERDRIVE_POOLED?.connectionString,
      hyperdriveSupabase: env.HYPERDRIVE_SUPABASE?.connectionString
    }
    const name = url.searchParams.get('case')
        , port = Number(url.searchParams.get('port'))
    strictTimers = name !== 'cpu'
    name === 'cpu' || name === 'no-end' || context.waitUntil(new Promise((resolve) => setTimeout(resolve, 20000)))
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
    const sql = client(port, { max: 1, fetch_types: !name.includes('false'), connect_timeout: 2 })
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
