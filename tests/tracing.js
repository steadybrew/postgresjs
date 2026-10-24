import dc from 'diagnostics_channel'
import { AsyncLocalStorage } from 'async_hooks'

import { t } from './test.js'
import postgres from '../src/index.js'

const snapshot = context => Object.fromEntries(Object.entries(context))
const settle = () => new Promise(setImmediate)
const now = () => performance.timeOrigin + performance.now()
const rel = x => new URL(x, import.meta.url)
const stages = ['start', 'end', 'asyncStart', 'asyncEnd', 'error']

const options = {
  db: 'postgres_js_test',
  user: 'postgres_js_test',
  idle_timeout: 1,
  connect_timeout: 1,
  max: 1
}

function collect(...names) {
  const events = []
  const undo = []
  const ids = new Map()
  const id = context => ids.get(context) || (ids.set(context, ids.size + 1), ids.size)
  for (const name of names.filter(x => x.startsWith('postgres:'))) {
    const handler = context => events.push({ name, stage: 'publish', id: id(context), time: now(), context: snapshot(context) })
    dc.subscribe(name, handler)
    undo.push(() => dc.unsubscribe(name, handler))
  }

  for (const name of names.filter(x => !x.startsWith('postgres:'))) {
    const channel = dc.tracingChannel('postgres:' + name)
    const handlers = Object.fromEntries(stages.map(stage =>
      [stage, context => events.push({ name, stage, id: id(context), time: now(), context: snapshot(context) })]
    ))
    channel.subscribe(handlers)
    undo.push(() => channel.unsubscribe(handlers))
  }

  return { events, stop: () => undo.forEach(x => x()) }
}

const of = (events, name) => events.filter(x => x.name === name)
const sequence = (events, name) => of(events, name).map(x => x.stage).join(' ')
const ended = (events, name = 'query') => of(events, name).filter(x => x.stage === 'asyncEnd').map(x => x.context)
const plain = 'start end asyncStart asyncEnd'
const failed = 'start end error asyncStart asyncEnd'
const count = (events, stage, name = 'query') => of(events, name).filter(x => x.stage === stage).length
const settled = (events, name = 'query') => JSON.stringify([count(events, 'start', name), count(events, 'asyncEnd', name)])
const server = o => ({ host: o.path || o.host[0], port: o.path ? undefined : o.port[0] })

async function traced(names, fn) {
  const sql = postgres(options)
  const { events, stop } = collect(...names)
  try {
    await fn(sql)
  } finally {
    stop()
    await sql.end()
  }
  return events
}

t('Tracing publishes a query in order with the context filled in as it is built', async() => {
  const sql = postgres(options)
  const { events, stop } = collect('query', 'postgres:pool:remove')
  await sql`select ${ 5 }::int as x`
  await sql.end()
  stop()
  const [done] = ended(events)
  const [remove] = of(events, 'postgres:pool:remove')
  const { host, port } = server(sql.options)
  return [
    JSON.stringify([
      plain, 'select $1::int as x', true, 'SELECT', 1,
      sql.options.database, sql.options.user, host, port, false, true, false, true
    ]),
    JSON.stringify([
      sequence(events, 'query'), done.query.text, typeof done.query.name === 'string',
      done.result.command, done.result.count, done.client.database, done.client.user, done.client.host, done.client.port, done.client.ssl,
      typeof done.client.processID === 'number', 'values' in done,
      remove.context.client.processID === done.client.processID
    ])
  ]
})

t('Tracing names a prepared statement and leaves an unnamed one without a name', async() => {
  const events = await traced(['query'], async sql => {
    await sql`select 1 as x`
    await sql`select 2 as x`.simple()
  })
  const [prepared, simple] = ended(events)
  return [JSON.stringify([true, null]), JSON.stringify([typeof prepared.query.name === 'string', simple.query.name || null])]
})

t('Tracing publishes error before asyncStart and keeps the error on the context', async() => {
  const events = await traced(['query'], sql => sql`select 1/0`.catch(() => undefined))
  const [done] = ended(events)
  return [failed + '|22012', sequence(events, 'query') + '|' + done.error.code]
})

t('Tracing a cursor with a callback settles once', async() => {
  const events = await traced(['query'], sql => sql`select * from generate_series(1, 5)`.cursor(2, () => undefined))
  return [JSON.stringify([1, 1]), settled(events)]
})

t('Tracing a cursor read with for await settles once, to the end and on break', async() => {
  const events = await traced(['query'], async sql => {
    for await (const rows of sql`select * from generate_series(1, 5)`.cursor(2))
      rows.length
    for await (const rows of sql`select * from generate_series(1, 5)`.cursor(2)) {
      rows.length
      break
    }
    await sql`select 1`
  })
  return [JSON.stringify([3, 3]), settled(events)]
})

t('Tracing forEach settles once', async() => {
  const events = await traced(['query'], sql => sql`select * from generate_series(1, 5)`.forEach(() => undefined))
  return [JSON.stringify([1, 1]), settled(events)]
})

t('Tracing COPY streams settles each query once, when the copy is over', async() => {
  const events = await traced(['query'], async sql => {
    await sql`create temp table tracing_copy (x int)`
    const writable = await sql`copy tracing_copy from stdin`.writable()
    writable.end('1\n2\n')
    await new Promise(resolve => writable.on('finish', resolve))
    const readable = await sql`copy (select * from tracing_copy order by x) to stdout`.readable()
    readable.resume()
    await new Promise(resolve => readable.on('end', resolve))
    await sql`select 1`
  })
  const copies = ended(events).filter(x => /^copy/.test(x.query.text))
  return [
    JSON.stringify([4, 4, ['COPY', 'COPY']]),
    JSON.stringify([count(events, 'start'), count(events, 'asyncEnd'), copies.map(x => x.result.command)])
  ]
})

t('Tracing describe, simple, unsafe and file settle once each', async() => {
  const events = await traced(['query'], async sql => {
    await sql`select 1 as x`.describe()
    await sql`select 2 as x`.simple()
    await sql.unsafe('select 3 as x')
    await sql.unsafe('select $1::int as x', [4])
    await sql.file(rel('select.sql'))
  })
  return [JSON.stringify([5, 5]), settled(events)]
})

t('Tracing pipelined queries settle once each with their own context', async() => {
  const events = await traced(['query'], sql => Promise.all([sql`select 1 as x`, sql`select 2 as x`, sql`select 3 as x`]))
  return [
    JSON.stringify(['select 1 as x', 'select 2 as x', 'select 3 as x']),
    JSON.stringify(ended(events).map(x => x.query.text))
  ]
})

t('Tracing a query cancelled before it is sent settles with the cancellation and is never built', async() => {
  const sql = postgres(options)
  const { events, stop } = collect('query')
  const slow = sql`select pg_sleep(0.2)`.execute()
  const waiting = sql`select 2 as x`
  const code = waiting.then(() => 'resolved', e => e.code)
  await waiting.cancel()
  await slow
  const result = await code
  stop()
  await sql.end()
  const never = of(events, 'query').find(x => x.stage === 'asyncEnd' && x.context.query.text === undefined)
  const own = events.filter(x => x.id === never.id)
  return [
    JSON.stringify(['57014', failed]),
    JSON.stringify([result, own.map(x => x.stage).join(' ')])
  ]
})

t('Tracing a reserved connection settles each query once', async() => {
  const sql = postgres(options)
  const { events, stop } = collect('query')
  const reserved = await sql.reserve()
  await reserved`select 1 as x`
  reserved.release()
  stop()
  await sql.end()
  return [JSON.stringify([1, 1]), settled(events)]
})

t('Tracing a transaction publishes begin, its queries and a savepoint', async() => {
  const events = await traced(['transaction', 'query'], sql => sql.begin('read write', async sql => {
    await sql`select 1 as x`
    await sql.savepoint('inner', sql => sql`select 2 as x`)
  }))
  const [savepoint, transaction] = ended(events, 'transaction')
  return [
    JSON.stringify([
      'start end start end asyncStart asyncEnd asyncStart asyncEnd', 'read write', 's0_inner', { committed: true }, null,
      ['begin read write', 'select 1 as x', 'savepoint "s0_inner"', 'select 2 as x', 'commit']
    ]),
    JSON.stringify([
      sequence(events, 'transaction'), transaction.options, savepoint.savepoint, transaction.result, savepoint.result || null,
      ended(events).map(x => x.query.text)
    ])
  ]
})

t('Tracing a rolled back transaction publishes the error', async() => {
  const events = await traced(['transaction'], sql => sql.begin(() => {
    throw new Error('stop')
  }).catch(() => undefined))
  const [done] = ended(events, 'transaction')
  return [failed + '|stop', sequence(events, 'transaction') + '|' + done.error.message]
})

t('Tracing a connection publishes its attempt and the removal', async() => {
  const sql = postgres(options)
  const { events, stop } = collect('connect', 'postgres:pool:remove')
  await sql`select 1`
  await sql.end()
  stop()
  const [done] = ended(events, 'connect')
  const [remove] = of(events, 'postgres:pool:remove')
  const { host, port } = server(sql.options)
  return [
    JSON.stringify([plain, [sql.options.database, host, port, sql.options.user, false], true, null]),
    JSON.stringify([
      sequence(events, 'connect'),
      [done.connection.database, done.connection.host, done.connection.port, done.connection.user, done.connection.ssl],
      typeof remove.context.client.processID === 'number', remove.context.error || null
    ])
  ]
})

t('Tracing a connection that fails to authenticate or to connect publishes the error', async() => {
  const { events, stop } = collect('connect')
  const codes = []
  const wrong = postgres({ ...options, user: 'postgres_js_test_md5', pass: 'wrong' })
  codes.push(await wrong`select 1`.catch(e => e.code))
  const refused = postgres({ ...options, host: '127.0.0.1', port: 33333 })
  codes.push(await refused`select 1`.catch(e => e.code))
  stop()
  return [
    JSON.stringify([['28P01', 'ECONNREFUSED'], failed + ' ' + failed, ['28P01', 'ECONNREFUSED']]),
    JSON.stringify([codes, sequence(events, 'connect'), ended(events, 'connect').map(x => x.error.code)])
  ]
})

t('Tracing start runs in the AsyncLocalStorage context of the caller', async() => {
  const storage = new AsyncLocalStorage()
  const seen = []
  const transforms = []
  const sql = postgres({ ...options, debug: () => seen.push(storage.getStore()) })
  const channel = dc.tracingChannel('postgres:query')
  const handlers = { start: () => seen.push('start:' + storage.getStore()) }
  channel.start.bindStore(storage, () => (transforms.push(storage.getStore()), 'span'))
  channel.subscribe(handlers)
  try {
    await sql`select 1`
    seen.length = 0
    transforms.length = 0
    await storage.run('caller', async() => {
      await sql`select 2`
    })
  } finally {
    channel.unsubscribe(handlers)
    channel.start.unbindStore(storage)
    await sql.end()
  }
  return [JSON.stringify([['caller'], ['start:span', 'span']]), JSON.stringify([transforms, seen])]
})

t('Tracing a transaction runs its function inside the transaction context', async() => {
  const storage = new AsyncLocalStorage()
  const sql = postgres(options)
  const channel = dc.tracingChannel('postgres:transaction')
  const handlers = { start: () => undefined }
  channel.start.bindStore(storage, () => 'transaction')
  channel.subscribe(handlers)
  let seen
  try {
    await sql.begin(async() => {
      seen = storage.getStore()
    })
  } finally {
    channel.unsubscribe(handlers)
    channel.start.unbindStore(storage)
    await sql.end()
  }
  return ['transaction', seen]
})

t('Nothing is published when nothing subscribes', async() => {
  const published = []
  const restore = []
  const names = ['query', 'connect', 'transaction', 'pool:connect'].flatMap(name => stages.map(stage => 'tracing:postgres:' + name + ':' + stage))
    .concat('postgres:pool:release', 'postgres:pool:remove')
  for (const name of names) {
    const channel = dc.channel(name)
    for (const method of ['publish', 'runStores']) {
      const original = channel[method]
      channel[method] = function() {
        published.push(name + '.' + method)
        return original.apply(this, arguments)
      }
      restore.push(() => delete channel[method])
    }
  }

  const sql = postgres(options)
  try {
    await sql`select 1 as x`
    await sql.begin(async sql => {
      await sql`select 2 as x`
      await sql.savepoint(sql => sql`select 3 as x`)
    })
    const reserved = await sql.reserve()
    await reserved`select 4 as x`
    reserved.release()
  } finally {
    await sql.end()
    restore.forEach(x => x())
  }

  return [JSON.stringify([]), JSON.stringify(published)]
})

t('Tracing contexts have no result or error key until one is set', async() => {
  const events = await traced(['query', 'connect', 'transaction', 'pool:connect'], sql => sql.begin(async sql => {
    await sql.savepoint(sql => sql`select 1 as x`)
  }))
  const early = events.filter(x => x.stage === 'start' || x.stage === 'end')
  return [
    JSON.stringify([['connect', 'pool:connect', 'query', 'transaction'], 0]),
    JSON.stringify([[...new Set(early.map(x => x.name))].sort(), early.filter(x => 'result' in x.context || 'error' in x.context).length])
  ]
})

const cancelledBeforeAwait = async(extra, warm) => {
  const sql = postgres({ ...options, ...extra })
  warm && await sql`select 1`
  const { events, stop } = collect('query')
  const query = sql`select 2 as x`
  query.cancel()
  const code = await query.catch(e => e.code)
  await sql`select 3 as x`
  stop()
  await sql.end()
  return JSON.stringify([code, count(events, 'start'), count(events, 'asyncEnd')])
}

t('Tracing a query cancelled before it is awaited opens no span, with several connections', async() =>
  [JSON.stringify(['57014', 1, 1]), await cancelledBeforeAwait({ max: 2 }, true)]
)

t('Tracing a query cancelled before it is awaited opens no span, with one connection', async() =>
  [JSON.stringify(['57014', 1, 1]), await cancelledBeforeAwait({ max: 1 }, true)]
)

t('Tracing a query cancelled before it is awaited opens no span, on a pool that has to connect', async() =>
  [JSON.stringify(['57014', 1, 1]), await cancelledBeforeAwait({ max: 2 }, false)]
)

t('Tracing a retried query settles once', async() => {
  const sql = postgres(options)
  const { events, stop } = collect('query')
  await sql`drop table if exists tracing_retry`
  await sql`create table tracing_retry (name text)`
  await sql`insert into tracing_retry values ('1')`
  await sql`select name from tracing_retry`
  await sql`alter table tracing_retry alter column name type int using name::integer`
  const [row] = await sql`select name from tracing_retry`
  await sql`drop table tracing_retry`
  stop()
  await sql.end()
  return [JSON.stringify([1, 7, 7]), JSON.stringify([row.name, count(events, 'start'), count(events, 'asyncEnd')])]
})

t('Tracing a server error in the middle of a cursor settles once with the error', async() => {
  const events = await traced(['query'], async sql => {
    await sql`select 1 / (x - 3) from generate_series(1, 5) x`.cursor(2, () => undefined).catch(() => undefined)
    await sql`select 1`
  })
  const [first] = ended(events)
  return [JSON.stringify([2, 2, '22012']), JSON.stringify([count(events, 'start'), count(events, 'asyncEnd'), first.error && first.error.code])]
})

t('Tracing a cursor callback that throws settles once with the error', async() => {
  const events = await traced(['query'], async sql => {
    await sql`select * from generate_series(1, 5)`.cursor(2, () => {
      throw new Error('boom')
    }).catch(() => undefined)
    await sql`select 1`
  })
  const [first] = ended(events)
  return [JSON.stringify([2, 2, 'boom']), JSON.stringify([count(events, 'start'), count(events, 'asyncEnd'), first.error && first.error.message])]
})

t('Tracing a query cancelled in the queue of a reserved connection settles once', async() => {
  const sql = postgres({ ...options, max_pipeline: 1 })
  const { events, stop } = collect('query')
  const reserved = await sql.reserve()
  const first = reserved`select pg_sleep(0.1)`.execute()
  const second = reserved`select 2 as x`.execute()
  const third = reserved`select 3 as x`.execute()
  const code = await third.cancel().then(() => third.catch(e => e.code))
  await Promise.allSettled([first, second])
  reserved.release()
  stop()
  await sql.end()
  return [JSON.stringify(['57014', 3, 3]), JSON.stringify([code, count(events, 'start'), count(events, 'asyncEnd')])]
})

t('Tracing a query cancelled in the queue of a transaction settles once', async() => {
  const sql = postgres({ ...options, max_pipeline: 1 })
  const { events, stop } = collect('query')
  await sql.begin(async sql => {
    const queries = [sql`select pg_sleep(0.1)`.execute(), sql`select 2 as x`.execute(), sql`select 3 as x`.execute()]
    await queries[2].cancel()
    await Promise.allSettled(queries)
  }).catch(() => undefined)
  stop()
  await sql.end()
  return [
    JSON.stringify([true, 1]),
    JSON.stringify([count(events, 'start') === count(events, 'asyncEnd'), ended(events).filter(x => x.error && x.error.code === '57014').length])
  ]
})

t('Tracing queries rejected because the pool is ending settle once', async() => {
  const sql = postgres({ ...options, max: 1 })
  const { events, stop } = collect('query')
  const running = sql`select pg_sleep(0.1)`.execute()
  const queued = sql`select 2 as x`.execute()
  await Promise.allSettled([running, queued, sql.end()])
  stop()
  return [JSON.stringify([2, 2]), settled(events)]
})

t('Tracing a pool checkout reports the pool at start and whether the connection was reused', async() => {
  const sql = postgres(options)
  const { events, stop } = collect('pool:connect')
  const first = await sql.reserve()
  first.release()
  const second = await sql.reserve()
  second.release()
  stop()
  await sql.end()
  const starts = of(events, 'pool:connect').filter(x => x.stage === 'start').map(x => x.context.pool)
  const [one, two] = ended(events, 'pool:connect')
  return [
    JSON.stringify([
      plain + ' ' + plain,
      [{ totalCount: 0, idleCount: 0, waitingCount: 0, maxSize: 1 }, { totalCount: 1, idleCount: 1, waitingCount: 0, maxSize: 1 }],
      [false, true], true
    ]),
    JSON.stringify([
      sequence(events, 'pool:connect'), starts, [one.client.reused, two.client.reused],
      typeof one.client.processID === 'number' && one.client.processID === two.client.processID
    ])
  ]
})

t('Tracing a pool checkout that fails publishes the error and no client', async() => {
  const { events, stop } = collect('pool:connect')
  const refused = postgres({ ...options, host: '127.0.0.1', port: 33333 })
  const codes = [await refused.reserve().catch(e => e.code)]
  const ended_ = postgres(options)
  await ended_.end()
  codes.push(await ended_.reserve().catch(e => e.code))
  stop()
  const done = ended(events, 'pool:connect')
  return [
    JSON.stringify([['ECONNREFUSED', 'CONNECTION_ENDED'], failed + ' ' + failed, [false, false], ['ECONNREFUSED', 'CONNECTION_ENDED']]),
    JSON.stringify([codes, sequence(events, 'pool:connect'), done.map(x => 'client' in x), done.map(x => x.error.code)])
  ]
})

t('Tracing a release publishes once, with the connection of the checkout', async() => {
  const sql = postgres(options)
  const { events, stop } = collect('pool:connect', 'postgres:pool:release')
  const reserved = await sql.reserve()
  reserved.release()
  reserved.release()
  stop()
  await sql.end()
  const releases = of(events, 'postgres:pool:release')
  const [checkout] = ended(events, 'pool:connect')
  return [
    JSON.stringify([1, true, null]),
    JSON.stringify([releases.length, releases[0].context.client.processID === checkout.client.processID, releases[0].context.error || null])
  ]
})

t('Tracing a transaction publishes its release with the error that ended it', async() => {
  const sql = postgres(options)
  const { events, stop } = collect('pool:connect', 'postgres:pool:release', 'transaction')
  await sql.begin(async sql => {
    await sql`select 1`
  })
  await sql.begin(() => {
    throw new Error('stop')
  }).catch(() => undefined)
  stop()
  await sql.end()
  const releases = of(events, 'postgres:pool:release').map(x => x.context)
  const checkouts = ended(events, 'pool:connect')
  return [
    JSON.stringify([2, [null, 'stop'], [true, true], 2]),
    JSON.stringify([
      releases.length, releases.map(x => x.error ? x.error.message : null),
      releases.map((x, i) => x.client.processID === checkouts[i].client.processID), checkouts.length
    ])
  ]
})

const spans = (events, name = 'pool:connect') => ended(events, name)
const at = (events, name, stage, nth = 0) => events.indexOf(of(events, name).filter(x => x.stage === stage)[nth])
const asyncEndOf = (events, text) => events.indexOf(of(events, 'query').find(x => x.stage === 'asyncEnd' && x.context.query.text === text))

t('Tracing a query on an idle connection has a pool span that starts and ends at once', async() => {
  const sql = postgres(options)
  await sql`select 1`
  const { events, stop } = collect('query', 'pool:connect')
  await sql`select 2 as x`
  stop()
  await sql.end()
  const [span] = spans(events)
  const start = of(events, 'pool:connect').find(x => x.stage === 'start')
  return [
    JSON.stringify([plain, 0, true, true, true, true]),
    JSON.stringify([
      sequence(events, 'pool:connect'), span.queuedBehind, span.handoverTime >= start.time, span.client.reused,
      typeof span.client.processID === 'number', at(events, 'query', 'start') < at(events, 'pool:connect', 'start')
    ])
  ]
})

t('Tracing a query that opens its connection nests the connect span inside the pool span', async() => {
  const storage = new AsyncLocalStorage()
  const sql = postgres(options)
  const pool = dc.tracingChannel('postgres:pool:connect')
  const connect = dc.tracingChannel('postgres:connect')
  const seen = []
  const probe = { start: () => seen.push(storage.getStore()) }
  pool.start.bindStore(storage, () => 'pool')
  connect.subscribe(probe)
  const { events, stop } = collect('query', 'pool:connect', 'connect')
  try {
    await sql`select 1`
  } finally {
    stop()
    connect.unsubscribe(probe)
    pool.start.unbindStore(storage)
    await sql.end()
  }
  const [span] = spans(events)
  return [
    JSON.stringify([['pool'], false, plain, true, true]),
    JSON.stringify([
      seen, span.client.reused, sequence(events, 'pool:connect'),
      at(events, 'pool:connect', 'start') < at(events, 'connect', 'start'),
      at(events, 'connect', 'asyncEnd') < at(events, 'pool:connect', 'asyncEnd')
    ])
  ]
})

t('Tracing a query sent ahead to a busy connection ends its pool span when the earlier query is done', async() => {
  const sql = postgres(options)
  await sql`select 1`
  const { events, stop } = collect('query', 'pool:connect')
  const slow = sql`select pg_sleep(0.2)`.execute()
  await settle()
  const waiting = sql`select 2 as x`
  await Promise.all([slow, waiting])
  stop()
  await sql.end()
  const [first, second] = spans(events)
  return [
    JSON.stringify([0, true, true, true]),
    JSON.stringify([
      first.queuedBehind, second.queuedBehind >= 1, second.client.reused,
      asyncEndOf(events, 'select pg_sleep(0.2)') < at(events, 'pool:connect', 'asyncEnd', 1)
    ])
  ]
})

t('Tracing queries drained from the pool queue when the connection opens wait behind the first', async() => {
  const sql = postgres(options)
  const { events, stop } = collect('query', 'pool:connect')
  await Promise.all([sql`select 1 as x`, sql`select 2 as x`, sql`select 3 as x`])
  stop()
  await sql.end()
  const found = spans(events)
  const pairs = [0, 1, 2].map(i => at(events, 'pool:connect', 'asyncEnd', i) < at(events, 'query', 'asyncEnd', i))
  return [
    JSON.stringify([3, 3, [false, true, true], true, [true, true, true]]),
    JSON.stringify([
      count(events, 'asyncEnd', 'pool:connect'), count(events, 'start', 'pool:connect'), found.map(x => x.client.reused),
      found[1].queuedBehind >= 1, pairs
    ])
  ]
})

t('Tracing fails the pool span before the query when the pool is ending', async() => {
  const sql = postgres(options)
  await sql`select 1`
  const { events, stop } = collect('query', 'pool:connect')
  const ending = sql.end()
  const code = await sql`select 2 as x`.catch(e => e.code)
  await ending
  stop()
  const [span] = spans(events)
  return [
    JSON.stringify(['CONNECTION_ENDED', failed, 'CONNECTION_ENDED', true]),
    JSON.stringify([
      code, sequence(events, 'pool:connect'), span.error.code,
      at(events, 'pool:connect', 'asyncEnd') < at(events, 'query', 'asyncEnd')
    ])
  ]
})

t('Tracing fails the pool span of a query refused during a COPY', async() => {
  const sql = postgres(options)
  await sql`create temp table tracing_pool_copy (x int)`
  const writable = await sql`copy tracing_pool_copy from stdin`.writable()
  const { events, stop } = collect('query', 'pool:connect')
  const code = await sql`select 1`.catch(e => e.code)
  stop()
  writable.end('1\n')
  await new Promise(resolve => writable.on('finish', resolve))
  await sql.end()
  const [span] = spans(events)
  return [
    JSON.stringify(['COPY_IN_PROGRESS', failed, 'COPY_IN_PROGRESS']),
    JSON.stringify([code, sequence(events, 'pool:connect'), span.error.code])
  ]
})

t('Tracing fails the pool span of a query cancelled in the pool queue', async() => {
  const sql = postgres(options)
  await sql`select 1`
  const { events, stop } = collect('query', 'pool:connect')
  const first = sql`select pg_sleep(${ 0.1 })`.execute()
  const waiting = sql`select 2 as x`
  const code = waiting.then(() => 'resolved', e => e.code)
  await settle()
  await waiting.cancel()
  await first
  const result = await code
  stop()
  await sql.end()
  const found = spans(events)
  return [
    JSON.stringify(['57014', ['57014', 'ok'], 2, 2]),
    JSON.stringify([
      result, found.map(x => x.error ? x.error.code : 'ok').sort(), count(events, 'asyncEnd', 'pool:connect'), count(events, 'start', 'pool:connect')
    ])
  ]
})

t('Tracing fails the pool span of a query whose connection attempt fails', async() => {
  const { events, stop } = collect('query', 'pool:connect', 'connect')
  const refused = postgres({ ...options, host: '127.0.0.1', port: 33333 })
  const code = await refused`select 1`.catch(e => e.code)
  stop()
  return [
    JSON.stringify(['ECONNREFUSED', failed, failed, true]),
    JSON.stringify([
      code, sequence(events, 'pool:connect'), sequence(events, 'connect'),
      at(events, 'pool:connect', 'asyncEnd') < at(events, 'query', 'asyncEnd')
    ])
  ]
})

t('Tracing fails the pool span of a query that waited behind others on a connection that is lost', async() => {
  const sql = postgres(options)
  const killer = postgres({ ...options, max: 1 })
  const [{ pid }] = await sql`select pg_backend_pid() as pid`
  const { events, stop } = collect('query', 'pool:connect')
  const running = sql`select pg_sleep(5)`.execute()
  await settle()
  const waiting = sql`select 2 as x`.execute()
  await killer`select pg_terminate_backend(${ pid })`
  const outcomes = await Promise.allSettled([running, waiting])
  stop()
  await Promise.all([sql.end(), killer.end()])
  const failures = of(events, 'pool:connect').filter(x => x.stage === 'error')
  const failed_ = events.find(x => x.name === 'pool:connect' && x.stage === 'asyncEnd' && x.context.error)
  return [
    JSON.stringify(['rejected', 'rejected', 1, true, true]),
    JSON.stringify([
      outcomes[0].status, outcomes[1].status, failures.length,
      count(events, 'start', 'pool:connect') === count(events, 'asyncEnd', 'pool:connect'),
      events.indexOf(failed_) < asyncEndOf(events, 'select 2 as x')
    ])
  ]
})

t('Tracing opens no pool span when only one of the query and pool channels has a subscriber', async() => {
  const sql = postgres(options)
  const poolOnly = collect('pool:connect')
  await sql`select 1`
  poolOnly.stop()
  const published = []
  const channel = dc.channel('tracing:postgres:pool:connect:start')
  const original = channel.runStores
  channel.runStores = function() {
    published.push('runStores')
    return original.apply(this, arguments)
  }
  const queryOnly = collect('query')
  try {
    await sql`select 2`
  } finally {
    queryOnly.stop()
    delete channel.runStores
    await sql.end()
  }
  return [JSON.stringify([0, []]), JSON.stringify([poolOnly.events.length, published])]
})

t('Tracing a query that fails to build while it is routed settles its pool span once, after end', async() => {
  const sql = postgres(options)
  await sql`select 1`
  const idle = collect('query', 'pool:connect')
  await sql`select ${ undefined }`.catch(() => undefined)
  idle.stop()
  const slow = sql`select pg_sleep(0.2)`.execute()
  await settle()
  const busy = collect('query', 'pool:connect')
  await sql`select ${ undefined }`.catch(() => undefined)
  busy.stop()
  await slow
  await sql.end()
  const summary = events => [
    sequence(events, 'pool:connect'), sequence(events, 'query'), count(events, 'asyncEnd', 'pool:connect'), count(events, 'asyncEnd'),
    at(events, 'pool:connect', 'asyncEnd') < at(events, 'query', 'asyncEnd')
  ]
  return [
    JSON.stringify([[plain, failed, 1, 1, true], [failed, failed, 1, 1, true]]),
    JSON.stringify([summary(idle.events), summary(busy.events)])
  ]
})

t('Tracing statements inside begin and reserve publish no plain pool span', async() => {
  const sql = postgres(options)
  const { events, stop } = collect('query', 'pool:connect')
  await sql.begin(async sql => {
    await sql`select 1`
  })
  const reserved = await sql.reserve()
  await reserved`select 2`
  reserved.release()
  stop()
  await sql.end()
  return [
    JSON.stringify([2, 2, 4]),
    JSON.stringify([count(events, 'start', 'pool:connect'), count(events, 'asyncEnd', 'pool:connect'), count(events, 'start')])
  ]
})

t('Tracing a lease taken on a busy connection reports the queries ahead of it', async() => {
  const sql = postgres(options)
  await sql`select 1`
  const slow = sql`select pg_sleep(0.2)`.execute()
  await settle()
  const { events, stop } = collect('pool:connect')
  await sql.begin(async sql => {
    await sql`select 1`
  })
  stop()
  await slow
  await sql.end()
  const [span] = spans(events)
  return [JSON.stringify([1, true]), JSON.stringify([span.queuedBehind, span.client.reused])]
})
