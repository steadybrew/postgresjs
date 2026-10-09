import assert from 'assert'
import net from 'net'
import { prepareName } from './compat.js'

export async function integration(postgres) {
  await firstTypes(postgres)
  await cursorReconnect(postgres)
  await preferStandby(postgres)
  await targetSessionAttrs(postgres)
  await leases(postgres)
  await endAfterTerminate(postgres)
  await prepareName(postgres)
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

const base = { host: 'localhost', user: 'postgres', max: 1, onnotice: () => undefined }

async function withSetting(postgres, port, name, value, fn) {
  const admin = postgres({ ...base, port, database: 'postgres', fetch_types: false })
  const wait = async expected => {
    for (let i = 0; i < 100; i++) {
      if ((await admin`select current_setting(${ name }) as value`)[0].value === expected)
        return
      await sleep(50)
    }
    throw new Error(name + ' did not become ' + expected)
  }
  try {
    const [{ original }] = await admin`select current_setting(${ name }) as original`
    try {
      await admin.unsafe('alter system set ' + name + ' = ' + value)
      await admin`select pg_reload_conf()`
      await wait(value)
      await fn()
    } finally {
      await admin.unsafe('alter system reset ' + name)
      await admin`select pg_reload_conf()`
      await wait(original)
    }
  } finally {
    await admin.end({ timeout: 0 })
  }
}

async function withReadOnlyDatabase(postgres, ports, fn) {
  const name = 'read_only_' + Math.random().toString(36).slice(2)
  const admins = ports.map(port => postgres({ ...base, port, database: 'postgres', fetch_types: false }))
  try {
    try {
      for (const admin of admins) {
        await admin.unsafe('create database ' + name)
        await admin.unsafe('alter database ' + name + ' set default_transaction_read_only = on')
      }
      await fn(name)
    } finally {
      for (const admin of admins)
        await admin.unsafe('drop database if exists ' + name + ' with (force)')
    }
  } finally {
    await Promise.all(admins.map(admin => admin.end({ timeout: 0 })))
  }
}

async function failure(promise) {
  const start = Date.now()
  const error = await promise.then(() => assert.fail('Expected a rejection'), error => error)
  return { error, elapsed: Date.now() - start }
}

async function unusedPort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

async function targetSessionAttrs(postgres) {
  await withReadOnlyDatabase(postgres, [5432, 5433], async database => {
    const sql = postgres({ ...base, port: 5432, database, target_session_attrs: 'read-write', connect_timeout: 3 })
    try {
      const { error, elapsed } = await failure(sql`select 1`)
      assert.strictEqual(error.code, 'TARGET_SESSION_ATTRS')
      assert(error.message.includes('read-write') && error.message.includes('localhost:5432'), error.message)
      assert(elapsed < 1000, 'Mismatch must fail at once: ' + elapsed)
    } finally {
      await sql.end({ timeout: 0 })
    }

    const both = postgres({ ...base, host: ['localhost', 'localhost'], port: [5433, 5432], database,
                            target_session_attrs: 'read-write', connect_timeout: 3 })
    try {
      const { error, elapsed } = await failure(both`select 1`)
      assert.strictEqual(error.code, 'TARGET_SESSION_ATTRS')
      assert(error.message.includes('localhost:5433') && error.message.includes('localhost:5432'), error.message)
      assert(elapsed < 1000, 'Mismatch on every host must fail at once: ' + elapsed)
    } finally {
      await both.end({ timeout: 0 })
    }
  })

  await withSetting(postgres, 5433, 'default_transaction_read_only', 'on', async() => {
    const sql = postgres({ ...base, host: ['localhost', 'localhost'], port: [5433, 5432], database: 'postgres',
                           target_session_attrs: 'read-write', connect_timeout: 3 })
    try {
      assert.strictEqual((await sql`show port`)[0].port, '5432')
    } finally {
      await sql.end({ timeout: 0 })
    }
  })

  await withSetting(postgres, 5433, 'ssl', 'off', async() => {
    const sql = postgres({ ...base, port: 5433, database: 'postgres', ssl: 'require', connect_timeout: 3 })
    try {
      const { error, elapsed } = await failure(sql`select 1`)
      assert.strictEqual(error.code, 'SSL_NOT_SUPPORTED')
      assert(elapsed < 1000, 'Missing SSL must fail at once: ' + elapsed)
    } finally {
      await sql.end({ timeout: 0 })
    }
  })

  const ports = [await unusedPort(), await unusedPort()]
  const refused = postgres({ ...base, host: ['127.0.0.1', '127.0.0.1'], port: ports, database: 'postgres', connect_timeout: 1, backoff: 0.05 })
  try {
    const { error, elapsed } = await failure(refused`select 1`)
    assert.strictEqual(error.code, 'ECONNREFUSED')
    assert(elapsed >= 1500 && elapsed < 4000, 'Refusal must retry until the deadline: ' + elapsed)
  } finally {
    await refused.end({ timeout: 0 })
  }
}

const pg = { host: 'localhost', port: 5432, user: 'postgres', database: 'postgres', fetch_types: true, onnotice: () => { /* Quiet. */ } }
const outcome = promise => Promise.resolve(promise).then(() => 'resolved', error => error.code || error.message)

const refusals = { count: 0 }

async function pressured() {
  const socket = net.connect(5432, 'localhost')
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  const write = socket.write.bind(socket)
  socket.write = (...args) => {
    write(...args)
    args[0].length >= 1024 && refusals.count++
    return args[0].length < 1024
  }
  return socket
}

async function leases(postgres) {
  const admin = postgres({ ...pg, max: 1 })
  await admin`drop table if exists lease_probe`
  await admin`create table lease_probe (x int)`
  try {
    await staleTransaction(postgres, admin)
    await staleReservation(postgres, admin)
    for (const options of [{ max_pipeline: 0 }, { socket: pressured }, {}]) {
      refusals.count = 0
      await ownedTransaction(postgres, admin, options)
      options.socket && assert(refusals.count >= 1, 'Backpressure was never applied')
    }
    await finishedHandles(postgres, admin)
    await rawBegin(postgres)
    await copyFailure(postgres, admin)
    await starvation(postgres)
    await endingSlot(postgres)
  } finally {
    await admin`drop table lease_probe`
    await admin.end({ timeout: 0 })
  }
}

async function staleTransaction(postgres, admin) {
  const sql = postgres({ ...pg, max: 1, backoff: 0.01 })
  try {
    let late
    let savepoint
    let finished
    const done = new Promise(resolve => finished = resolve)
    const result = outcome(sql.begin(async t => {
      try {
        const [{ pid }] = await t`select pg_backend_pid() as pid`
        const other = sql`select pg_backend_pid() as pid`
        await admin`select pg_terminate_backend(${ pid })`
        const [{ pid: next }] = await other
        assert.notStrictEqual(next, pid)
        late = await outcome(t`insert into lease_probe values (1)`)
        savepoint = await outcome(t.savepoint(s => s`insert into lease_probe values (2)`))
        await t`insert into lease_probe values (3)`
      } finally {
        finished()
      }
    }))
    const code = await result
    await done
    assert.strictEqual((await admin`select count(*)::int as n from lease_probe`)[0].n, 0)
    assert.strictEqual(late, 'CONNECTION_CLOSED')
    assert.strictEqual(savepoint, 'CONNECTION_CLOSED')
    assert.strictEqual(code, '57P01')
    assert.strictEqual((await sql`select 1 as x`)[0].x, 1)
  } finally {
    await sql.end({ timeout: 0 })
  }
}

async function endAfterTerminate(postgres) {
  const admin = postgres({ ...pg, max: 1 })
  const sql = postgres({ ...pg, max: 1 })
  try {
    const [{ pid }] = await sql`select pg_backend_pid() as pid`
    const inflight = outcome(sql`select pg_sleep(30)`)
    const active = async() => (await admin`
      select 1 from pg_stat_activity where pid = ${ pid } and query like 'select pg_sleep%' and state = 'active'
    `).length
    for (let i = 0; i < 100 && !(await active()); i++)
      await sleep(20)
    await admin`select pg_terminate_backend(${ pid })`
    const start = Date.now()
    assert.strictEqual(await Promise.race([sql.end().then(() => 'resolved'), sleep(3000).then(() => 'hung')]), 'resolved')
    assert(Date.now() - start < 2000, 'end() must not wait on a terminated backend')
    assert.notStrictEqual(await Promise.race([inflight, sleep(1000).then(() => 'hung')]), 'hung')
    assert.notStrictEqual(await inflight, 'resolved')
  } finally {
    await sql.end({ timeout: 0 })
    await admin.end({ timeout: 0 })
  }
}

async function finishedHandles(postgres, admin) {
  const sql = postgres({ ...pg, max: 1, backoff: 0.01 })
  try {
    const held = await sql.reserve()
    await held`select 1 as x`
    held.release()
    assert.strictEqual(await outcome(held`insert into lease_probe values (5)`), 'CONNECTION_ENDED')
    const leaks = []
    await sql.begin(async t => {
      leaks.push(t)
      await t.savepoint(async s => { leaks.push(s) })
    })
    await outcome(sql.begin(async t => {
      leaks.push(t)
      throw new Error('mine')
    }))
    const prepared = []
    await sql.begin(async t => {
      prepared.push(t)
      t.prepare('lease_finished_' + process.pid)
    })
    await admin.unsafe(`rollback prepared 'lease_finished_${ process.pid }'`)
    for (const leak of [...leaks, ...prepared])
      assert.strictEqual(await outcome(leak`insert into lease_probe values (6)`), 'CONNECTION_ENDED')
    assert.strictEqual((await admin`select count(*)::int as n from lease_probe`)[0].n, 0)
    assert.strictEqual((await sql`select 1 as x`)[0].x, 1)
  } finally {
    await sql.end({ timeout: 0 })
  }
}

async function staleReservation(postgres, admin) {
  const sql = postgres({ ...pg, max: 1, backoff: 0.01 })
  try {
    const held = await sql.reserve()
    const [{ pid }] = await held`select pg_backend_pid() as pid`
    const other = sql`select pg_backend_pid() as pid`
    await admin`select pg_terminate_backend(${ pid })`
    assert.notStrictEqual((await other)[0].pid, pid)
    assert.strictEqual(await outcome(held`insert into lease_probe values (4)`), 'CONNECTION_CLOSED')
    held.release()
    assert.strictEqual((await admin`select count(*)::int as n from lease_probe`)[0].n, 0)
    assert.strictEqual((await sql`select 1 as x`)[0].x, 1)
  } finally {
    await sql.end({ timeout: 0 })
  }
}

async function ownedTransaction(postgres, admin, options) {
  const sql = postgres({ ...pg, max: 2, ...options })
  try {
    await assert.rejects(sql.begin(' '.repeat(1100) + 'read write', async t => {
      const [{ pid }] = await t`select pg_backend_pid() as pid`
      await t`insert into lease_probe values (5)`
      const [{ pid: other }] = await sql`select pg_backend_pid() as pid`
      assert.notStrictEqual(other, pid)
      assert.strictEqual((await sql`select count(*)::int as n from lease_probe`)[0].n, 0)
      assert.strictEqual((await t`select count(*)::int as n from lease_probe`)[0].n, 1)
      throw new Error('rollback')
    }), /rollback/)
    assert.strictEqual((await admin`select count(*)::int as n from lease_probe`)[0].n, 0)
    await sql.begin(' '.repeat(1100) + 'read write', async t => {
      await t`insert into lease_probe values (6)`
    })
    assert.strictEqual((await admin`select count(*)::int as n from lease_probe`)[0].n, 1)
    await admin`delete from lease_probe`
    const [{ pid }] = await sql`select pg_backend_pid() as pid`
    assert(pid > 0)
  } finally {
    await sql.end({ timeout: 0 })
  }
}

async function rawBegin(postgres) {
  const sql = postgres({ ...pg, max: 2 })
  try {
    assert.strictEqual(await outcome(sql`begin`), 'UNSAFE_TRANSACTION')
  } finally {
    await sql.end({ timeout: 0 })
  }
}

async function copyFailure(postgres, admin) {
  await admin`drop table if exists lease_copy`
  await admin`create table lease_copy (x int)`
  const sql = postgres({ ...pg, max: 1 })
  try {
    const result = await outcome(sql.begin(async t => {
      const writable = await t`copy lease_copy from stdin`.writable()
      writable.on('error', () => { /* Expected. */ })
      writable.write('1\n')
      throw new Error('boom')
    }))
    assert.notStrictEqual(result, 'resolved')
    const [{ tx }] = await sql`select txid_current_if_assigned() as tx`
    assert.strictEqual(tx, null)
    assert.strictEqual((await sql`select count(*)::int as n from lease_copy`)[0].n, 0)
  } finally {
    await sql.end({ timeout: 0 })
    await admin`drop table lease_copy`
  }
}

async function starvation(postgres) {
  for (const max of [1, 3]) {
    const sql = postgres({ ...pg, max })
    const flood = { stop: false }
    const inflight = new Set()
    const running = (async() => {
      while (!flood.stop) {
        const p = sql`select pg_sleep(0.002)`.then(() => inflight.delete(p))
        inflight.add(p)
        if (inflight.size >= 20 * max)
          await Promise.race(inflight)
      }
      await Promise.all(inflight)
    })()
    try {
      await sleep(100)
      const start = Date.now()
      const result = await outcome(Promise.race([sql.begin(t => t`select 1 as x`), sleep(3000).then(() => 'starved')]))
      assert.strictEqual(result, 'resolved')
      assert(Date.now() - start < 1000, 'begin starved at max ' + max)
    } finally {
      flood.stop = true
      await running
      await sql.end({ timeout: 0 })
    }
  }
}

async function endingSlot(postgres) {
  let created = 0
  const sql = postgres({ ...pg, max: 2, socket: async() => {
    created++
    const socket = net.connect(5432, 'localhost')
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    return socket
  } })
  const slow = sql`select pg_sleep(0.3)`.execute()
  await sleep(50)
  const ending = outcome(sql.end())
  await sleep(0)
  assert.strictEqual(await outcome(sql.begin(t => t`select 1 as x`)), 'CONNECTION_ENDED')
  assert.strictEqual(await outcome(sql.reserve()), 'CONNECTION_ENDED')
  await slow
  assert.strictEqual(await ending, 'resolved')
  assert.strictEqual(created, 1)
}
