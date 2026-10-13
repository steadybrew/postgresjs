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
  savepoint: sql => sql.begin(tx => tx.savepoint(sp => sp`select 1 as x`))
}

export async function tracer(mode, events) {
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
