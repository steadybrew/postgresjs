import dc from 'diagnostics_channel'
import { AsyncLocalStorage } from 'async_hooks'

import { t } from './test.js'
import postgres from '../src/index.js'

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
    const handler = context => events.push({ name, stage: 'publish', id: id(context), context: { ...context } })
    dc.subscribe(name, handler)
    undo.push(() => dc.unsubscribe(name, handler))
  }

  for (const name of names.filter(x => !x.startsWith('postgres:'))) {
    const channel = dc.tracingChannel('postgres:' + name)
    const handlers = Object.fromEntries(stages.map(stage =>
      [stage, context => events.push({ name, stage, id: id(context), context: { ...context } })]
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
const server = o => ({ address: o.path || o.host[0], port: o.path ? undefined : o.port[0] })

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
  const { events, stop } = collect('query', 'postgres:query:send')
  await sql`select ${ 5 }::int as x`
  stop()
  await sql.end()
  const [done] = ended(events)
  const [send] = of(events, 'postgres:query:send')
  const { address, port } = server(sql.options)
  return [
    JSON.stringify([
      'start end publish asyncStart asyncEnd', 'select $1::int as x', [5], 'SELECT', 1,
      sql.options.database, sql.options.user, address, port, true, true
    ]),
    JSON.stringify([
      events.map(x => x.stage).join(' '), done.query, done.values, done.result.command, done.result.count,
      done.database, done.user, done.serverAddress, done.serverPort, typeof done.connectionId === 'number',
      send.context.connectionId === done.connectionId
    ])
  ]
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
  })
  return [JSON.stringify([2, 2]), settled(events)]
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
  const copies = ended(events).filter(x => /^copy/.test(x.query))
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
    JSON.stringify(ended(events).map(x => x.query))
  ]
})

t('Tracing a query cancelled before it is sent settles with the cancellation and is never sent', async() => {
  const sql = postgres(options)
  const { events, stop } = collect('query', 'postgres:query:send')
  const slow = sql`select pg_sleep(0.2)`.execute()
  const waiting = sql`select 2 as x`
  const code = waiting.then(() => 'resolved', e => e.code)
  await waiting.cancel()
  await slow
  const result = await code
  stop()
  await sql.end()
  const never = of(events, 'query').find(x => x.stage === 'asyncEnd' && x.context.query === undefined)
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
      ended(events).map(x => x.query)
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

t('Tracing a connection publishes its attempt and the close', async() => {
  const sql = postgres(options)
  const { events, stop } = collect('connection', 'postgres:connection:close')
  await sql`select 1`
  await sql.end()
  stop()
  const [done] = ended(events, 'connection')
  const [close] = of(events, 'postgres:connection:close')
  const { address, port } = server(sql.options)
  return [
    JSON.stringify([plain, true, sql.options.database, address, port, true, null]),
    JSON.stringify([sequence(events, 'connection'), typeof done.connectionId === 'number', done.database, done.serverAddress, done.serverPort,
                    close.context.connectionId === done.connectionId, close.context.error || null])
  ]
})

t('Tracing a connection that fails to authenticate or to connect publishes the error', async() => {
  const { events, stop } = collect('connection')
  const codes = []
  const wrong = postgres({ ...options, user: 'postgres_js_test_md5', pass: 'wrong' })
  codes.push(await wrong`select 1`.catch(e => e.code))
  const refused = postgres({ ...options, host: '127.0.0.1', port: 33333 })
  codes.push(await refused`select 1`.catch(e => e.code))
  stop()
  return [
    JSON.stringify([['28P01', 'ECONNREFUSED'], failed + ' ' + failed, ['28P01', 'ECONNREFUSED']]),
    JSON.stringify([codes, sequence(events, 'connection'), ended(events, 'connection').map(x => x.error.code)])
  ]
})

t('Tracing start runs in the AsyncLocalStorage context of the caller', async() => {
  const storage = new AsyncLocalStorage()
  const seen = []
  let spans = 0
  const sql = postgres({ ...options, debug: () => seen.push(storage.getStore()) })
  const channel = dc.tracingChannel('postgres:query')
  const handlers = { start: () => seen.push('start:' + storage.getStore()) }
  channel.start.bindStore(storage, () => 'span-' + ++spans)
  channel.subscribe(handlers)
  try {
    await sql`select 1`
    seen.length = 0
    await sql`select 2`
  } finally {
    channel.unsubscribe(handlers)
    channel.start.unbindStore(storage)
    await sql.end()
  }
  return [JSON.stringify(['start:span-2', 'span-2']), JSON.stringify(seen)]
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
  const names = ['query', 'connection', 'transaction'].flatMap(name => stages.map(stage => 'tracing:postgres:' + name + ':' + stage))
    .concat('postgres:query:send', 'postgres:connection:close')
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
  } finally {
    await sql.end()
    restore.forEach(x => x())
  }

  return [JSON.stringify([]), JSON.stringify(published)]
})
