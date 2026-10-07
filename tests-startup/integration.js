import assert from 'assert'

export async function integration(postgres) {
  await firstTypes(postgres)
  await cursorReconnect(postgres)
  await preferStandby(postgres)
  for (const max of [1, 3]) {
    for (const fetch_types of [true, false]) {
      for (const prepare of [true, false])
        await combination(postgres, { max, fetch_types, prepare })
    }
  }
}

async function combination(postgres, { max, fetch_types, prepare }) {
  const sql = postgres({ host: 'localhost', port: 5432, user: 'postgres', database: 'postgres',
                         max, fetch_types, prepare, connect_timeout: 2 })
  const query = (client, marker) => client`select ${ marker }::int as marker, pg_backend_pid() as pid`
  async function capacity() {
    for (let round = 0; round < 2; round++) {
      const held = await Promise.all(Array.from({ length: max }, () => sql.reserve()))
      const results = await Promise.all(held.map((client, i) => query(client, i)))
      assert.strictEqual(new Set(results.map(x => x[0].pid)).size, max)
      results.forEach((x, i) => assert.strictEqual(x[0].marker, i))
      held.forEach(client => client.release())
    }
  }
  try {
    const assigned = sql.reserve()
    const pending = query(sql, 101).execute()
    const held = await assigned
    assert.strictEqual((await query(held, 102))[0].marker, 102)
    held.release()
    assert.strictEqual((await pending)[0].marker, 101)
    await capacity()
    if (max === 1) {
      const occupied = await sql.reserve()
      const [{ pid }] = await query(occupied, 103)
      const first = sql.reserve()
      const second = sql.reserve()
      const admin = postgres({ host: 'localhost', port: 5432, user: 'postgres', database: 'postgres', max: 1 })
      try {
        await admin`select pg_terminate_backend(${ pid })`
        const recovered = await first
        assert.strictEqual((await query(recovered, 104))[0].marker, 104)
        recovered.release()
        const next = await second
        assert.strictEqual((await query(next, 105))[0].marker, 105)
        next.release()
        await capacity()
      } finally {
        await admin.end({ timeout: 0 })
      }
    }
  } finally {
    await sql.end({ timeout: 0 })
  }
}

async function firstTypes(postgres) {
  for (const prepare of [true, false]) {
    const sql = postgres({ host: 'localhost', port: 5432, user: 'postgres', database: 'postgres', max: 3, prepare })
    try {
      const results = await Promise.all(Array.from({ length: 3 }, () => sql`select ${ sql.array(['a', 'b,c'], 25) }::text[] as value`))
      results.forEach(x => assert.deepStrictEqual(x[0].value, ['a', 'b,c']))
      assert.strictEqual(new Set(results.map(x => x.state.pid)).size, 3)
    } finally {
      await sql.end({ timeout: 0 })
    }
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function cursorReconnect(postgres) {
  const options = { host: 'localhost', port: 5432, user: 'postgres', database: 'postgres', fetch_types: false, backoff: 0.01,
                    onnotice: () => { /* Quiet. */ } }
  const admin = postgres(options)
  const sql = postgres({ ...options, max: 1 })
  try {
    const gate = { release: null }
    const cursor = sql`select generate_series(1, 10) as x`.cursor(1, () => new Promise(resolve => { gate.release = resolve })).catch(error => error)
    while (!gate.release)
      await sleep(5)
    await admin`select pg_terminate_backend(pid) from pg_stat_activity where query like 'select generate_series%' and pid <> pg_backend_pid()`
    await sleep(100)
    const next = sql`select pg_sleep(0.3), 1 as y`.then(x => x[0].y, error => error.code)
    await sleep(100)
    gate.release()
    assert.strictEqual(await next, 1)
    await cursor
    assert.strictEqual((await sql`select 2 as z`)[0].z, 2)
  } finally {
    await sql.end({ timeout: 0 })
    await admin.end({ timeout: 0 })
  }
}

async function preferStandby(postgres) {
  for (const port of [[5432, 5499], [5499, 5432]]) {
    const sql = postgres({ host: ['localhost', 'localhost'], port, user: 'postgres', database: 'postgres', max: 1, fetch_types: false,
                           connect_timeout: 2, target_session_attrs: 'prefer-standby' })
    try {
      assert.strictEqual((await sql`select pg_is_in_recovery() as recovery`)[0].recovery, false)
    } finally {
      await sql.end({ timeout: 0 })
    }
  }
}
