import { writeFileSync } from 'node:fs'

export const scenarios = {
  tagged: sql => sql`select 1 as x`,
  parameters: sql => sql`select ${ 1 }::int as x`,
  unsafe: sql => sql.unsafe('select $1::int as x', [1]),
  simple: sql => sql`select 1 as x`.simple(),
  pipelined: sql => Promise.all([sql`select 1 as x`, sql`select 2 as x`, sql`select 3 as x`]),
  describe: sql => sql`select ${ 1 }::int as x`.describe(),
  cursor: async sql => {
    for await (const rows of sql`select generate_series(1, 3) as x`.cursor(2))
      void rows
  },
  forEach: sql => sql`select generate_series(1, 3) as x`.forEach(() => {}),
  error: sql => sql`select from missing_table`.catch(() => {}),
  reserve: async sql => {
    const reserved = await sql.reserve()
    await reserved`select 1 as x`
    reserved.release()
  },
  commit: sql => sql.begin(tx => tx`select 1 as x`),
  rollback: sql => sql.begin(async tx => {
    await tx`select 1 as x`
    throw new Error('rollback')
  }).catch(() => {}),
  savepoint: sql => sql.begin(tx => tx.savepoint(sp => sp`select 1 as x`)),
  copyOut: async sql => {
    const readable = await sql`copy (select generate_series(1, 3)) to stdout`.readable()
    await new Promise((resolve, reject) => readable.on('data', () => {}).on('end', resolve).on('error', reject))
  },
  copyIn: async sql => {
    await sql`drop table if exists tracing_copy`
    await sql`create table tracing_copy (x int)`
    const writable = await sql`copy tracing_copy from stdin`.writable()
    writable.write('1\n')
    writable.end('2\n')
    await new Promise((resolve, reject) => writable.on('finish', resolve).on('error', reject))
    await sql`drop table tracing_copy`
  },
  cancelBeforeSend: async sql => {
    const query = sql`select 1 as x`
    await query.cancel()
    await query.catch(() => {})
  },
  buildFailure: sql => sql`select ${ sql.json(1n) } as x`.catch(() => {})
}

export async function tracer(mode, events) {
  if (mode === 'dd-native') {
    const dc = await import('node:diagnostics_channel')
    const { AsyncLocalStorage } = await import('node:async_hooks')
    const storage = new AsyncLocalStorage()
    const noop = () => {}
    for (const name of ['query', 'connect', 'pool:connect', 'transaction']) {
      const channel = dc.tracingChannel('postgres:' + name)
      channel.start.bindStore(storage, () => name)
      channel.subscribe({ start: noop, end: noop, asyncStart: noop, asyncEnd: noop, error: noop })
    }
    for (const name of ['postgres:pool:release', 'postgres:pool:remove'])
      dc.subscribe(name, noop)
  }

  if (mode.startsWith('dd')) {
    const { default: dd } = await import('dd-trace')
    return {
      instrument: sql => sql,
      run: (name, fn) => dd.trace('scenario', { resource: name }, async() => { await fn() }),
      finish: async() => {}
    }
  }

  const Sentry = await import('@sentry/node')
  Sentry.init({
    dsn: 'https://public@127.0.0.1/1',
    tracesSampleRate: 1,
    traceLifecycle: 'static',
    integrations: xs => mode === 'sentry-manual' ? xs.filter(x => x.name !== 'PostgresJs') : xs,
    beforeSendTransaction: event => (events.push({
      transaction: event.transaction,
      spans: (event.spans || []).map(x => ({ op: x.op, description: x.description, status: x.status, data: Object.keys(x.data || {}) }))
    }), null)
  })
  const { instrumentPostgresJsSql } = mode === 'sentry-manual' ? await import('@sentry/server-utils') : {}
  return {
    instrument: sql => instrumentPostgresJsSql ? instrumentPostgresJsSql(sql) : sql,
    run: (name, fn) => Sentry.startSpan({ name, op: 'scenario', forceTransaction: true }, async() => { await fn() }),
    finish: () => Sentry.flush(5000)
  }
}

export async function main(t, postgres, events) {
  const failures = []
  const sql = t.instrument(postgres({ max: 2, idle_timeout: 1, onnotice: () => {} }))
  for (const [name, scenario] of Object.entries(scenarios))
    await t.run(name, () => scenario(sql)).catch(e => failures.push({ name, error: String(e) }))
  await sql.end()
  await t.finish()
  writeFileSync(process.env.RESULT_FILE, JSON.stringify({ events, failures }))
}
