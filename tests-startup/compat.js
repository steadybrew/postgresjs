import assert from 'assert'
import { peer } from './peer.js'
import { sleep } from './startup.js'

export const compatNames = ['timer-arguments']

const pg = { host: 'localhost', port: 5432, user: 'postgres', database: 'postgres', connect_timeout: 2, onnotice: () => { /* Quiet. */ } }
const base = server => ({ host: '127.0.0.1', port: server.port, user: 'fixture', database: 'fixture', ssl: false, fetch_types: false, max: 1 })
const marker = sql => sql.unsafe('select 42 as marker', [], { simple: true }).then(x => x[0].marker)
const startups = server => server.events.filter(x => x.type === 'startup').length

export async function compat(name, postgres) {
  if (name === 'timer-arguments')
    return timerArguments(postgres)
}

async function timerArguments(postgres) {
  const real = globalThis.setTimeout
  const calls = []
  globalThis.setTimeout = (fn, ms, ...rest) => {
    calls.push([ms, rest.length])
    if (rest.length)
      throw new Error('setTimeout received ' + rest.length + ' extra arguments')
    return real(fn, ms)
  }
  const servers = []
  const open = async options => {
    const server = await peer(options.peer || {})
    servers.push(server)
    return server
  }
  try {
    const idle = await open({})
    const idling = postgres({ ...base(idle), connect_timeout: 2, idle_timeout: 0.1 })
    assert.strictEqual(await marker(idling), 42)
    await sleep(300)
    assert.strictEqual(await marker(idling), 42)
    assert.strictEqual(startups(idle), 2)
    await idling.end({ timeout: 1 })

    const life = await open({})
    const living = postgres({ ...base(life), max_lifetime: 0.2 })
    assert.strictEqual(await marker(living), 42)
    await sleep(400)
    assert.strictEqual(await marker(living), 42)
    assert.strictEqual(startups(life), 2)
    await living.end({ timeout: 1 })

    const held = await open({ peer: { holdStartup: true } })
    const hosts = { host: '127.0.0.1,127.0.0.1', port: held.port + ',' + held.port }
    const connecting = postgres({ ...base(held), ...hosts, connect_timeout: 0.3, backoff: 0.01 })
    const started = Date.now()
    await assert.rejects(marker(connecting), error => error.code === 'CONNECT_TIMEOUT')
    assert(Date.now() - started < 1500)
    assert.strictEqual(startups(held), 2)
    await connecting.end({ timeout: 0 })

    const hung = await open({ peer: { holdQuery: 'pg_sleep' } })
    const ending = postgres({ ...base(hung), max_pipeline: 0 })
    const query = ending.unsafe('select pg_sleep(60)', [], { simple: true }).execute()
    const rejected = assert.rejects(query, error => error.code === 'CONNECTION_DESTROYED')
    await sleep(50)
    const outcome = await Promise.race([ending.end({ timeout: 0.1 }).then(() => 'resolved'), sleep(2000).then(() => 'hung')])
    assert.strictEqual(outcome, 'resolved')
    await rejected

    assert(calls.some(x => x[0] === 100), 'idle_timeout timer not armed')
    assert(calls.some(x => x[0] === 200), 'max_lifetime timer not armed')
    assert(calls.some(x => x[0] === 300), 'connect_timeout timer not armed')
    assert(calls.some(x => x[0] === 100), 'end timeout timer not armed')
    assert(calls.every(x => x[1] === 0), 'setTimeout received extra arguments')
  } finally {
    globalThis.setTimeout = real
    await Promise.all(servers.map(x => x.close()))
  }
}

export async function prepareName(postgres) {
  const names = ['tx 1!', 'it\'s', 'a-b_c.d$e', 'a"b\\c', 'trailing\\', '\\\'', '\'\'', '\\\\', 'x\\\'; select 1; --', 'plain']
  const created = new Set()
  const sql = postgres({ ...pg, max: 1 })
  const sessions = { on: sql, off: postgres({ ...pg, max: 1, connection: { standard_conforming_strings: 'off' } }) }
  try {
    assert.strictEqual((await sql`show max_prepared_transactions`)[0].max_prepared_transactions > 0, true)
    assert.strictEqual((await sessions.off`show standard_conforming_strings`)[0].standard_conforming_strings, 'off')
    for (const [mode, client] of Object.entries(sessions)) {
      for (const name of names) {
        const gid = mode + ':' + name
        await client.begin(async t => {
          await t`select 1`
          created.add(gid)
          await t.prepare(gid)
        })
        const found = await sql`select gid from pg_prepared_xacts where gid = ${ gid }`
        assert.strictEqual(found.length, 1, 'missing prepared transaction ' + JSON.stringify(gid))
        const [{ statement }] = await sql`select format('commit prepared %L', gid) as statement from pg_prepared_xacts where gid = ${ gid }`
        await sql.unsafe(statement)
        created.delete(gid)
      }
    }
    for (const invalid of [undefined, null, '', 'a\0b', 123, {}]) {
      await sql.begin(async t => {
        assert.throws(() => t.prepare(invalid), error => error.code === 'INVALID_TRANSACTION_NAME')
      })
    }
    assert.strictEqual((await sql`select count(*)::int as n from pg_prepared_xacts where gid = any(${ [...created] })`)[0].n, 0)
  } finally {
    for (const gid of created) {
      const rows = await sql`select format('rollback prepared %L', gid) as statement from pg_prepared_xacts where gid = ${ gid }`
      for (const row of rows)
        await sql.unsafe(row.statement)
    }
    await Promise.all(Object.values(sessions).map(x => x.end({ timeout: 0 })))
  }
}
